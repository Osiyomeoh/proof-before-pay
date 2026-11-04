// App routes: pages, hold creation, the PayPal return, the read-only view and the recorded-day clock.
// Nothing here captures. The money routes in http.ts remain the only way to release or void.
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isValidDate } from '../proof/engine.ts';
import type { Fleet, Verdict } from '../proof/engine.ts';
import type { Payments, Proof } from '../payments/service.ts';
import { DEMO_DESCRIPTION, DEMO_MILESTONES, buildView, currentIndex, opensOn } from './demo.ts';
import { readJson, send } from './http.ts';

export type AppExplanation = {
  source: 'model' | 'recorded' | 'template';
  explanation: string;
  installerQuestion: string | null;
  model: string | null;
  templateReason: string | null;
};

export type AppDeps = {
  payments: Payments;
  proof: Proof;
  fleet: Fleet;
  lastDate: string;
  mode: 'sample' | 'sandbox';
  publicUrl: string;
  explain: (verdict: Verdict) => Promise<AppExplanation>;
  now?: () => number;
  maxHoldsPerMinute?: number;
};

const PUBLIC_DIR = new URL('../../public/', import.meta.url);
const FONTS = new URL('../../node_modules/@fontsource/', import.meta.url);

// A fixed list, so a request path never reaches the file system.
const STATIC_FILES: ReadonlyArray<[string, URL, string]> = [
  ['/app.js', new URL('app.js', PUBLIC_DIR), 'text/javascript; charset=utf-8'],
  ['/chart.js', new URL('chart.js', PUBLIC_DIR), 'text/javascript; charset=utf-8'],
  ['/styles.css', new URL('styles.css', PUBLIC_DIR), 'text/css; charset=utf-8'],
  ['/icon.svg', new URL('icon.svg', PUBLIC_DIR), 'image/svg+xml'],
  ['/fonts/sans-400.woff2', new URL('ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2', FONTS), 'font/woff2'],
  ['/fonts/sans-600.woff2', new URL('ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2', FONTS), 'font/woff2'],
  ['/fonts/mono-400.woff2', new URL('ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2', FONTS), 'font/woff2'],
  ['/fonts/mono-500.woff2', new URL('ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2', FONTS), 'font/woff2'],
];

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const REPLAY_STATUS: Record<string, number> = { MOVED: 200, NOT_FOUND: 404, NOT_HELD: 409, BUSY: 409, NOT_FORWARD: 409 };

export function createApp(deps: AppDeps) {
  const { payments, proof, fleet, lastDate, mode, publicUrl, explain } = deps;
  const now = deps.now ?? Date.now;
  const maxHolds = deps.maxHoldsPerMinute ?? 20;
  const files = new Map(STATIC_FILES.map(([path, file, type]) => [path, { body: readFileSync(file), type }]));
  const page = readFileSync(new URL('index.html', PUBLIC_DIR));
  let holdsInMinute: { minute: number; count: number } = { minute: 0, count: 0 };

  function servePage(res: ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(page);
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

  return async function route(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (req.method === 'GET') {
      if (path === '/' || /^\/c\/[^/]+$/.test(path)) {
        servePage(res);
        return true;
      }
      if (path === '/healthz') {
        send(res, 200, { ok: true, mode });
        return true;
      }
      const file = files.get(path);
      if (file !== undefined) {
        res.writeHead(200, { 'Content-Type': file.type, 'X-Content-Type-Options': 'nosniff' });
        res.end(file.body);
        return true;
      }
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
