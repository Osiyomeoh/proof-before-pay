// Signs webhook bodies the way PayPal documents it, using a throwaway RSA key and certificate
// generated for each test run, so no private key is ever stored in the repo.
import { execFileSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

export const CERT_URL = 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test';
export const WEBHOOK_ID = 'test-webhook-id';

export function makeSigner(days = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'webhook-cert-'));
  try {
    const keyPath = join(dir, 'key.pem');
    const certPath = join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', String(days), '-subj', '/CN=webhook-test'],
      { stdio: 'ignore' },
    );
    const key = readFileSync(keyPath, 'utf8');
    const cert = readFileSync(certPath, 'utf8');
    return {
      cert,
      headers(raw: Buffer, overrides: Record<string, string> = {}, webhookId = WEBHOOK_ID): Record<string, string> {
        const id = 'transmission-1';
        const time = '2026-11-04T20:00:00Z';
        const sign = createSign('SHA256');
        sign.update(`${id}|${time}|${webhookId}|${crc32(raw)}`);
        return {
          'paypal-transmission-id': id,
          'paypal-transmission-time': time,
          'paypal-transmission-sig': sign.sign(key, 'base64'),
          'paypal-cert-url': CERT_URL,
          'paypal-auth-algo': 'SHA256withRSA',
          ...overrides,
        };
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function certFetch(cert: string) {
  const urls: string[] = [];
  const fetchCert = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(cert, { status: 200 });
  }) as typeof fetch;
  return { fetch: fetchCert, urls };
}
