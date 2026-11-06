// HTTP routes for money and webhooks. App pages and hold creation live in app.ts.
// The webhook route reads raw bytes and verifies them before parsing anything.
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { Payments } from '../payments/service.ts';
import type { WebhookCheck, WebhookHeaders } from '../paypal/webhook.ts';
import { acceptsBrotli, brotli } from './compress.ts';

const MAX_BODY_BYTES = 1024 * 1024;

export type ServerDeps = {
  payments: Payments;
  verifyWebhook: (headers: WebhookHeaders, rawBody: Buffer) => Promise<WebhookCheck>;
  // Returns true when it handled the request.
  app?: (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean>;
};

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = chunk as Buffer;
    size += part.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

const COMPRESS_FROM_BYTES = 1024;

export function send(res: ServerResponse, status: number, body: unknown) {
  const json = Buffer.from(JSON.stringify(body));
  if (json.length < COMPRESS_FROM_BYTES) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(json);
    return;
  }
  // Quality 5: this runs on the request path, and the ledger reply goes from 118 KB to 11 KB.
  const br = acceptsBrotli(res.req.headers['accept-encoding']) ? brotli(json, 5) : undefined;
  res.writeHead(status, { 'Content-Type': 'application/json', Vary: 'Accept-Encoding', ...(br === undefined ? {} : { 'Content-Encoding': 'br' }) });
  res.end(br ?? json);
}

// Requiring JSON blocks a plain cross-site form post from reaching a money route.
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return null;
  try {
    const parsed: unknown = JSON.parse((await readBody(req)).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch (error) {
    if (error instanceof BodyTooLarge) throw error;
    return null;
  }
}

const RELEASE_STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  NOT_HELD: 409,
  ALREADY_RELEASED: 200,
  IN_PROGRESS: 409,
  LOCKED: 409,
  TAP_REQUIRED: 403,
  CAPTURED: 200,
  PENDING: 202,
  DECLINED: 402,
  REJECTED: 502,
  UNKNOWN: 504,
};

const VOID_STATUS: Record<string, number> = { NOT_FOUND: 404, NOT_HELD: 409, TAP_REQUIRED: 403, VOIDED: 200, REJECTED: 502, UNKNOWN: 504 };

export function createHandler(deps: ServerDeps): RequestListener {
  const { payments, verifyWebhook } = deps;

  async function route(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (req.method === 'POST' && path === '/webhooks/paypal') {
      const raw = await readBody(req);
      const check = await verifyWebhook(req.headers, raw);
      if (!check.ok) return send(res, check.reason === 'NOT_CONFIGURED' ? 503 : 401, { error: check.reason });
      let event: unknown;
      try {
        event = JSON.parse(raw.toString('utf8'));
      } catch {
        return send(res, 400, { error: 'BAD_JSON' });
      }
      return send(res, 200, payments.applyWebhook(event));
    }

    const contract = path.match(/^\/api\/contracts\/([^/]+)$/);
    if (req.method === 'GET' && contract?.[1] !== undefined) {
      const found = payments.get(contract[1]);
      return found === null ? send(res, 404, { error: 'NOT_FOUND' }) : send(res, 200, found);
    }

    const milestone = path.match(/^\/api\/contracts\/([^/]+)\/milestones\/([^/]+)\/(tap|release)$/);
    if (req.method === 'POST' && milestone?.[1] !== undefined && milestone[2] !== undefined) {
      const body = await readJson(req);
      if (body === null) return send(res, 415, { error: 'JSON_REQUIRED' });
      if (milestone[3] === 'tap') {
        const tap = payments.prepareRelease(milestone[1], milestone[2]);
        return send(res, tap.outcome === 'READY' ? 200 : tap.outcome === 'LOCKED' ? 409 : 404, tap);
      }
      // Only the tap token is read from the body. A verdict or amount sent by the client is ignored.
      const result = await payments.release(milestone[1], milestone[2], body['tap']);
      return send(res, RELEASE_STATUS[result.outcome] ?? 500, result);
    }

    const voiding = path.match(/^\/api\/contracts\/([^/]+)\/void(\/tap)?$/);
    if (req.method === 'POST' && voiding?.[1] !== undefined) {
      const body = await readJson(req);
      if (body === null) return send(res, 415, { error: 'JSON_REQUIRED' });
      if (voiding[2] !== undefined) {
        const token = payments.prepareVoid(voiding[1]);
        return token === null ? send(res, 404, { error: 'NOT_FOUND' }) : send(res, 200, { token });
      }
      const result = await payments.voidHold(voiding[1], body['tap']);
      return send(res, VOID_STATUS[result.outcome] ?? 500, result);
    }

    if (deps.app !== undefined && (await deps.app(req, res, path))) return;
    return send(res, 404, { error: 'NOT_FOUND' });
  }

  return (req, res) => {
    route(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.destroy();
      if (error instanceof BodyTooLarge) return send(res, 413, { error: 'BODY_TOO_LARGE' });
      // The details stay in the server log, so nothing internal reaches the client.
      console.error('request failed:', error instanceof Error ? error.message : 'unknown error');
      return send(res, 500, { error: 'INTERNAL' });
    });
  };
}
