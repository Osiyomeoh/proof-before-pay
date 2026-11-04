import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { Verdict } from '../src/proof/engine.ts';
import { createPayPalClient } from '../src/paypal/client.ts';
import { createWebhookVerifier } from '../src/paypal/webhook.ts';
import { createPayments } from '../src/payments/service.ts';
import type { Contract, Proof } from '../src/payments/service.ts';
import { createHandler } from '../src/server/http.ts';
import { createFakePayPal } from './helpers/fake-paypal.ts';
import { WEBHOOK_ID, certFetch, makeSigner } from './helpers/signer.ts';

const signer = makeSigner();
const fake = createFakePayPal();
let status: Verdict['status'] = 'HOLD';
const proof: Proof = () => ({ status } as unknown as Verdict);
const payments = createPayments({ paypal: createPayPalClient({ clientId: 'a', clientSecret: 'b', fetch: fake.fetch }), proof });
const verifyWebhook = createWebhookVerifier({ webhookId: WEBHOOK_ID, fetch: certFetch(signer.cert).fetch });
const server = createServer(createHandler({ payments, verifyWebhook }));
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function held(): Promise<Contract> {
  const contract = await payments.startHold({
    description: 'x',
    currency: 'USD',
    milestones: [{ title: 'Producing', amountCents: 10000, unitId: '01', proofDate: '2020-10-07' }],
    returnUrl: 'https://e.com/a',
    cancelUrl: 'https://e.com/b',
  });
  await payments.completeHold(contract.id);
  return contract;
}

const post = (path: string, body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
  fetch(`${base}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('a client claiming RELEASE_READY, a smaller amount and another authorization changes nothing', async () => {
  status = 'HOLD';
  const contract = await held();
  const before = fake.captures().length;
  const forged = { tap: 'x', verdict: { status: 'RELEASE_READY' }, status: 'RELEASE_READY', amount: '1.00', authorizationId: 'OTHER' };
  const res = await post(`/api/contracts/${contract.id}/milestones/m1/release`, forged);
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { outcome: string }).outcome, 'LOCKED');
  assert.equal(fake.captures().length, before);
});

test('the tap route gives no token while the verdict is HOLD', async () => {
  status = 'HOLD';
  const contract = await held();
  const res = await post(`/api/contracts/${contract.id}/milestones/m1/tap`, {});
  assert.equal(res.status, 409);
  assert.ok(!('token' in ((await res.json()) as object)));
});

test('verdict ready, no tap: 403 and no capture', async () => {
  status = 'RELEASE_READY';
  const contract = await held();
  const before = fake.captures().length;
  const res = await post(`/api/contracts/${contract.id}/milestones/m1/release`, {});
  assert.equal(res.status, 403);
  assert.equal(fake.captures().length, before);
});

test('tap then release captures the server\'s amount against the server\'s authorization', async () => {
  status = 'RELEASE_READY';
  const contract = await held();
  const tap = (await (await post(`/api/contracts/${contract.id}/milestones/m1/tap`, {})).json()) as { token: string };
  const res = await post(`/api/contracts/${contract.id}/milestones/m1/release`, { tap: tap.token, amount: '1.00', authorizationId: 'OTHER' });
  assert.equal(res.status, 200);
  const capture = fake.captures().at(-1);
  assert.equal((capture?.body as { amount: { value: string } }).amount.value, '100.00');
  assert.ok(capture?.path.includes(contract.authorizationId ?? 'missing'));
});

test('a form post cannot reach a money route', async () => {
  status = 'RELEASE_READY';
  const contract = await held();
  const before = fake.captures().length;
  const res = await post(`/api/contracts/${contract.id}/milestones/m1/release`, 'tap=x', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(res.status, 415);
  assert.equal(fake.captures().length, before);
});

test('an oversized body gets a 413', async () => {
  const res = await post('/webhooks/paypal', 'x'.repeat(1024 * 1024 + 1), {});
  assert.equal(res.status, 413);
});

test('webhook over HTTP: odd spacing survives, because the raw bytes are what get checked', async () => {
  status = 'RELEASE_READY';
  const contract = await held();
  const tap = (await (await post(`/api/contracts/${contract.id}/milestones/m1/tap`, {})).json()) as { token: string };
  await post(`/api/contracts/${contract.id}/milestones/m1/release`, { tap: tap.token });
  const captureId = contract.milestones[0]?.captureId;
  const raw = `{  "id" : "WH-HTTP",\n  "event_type":"PAYMENT.CAPTURE.REFUNDED",   "resource":{"id":"${captureId}"}  }`;
  const res = await post('/webhooks/paypal', raw, signer.headers(Buffer.from(raw)));
  assert.equal(res.status, 200);
  assert.equal(contract.milestones[0]?.status, 'REFUNDED');
});

test('webhook over HTTP: a bad signature gets a 401 and changes nothing', async () => {
  status = 'RELEASE_READY';
  const contract = await held();
  const raw = JSON.stringify({ id: 'WH-BAD', event_type: 'PAYMENT.AUTHORIZATION.VOIDED', resource: { id: contract.authorizationId } });
  const res = await post('/webhooks/paypal', raw, signer.headers(Buffer.from(`${raw} `)));
  assert.equal(res.status, 401);
  assert.equal(contract.status, 'HELD');
});

test('webhook over HTTP: with no webhook ID set, events get a 503 and change nothing', async () => {
  const closed = createServer(createHandler({ payments, verifyWebhook: createWebhookVerifier({ webhookId: undefined }) }));
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const contract = await held();
  const raw = JSON.stringify({ id: 'WH-CLOSED', event_type: 'PAYMENT.AUTHORIZATION.VOIDED', resource: { id: contract.authorizationId } });
  const res = await fetch(`http://127.0.0.1:${(closed.address() as AddressInfo).port}/webhooks/paypal`, { method: 'POST', headers: signer.headers(Buffer.from(raw)), body: raw });
  closed.close();
  assert.equal(res.status, 503);
  assert.equal(contract.status, 'HELD');
});

test('unknown contract and route both get a 404', async () => {
  assert.equal((await fetch(`${base}/api/contracts/nope`)).status, 404);
  assert.equal((await post('/api/contracts/nope/milestones/m1/release', {})).status, 404);
  assert.equal((await fetch(`${base}/nothing`)).status, 404);
});
