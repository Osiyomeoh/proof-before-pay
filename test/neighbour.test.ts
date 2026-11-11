// The neighbour contract: four weekly bills from inverter 01's real 2020 readings, a $0 week that
// never reaches PayPal, captures that are never final, and the unused hold voided at the end.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createAgent } from '../src/ai/agent.ts';
import { createRecordedExplainer } from '../src/ai/recorded.ts';
import { createExcuseChecker, createRecordedSplitter } from '../src/ai/excuse.ts';
import { loadMauiLogger } from '../src/proof/claims.ts';
import { addDays, judge } from '../src/proof/engine.ts';
import type { Fleet } from '../src/proof/engine.ts';
import { forgeryTest } from '../src/proof/forgery.ts';
import { MAUI_INVERTERS, commonDates, loadMauiFleet } from '../src/proof/maui.ts';
import { billCents, readMeter } from '../src/proof/meter.ts';
import { createPayPalClient } from '../src/paypal/client.ts';
import type { CaptureInput, PayPalClient } from '../src/paypal/client.ts';
import { recordedOrder } from '../src/paypal/order-record.ts';
import { createRecordedPayPal } from '../src/paypal/recorded.ts';
import { createPayments, remainingCents } from '../src/payments/service.ts';
import type { Meter, NewMilestone } from '../src/payments/service.ts';
import { createApp } from '../src/server/app.ts';
import { createHandler } from '../src/server/http.ts';
import { NEIGHBOUR_MILESTONES, NEIGHBOUR_START, WEEK_CAP_KWH } from '../src/server/neighbour.ts';
import type { NeighbourView } from '../src/server/neighbour.ts';
import { createFakePayPal } from './helpers/fake-paypal.ts';

const fleet = loadMauiFleet();
const lastDate = commonDates(fleet).at(-1) as string;
const proof = (unitId: string, date: string) => judge(fleet, unitId, date);
const meterOf = (f: Fleet): Meter => (unitId, from, through) => readMeter(f, unitId, from, through).tenths;
const meter = meterOf(fleet);

// Worked out from the dataset by readMeter: each day floored to a tenth of a kWh, at $0.10 a kWh.
const WEEK_CENTS = [2247, 861, 0, 974];

const week = (i: number): NewMilestone => {
  const m = NEIGHBOUR_MILESTONES[i];
  assert.ok(m !== undefined);
  return m;
};

async function setup(milestones: readonly NewMilestone[] = NEIGHBOUR_MILESTONES, m: Meter = meter) {
  const fake = createFakePayPal();
  const paypal = createPayPalClient({ clientId: 'a', clientSecret: 'b', fetch: fake.fetch });
  const payments = createPayments({ paypal, proof, meter: m });
  const contract = await payments.startHold({
    description: 'Neighbour',
    currency: 'USD',
    milestones: [...milestones],
    returnUrl: 'https://example.com/ok',
    cancelUrl: 'https://example.com/no',
  });
  await payments.completeHold(contract.id);
  return { fake, payments, contract };
}

type Setup = Awaited<ReturnType<typeof setup>>;

// Feeds a week its last recorded day, then taps and releases it.
async function closeWeek({ payments, contract }: Setup, milestoneId: string) {
  const milestone = contract.milestones.find((m) => m.id === milestoneId);
  assert.ok(milestone?.metering);
  if (milestone.proofDate < milestone.metering.through) {
    assert.equal(payments.moveProofDate(contract.id, milestoneId, milestone.metering.through).outcome, 'MOVED');
  }
  const tap = payments.prepareRelease(contract.id, milestoneId);
  assert.equal(tap.outcome, 'READY');
  return payments.release(contract.id, milestoneId, tap.outcome === 'READY' ? tap.token : '');
}

const types = (s: Setup) => s.contract.timeline.map((e) => e.type);

test('the four weeks bill exactly what inverter 01 recorded, with no day missing', () => {
  assert.equal(NEIGHBOUR_MILESTONES.length, 4);
  NEIGHBOUR_MILESTONES.forEach((m, i) => {
    assert.ok(m.metering);
    assert.equal(m.metering.from, addDays(NEIGHBOUR_START, 7 * i));
    const reading = readMeter(fleet, m.unitId, m.metering.from, m.metering.through);
    assert.equal(reading.days.length, 7);
    assert.equal(reading.missingDays, 0);
    assert.equal(billCents(reading.tenths, m.metering.priceCentsPerKwh, m.metering.capCents), WEEK_CENTS[i]);
  });
  // The four weeks fit inside PayPal's 29-day authorization.
  const lastDay = week(3).metering?.through ?? '';
  assert.equal((Date.parse(lastDay) - Date.parse(NEIGHBOUR_START)) / 86_400_000 + 1, 28);
});

// The landing page shows the four bills before any hold exists, so its numbers are written into the
// page. This keeps them equal to what the meter reads.
test('the landing page shows the same four bills the meter works out', () => {
  const code = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  let captured = 0;
  NEIGHBOUR_MILESTONES.forEach((m, i) => {
    assert.ok(m.metering);
    const { tenths } = readMeter(fleet, m.unitId, m.metering.from, m.metering.through);
    const cents = billCents(tenths, m.metering.priceCentsPerKwh, m.metering.capCents);
    captured += cents;
    assert.ok(code.includes(`['Week ${i + 1}', '${(tenths / 10).toFixed(1)} kWh', '${usd(cents)}']`), `Week ${i + 1} row`);
  });
  const total = NEIGHBOUR_MILESTONES.reduce((sum, m) => sum + m.amountCents, 0);
  assert.ok(code.includes(`'Captured ${usd(captured)}'`));
  assert.ok(code.includes(`'Back to the buyer ${usd(total - captured)}'`));
  assert.ok(code.includes(`'Hold ${usd(total)} for four weeks of power'`));
});

test('the weekly cap is above every full week inverter 01 made in 2020 before the window', () => {
  const weeks: number[] = [];
  for (let from = '2020-01-06'; from < NEIGHBOUR_START; from = addDays(from, 7)) {
    const reading = readMeter(fleet, '01', from, addDays(from, 6));
    if (reading.missingDays === 0) weeks.push(reading.tenths);
  }
  assert.equal(weeks.length, 38);
  assert.equal(Math.max(...weeks), 2896); // 289.6 kWh, the week of Apr 27
  assert.ok(Math.max(...weeks) < WEEK_CAP_KWH * 10);
});

test('the meter floors each day to a tenth, counts a missing day as zero and never bills above the cap', () => {
  const f: Fleet = { '01': { '2020-01-01': { kwh: 1.29, sun: null }, '2020-01-02': { kwh: 22.0, sun: null }, '2020-01-04': { kwh: Number.NaN, sun: null } } };
  const reading = readMeter(f, '01', '2020-01-01', '2020-01-04');
  assert.deepEqual(reading.days.map((d) => d.tenths), [12, 220, null, null]);
  assert.equal(reading.tenths, 232);
  assert.equal(reading.missingDays, 2);
  assert.equal(billCents(232, 10, 3000), 232);
  assert.equal(billCents(5, 15, 3000), 7); // 0.5 kWh at 15c is 7.5c, rounded down
  assert.equal(billCents(99_999, 10, 3000), 3000);
});

test('a metered contract is refused unless every week is metered, a meter exists and the terms add up', async () => {
  const paypal = createRecordedPayPal();
  const input = (milestones: NewMilestone[]) => ({ description: 'x', currency: 'USD', milestones, returnUrl: 'https://e.com/a', cancelUrl: 'https://e.com/b' });
  const withMeter = createPayments({ paypal, proof, meter });
  const fixed: NewMilestone = { title: 'Fixed', amountCents: 3000, unitId: '01', proofDate: '2020-10-01' };
  await assert.rejects(withMeter.startHold(input([week(0), fixed])), RangeError);
  await assert.rejects(createPayments({ paypal, proof }).startHold(input([week(0)])), RangeError);
  const w = week(0);
  assert.ok(w.metering);
  await assert.rejects(withMeter.startHold(input([{ ...w, amountCents: 1 }])), RangeError);
  await assert.rejects(withMeter.startHold(input([{ ...w, proofDate: w.metering.from }])), RangeError);
  await assert.rejects(withMeter.startHold(input([{ ...w, metering: { ...w.metering, priceCentsPerKwh: 0.5 } }])), RangeError);
  await assert.rejects(withMeter.startHold(input([{ ...w, metering: { ...w.metering, through: '2020-09-01' } }])), RangeError);
});

test('an open week stays locked, and its clock stops at the week’s last day', async () => {
  const s = await setup();
  assert.equal(s.payments.prepareRelease(s.contract.id, 'm1').outcome, 'LOCKED');
  assert.equal(s.payments.moveProofDate(s.contract.id, 'm1', '2020-10-02').outcome, 'MOVED');
  assert.equal(s.payments.prepareRelease(s.contract.id, 'm1').outcome, 'LOCKED');
  // Even a valid token from another week can't release an open one.
  const released = await s.payments.release(s.contract.id, 'm1', 'not-a-token');
  assert.equal(released.outcome, 'LOCKED');
  assert.ok(types(s).includes('RELEASE_REFUSED_OPEN_WEEK'));
  assert.equal(s.payments.moveProofDate(s.contract.id, 'm1', '2020-10-05').outcome, 'PAST_WEEK');
  assert.equal(s.fake.captures().length, 0);
});

test('four weeks capture $22.47, $8.61, nothing, $9.74, none final, and the rest of the hold goes back', async () => {
  const s = await setup();
  const outcomes = [];
  for (const id of ['m1', 'm2', 'm3', 'm4']) outcomes.push((await closeWeek(s, id)).outcome);
  assert.deepEqual(outcomes, ['CAPTURED', 'CAPTURED', 'NOTHING_DUE', 'CAPTURED']);

  const bodies = s.fake.captures().map((c) => c.body as { amount: { value: string }; final_capture: boolean });
  assert.deepEqual(bodies.map((b) => b.amount.value), ['22.47', '8.61', '9.74']);
  assert.ok(bodies.every((b) => b.final_capture === false));
  assert.deepEqual(s.contract.milestones.map((m) => m.amountCents), WEEK_CENTS);
  assert.equal(s.contract.milestones[2]?.status, 'NOTHING_DUE');
  assert.equal(s.contract.milestones[2]?.captureId, null);

  // One void, after the last capture.
  const voids = s.fake.calls.filter((c) => c.path.endsWith('/void'));
  assert.equal(voids.length, 1);
  assert.ok(s.fake.calls.indexOf(voids[0] as (typeof voids)[number]) > s.fake.calls.indexOf(s.fake.captures().at(-1) as (typeof voids)[number]));
  assert.equal(s.contract.status, 'VOIDED');
  assert.equal(remainingCents(s.contract), 12000 - 4082);
  assert.ok(types(s).includes('HUMAN_CLOSED_EMPTY_WEEK'));
  assert.equal(types(s).at(-1), 'REST_RETURNED');

  // PayPal's record, in sample mode, agrees.
  const record = recordedOrder(s.contract);
  assert.equal(record.authorizations[0]?.status, 'VOIDED');
  assert.deepEqual(record.captures.map((c) => [c.amount?.value, c.finalCapture]), [['22.47', false], ['8.61', false], ['9.74', false]]);
});

test('a $0 last week still returns the rest of the hold, with no capture for it', async () => {
  const s = await setup([week(0), week(2)]);
  assert.equal((await closeWeek(s, 'm1')).outcome, 'CAPTURED');
  assert.equal((await closeWeek(s, 'm2')).outcome, 'NOTHING_DUE');
  assert.equal(s.fake.captures().length, 1);
  assert.equal(s.contract.status, 'VOIDED');
  assert.equal(remainingCents(s.contract), 6000 - 2247);
});

test('a week billed at the cap uses the whole hold, so the contract closes with nothing to void', async () => {
  const days: Record<string, { kwh: number; sun: null }> = {};
  for (let i = 0; i < 7; i++) days[addDays(NEIGHBOUR_START, i)] = { kwh: 50, sun: null };
  const s = await setup([week(0)], meterOf({ '01': days }));
  assert.equal((await closeWeek(s, 'm1')).outcome, 'CAPTURED');
  assert.equal(s.contract.milestones[0]?.billedTenths, 3500);
  assert.equal(s.contract.milestones[0]?.amountCents, 3000);
  assert.equal(s.contract.status, 'CLOSED');
  assert.equal(s.fake.calls.filter((c) => c.path.endsWith('/void')).length, 0);
});

test('if PayPal refuses the final void, the hold stays open and can still be given back', async () => {
  const s = await setup([week(0)]);
  s.fake.override((call) => (call.path.endsWith('/void') ? { status: 500, body: { name: 'INTERNAL_SERVER_ERROR' } } : null));
  assert.equal((await closeWeek(s, 'm1')).outcome, 'CAPTURED');
  assert.equal(s.contract.status, 'HELD');
  assert.equal(types(s).at(-1), 'REST_NOT_RETURNED');
  s.fake.clearOverride();
  const token = s.payments.prepareVoid(s.contract.id);
  assert.equal((await s.payments.voidHold(s.contract.id, token)).outcome, 'VOIDED');
  assert.equal(s.contract.status, 'VOIDED');
});

test('a declined week is billed again from the same readings, never from the request', async () => {
  const s = await setup([week(0)]);
  s.fake.override((call) => (call.path.endsWith('/capture') ? { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] } } : null));
  assert.equal((await closeWeek(s, 'm1')).outcome, 'REJECTED');
  s.fake.clearOverride();
  assert.equal((await closeWeek(s, 'm1')).outcome, 'CAPTURED');
  assert.deepEqual(s.fake.captures().map((c) => (c.body as { amount: { value: string } }).amount.value), ['22.47', '22.47']);
});

// Over HTTP, the way the page uses it.
const captures: CaptureInput[] = [];
const recorded = createRecordedPayPal();
const counting: PayPalClient = { ...recorded, capture: (input) => (captures.push(input), recorded.capture(input)) };
const payments = createPayments({ paypal: counting, proof, meter });
const logger = loadMauiLogger(MAUI_INVERTERS);
const explainer = createRecordedExplainer();
const app = createApp({
  payments, proof, fleet, lastDate, mode: 'sample', publicUrl: 'http://localhost', maxHoldsPerMinute: 1000,
  explain: (v) => explainer.explain(v),
  ledger: async () => [],
  orderRecord: async (c) => ({ record: recordedOrder(c), readAt: '2026-11-08T00:00:00.000Z' }),
  checkExcuse: createExcuseChecker(createRecordedSplitter([]), fleet, logger),
  forgeCheck: (v) => forgeryTest(v, fleet, logger),
  // A metered week has no verdict, so the agent is never asked. With no model it would only make plain runs.
  agent: createAgent({ create: null, model: '' }),
});
const server = createServer(createHandler({ payments, verifyWebhook: async () => ({ ok: false, reason: 'NOT_CONFIGURED' }), app }));
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const post = (path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const view = async (id: string) => (await (await fetch(`${base}/api/contracts/${id}/view`)).json()) as NeighbourView;
const replay = (id: string, to: string) => post(`/api/contracts/${id}/replay`, { to });

async function neighbourHold(body: Record<string, unknown> = {}): Promise<string> {
  const res = await post('/api/contracts', { kind: 'neighbour', ...body });
  assert.equal(res.status, 201);
  return ((await res.json()) as { id: string }).id;
}

async function releaseWeek(id: string, m: string) {
  const tap = await post(`/api/contracts/${id}/milestones/${m}/tap`);
  assert.equal(tap.status, 200);
  const token = ((await tap.json()) as { token: string }).token;
  const res = await post(`/api/contracts/${id}/milestones/${m}/release`, { tap: token });
  return { status: res.status, outcome: ((await res.json()) as { outcome: string }).outcome };
}

test('only the two fixed contracts can be started, and the request sets no amount', async () => {
  assert.equal((await post('/api/contracts', { kind: 'loan' })).status, 400);
  const id = await neighbourHold({ amountCents: 1, totalCents: 1, priceCentsPerKwh: 1 });
  const v = await view(id);
  assert.equal(v.kind, 'neighbour');
  assert.equal(v.totalCents, 12000);
  assert.equal(v.heldCents, 12000);
  assert.deepEqual(v.terms, { priceCentsPerKwh: 10, capKwh: 300, weeks: 4, start: NEIGHBOUR_START });
  assert.equal(v.weeks.length, 4);
  // Nothing of the first week has been recorded yet.
  assert.equal(v.clock.date, addDays(NEIGHBOUR_START, -1));
  assert.deepEqual(v.weeks.map((w) => w.days.length), [0, 0, 0, 0]);
  assert.deepEqual(v.clock.stops, [{ date: '2020-10-04', label: 'End of week 1' }]);
});

test('the page never sees a day after the newest recorded one, and a week’s clock stops at its end', async () => {
  const id = await neighbourHold();
  assert.equal((await post(`/api/contracts/${id}/milestones/m1/tap`)).status, 409);
  assert.equal((await replay(id, '2020-10-01')).status, 200);
  let v = await view(id);
  assert.equal(v.clock.date, '2020-10-01');
  assert.deepEqual(v.weeks[0]?.days.map((d) => d.date), ['2020-09-28', '2020-09-29', '2020-09-30', '2020-10-01']);
  assert.equal(v.weeks[0]?.tenths, 348 + 346 + 305 + 284);
  assert.equal(v.weeks[0]?.due, false);
  assert.ok(v.history.every((d) => d.date <= '2020-10-01'));
  assert.ok(v.weeks.flatMap((w) => w.days).every((d) => d.date <= '2020-10-01'));

  // A jump past the week lands on its last day.
  assert.equal((await replay(id, '2020-10-20')).status, 200);
  v = await view(id);
  assert.equal(v.clock.date, '2020-10-04');
  assert.equal(v.weeks[0]?.due, true);
  assert.equal(v.weeks[0]?.cents, 2247);
  assert.deepEqual(v.clock.stops, []);
  assert.equal((await replay(id, '2020-10-20')).status, 409);
});

test('the installer-only panels have nothing to say about a neighbour contract', async () => {
  const id = await neighbourHold();
  assert.equal((await fetch(`${base}/api/contracts/${id}/forge`)).status, 409);
  assert.equal((await post(`/api/contracts/${id}/excuse`, { reply: 'It was cloudy' })).status, 409);
  assert.deepEqual(await (await fetch(`${base}/api/contracts/${id}/explanation`)).json(), { explanation: null });
});

test('over HTTP, four weeks capture $40.82 of the $120 hold and return the rest', async () => {
  const id = await neighbourHold();
  const before = captures.length;
  const outcomes = [];
  for (const [m, through] of [['m1', '2020-10-04'], ['m2', '2020-10-11'], ['m3', '2020-10-18'], ['m4', '2020-10-25']] as const) {
    assert.equal((await replay(id, through)).status, 200);
    outcomes.push(await releaseWeek(id, m));
  }
  assert.deepEqual(outcomes.map((o) => o.status), [200, 200, 200, 200]);
  assert.deepEqual(outcomes.map((o) => o.outcome), ['CAPTURED', 'CAPTURED', 'NOTHING_DUE', 'CAPTURED']);
  assert.deepEqual(captures.slice(before).map((c) => [c.amount.value, c.finalCapture]), [['22.47', false], ['8.61', false], ['9.74', false]]);

  const v = await view(id);
  assert.equal(v.status, 'VOIDED');
  assert.equal(v.releasedCents, 4082);
  assert.equal(v.returnedCents, 7918);
  assert.equal(v.heldCents, 0);
  assert.deepEqual(v.weeks.map((w) => [w.status, w.cents]), [['CAPTURED', 2247], ['CAPTURED', 861], ['NOTHING_DUE', 0], ['CAPTURED', 974]]);
  assert.equal(v.timeline.at(-1)?.type, 'REST_RETURNED');
  // A settled week can't be billed twice.
  assert.equal((await releaseWeek(id, 'm4')).outcome, 'ALREADY_RELEASED');
  assert.equal(captures.length, before + 3);
});
