// App routes: pages, hold creation, the PayPal return, the read-only view and the recorded-day clock.
// Nothing here captures. The money routes in http.ts remain the only way to release or void.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { acceptsBrotli, brotli } from './compress.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { addDays, isValidDate } from '../proof/engine.ts';
import type { Fleet, Verdict } from '../proof/engine.ts';
import type { LedgerRow } from '../proof/ledger.ts';
import type { Contract, Payments, Proof } from '../payments/service.ts';
import { checkRecord } from '../paypal/order-record.ts';
import type { TimedRecord } from '../paypal/order-record.ts';
import { DEMO_DESCRIPTION, DEMO_MILESTONES, DEMO_UNIT, buildView, currentIndex, opensOn, seenDate } from './demo.ts';
import { readJson, send } from './http.ts';

// Kept here rather than imported, so the server doesn't load the AI module. test/excuse.test.ts checks they match.
export const MAX_REPLY_CHARS = 600;

export type AppExplanation = {
  source: 'model' | 'recorded' | 'template';
  explanation: string;
  installerQuestion: string | null;
  model: string | null;
  templateReason: string | null;
};

// The installer's reply, split into claims and each one tested against measured data. Read-only:
// the answer carries findings, never a verdict, and the hold is taken from the engine as before.
export type ExcuseAnswer = {
  source: 'model' | 'recorded' | 'keywords';
  model: string | null;
  fallbackReason: string | null;
  claims: ReadonlyArray<{ kind: string; quote: string; finding: string; sentence: string; dates: readonly string[] }>;
};

export type AppDeps = {
  payments: Payments;
  proof: Proof;
  fleet: Fleet;
  lastDate: string;
  mode: 'sample' | 'sandbox';
  publicUrl: string;
  explain: (verdict: Verdict) => Promise<AppExplanation>;
  ledger: (through: string) => Promise<readonly LedgerRow[]>;
  // PayPal's own record of the order, read with the Agent Toolkit's get_order tool. Read-only.
  orderRecord: (contract: Contract) => Promise<TimedRecord>;
  checkExcuse: (verdict: Verdict, reply: string) => Promise<ExcuseAnswer>;
  maxExcusesPerMinute?: number;
  now?: () => number;
  maxHoldsPerMinute?: number;
};

const PUBLIC_DIR = new URL('../../public/', import.meta.url);
const NODE_MODULES = new URL('../../node_modules/', import.meta.url);
const FONTS = new URL('@fontsource/', NODE_MODULES);

// A fixed list, so a request path never reaches the file system.
const STATIC_FILES: ReadonlyArray<[string, URL, string]> = [
  ['/app.js', new URL('app.js', PUBLIC_DIR), 'text/javascript; charset=utf-8'],
  ['/chart.js', new URL('chart.js', PUBLIC_DIR), 'text/javascript; charset=utf-8'],
  ['/dom.js', new URL('dom.js', PUBLIC_DIR), 'text/javascript; charset=utf-8'],
  ['/ledger.js', new URL('ledger.js', PUBLIC_DIR), 'text/javascript; charset=utf-8'],
  // The self-contained browser build. The ESM build imports "ag-stack" by bare name, which a browser can't resolve.
  // The noStyle build, because the full one adds legacy-theme <style> tags on load, before a nonce can be set.
  ['/vendor/ag-grid.min.js', new URL('ag-grid-community/dist/ag-grid-community.min.noStyle.js', NODE_MODULES), 'text/javascript; charset=utf-8'],
  ['/styles.css', new URL('styles.css', PUBLIC_DIR), 'text/css; charset=utf-8'],
  ['/icon.svg', new URL('icon.svg', PUBLIC_DIR), 'image/svg+xml'],
  ['/fonts/sans-400.woff2', new URL('ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2', FONTS), 'font/woff2'],
  ['/fonts/sans-600.woff2', new URL('ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2', FONTS), 'font/woff2'],
  ['/fonts/mono-400.woff2', new URL('ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2', FONTS), 'font/woff2'],
  ['/fonts/mono-500.woff2', new URL('ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2', FONTS), 'font/woff2'],
];

type StaticFile = { body: Buffer; type: string; br: Buffer | undefined };

// Quality 9: the grid bundle takes 175 ms and 345 KB here. Quality 11 saves 30 KB more and takes 5.9 s, too slow to start on 0.25 vCPU.
// woff2 is already compressed.
const FILES = new Map(STATIC_FILES.map(([path, file, type]): [string, StaticFile] => {
  const body = readFileSync(file);
  return [path, { body, type, br: type.startsWith('font/') ? undefined : brotli(body, 9) }];
}));

// AG Grid adds its styles at runtime and draws icons from data: URLs: https://www.ag-grid.com/javascript-data-grid/security/
const contentPolicy = (nonce: string) =>
  `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

const REPLAY_STATUS: Record<string, number> = { MOVED: 200, NOT_FOUND: 404, NOT_HELD: 409, BUSY: 409, NOT_FORWARD: 409 };

export function createApp(deps: AppDeps) {
  const { payments, proof, fleet, lastDate, mode, publicUrl, explain } = deps;
  const now = deps.now ?? Date.now;
  const maxHolds = deps.maxHoldsPerMinute ?? 20;
  const page = readFileSync(new URL('index.html', PUBLIC_DIR), 'utf8');
  let holdsInMinute: { minute: number; count: number } = { minute: 0, count: 0 };
  const maxExcuses = deps.maxExcusesPerMinute ?? 20;
  let excusesInMinute: { minute: number; count: number } = { minute: 0, count: 0 };

  function servePage(res: ServerResponse) {
    const nonce = randomBytes(16).toString('base64url');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': contentPolicy(nonce), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(page.replace('__STYLE_NONCE__', nonce));
  }

  function redirect(res: ServerResponse, location: string) {
    res.writeHead(303, { Location: location });
    res.end();
  }

  // Each new hold calls PayPal, so a public demo needs a ceiling.
  function underHoldLimit(): boolean {
    const minute = Math.floor(now() / 60_000);
    if (holdsInMinute.minute !== minute) holdsInMinute = { minute, count: 0 };
    holdsInMinute.count += 1;
    return holdsInMinute.count <= maxHolds;
  }

  // Each reply may cost a model call, so the excuse check has its own ceiling.
  function underExcuseLimit(): boolean {
    const minute = Math.floor(now() / 60_000);
    if (excusesInMinute.minute !== minute) excusesInMinute = { minute, count: 0 };
    excusesInMinute.count += 1;
    return excusesInMinute.count <= maxExcuses;
  }

  return async function route(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    // Node leaves the body out of a HEAD response. The PayPal return below stays GET only, because it places a hold.
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (path === '/' || path === '/judge' || /^\/c\/[^/]+$/.test(path)) {
        servePage(res);
        return true;
      }
      if (path === '/healthz') {
        send(res, 200, { ok: true, mode });
        return true;
      }
      const file = FILES.get(path);
      if (file !== undefined) {
        const cache = path.startsWith('/vendor/') || path.startsWith('/fonts/') ? { 'Cache-Control': 'public, max-age=86400' } : {};
        const br = acceptsBrotli(req.headers['accept-encoding']) ? file.br : undefined;
        const encoding = { ...(file.br === undefined ? {} : { Vary: 'Accept-Encoding' }), ...(br === undefined ? {} : { 'Content-Encoding': 'br' }) };
        res.writeHead(200, { 'Content-Type': file.type, 'X-Content-Type-Options': 'nosniff', ...cache, ...encoding });
        res.end(br ?? file.body);
        return true;
      }
    }

    if (req.method === 'GET') {
      if (path === '/paypal/return' || path === '/paypal/cancel') {
        const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('contract') ?? '';
        if (payments.get(id) === null) {
          redirect(res, '/');
          return true;
        }
        const target = `/c/${encodeURIComponent(id)}`;
        if (path === '/paypal/cancel') {
          redirect(res, `${target}?hold=cancelled`);
          return true;
        }
        try {
          await payments.completeHold(id);
          redirect(res, target);
        } catch (error) {
          console.error('hold failed:', error instanceof Error ? error.message : 'unknown error');
          redirect(res, `${target}?hold=failed`);
        }
        return true;
      }
    }

    if (req.method === 'POST' && path === '/api/contracts') {
      if ((await readJson(req)) === null) {
        send(res, 415, { error: 'JSON_REQUIRED' });
        return true;
      }
      if (!underHoldLimit()) {
        send(res, 429, { error: 'TOO_MANY_HOLDS' });
        return true;
      }
      // The contract is fixed on the server. Nothing in the request sets an amount.
      const id = crypto.randomUUID();
      const contract = await payments.startHold({
        description: DEMO_DESCRIPTION,
        currency: 'USD',
        milestones: [...DEMO_MILESTONES],
        returnUrl: `${publicUrl}/paypal/return?contract=${id}`,
        cancelUrl: `${publicUrl}/paypal/cancel?contract=${id}`,
        contractId: id,
      });
      // Sample mode has no buyer approval step, because no PayPal account is involved.
      if (mode === 'sample') await payments.completeHold(contract.id);
      send(res, 201, { id: contract.id, approveUrl: contract.approveUrl });
      return true;
    }

    const viewMatch = path.match(/^\/api\/contracts\/([^/]+)\/(view|explanation)$/);
    if (req.method === 'GET' && viewMatch?.[1] !== undefined) {
      const contract = payments.get(viewMatch[1]);
      if (contract === null) {
        send(res, 404, { error: 'NOT_FOUND' });
        return true;
      }
      const view = buildView(contract, proof, fleet, mode, lastDate);
      if (viewMatch[2] === 'view') {
        send(res, 200, view);
        return true;
      }
      const verdict = view.milestones.find((m) => m.isCurrent)?.verdict ?? null;
      send(res, 200, verdict === null ? { explanation: null } : await explain(verdict));
      return true;
    }

    const excuseMatch = path.match(/^\/api\/contracts\/([^/]+)\/excuse$/);
    if (req.method === 'POST' && excuseMatch?.[1] !== undefined) {
      const body = await readJson(req);
      if (body === null) {
        send(res, 415, { error: 'JSON_REQUIRED' });
        return true;
      }
      const contract = payments.get(excuseMatch[1]);
      if (contract === null) {
        send(res, 404, { error: 'NOT_FOUND' });
        return true;
      }
      const reply = body['reply'];
      if (typeof reply !== 'string' || reply.trim() === '' || reply.length > MAX_REPLY_CHARS) {
        send(res, 400, { error: 'BAD_REPLY', maxChars: MAX_REPLY_CHARS });
        return true;
      }
      const verdict = buildView(contract, proof, fleet, mode, lastDate).milestones.find((m) => m.isCurrent)?.verdict ?? null;
      if (verdict === null || verdict.status !== 'HOLD') {
        send(res, 409, { error: 'NOT_ON_HOLD' });
        return true;
      }
      if (!underExcuseLimit()) {
        send(res, 429, { error: 'TOO_MANY_REPLIES' });
        return true;
      }
      send(res, 200, { date: verdict.date, ...(await deps.checkExcuse(verdict, reply.trim())) });
      return true;
    }

    const ledgerMatch = path.match(/^\/api\/contracts\/([^/]+)\/ledger$/);
    if (req.method === 'GET' && ledgerMatch?.[1] !== undefined) {
      const contract = payments.get(ledgerMatch[1]);
      if (contract === null) {
        send(res, 404, { error: 'NOT_FOUND' });
        return true;
      }
      const through = seenDate(contract);
      send(res, 200, { unit: DEMO_UNIT, through, judgedFrom: addDays(through, -6), rows: await deps.ledger(through) });
      return true;
    }

    const recordMatch = path.match(/^\/api\/contracts\/([^/]+)\/paypal-record$/);
    if (req.method === 'GET' && recordMatch?.[1] !== undefined) {
      const contract = payments.get(recordMatch[1]);
      if (contract === null) {
        send(res, 404, { error: 'NOT_FOUND' });
        return true;
      }
      // Until the buyer approves there is no hold to compare.
      if (contract.authorizationId === null) {
        send(res, 200, { record: null, check: null, readAt: null });
        return true;
      }
      try {
        const { record, readAt } = await deps.orderRecord(contract);
        send(res, 200, { record, check: checkRecord(record, contract), readAt });
      } catch (error) {
        console.error('PayPal record read failed:', error instanceof Error ? error.message.slice(0, 200) : 'unknown error');
        send(res, 503, { error: 'PAYPAL_UNAVAILABLE' });
      }
      return true;
    }

    const replay = path.match(/^\/api\/contracts\/([^/]+)\/replay$/);
    if (req.method === 'POST' && replay?.[1] !== undefined) {
      const body = await readJson(req);
      if (body === null) {
        send(res, 415, { error: 'JSON_REQUIRED' });
        return true;
      }
      const contract = payments.get(replay[1]);
      if (contract === null) {
        send(res, 404, { error: 'NOT_FOUND' });
        return true;
      }
      const to = body['to'];
      if (typeof to !== 'string' || !isValidDate(to) || to > lastDate) {
        send(res, 400, { error: 'BAD_DATE' });
        return true;
      }
      const index = currentIndex(contract);
      const milestone = contract.milestones[index];
      if (milestone === undefined) {
        send(res, 409, { error: 'ALL_RELEASED' });
        return true;
      }
      // A date before this milestone opens moves to its first open date.
      const opens = opensOn(contract, index);
      const date = opens !== null && to < opens ? opens : to;
      const moved = payments.moveProofDate(contract.id, milestone.id, date);
      send(res, REPLAY_STATUS[moved.outcome] ?? 500, moved);
      return true;
    }

    return false;
  };
}
