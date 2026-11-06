// Runs the whole app over real HTTP, on the real Maui data, in sample mode.
// Captures are counted at the PayPal client, so a refused release is proven to make no call.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createRecordedExplainer } from '../src/ai/recorded.ts';
import { createExplainer } from '../src/ai/explain.ts';
import { createPayments } from '../src/payments/service.ts';
import { PayPalError } from '../src/paypal/client.ts';
import type { CaptureInput, PayPalClient } from '../src/paypal/client.ts';
import { createRecordedPayPal } from '../src/paypal/recorded.ts';
import { judge } from '../src/proof/engine.ts';
import { createLedger } from '../src/proof/ledger.ts';
import type { LedgerRow } from '../src/proof/ledger.ts';
import { commonDates, loadMauiFleet } from '../src/proof/maui.ts';
import { createApp } from '../src/server/app.ts';
import type { AppDeps } from '../src/server/app.ts';
import { DEMO_MILESTONES } from '../src/server/demo.ts';
import type { ContractView } from '../src/server/demo.ts';
import { createHandler } from '../src/server/http.ts';

const fleet = loadMauiFleet();
const lastDate = commonDates(fleet).at(-1) as string;
const proof = (unitId: string, date: string) => judge(fleet, unitId, date);
const captures: CaptureInput[] = [];
const ledger = createLedger(fleet, '01', lastDate);

function startServer(paypal: PayPalClient, options: Partial<AppDeps> = {}) {
  const payments = createPayments({ paypal, proof });
  const explainer = createRecordedExplainer();
  const app = createApp({ payments, proof, fleet, lastDate, mode: 'sample', publicUrl: 'http://localhost', explain: (v) => explainer.explain(v), ledger: ledger.through, ...options });
  const server = createServer(createHandler({ payments, verifyWebhook: async () => ({ ok: false, reason: 'NOT_CONFIGURED' }), app }));
  return server;
}

const recorded = createRecordedPayPal();
const counting: PayPalClient = {
  ...recorded,
  capture: (input) => {
    captures.push(input);
    return recorded.capture(input);
  },
};
const server = startServer(counting, { maxHoldsPerMinute: 1000 });
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const post = (path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function newHold(): Promise<string> {
  const res = await post('/api/contracts');
  assert.equal(res.status, 201);
  return ((await res.json()) as { id: string }).id;
}

const view = async (id: string) => (await (await fetch(`${base}/api/contracts/${id}/view`)).json()) as ContractView;
const replay = (id: string, to: string) => post(`/api/contracts/${id}/replay`, { to });
const tap = (id: string, m: string) => post(`/api/contracts/${id}/milestones/${m}/tap`);

async function release(id: string, m: string) {
  const token = ((await (await tap(id, m)).json()) as { token?: string }).token;
  const res = await post(`/api/contracts/${id}/milestones/${m}/release`, { tap: token });
  return { status: res.status, body: (await res.json()) as { outcome: string } };
}

test('a new hold opens on the real outage with Release locked and no capture', async () => {
  const id = await newHold();
  const before = captures.length;
  const v = await view(id);
  assert.equal(v.status, 'HELD');
  assert.equal(v.heldCents, 10000);
  assert.equal(v.releasedCents, 0);
  assert.equal(v.clock.date, '2020-10-12');
  assert.equal(v.milestones[0]?.verdict?.status, 'HOLD');
  assert.ok((v.milestones[0]?.verdict?.reasonText.length ?? 0) > 0);
  assert.equal((await tap(id, 'm1')).status, 409);
  assert.equal(captures.length, before);
});

test('an amount sent when starting a hold is ignored', async () => {
  const res = await post('/api/contracts', { amountCents: 1, milestones: [{ amountCents: 1 }] });
  const { id } = (await res.json()) as { id: string };
  assert.equal((await view(id)).totalCents, 10000);
});

test('every day of the Oct 22-25 recovery stays locked and makes no capture', async () => {
  const id = await newHold();
  const before = captures.length;
  for (const date of ['2020-10-22', '2020-10-23', '2020-10-24', '2020-10-25']) {
    assert.equal((await replay(id, date)).status, 200);
    const v = await view(id);
    assert.equal(v.milestones[0]?.verdict?.status, 'HOLD', date);
    assert.ok((v.history.at(-1)?.kwh ?? 0) > 0, `${date} really has production`);
    assert.equal((await tap(id, 'm1')).status, 409, date);
  }
  assert.equal(captures.length, before);
});

test('the landing page claim holds for inverter 01: one good day passes, then the output goes back to zero', () => {
  const window = judge(fleet, '01', '2020-10-26').window;
  const oct23 = window.find((day) => day.date === '2020-10-23');
  assert.ok((oct23?.ratio ?? 0) >= 0.7, 'a one-good-day rule would pay on Oct 23');
  assert.equal(judge(fleet, '01', '2020-10-23').status, 'HOLD');

  // Nov 5 and 6 have no daily total. Their raw rows show zero peak power (spike/SPIKE-PHYSICS.md).
  const after = commonDates(fleet).filter((date) => date >= '2020-10-26' && date <= '2020-11-12');
  assert.equal(after.length, 16);
  for (const date of after) assert.equal(judge(fleet, '01', date).window.at(-1)?.kwh, 0, date);
});

test('the clock only moves forward, and only to dates in the data', async () => {
  const id = await newHold();
  assert.equal((await replay(id, '2020-11-01')).status, 200);
  assert.equal((await replay(id, '2020-10-20')).status, 409);
  assert.equal((await replay(id, '2020-11-01')).status, 409);
  assert.equal((await replay(id, 'not-a-date')).status, 400);
  assert.equal((await replay(id, '2020-13-40')).status, 400);
  assert.equal((await post(`/api/contracts/${id}/replay`, { to: 20201201 })).status, 400);
  const tooLate = new Date(`${lastDate}T00:00:00Z`);
  tooLate.setUTCDate(tooLate.getUTCDate() + 1);
  assert.equal((await replay(id, tooLate.toISOString().slice(0, 10))).status, 400);
  assert.equal((await view(id)).clock.date, '2020-11-01');
});

test('the view holds no reading from after the day being judged', async () => {
  const id = await newHold();
  const v = await view(id);
  assert.equal(v.history.at(-1)?.date, '2020-10-12');
  assert.ok(v.history.every((day) => day.date <= '2020-10-12'));
  assert.equal(v.history.length, 45);
});

test('a token issued on a ready day is refused once later data puts the verdict back on hold', async () => {
  const id = await newHold();
  await replay(id, '2020-11-19');
  const token = ((await (await tap(id, 'm1')).json()) as { token: string }).token;
  await replay(id, '2021-01-18'); // PEERS_DOWN hold in the real data
  const before = captures.length;
  const res = await post(`/api/contracts/${id}/milestones/m1/release`, { tap: token });
  assert.equal(res.status, 409);
  assert.equal(captures.length, before);
});

test('full story: hold, locked outage, release on Nov 19, second milestone 30 days on, closed', async () => {
  const id = await newHold();
  const before = captures.length;
  assert.equal((await replay(id, '2020-11-18')).status, 200);
  assert.equal((await tap(id, 'm1')).status, 409);
  assert.equal((await replay(id, '2020-11-19')).status, 200);
  assert.equal((await view(id)).milestones[0]?.verdict?.status, 'RELEASE_READY');

  // The data unlocks the button, and still nothing moves without the tap.
  assert.equal(captures.length, before);
  const first = await release(id, 'm1');
  assert.equal(first.body.outcome, 'CAPTURED');
  assert.equal(captures.length, before + 1);
  assert.equal(captures.at(-1)?.amount.value, '40.00');
  assert.equal(captures.at(-1)?.finalCapture, false);

  // The second milestone has no verdict and can't be tapped until it opens.
  const waiting = await view(id);
  assert.equal(waiting.heldCents, 6000);
  assert.equal(waiting.releasedCents, 4000);
  assert.equal(waiting.milestones[1]?.isCurrent, true);
  assert.equal(waiting.milestones[1]?.verdict, null);
  assert.equal(waiting.clock.waitingUntil, '2020-12-19');
  assert.equal((await tap(id, 'm2')).status, 409);

  // A date before it opens moves to the first open date, so a release can't be stacked on the same day.
  assert.equal((await replay(id, '2020-11-20')).status, 200);
  const opened = await view(id);
  assert.equal(opened.milestones[1]?.proofDate, '2020-12-19');
  assert.equal(opened.milestones[1]?.verdict?.status, 'RELEASE_READY');

  const second = await release(id, 'm2');
  assert.equal(second.body.outcome, 'CAPTURED');
  assert.equal(captures.at(-1)?.amount.value, '60.00');
  assert.equal(captures.at(-1)?.finalCapture, true);

  const closed = await view(id);
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.releasedCents, 10000);
  assert.equal(closed.heldCents, 0);
  assert.equal((await replay(id, '2021-02-01')).status, 409);
});

test('giving the rest back after one release returns the remainder and blocks later releases', async () => {
  const id = await newHold();
  await replay(id, '2020-11-19');
  await release(id, 'm1');
  const { token } = (await (await post(`/api/contracts/${id}/void/tap`)).json()) as { token: string };
  assert.equal((await post(`/api/contracts/${id}/void`, { tap: token })).status, 200);
  const v = await view(id);
  assert.equal(v.status, 'VOIDED');
  assert.equal(v.returnedCents, 6000);
  assert.equal(v.releasedCents, 4000);
  assert.equal((await replay(id, '2020-12-19')).status, 409);
  assert.equal((await release(id, 'm2')).body.outcome, 'NOT_HELD');
});

test('explanation for the outage is a saved real answer, labelled as recorded', async () => {
  const id = await newHold();
  const answer = (await (await fetch(`${base}/api/contracts/${id}/explanation`)).json()) as { source: string; model: string; explanation: string };
  assert.equal(answer.source, 'recorded');
  assert.equal(answer.model, 'claude-sonnet-4-6');
  assert.ok(answer.explanation.length > 0);
});

test('a day with no saved answer gets the labelled template, never an empty panel', async () => {
  const id = await newHold();
  await replay(id, '2020-10-14');
  const answer = (await (await fetch(`${base}/api/contracts/${id}/explanation`)).json()) as { source: string; templateReason: string; explanation: string };
  assert.equal(answer.source, 'template');
  assert.equal(answer.templateReason, 'NO_MODEL');
  assert.ok(answer.explanation.length > 0);
});

test('the ledger holds no day after the one being judged, and follows the clock', async () => {
  const id = await newHold();
  type Ledger = { through: string; judgedFrom: string; rows: LedgerRow[] };
  const read = async () => (await (await fetch(`${base}/api/contracts/${id}/ledger`)).json()) as Ledger;

  const first = await read();
  assert.equal(first.through, '2020-10-12');
  assert.equal(first.judgedFrom, '2020-10-06');
  assert.equal(first.rows.at(-1)?.date, '2020-10-12');
  assert.ok(first.rows.every((row) => row.date <= '2020-10-12'));

  await replay(id, '2020-10-23');
  const later = await read();
  assert.equal(later.rows.at(-1)?.date, '2020-10-23');
  assert.deepEqual(later.rows.at(-1)?.status, judge(fleet, '01', '2020-10-23').status);
  assert.equal((await fetch(`${base}/api/contracts/no-such-hold/ledger`)).status, 404);
});

test('each page gets its own style nonce, in the policy and in the page', async () => {
  const nonces = await Promise.all([1, 2].map(async () => {
    const page = await fetch(`${base}/`);
    const policy = page.headers.get('content-security-policy') ?? '';
    const inPolicy = policy.match(/style-src 'self' 'nonce-([A-Za-z0-9_-]+)'/)?.[1];
    const inPage = (await page.text()).match(/name="style-nonce" content="([^"]+)"/)?.[1];
    assert.ok(inPolicy);
    assert.equal(inPage, inPolicy);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    return inPolicy;
  }));
  assert.notEqual(nonces[0], nonces[1]);
});

test('HEAD works on pages and static files, and never reaches the PayPal return', async () => {
  for (const path of ['/', '/healthz', '/app.js', '/vendor/ag-grid.min.js']) {
    const res = await fetch(`${base}${path}`, { method: 'HEAD' });
    assert.equal(res.status, 200, path);
    assert.equal((await res.arrayBuffer()).byteLength, 0, path);
  }
  const id = await newHold();
  assert.equal((await fetch(`${base}/paypal/return?contract=${id}`, { method: 'HEAD', redirect: 'manual' })).status, 404);
});

test('opening the judge page creates nothing, and each press starts a new hold', async () => {
  let orders = 0;
  const watching: PayPalClient = {
    ...recorded,
    createAuthorizeOrder: (input) => {
      orders += 1;
      return recorded.createAuthorizeOrder(input);
    },
  };
  const own = startServer(watching, { maxHoldsPerMinute: 1000 });
  await new Promise<void>((resolve) => own.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(own.address() as AddressInfo).port}`;
  try {
    for (const method of ['GET', 'HEAD']) {
      const page = await fetch(`${url}/judge`, { method });
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    }
    assert.equal(orders, 0);
    const press = async () => ((await (await fetch(`${url}/api/contracts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()) as { id: string }).id;
    const ids = [await press(), await press()];
    assert.notEqual(ids[0], ids[1]);
    assert.equal(orders, 2);
  } finally {
    own.close();
  }
});

test('the judge page says only what the real data shows', async () => {
  const code = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const rows = await ledger.through('2020-11-19');
  const row = (date: string) => rows.find((r) => r.date === date);
  assert.equal(row('2020-10-12')?.kwh, 0);
  assert.equal(row('2020-10-12')?.status, 'HOLD');
  assert.ok((row('2020-10-22')?.kwh ?? 0) > 0);
  assert.equal(row('2020-10-22')?.status, 'HOLD');
  assert.equal(row('2020-10-26')?.kwh, 0);
  assert.equal(row('2020-11-19')?.status, 'RELEASE_READY');
  const earlyPays = rows.filter((r) => r.date >= '2020-10-08' && r.date <= '2020-10-26' && r.oneGoodDay === 'PAYS').map((r) => r.date);
  assert.deepEqual(earlyPays, ['2020-10-23', '2020-10-24']);
  assert.match(code, /would already have paid, on Oct 23 and 24/);
  assert.match(code, /Release \$40\.00/);
  assert.match(code, /Release \$60\.00/);
  assert.deepEqual([...DEMO_MILESTONES].map((m) => m.amountCents), [4000, 6000]);
});

test('pages carry a strict content policy, and paths outside the fixed list are not served', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.match(await page.text(), /doi\.org\/10\.25984\/1846021/);
  for (const path of ['/app.js', '/chart.js', '/dom.js', '/ledger.js', '/vendor/ag-grid.min.js', '/styles.css', '/icon.svg', '/fonts/sans-400.woff2', '/fonts/mono-500.woff2']) {
    assert.equal((await fetch(`${base}${path}`)).status, 200, path);
  }
  for (const path of ['/.env', '/public/app.js', '/..%2f.env', '/fonts/../../.env', '/WIN-DECISION.md']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});

test('the browser code holds no secret names and no capture logic', () => {
  const code = ['app.js', 'chart.js'].map((f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(code, /PAYPAL_|CLIENT_SECRET|AWS_/);
  assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|document\.write/);
});

test('the PayPal return places the hold once approved, and reports a failure without placing one', async () => {
  let authorizeWorks = false;
  const base2 = createRecordedPayPal();
  const paypal: PayPalClient = {
    ...base2,
    authorizeOrder: (orderId, requestId) => {
      if (!authorizeWorks) throw new PayPalError('PayPal 422: not approved', 422, null, true);
      return base2.authorizeOrder(orderId, requestId);
    },
  };
  const sandbox = startServer(paypal, { mode: 'sandbox' });
  await new Promise<void>((resolve) => sandbox.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(sandbox.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${url}/api/contracts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const { id } = (await res.json()) as { id: string };
    const status = async () => ((await (await fetch(`${url}/api/contracts/${id}/view`)).json()) as ContractView).status;
    assert.equal(await status(), 'AWAITING_APPROVAL');

    const failed = await fetch(`${url}/paypal/return?contract=${id}`, { redirect: 'manual' });
    assert.equal(failed.headers.get('location'), `/c/${id}?hold=failed`);
    assert.equal(await status(), 'AWAITING_APPROVAL');

    const cancelled = await fetch(`${url}/paypal/cancel?contract=${id}`, { redirect: 'manual' });
    assert.equal(cancelled.headers.get('location'), `/c/${id}?hold=cancelled`);

    authorizeWorks = true;
    const done = await fetch(`${url}/paypal/return?contract=${id}`, { redirect: 'manual' });
    assert.equal(done.headers.get('location'), `/c/${id}`);
    assert.equal(await status(), 'HELD');

    const unknown = await fetch(`${url}/paypal/return?contract=nope`, { redirect: 'manual' });
    assert.equal(unknown.headers.get('location'), '/');
  } finally {
    sandbox.close();
  }
});

test('new holds stop at the limit, because each one calls PayPal', async () => {
  const limited = startServer(createRecordedPayPal(), { maxHoldsPerMinute: 2, now: () => 1_000_000 });
  await new Promise<void>((resolve) => limited.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(limited.address() as AddressInfo).port}/api/contracts`;
  const start = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  try {
    assert.equal((await start()).status, 201);
    assert.equal((await start()).status, 201);
    assert.equal((await start()).status, 429);
  } finally {
    limited.close();
  }
});

test('model calls stop at the limit and the template takes over', async () => {
  let calls = 0;
  const explainer = createExplainer({
    model: 'm',
    maxCalls: 1,
    create: async () => {
      calls += 1;
      return { stop_reason: 'end_turn', model: 'm', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: '{"explanation":"On hold.","installer_question":"Could you share the logs?"}' }] };
    },
  });
  const first = await explainer.explain(judge(fleet, '01', '2020-10-12'));
  const second = await explainer.explain(judge(fleet, '01', '2020-10-13'));
  assert.equal(first.source, 'model');
  assert.equal(second.source, 'template');
  assert.equal(second.templateReason, 'CALL_LIMIT');
  assert.equal(calls, 1);
});
