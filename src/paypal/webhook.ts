// Webhook signature check, using PayPal's self-verification method (no API call):
// https://developer.paypal.com/api/rest/webhooks/rest/
// The signed message is `${transmissionId}|${time}|${webhookId}|${crc32 of the raw body}`.
// The body must be the exact bytes received, because re-serialized JSON can change the CRC.
import { X509Certificate, createVerify } from 'node:crypto';
import { crc32 } from 'node:zlib';

export type WebhookHeaders = Record<string, string | string[] | undefined>;
export type WebhookCheck = { ok: true } | { ok: false; reason: WebhookRejection };
export type WebhookRejection =
  | 'NOT_CONFIGURED'
  | 'MISSING_HEADER'
  | 'CERT_URL_NOT_ALLOWED'
  | 'CERT_UNAVAILABLE'
  | 'CERT_NOT_VALID_NOW'
  | 'BAD_SIGNATURE';

export type VerifierOptions = {
  webhookId: string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
};

const CERT_TIMEOUT_MS = 10_000;
const CERT_MAX_BYTES = 64 * 1024;

// Our own precaution, not from the docs: the header tells us where to fetch the key, and an
// attacker controls the headers, so the certificate has to come from PayPal's own hosts over HTTPS.
export function isAllowedCertUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return false;
  return url.hostname === 'paypal.com' || url.hostname.endsWith('.paypal.com');
}

function header(headers: WebhookHeaders, name: string): string | null {
  const value = headers[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

export function createWebhookVerifier(options: VerifierOptions) {
  const send = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const certs = new Map<string, X509Certificate>();

  async function loadCert(url: string): Promise<X509Certificate | null> {
    const cached = certs.get(url);
    if (cached !== undefined) return cached;
    try {
      const res = await send(url, { redirect: 'error', signal: AbortSignal.timeout(CERT_TIMEOUT_MS) });
      if (!res.ok) return null;
      const pem = await res.text();
      if (pem.length > CERT_MAX_BYTES) return null;
      const cert = new X509Certificate(pem);
      certs.set(url, cert);
      return cert;
    } catch {
      return null;
    }
  }

  return async function verify(headers: WebhookHeaders, rawBody: Buffer): Promise<WebhookCheck> {
    const webhookId = options.webhookId;
    if (webhookId === undefined || webhookId === '') return { ok: false, reason: 'NOT_CONFIGURED' };

    const transmissionId = header(headers, 'paypal-transmission-id');
    const transmissionTime = header(headers, 'paypal-transmission-time');
    const signature = header(headers, 'paypal-transmission-sig');
    const certUrl = header(headers, 'paypal-cert-url');
    if (transmissionId === null || transmissionTime === null || signature === null || certUrl === null) {
      return { ok: false, reason: 'MISSING_HEADER' };
    }
    if (!isAllowedCertUrl(certUrl)) return { ok: false, reason: 'CERT_URL_NOT_ALLOWED' };

    const cert = await loadCert(certUrl);
    if (cert === null) return { ok: false, reason: 'CERT_UNAVAILABLE' };
    const time = now();
    if (time < Date.parse(cert.validFrom) || time > Date.parse(cert.validTo)) return { ok: false, reason: 'CERT_NOT_VALID_NOW' };

    const message = `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(rawBody)}`;
    // The algorithm is fixed here, and the sender's paypal-auth-algo header can't change it.
    const verifier = createVerify('SHA256');
    verifier.update(message);
    let valid = false;
    try {
      valid = verifier.verify(cert.publicKey, signature, 'base64');
    } catch {
      valid = false;
    }
    return valid ? { ok: true } : { ok: false, reason: 'BAD_SIGNATURE' };
  };
}
