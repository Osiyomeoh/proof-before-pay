import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Verdict } from '../src/proof/engine.ts';
import { judge } from '../src/proof/engine.ts';
import { loadMauiFleet } from '../src/proof/maui.ts';
import { createPayPalClient } from '../src/paypal/client.ts';
import { centsToValue, createPayments } from '../src/payments/service.ts';
import type { NewMilestone, Proof } from '../src/payments/service.ts';
import { createFakePayPal } from './helpers/fake-paypal.ts';

const verdict = (status: Verdict['status']): Verdict => ({
  status,
  unitId: '01',
  date: '2020-10-07',
  reasons: [],
  window: [],
  mean: null,
  baseline: null,
  historyDays: 0,
} as unknown as Verdict);

const ready: Proof = () => verdict('RELEASE_READY');
const hold: Proof = () => verdict('HOLD');

const TWO: NewMilestone[] = [
  { title: 'Delivered', amountCents: 4000, unitId: '01', proofDate: '2020-10-01' },
  { title: 'Producing', amountCents: 6000, unitId: '01', proofDate: '2020-10-07' },
];

async function setup(proof: Proof = ready, milestones = TWO, now?: () => number) {
  const fake = createFakePayPal();
  const paypal = createPayPalClient({ clientId: 'a', clientSecret: 'b', fetch: fake.fetch });
  const payments = createPayments({ paypal, proof, ...(now ? { now } : {}) });
  const contract = await payments.startHold({
    description: 'Solar install',
    currency: 'USD',
    milestones,
    returnUrl: 'https://example.com/ok',
    cancelUrl: 'https://example.com/no',
  });
  await payments.completeHold(contract.id);
  return { fake, payments, contract };
}

function tapFor(payments: Awaited<ReturnType<typeof setup>>['payments'], contractId: string, milestoneId: string): string {
  const tap = payments.prepareRelease(contractId, milestoneId);
  assert.equal(tap.outcome, 'READY');
  return tap.outcome === 'READY' ? tap.token : '';
}

test('whole-cent amounts format the way PayPal expects', () => {
  assert.equal(centsToValue(4000), '40.00');
  assert.equal(centsToValue(5), '0.05');
  assert.equal(centsToValue(123456), '1234.56');
  assert.throws(() => centsToValue(1.5));
  assert.throws(() => centsToValue(-1));
});

test('a hold moves no money: the only calls are create order and authorize', async () => {
  const { fake, contract } = await setup();
  assert.equal(contract.status, 'HELD');
  assert.deepEqual(fake.calls.map((call) => call.path.split('/').pop()), ['orders', 'authorize']);
  assert.equal(fake.captures().length, 0);
  assert.equal(contract.expiresAt, '2026-12-03T00:00:00Z');
});

test('a contract with no milestones, or a bad amount, is refused before calling PayPal', async () => {
  const fake = createFakePayPal();
  const paypal = createPayPalClient({ clientId: 'a', clientSecret: 'b', fetch: fake.fetch });
  const payments = createPayments({ paypal, proof: ready });
  const base = { description: 'x', currency: 'USD', returnUrl: 'https://e.com/a', cancelUrl: 'https://e.com/b' };
  await assert.rejects(payments.startHold({ ...base, milestones: [] }));
  await assert.rejects(payments.startHold({ ...base, milestones: [{ title: 'x', amountCents: 0, unitId: '01', proofDate: '2020-10-07' }] }));
  await assert.rejects(payments.startHold({ ...base, milestones: [{ title: 'x', amountCents: 10.5, unitId: '01', proofDate: '2020-10-07' }] }));
  assert.equal(fake.calls.length, 0);
});

// The rule from PLAN.md, on the real outage and the real engine.
test('real data: the outage keeps Release locked, and no capture reaches PayPal', async () => {
  const fleet = loadMauiFleet();
  const proof: Proof = (unitId, date) => judge(fleet, unitId, date);
  for (const date of ['2020-10-08', '2020-10-12', '2020-10-23', '2020-11-18']) {
    const { fake, payments, contract } = await setup(proof, [{ title: 'Producing', amountCents: 10000, unitId: '01', proofDate: date }]);
    const tap = payments.prepareRelease(contract.id, 'm1');
    assert.equal(tap.outcome, 'LOCKED', date);
    const result = await payments.release(contract.id, 'm1', 'any-token');
    assert.equal(result.outcome, 'LOCKED', date);
    assert.equal(fake.captures().length, 0, date);
  }
});

test('real data: a healthy window can be released, but only after a tap', async () => {
  const fleet = loadMauiFleet();
  const proof: Proof = (unitId, date) => judge(fleet, unitId, date);
  const { fake, payments, contract } = await setup(proof, [{ title: 'Producing', amountCents: 10000, unitId: '01', proofDate: '2020-11-19' }]);
  assert.equal((await payments.release(contract.id, 'm1', undefined)).outcome, 'TAP_REQUIRED');
  assert.equal(fake.captures().length, 0);
  const result = await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'));
  assert.equal(result.outcome, 'CAPTURED');
  assert.equal(fake.captures().length, 1);
});

test('no token is issued while the verdict is HOLD', async () => {
  const { payments, contract } = await setup(hold);
  const tap = payments.prepareRelease(contract.id, 'm1');
  assert.equal(tap.outcome, 'LOCKED');
  assert.ok(!('token' in tap));
});

test('a token issued while ready cannot be spent once the verdict turns to HOLD', async () => {
  let current: Proof = ready;
  const { fake, payments, contract } = await setup((u, d) => current(u, d));
  const token = tapFor(payments, contract.id, 'm1');
  current = hold;
  assert.equal((await payments.release(contract.id, 'm1', token)).outcome, 'LOCKED');
  assert.equal(fake.captures().length, 0);
  assert.equal(contract.milestones[0]?.status, 'WAITING');
});

for (const [label, token] of [['no', undefined], ['an empty', ''], ['a made-up', 'guess'], ['a non-string', { tap: true }]] as const) {
  test(`${label} token cannot release`, async () => {
    const { fake, payments, contract } = await setup();
    assert.equal((await payments.release(contract.id, 'm1', token)).outcome, 'TAP_REQUIRED');
    assert.equal(fake.captures().length, 0);
  });
}

test('a token only works for its own milestone', async () => {
  const { fake, payments, contract } = await setup();
  const token = tapFor(payments, contract.id, 'm1');
  assert.equal((await payments.release(contract.id, 'm2', token)).outcome, 'TAP_REQUIRED');
  assert.equal(fake.captures().length, 0);
});

test('a token only works for its own contract', async () => {
  const first = await setup();
  const fake = first.fake;
  const other = await first.payments.startHold({ description: 'x', currency: 'USD', milestones: TWO, returnUrl: 'https://e.com/a', cancelUrl: 'https://e.com/b' });
  await first.payments.completeHold(other.id);
  const token = tapFor(first.payments, first.contract.id, 'm1');
  assert.equal((await first.payments.release(other.id, 'm1', token)).outcome, 'TAP_REQUIRED');
  assert.equal(fake.captures().length, 0);
});

test('a token expires after five minutes', async () => {
  let time = 1_000_000;
  const { fake, payments, contract } = await setup(ready, TWO, () => time);
  const token = tapFor(payments, contract.id, 'm1');
  time += 5 * 60 * 1000 + 1;
  assert.equal((await payments.release(contract.id, 'm1', token)).outcome, 'TAP_REQUIRED');
  assert.equal(fake.captures().length, 0);
});

test('two taps at once make one capture call', async () => {
  const { fake, payments, contract } = await setup();
  const token = tapFor(payments, contract.id, 'm1');
  const [first, second] = await Promise.all([payments.release(contract.id, 'm1', token), payments.release(contract.id, 'm1', token)]);
  assert.equal(first.outcome, 'CAPTURED');
  assert.equal(second.outcome, 'IN_PROGRESS');
  assert.equal(fake.captures().length, 1);
});

test('tapping a released milestone again makes no second capture', async () => {
  const { fake, payments, contract } = await setup();
  await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'));
  const again = await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'));
  assert.equal(again.outcome, 'ALREADY_RELEASED');
  assert.equal(fake.captures().length, 1);
});

test('partial captures: the last milestone is the final capture, and the contract closes', async () => {
  const { fake, payments, contract } = await setup();
  await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'));
  assert.equal(contract.status, 'HELD');
  await payments.release(contract.id, 'm2', tapFor(payments, contract.id, 'm2'));
  assert.equal(contract.status, 'CLOSED');
  const bodies = fake.captures().map((call) => call.body as { amount: { value: string }; final_capture: boolean });
  assert.deepEqual(bodies.map((body) => [body.amount.value, body.final_capture]), [['40.00', false], ['60.00', true]]);
});

test('milestones can release out of order, and the last one is still final', async () => {
  const { fake, payments, contract } = await setup();
  await payments.release(contract.id, 'm2', tapFor(payments, contract.id, 'm2'));
  await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'));
  const bodies = fake.captures().map((call) => call.body as { amount: { value: string }; final_capture: boolean });
  assert.deepEqual(bodies.map((body) => [body.amount.value, body.final_capture]), [['60.00', false], ['40.00', true]]);
});

test('no reply from PayPal: the retry reuses the request ID, so the money moves once', async () => {
  const { fake, payments, contract } = await setup();
  fake.override(() => 'NETWORK_ERROR');
  const lost = await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'));
  assert.equal(lost.outcome, 'UNKNOWN');
  assert.equal(contract.milestones[0]?.status, 'CAPTURE_UNKNOWN');
  const firstId = fake.captures()[0]?.requestId;

  // The first call did reach PayPal, so PayPal answers the repeat with that capture.
  const path = fake.captures()[0]?.path ?? '';
  fake.remember(path, firstId ?? '', { status: 201, body: { id: 'CAP-ONCE', status: 'COMPLETED' } });
  fake.clearOverride();

  const retried = await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'));
  assert.equal(retried.outcome, 'CAPTURED');
  assert.equal(fake.captures()[1]?.requestId, firstId);
  assert.equal(contract.milestones[0]?.captureId, 'CAP-ONCE');
});

test('a definite refusal returns the milestone to WAITING with a new request ID and PayPal\'s debug ID', async () => {
  const { fake, payments, contract } = await setup();
  const before = contract.milestones[0]?.captureRequestId;
  fake.override(() => ({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'X' }] } }));
  const result = await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'));
  assert.equal(result.outcome, 'REJECTED');
  assert.equal(contract.milestones[0]?.status, 'WAITING');
  assert.notEqual(contract.milestones[0]?.captureRequestId, before);
  assert.match(contract.milestones[0]?.debugId ?? '', /^debug-/);
});

test('a capture refused once can succeed on the next tap, with a new request ID and invoice ID', async () => {
  const { fake, payments, contract } = await setup();
  fake.override(() => ({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY' } }));
  assert.equal((await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'))).outcome, 'REJECTED');
  fake.clearOverride();
  assert.equal((await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'))).outcome, 'CAPTURED');
});

test('a PENDING capture is not reported as paid, and cannot be captured again', async () => {
  const { fake, payments, contract } = await setup();
  fake.override((call) => (call.path.endsWith('/capture') ? { status: 201, body: { id: 'CAP-P', status: 'PENDING' } } : null));
  assert.equal((await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'))).outcome, 'PENDING');
  assert.equal(contract.milestones[0]?.status, 'PENDING');
  assert.equal((await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'))).outcome, 'ALREADY_RELEASED');
  assert.equal(fake.captures().length, 1);
});

test('an unexpected capture status is unknown, not paid', async () => {
  const { fake, payments, contract } = await setup();
  fake.override((call) => (call.path.endsWith('/capture') ? { status: 201, body: { id: 'CAP-X', status: 'SOMETHING_NEW' } } : null));
  assert.equal((await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'))).outcome, 'UNKNOWN');
  assert.equal(contract.milestones[0]?.status, 'CAPTURE_UNKNOWN');
});

test('a decline can be retried, with a new request ID', async () => {
  const { fake, payments, contract } = await setup();
  const before = contract.milestones[0]?.captureRequestId;
  fake.override((call) => (call.path.endsWith('/capture') ? { status: 201, body: { id: 'CAP-D', status: 'DECLINED' } } : null));
  assert.equal((await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'))).outcome, 'DECLINED');
  fake.clearOverride();
  assert.equal((await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'))).outcome, 'CAPTURED');
  assert.notEqual(fake.captures()[1]?.requestId, before);
});

test('voiding needs a tap, gives the hold back, and blocks later releases', async () => {
  const { fake, payments, contract } = await setup();
  assert.equal((await payments.voidHold(contract.id, undefined)).outcome, 'TAP_REQUIRED');
  assert.equal(fake.calls.filter((call) => call.path.endsWith('/void')).length, 0);
  assert.equal((await payments.voidHold(contract.id, payments.prepareVoid(contract.id))).outcome, 'VOIDED');
  assert.equal(contract.status, 'VOIDED');
  assert.equal((await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'))).outcome, 'NOT_HELD');
  assert.equal(fake.captures().length, 0);
});

test('a release tap cannot be used to void, or a void tap to release', async () => {
  const { payments, contract } = await setup();
  assert.equal((await payments.voidHold(contract.id, tapFor(payments, contract.id, 'm1'))).outcome, 'TAP_REQUIRED');
  assert.equal((await payments.release(contract.id, 'm1', payments.prepareVoid(contract.id))).outcome, 'TAP_REQUIRED');
});

test('reauthorizing asks only for what is still uncaptured, and later captures use the new ID', async () => {
  const { fake, payments, contract } = await setup();
  await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'));
  const oldId = contract.authorizationId;
  await payments.reauthorizeHold(contract.id);
  const reauth = fake.calls.find((call) => call.path.endsWith('/reauthorize'));
  assert.deepEqual(reauth?.body, { amount: { currency_code: 'USD', value: '60.00' } });
  assert.notEqual(contract.authorizationId, oldId);
  await payments.release(contract.id, 'm2', tapFor(payments, contract.id, 'm2'));
  assert.ok(fake.captures()[1]?.path.includes(contract.authorizationId ?? 'missing'));
});

test('webhook: completed ticks the timeline for a pending capture, and repeats are ignored', async () => {
  const { fake, payments, contract } = await setup();
  fake.override((call) => (call.path.endsWith('/capture') ? { status: 201, body: { id: 'CAP-P', status: 'PENDING' } } : null));
  await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'));
  const event = { id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-P' } };
  assert.deepEqual(payments.applyWebhook(event), { applied: true, reason: 'APPLIED' });
  assert.equal(contract.milestones[0]?.status, 'CAPTURED');
  assert.deepEqual(payments.applyWebhook(event), { applied: false, reason: 'DUPLICATE' });
  assert.ok(contract.timeline.some((entry) => entry.source === 'webhook' && entry.type === 'CAPTURE_CAPTURED'));
});

test('webhook: an event arriving before the capture call returns still matches, by invoice ID', async () => {
  const fake = createFakePayPal();
  let finish: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const slow = createPayments({
    proof: ready,
    paypal: {
      ...createPayPalClient({ clientId: 'a', clientSecret: 'b', fetch: fake.fetch }),
      capture: async (input) => {
        await gate;
        return { id: 'CAP-LATE', status: 'COMPLETED', amount: input.amount, finalCapture: false, debugId: null };
      },
    },
  });
  const held = await slow.startHold({ description: 'x', currency: 'USD', milestones: TWO, returnUrl: 'https://e.com/a', cancelUrl: 'https://e.com/b' });
  await slow.completeHold(held.id);
  const pending = slow.release(held.id, 'm1', tapFor(slow, held.id, 'm1'));
  const early = slow.applyWebhook({ id: 'WH-E', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-LATE', invoice_id: `${held.id}:m1:1` } });
  assert.equal(early.applied, true);
  finish?.();
  assert.equal((await pending).outcome, 'CAPTURED');
  assert.equal(held.milestones[0]?.captureId, 'CAP-LATE');
});

test('webhook: a late PENDING or DECLINED cannot undo a completed capture', async () => {
  const { payments, contract } = await setup();
  await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'));
  const id = contract.milestones[0]?.captureId;
  assert.equal(payments.applyWebhook({ id: 'WH-2', event_type: 'PAYMENT.CAPTURE.PENDING', resource: { id } }).reason, 'NO_CHANGE');
  assert.equal(payments.applyWebhook({ id: 'WH-3', event_type: 'PAYMENT.CAPTURE.DECLINED', resource: { id } }).reason, 'NO_CHANGE');
  assert.equal(contract.milestones[0]?.status, 'CAPTURED');
});

for (const type of ['PAYMENT.CAPTURE.DECLINED', 'PAYMENT.CAPTURE.DENIED']) {
  test(`webhook: ${type} marks a pending capture declined`, async () => {
    const { fake, payments, contract } = await setup();
    fake.override((call) => (call.path.endsWith('/capture') ? { status: 201, body: { id: 'CAP-P', status: 'PENDING' } } : null));
    await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'));
    assert.equal(payments.applyWebhook({ id: 'WH', event_type: type, resource: { id: 'CAP-P' } }).applied, true);
    assert.equal(contract.milestones[0]?.status, 'DECLINED');
  });
}

test('webhook: a refund finds its capture through the up link', async () => {
  const { payments, contract } = await setup();
  await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'));
  const captureId = contract.milestones[0]?.captureId;
  const event = {
    id: 'WH-R',
    event_type: 'PAYMENT.CAPTURE.REFUNDED',
    resource: { id: 'REFUND-1', links: [{ rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` }] },
  };
  assert.equal(payments.applyWebhook(event).applied, true);
  assert.equal(contract.milestones[0]?.status, 'REFUNDED');
  assert.equal(contract.milestones[0]?.captureId, captureId);
});

test('webhook: VOIDED closes the hold, including one that reached its time limit', async () => {
  const { payments, contract } = await setup();
  const result = payments.applyWebhook({ id: 'WH-V', event_type: 'PAYMENT.AUTHORIZATION.VOIDED', resource: { id: contract.authorizationId } });
  assert.equal(result.applied, true);
  assert.equal(contract.status, 'VOIDED');
  assert.equal((await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'))).outcome, 'NOT_HELD');
});

test('webhook: a void for a replaced authorization does not close the new hold', async () => {
  const { payments, contract } = await setup();
  const oldId = contract.authorizationId;
  await payments.reauthorizeHold(contract.id);
  assert.equal(payments.applyWebhook({ id: 'WH-O', event_type: 'PAYMENT.AUTHORIZATION.VOIDED', resource: { id: oldId } }).reason, 'UNMATCHED');
  assert.equal(contract.status, 'HELD');
});

test('webhook: unknown event types and unmatched captures change nothing', async () => {
  const { payments, contract } = await setup();
  assert.equal(payments.applyWebhook({ id: 'WH-U', event_type: 'BILLING.SOMETHING', resource: {} }).reason, 'IGNORED_TYPE');
  assert.equal(payments.applyWebhook({ id: 'WH-N', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'NOT-OURS' } }).reason, 'UNMATCHED');
  assert.equal(payments.applyWebhook('nonsense').applied, false);
  assert.equal(contract.milestones[0]?.status, 'WAITING');
});

test('webhook: a stale decline cannot mark a capture in flight as declined, which would allow a second capture', async () => {
  const fake = createFakePayPal();
  let finish: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const slow = createPayments({
    proof: ready,
    paypal: {
      ...createPayPalClient({ clientId: 'a', clientSecret: 'b', fetch: fake.fetch }),
      capture: async (input) => {
        await gate;
        return { id: 'CAP-NEW', status: 'COMPLETED', amount: input.amount, finalCapture: false, debugId: null };
      },
    },
  });
  const held = await slow.startHold({ description: 'x', currency: 'USD', milestones: TWO, returnUrl: 'https://e.com/a', cancelUrl: 'https://e.com/b' });
  await slow.completeHold(held.id);
  const pending = slow.release(held.id, 'm1', tapFor(slow, held.id, 'm1'));
  const stale = slow.applyWebhook({ id: 'WH-S', event_type: 'PAYMENT.CAPTURE.DECLINED', resource: { id: 'CAP-OLD', invoice_id: `${held.id}:m1:1` } });
  assert.equal(stale.reason, 'UNMATCHED');
  assert.equal(held.milestones[0]?.status, 'CAPTURING');
  finish?.();
  assert.equal((await pending).outcome, 'CAPTURED');
});

test('a spent token cannot be used again, even when the capture was refused', async () => {
  const { fake, payments, contract } = await setup();
  const token = tapFor(payments, contract.id, 'm1');
  fake.override(() => ({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY' } }));
  assert.equal((await payments.release(contract.id, 'm1', token)).outcome, 'REJECTED');
  fake.clearOverride();
  assert.equal((await payments.release(contract.id, 'm1', token)).outcome, 'TAP_REQUIRED');
  assert.equal(fake.captures().length, 1);
});

test('reauthorizing with nothing left to hold makes no call', async () => {
  const { fake, payments, contract } = await setup(ready, [TWO[0] as NewMilestone]);
  await payments.release(contract.id, 'm1', tapFor(payments, contract.id, 'm1'));
  await payments.reauthorizeHold(contract.id);
  assert.equal(fake.calls.filter((call) => call.path.endsWith('/reauthorize')).length, 0);
});

test('the source has exactly one capture call, and it is inside release()', () => {
  const root = fileURLToPath(new URL('../src', import.meta.url));
  const callers = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .flatMap((file) => {
      const source = readFileSync(join(root, file), 'utf8');
      return (source.match(/\.capture\(/g) ?? []).map(() => file);
    });
  assert.deepEqual(callers, ['payments/service.ts']);
  const service = readFileSync(join(root, 'payments/service.ts'), 'utf8');
  const start = service.indexOf('async release(');
  const end = service.indexOf('async voidHold(');
  const at = service.indexOf('.capture(');
  assert.ok(start < at && at < end);
  // The verdict and the tap must both be checked before the capture call.
  assert.ok(start < service.indexOf('verdict.status !== \'RELEASE_READY\'', start));
  assert.ok(service.indexOf('verdict.status !== \'RELEASE_READY\'', start) < service.indexOf('takeTap(tapToken', start));
  assert.ok(service.indexOf('takeTap(tapToken', start) < at);
});
