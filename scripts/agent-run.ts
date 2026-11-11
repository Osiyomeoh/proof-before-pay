// Real Bedrock runs of the agent, through the real route, on a sample-mode hold over the Maui outage.
//   npm run agent
// Steps one hold through the days the page stops on, releases milestone 1 on Nov 19 with the recorded
// PayPal stand-in (no PayPal call, no money), then runs milestone 2 when it opens. Prints every step and
// whether the checks kept the answer, then saves the runs to spike/agent-run.json for sample mode.
// At most 6 runs of up to 6 model calls each, with at most 1,024 output tokens per call.
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBedrockAgent } from '../src/ai/bedrock.ts';
import type { AgentRun } from '../src/ai/agent.ts';
import { createExcuseChecker, createRecordedSplitter } from '../src/ai/excuse.ts';
import { createRecordedExplainer } from '../src/ai/recorded.ts';
import { createPayments } from '../src/payments/service.ts';
import { recordedOrder } from '../src/paypal/order-record.ts';
import { createRecordedPayPal } from '../src/paypal/recorded.ts';
import { loadMauiLogger } from '../src/proof/claims.ts';
import { judge } from '../src/proof/engine.ts';
import { forgeryTest } from '../src/proof/forgery.ts';
import { createLedger } from '../src/proof/ledger.ts';
import { MAUI_INVERTERS, commonDates, loadMauiFleet } from '../src/proof/maui.ts';
import { createApp } from '../src/server/app.ts';
import type { ContractView } from '../src/server/demo.ts';
import { createHandler } from '../src/server/http.ts';

process.loadEnvFile(new URL('../.env', import.meta.url));
const fleet = loadMauiFleet();
const lastDate = commonDates(fleet).at(-1) as string;
const proof = (unitId: string, date: string) => judge(fleet, unitId, date);
const logger = loadMauiLogger(MAUI_INVERTERS);
const excuses = JSON.parse(readFileSync(new URL('../spike/excuse-run.json', import.meta.url), 'utf8')) as { results: Parameters<typeof createRecordedSplitter>[0] };
const explainer = createRecordedExplainer();
const payments = createPayments({ paypal: createRecordedPayPal(), proof });
const app = createApp({
  payments, proof, fleet, lastDate, mode: 'sample', publicUrl: 'http://localhost',
  explain: (v) => explainer.explain(v),
  ledger: createLedger(fleet, '01', lastDate).through,
  orderRecord: async (c) => ({ record: recordedOrder(c), readAt: new Date().toISOString() }),
  checkExcuse: createExcuseChecker(createRecordedSplitter(excuses.results), fleet, logger),
  forgeCheck: (v) => forgeryTest(v, fleet, logger),
  agent: createBedrockAgent(),
});
const server = createServer(createHandler({ payments, verifyWebhook: async () => ({ ok: false, reason: 'NOT_CONFIGURED' }), app }));
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const post = async (path: string, body: unknown = {}) => (await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>;
const view = async (id: string) => (await (await fetch(`${base}/api/contracts/${id}/view`)).json()) as ContractView;

const { id } = (await post('/api/contracts')) as { id: string };
const results: Array<AgentRun & { ms: number }> = [];

async function runOn(date: string) {
  await post(`/api/contracts/${id}/replay`, { to: date });
  const started = Date.now();
  const { run } = (await (await fetch(`${base}/api/contracts/${id}/agent`)).json()) as { run: AgentRun | null };
  const ms = Date.now() - started;
  if (run === null) throw new Error(`no run on ${date}`);
  console.log(`\nMilestone ${run.milestone.number}, ${run.date} ${run.status}: ${run.source}${run.fallbackReason ? ` (${run.fallbackReason})` : ''}, ${run.calls} calls, ${ms} ms, ${run.usage?.inputTokens ?? 0} in, ${run.usage?.outputTokens ?? 0} out`);
  for (const step of run.steps) console.log(`  ${step.ok ? '✓' : '✗'} ${step.tool} ${JSON.stringify(step.input)}: ${step.said}`);
  console.log(`  next: ${run.nextStep}\n  ${run.summary}`);
  if (run.messageToInstaller) console.log(`  message: ${run.messageToInstaller}`);
  results.push({ ...run, ms });
}

for (const date of ['2020-10-12', '2020-10-22', '2020-10-23', '2020-10-26', '2020-11-19']) await runOn(date);

// Milestone 1 passed on Nov 19. Release it through the same tap and release routes as the page.
const first = (await view(id)).milestones[0];
if (first === undefined) throw new Error('no milestone 1');
const tap = await post(`/api/contracts/${id}/milestones/${first.id}/tap`);
const released = await post(`/api/contracts/${id}/milestones/${first.id}/release`, { tap: tap['token'] });
console.log(`\nreleased milestone 1 with the recorded stand-in: ${String(released['outcome'])}`);
await runOn('2020-12-19');

server.close();
const kept = results.filter((r) => r.source === 'model').length;
const calls = results.reduce((sum, r) => sum + r.calls, 0);
const tokens = results.reduce((sum, r) => sum + (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0), 0);
console.log(`\nkept ${kept} of ${results.length} agent answers; ${calls} model calls; ${tokens} tokens in total`);
writeFileSync(new URL('../spike/agent-run.json', import.meta.url), `${JSON.stringify({ ranAt: new Date().toISOString(), kept, total: results.length, calls, tokens, results }, null, 2)}\n`);
