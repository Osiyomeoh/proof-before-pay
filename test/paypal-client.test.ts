import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PayPalError, SANDBOX_API, createPayPalClient } from '../src/paypal/client.ts';
import { createFakePayPal } from './helpers/fake-paypal.ts';

const SECRET = 'client-secret-value';
const make = (fake = createFakePayPal(), now?: () => number) =>
  createPayPalClient({ clientId: 'client-id', clientSecret: SECRET, fetch: fake.fetch, ...(now ? { now } : {}) });

const captureInput = {
  authorizationId: 'AUTH1',
  amount: { currency_code: 'USD', value: '40.00' },
  finalCapture: false,
  invoiceId: 'c1:m1',
  requestId: 'req-1',
};

test('only the sandbox host is reachable, and options have no host setting', async () => {
  const hosts: string[] = [];
  const fake = createFakePayPal();
  const spy = (async (input: string | URL | Request, init?: RequestInit) => {
    hosts.push(new URL(String(input)).origin);
    return fake.fetch(input, init);
  }) as typeof fetch;
  const client = createPayPalClient({ clientId: 'a', clientSecret: 'b', fetch: spy, ...({ baseUrl: 'https://api-m.paypal.com' } as object) });
  await client.getAuthorization('AUTH1');
  assert.deepEqual([...new Set(hosts)], [SANDBOX_API]);
});

test('the token is reused until close to expiry, then refreshed', async () => {
  const fake = createFakePayPal();
  let time = 0;
  const client = make(fake, () => time);
  await client.getAuthorization('A');
  await client.getAuthorization('B');
  assert.equal(fake.tokensIssued(), 1);
  time = 3_600_000 - 59_000; // inside the 60-second margin of a 3,600-second token
  await client.getAuthorization('C');
  assert.equal(fake.tokensIssued(), 2);
});

test('a refused token is replaced once and the call retried', async () => {
  const fake = createFakePayPal();
  let refused = false;
  fake.override(() => {
    if (refused) return null;
    refused = true;
    return { status: 401, body: { name: 'AUTHENTICATION_FAILURE' } };
  });
  await make(fake).getAuthorization('A');
  assert.equal(fake.tokensIssued(), 2);
  assert.equal(fake.calls.length, 2);
});

test('capture sends the request ID, amount, final flag and invoice ID', async () => {
  const fake = createFakePayPal();
  const capture = await make(fake).capture(captureInput);
  const [call] = fake.captures();
  assert.equal(call?.path, '/v2/payments/authorizations/AUTH1/capture');
  assert.equal(call?.requestId, 'req-1');
  assert.deepEqual(call?.body, { amount: captureInput.amount, final_capture: false, invoice_id: 'c1:m1' });
  assert.equal(capture.status, 'COMPLETED');
  assert.match(capture.debugId ?? '', /^debug-/);
});

test('reads do not send a PayPal-Request-Id', async () => {
  const fake = createFakePayPal();
  await make(fake).getAuthorization('A');
  assert.equal(fake.calls[0]?.requestId, null);
});

test('IDs are escaped so they cannot change the request path', async () => {
  const fake = createFakePayPal();
  await make(fake).getAuthorization('../../v1/oauth2/token');
  assert.equal(fake.calls[0]?.path, '/v2/payments/authorizations/..%2F..%2Fv1%2Foauth2%2Ftoken');
});

test('a 422 is a definite refusal and keeps PayPal\'s name, issue and debug ID', async () => {
  const fake = createFakePayPal();
  fake.override(() => ({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', message: 'no', details: [{ issue: 'SOME_ISSUE' }] } }));
  await assert.rejects(make(fake).capture(captureInput), (error: unknown) => {
    assert.ok(error instanceof PayPalError);
    assert.equal(error.definite, true);
    assert.equal(error.status, 422);
    assert.match(error.message, /UNPROCESSABLE_ENTITY \/ SOME_ISSUE/);
    assert.match(error.debugId ?? '', /^debug-/);
    return true;
  });
});

for (const status of [408, 409, 429, 500, 503]) {
  test(`a ${status} leaves the outcome unknown`, async () => {
    const fake = createFakePayPal();
    fake.override(() => ({ status }));
    await assert.rejects(make(fake).capture(captureInput), (error: unknown) => error instanceof PayPalError && !error.definite);
  });
}

test('a network failure leaves the outcome unknown', async () => {
  const fake = createFakePayPal();
  fake.override(() => 'NETWORK_ERROR');
  await assert.rejects(make(fake).capture(captureInput), (error: unknown) => error instanceof PayPalError && !error.definite);
});

test('a failed token call is definite, because the capture was never sent', async () => {
  const refused = (async () => new Response('{}', { status: 401 })) as typeof fetch;
  const client = createPayPalClient({ clientId: 'a', clientSecret: SECRET, fetch: refused });
  await assert.rejects(client.capture(captureInput), (error: unknown) => error instanceof PayPalError && error.definite);
});

test('a success reply with no capture ID is unknown, not a success', async () => {
  const fake = createFakePayPal();
  fake.override(() => ({ status: 201, body: { status: 'COMPLETED' } }));
  await assert.rejects(make(fake).capture(captureInput), (error: unknown) => error instanceof PayPalError && !error.definite);
});

test('errors never contain the client secret or the basic auth header', async () => {
  const leaky = (async () => new Response('{"error":"invalid_client"}', { status: 401 })) as typeof fetch;
  const client = createPayPalClient({ clientId: 'client-id', clientSecret: SECRET, fetch: leaky });
  await assert.rejects(client.getAuthorization('A'), (error: unknown) => {
    const seen = `${String(error)} ${JSON.stringify(error)}`;
    assert.ok(!seen.includes(SECRET));
    assert.ok(!seen.includes(Buffer.from(`client-id:${SECRET}`).toString('base64')));
    return true;
  });
});

test('a void with a 204 and no body counts as voided', async () => {
  const fake = createFakePayPal();
  fake.override(() => ({ status: 204 }));
  assert.equal((await make(fake).voidAuthorization('A', 'req')).status, 'VOIDED');
});

test('reauthorize returns the new authorization ID', async () => {
  const fake = createFakePayPal();
  const auth = await make(fake).reauthorize('A', { currency_code: 'USD', value: '60.00' }, 'req');
  assert.match(auth.id, /^REAUTH/);
  assert.equal(auth.expiresAt, '2026-12-10T00:00:00Z');
});

test('create order returns the buyer approval link from the payer-action rel', async () => {
  const order = await make().createAuthorizeOrder({
    amount: { currency_code: 'USD', value: '100.00' },
    description: 'x',
    referenceId: 'r',
    returnUrl: 'https://example.com/a',
    cancelUrl: 'https://example.com/c',
    requestId: 'req',
  });
  assert.equal(order.status, 'PAYER_ACTION_REQUIRED');
  assert.match(order.approveUrl ?? '', /checkoutnow/);
});
