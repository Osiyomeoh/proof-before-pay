import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebhookVerifier, isAllowedCertUrl } from '../src/paypal/webhook.ts';
import { WEBHOOK_ID, certFetch, makeSigner } from './helpers/signer.ts';

const signer = makeSigner();
const raw = Buffer.from('{ "id":"WH-1",   "event_type":"PAYMENT.CAPTURE.COMPLETED", "resource":{"amount":"40.00"} }');

function setup(webhookId: string | undefined = WEBHOOK_ID, cert = signer.cert) {
  const certs = certFetch(cert);
  return { certs, verify: createWebhookVerifier({ webhookId, fetch: certs.fetch }) };
}

test('a correctly signed body passes', async () => {
  const { verify } = setup();
  assert.deepEqual(await verify(signer.headers(raw), raw), { ok: true });
});

test('one changed byte fails', async () => {
  const { verify } = setup();
  const tampered = Buffer.from(raw.toString().replace('40.00', '90.00'));
  assert.deepEqual(await verify(signer.headers(raw), tampered), { ok: false, reason: 'BAD_SIGNATURE' });
});

test('the same JSON re-serialized fails, so only the raw bytes can verify', async () => {
  const { verify } = setup();
  const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString())));
  assert.notDeepEqual(reserialized, raw);
  assert.deepEqual(await verify(signer.headers(raw), reserialized), { ok: false, reason: 'BAD_SIGNATURE' });
});

test('a signature made for another webhook ID fails', async () => {
  const { verify } = setup();
  assert.deepEqual(await verify(signer.headers(raw, {}, 'other-webhook'), raw), { ok: false, reason: 'BAD_SIGNATURE' });
});

test('a signature from another key fails, even with a certificate from an allowed URL', async () => {
  const other = makeSigner();
  const { verify } = setup();
  assert.deepEqual(await verify(other.headers(raw), raw), { ok: false, reason: 'BAD_SIGNATURE' });
});

test('changing a signed header fails', async () => {
  const { verify } = setup();
  const headers = signer.headers(raw, { 'paypal-transmission-time': '2026-11-05T00:00:00Z' });
  assert.deepEqual(await verify(headers, raw), { ok: false, reason: 'BAD_SIGNATURE' });
});

test('a sender cannot pick a weaker algorithm through the header', async () => {
  const { verify } = setup();
  const headers = signer.headers(raw, { 'paypal-auth-algo': 'none', 'paypal-transmission-sig': 'AAAA' });
  assert.deepEqual(await verify(headers, raw), { ok: false, reason: 'BAD_SIGNATURE' });
});

for (const name of ['paypal-transmission-id', 'paypal-transmission-time', 'paypal-transmission-sig', 'paypal-cert-url']) {
  test(`a missing ${name} header fails`, async () => {
    const { verify } = setup();
    const headers: Record<string, string> = signer.headers(raw);
    delete headers[name];
    assert.deepEqual(await verify(headers, raw), { ok: false, reason: 'MISSING_HEADER' });
  });
}

test('with no webhook ID configured, every event fails', async () => {
  const certs = certFetch(signer.cert);
  const verify = createWebhookVerifier({ webhookId: undefined, fetch: certs.fetch });
  assert.deepEqual(await verify(signer.headers(raw), raw), { ok: false, reason: 'NOT_CONFIGURED' });
  assert.equal(certs.urls.length, 0);
});

for (const url of [
  'https://evil.example.com/cert.pem',
  'https://paypal.com.evil.example.com/cert.pem',
  'https://evilpaypal.com/cert.pem',
  'http://api.sandbox.paypal.com/cert.pem',
  'https://api.paypal.com@evil.example.com/cert.pem',
  'https://api.paypal.com:8443/cert.pem',
  'file:///etc/passwd',
  'not a url',
]) {
  test(`the certificate URL ${url} is refused and never fetched`, async () => {
    const { verify, certs } = setup();
    assert.deepEqual(await verify(signer.headers(raw, { 'paypal-cert-url': url }), raw), { ok: false, reason: 'CERT_URL_NOT_ALLOWED' });
    assert.equal(certs.urls.length, 0);
  });
}

test('PayPal hosts over HTTPS are allowed', () => {
  assert.equal(isAllowedCertUrl('https://api.paypal.com/v1/notifications/certs/CERT-1'), true);
  assert.equal(isAllowedCertUrl('https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1'), true);
});

test('a certificate outside its validity dates fails', async () => {
  const certs = certFetch(signer.cert);
  const later = Date.now() + 30 * 24 * 3600 * 1000;
  const verify = createWebhookVerifier({ webhookId: WEBHOOK_ID, fetch: certs.fetch, now: () => later });
  assert.deepEqual(await verify(signer.headers(raw), raw), { ok: false, reason: 'CERT_NOT_VALID_NOW' });
});

test('an unreadable certificate fails', async () => {
  const { verify } = setup(WEBHOOK_ID, 'not a certificate');
  assert.deepEqual(await verify(signer.headers(raw), raw), { ok: false, reason: 'CERT_UNAVAILABLE' });
});

test('a failed certificate download fails and is not cached', async () => {
  let attempts = 0;
  const flaky = (async () => {
    attempts += 1;
    return attempts === 1 ? new Response('', { status: 500 }) : new Response(signer.cert);
  }) as typeof fetch;
  const verify = createWebhookVerifier({ webhookId: WEBHOOK_ID, fetch: flaky });
  assert.deepEqual(await verify(signer.headers(raw), raw), { ok: false, reason: 'CERT_UNAVAILABLE' });
  assert.deepEqual(await verify(signer.headers(raw), raw), { ok: true });
});

test('the certificate is downloaded once per URL', async () => {
  const { verify, certs } = setup();
  await verify(signer.headers(raw), raw);
  await verify(signer.headers(raw), raw);
  assert.equal(certs.urls.length, 1);
});
