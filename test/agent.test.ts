// The AI agent: four read-only tools, a proposal the server checks, and no way to move money.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { allowedSteps, createAgent, replayRun } from '../src/ai/agent.ts';
import type { AgentCase, AgentFallback, AgentRecord, AgentReply, AgentRequest, SavedRun } from '../src/ai/agent.ts';
import { createBedrockAgent } from '../src/ai/bedrock.ts';
import { buildEvidence } from '../src/ai/explain.ts';
import { createRecordedAgent } from '../src/ai/recorded.ts';
import { createPayments } from '../src/payments/service.ts';
import { createPayPalClient } from '../src/paypal/client.ts';
import { judge } from '../src/proof/engine.ts';
import type { Verdict } from '../src/proof/engine.ts';
import { createLedger } from '../src/proof/ledger.ts';
import type { LedgerRow } from '../src/proof/ledger.ts';
import { commonDates, loadMauiFleet } from '../src/proof/maui.ts';
import { createFakePayPal } from './helpers/fake-paypal.ts';

const fleet = loadMauiFleet();
const ledger = createLedger(fleet, '01', commonDates(fleet).at(-1) as string);
const OUTAGE = judge(fleet, '01', '2020-10-12');
const LATER = judge(fleet, '01', '2020-10-26');
const HEALTHY = judge(fleet, '01', '2020-11-19');
const saved = (JSON.parse(readFileSync(new URL('../spike/agent-run.json', import.meta.url), 'utf8')) as { results: SavedRun[] }).results;
function savedOn(date: string): SavedRun {
  const run = saved.find((r) => r.date === date);
  assert.ok(run, `no saved run on ${date}`);
  return run;
}

const AGREES: AgentRecord = { orderStatus: 'COMPLETED', holdStatus: 'CREATED', capturedCents: { paypal: 0, app: 0 }, holdOpen: { paypal: true, app: true }, agrees: true };
const DIFFERS: AgentRecord = { ...AGREES, capturedCents: { paypal: 4000, app: 0 }, agrees: false };
const MILESTONE_1 = { number: 1, of: 2, title: 'Producing', amountCents: 4000 };

let keys = 0;
function caseFor(verdict: Verdict, record: AgentRecord | null | Error = AGREES, options: Partial<AgentCase> = {}): AgentCase {
  keys += 1;
  return {
    key: `case-${keys}`,
    verdict,
    milestone: MILESTONE_1,
    readDays: ledger.through,
    readRecord: async () => {
      if (record instanceof Error) throw record;
      return record;
    },
    ...options,
  };
}

let ids = 0;
type Use = { type: 'tool_use'; id: string; name: string; input: unknown };
const use = (name: string, input: unknown = {}): Use => ({ type: 'tool_use', id: `t${(ids += 1)}`, name, input });
const usage = { input_tokens: 10, output_tokens: 5 };
const tools = (...blocks: Use[]): AgentReply => ({ stop_reason: 'tool_use', model: 'test-model', usage, content: blocks });
const READS = () => tools(use('read_verdict'), use('read_days', { days: 45 }), use('read_paypal_record'));
function answer(fields: unknown, overrides: Partial<AgentReply> = {}): AgentReply {
  return { stop_reason: 'end_turn', model: 'test-model', usage, content: [{ type: 'text', text: typeof fields === 'string' ? fields : JSON.stringify(fields) }], ...overrides };
}

// A model that plays back replies in order and repeats the last one. Each request is copied as it was sent.
function scripted(...replies: Array<AgentReply | Error>) {
  const requests: AgentRequest[] = [];
  const create = async (request: AgentRequest): Promise<AgentReply> => {
    requests.push(structuredClone(request));
    const next = replies[Math.min(requests.length, replies.length) - 1];
    if (next === undefined || next instanceof Error) throw next ?? new Error('no reply');
    return next;
  };
  return { create, requests };
}

// What the model was sent back for each tool call, by tool name, in the order the calls were made.
function toolResults(requests: AgentRequest[]) {
  const last = requests.at(-1)?.messages ?? [];
  const names = new Map<string, string>();
  const out: Array<{ name: string; content: string; isError: boolean }> = [];
  for (const message of last) {
    if (message.role === 'assistant') for (const block of message.content) if (block.type === 'tool_use') names.set(block.id, block.name);
    if (message.role === 'user' && Array.isArray(message.content)) {
      for (const block of message.content) out.push({ name: names.get(block.tool_use_id) ?? '?', content: block.content, isError: block.is_error === true });
    }
  }
  return out;
}

const HOLD_SUMMARY = 'Milestone 1 of 2 ($40.00) is on HOLD as of Oct 12, 2020.';
const GOOD_HOLD = { summary: savedOn('2020-10-12').summary, next_step: 'ASK_INSTALLER', message_to_installer: savedOn('2020-10-12').messageToInstaller };
const GOOD_READY = { summary: savedOn('2020-11-19').summary, next_step: 'PROPOSE_RELEASE', message_to_installer: '' };

test('a good run is kept and labelled as the model\'s, with each tool call shown', async () => {
  const { create } = scripted(READS(), answer(GOOD_HOLD));
  const run = await createAgent({ create, model: 'm' }).run(caseFor(OUTAGE));
  assert.equal(run.source, 'model');
  assert.equal(run.fallbackReason, null);
  assert.equal(run.model, 'test-model');
  assert.equal(run.nextStep, 'ASK_INSTALLER');
  assert.equal(run.summary, GOOD_HOLD.summary);
  assert.equal(run.messageToInstaller, GOOD_HOLD.message_to_installer);
  assert.deepEqual(run.steps.map((s) => [s.tool, s.ok]), [['read_verdict', true], ['read_days', true], ['read_paypal_record', true]]);
  assert.equal(run.calls, 2);
  assert.deepEqual(run.usage, { inputTokens: 20, outputTokens: 10 });
});

test('the model is offered four read-only tools and sent no IDs or buyer details', async () => {
  const { create, requests } = scripted(READS(), answer(GOOD_HOLD));
  await createAgent({ create, model: 'm' }).run(caseFor(OUTAGE));
  assert.deepEqual(requests[0]?.tools.map((t) => t.name), ['read_verdict', 'read_days', 'read_paypal_record', 'draft_installer_message']);
  assert.deepEqual(Object.keys(requests[0] ?? {}).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system', 'tools']);
  const sent = JSON.stringify(requests.at(-1)?.messages);
  assert.ok(sent.includes('records_agree'), 'the record read should have reached the model');
  assert.ok(!/AUTH|ORDER|payer|payment_source|email|authorization_id|order_id/.test(sent));
});

test('a tool it doesn\'t have is refused, goes nowhere, and no money moves', async () => {
  const fake = createFakePayPal();
  const verdict = Object.freeze({ ...OUTAGE }) as Verdict;
  const payments = createPayments({ paypal: createPayPalClient({ clientId: 'a', clientSecret: 'b', fetch: fake.fetch }), proof: () => verdict });
  const contract = await payments.startHold({
    description: 'x',
    currency: 'USD',
    milestones: [{ title: 'Producing', amountCents: 10000, unitId: '01', proofDate: '2020-10-12' }],
    returnUrl: 'https://e.com/a',
    cancelUrl: 'https://e.com/b',
  });
  await payments.completeHold(contract.id);
  const callsBefore = fake.calls.length;

  const long = `capture_authorization_${'x'.repeat(100)}`;
  const { create, requests } = scripted(
    tools(use('read_verdict'), use('capture_authorization', { amount: '40.00' }), use('release_payment', { milestone: 'm1' }), use(long)),
    answer(GOOD_HOLD),
  );
  const run = await createAgent({ create, model: 'm' }).run(caseFor(verdict));

  const refused = toolResults(requests).filter((r) => r.name !== 'read_verdict');
  assert.equal(refused.length, 3);
  for (const r of refused) {
    assert.equal(r.isError, true);
    assert.match(r.content, /There is no tool with that name/);
  }
  assert.deepEqual(run.steps.filter((s) => !s.ok).map((s) => s.said), Array(3).fill('Refused: not one of its four read-only tools'));
  assert.ok(run.steps.every((s) => s.tool.length <= 40));
  assert.equal(fake.calls.length, callsBefore);
  assert.equal(fake.captures().length, 0);
  assert.equal(payments.prepareRelease(contract.id, 'm1').outcome, 'LOCKED');
  assert.equal(verdict.status, 'HOLD');
});

test('the steps it may propose depend on the verdict and on PayPal\'s record read in the same run', () => {
  assert.deepEqual(allowedSteps('HOLD', 'agrees'), ['WAIT', 'ASK_INSTALLER']);
  assert.deepEqual(allowedSteps('RELEASE_READY', 'agrees'), ['WAIT', 'PROPOSE_RELEASE']);
  for (const record of ['unread', 'differs', 'unavailable', 'no_hold'] as const) assert.deepEqual(allowedSteps('RELEASE_READY', record), ['WAIT'], record);
});

test('on HOLD, a proposal to release is replaced by a plain run that asks the installer', async () => {
  const { create } = scripted(READS(), answer({ summary: HOLD_SUMMARY, next_step: 'PROPOSE_RELEASE', message_to_installer: '' }));
  const run = await createAgent({ create, model: 'm' }).run(caseFor(OUTAGE));
  assert.equal(run.source, 'template');
  assert.equal(run.fallbackReason, 'STEP_NOT_ALLOWED');
  assert.equal(run.nextStep, 'ASK_INSTALLER');
  assert.ok((run.messageToInstaller ?? '').length > 0);
  assert.equal(run.calls, 2);
});

test('release is proposed only when PayPal\'s record was read in the run and agrees', async () => {
  const without = scripted(tools(use('read_verdict'), use('read_days', { days: 45 })), answer(GOOD_READY));
  const unread = await createAgent({ create: without.create, model: 'm' }).run(caseFor(HEALTHY));
  assert.equal(unread.fallbackReason, 'STEP_NOT_ALLOWED');
  assert.equal(unread.nextStep, 'PROPOSE_RELEASE', 'the plain run reads the record itself, and it agrees');

  const differs = await createAgent({ create: scripted(READS(), answer(GOOD_READY)).create, model: 'm' }).run(caseFor(HEALTHY, DIFFERS));
  assert.equal(differs.fallbackReason, 'STEP_NOT_ALLOWED');
  assert.equal(differs.nextStep, 'WAIT');
  assert.match(differs.summary, /doesn't match this page/);

  const down = await createAgent({ create: scripted(READS(), answer(GOOD_READY)).create, model: 'm' }).run(caseFor(HEALTHY, new Error('PayPal down')));
  assert.equal(down.fallbackReason, 'STEP_NOT_ALLOWED');
  assert.equal(down.nextStep, 'WAIT');
  assert.match(down.summary, /couldn't be read/);

  const agrees = await createAgent({ create: scripted(READS(), answer(GOOD_READY)).create, model: 'm' }).run(caseFor(HEALTHY));
  assert.equal(agrees.source, 'model');
  assert.equal(agrees.nextStep, 'PROPOSE_RELEASE');
  assert.equal(agrees.messageToInstaller, null);
});

test('an answer given before reading the verdict is not used', async () => {
  const run = await createAgent({ create: scripted(answer(GOOD_HOLD)).create, model: 'm' }).run(caseFor(OUTAGE));
  assert.equal(run.fallbackReason, 'DID_NOT_READ');
  assert.equal(run.source, 'template');
  assert.equal(run.calls, 1);
});

test('numbers are checked against what the tools returned in this run', async () => {
  // Sep 7 is outside the judged week, so its kWh is only in read_days when it reaches back that far.
  const sep7 = (await ledger.through('2020-10-12')).find((row) => row.date === '2020-09-07');
  assert.ok(sep7?.kwh);
  const kwh = Number(sep7.kwh.toFixed(1));
  assert.ok(!JSON.stringify(buildEvidence(OUTAGE)).includes(String(kwh)), 'the number must not be in the verdict itself');
  // No date in the sentence, so only the number check can catch it.
  const said = { summary: `${HOLD_SUMMARY} On one day in early September this inverter made ${kwh} kWh.`, next_step: 'WAIT', message_to_installer: '' };
  const far = await createAgent({ create: scripted(tools(use('read_verdict'), use('read_days', { days: 45 })), answer(said)).create, model: 'm' }).run(caseFor(OUTAGE));
  assert.equal(far.source, 'model');
  const near = await createAgent({ create: scripted(tools(use('read_verdict'), use('read_days', { days: 3 })), answer(said)).create, model: 'm' }).run(caseFor(OUTAGE));
  assert.equal(near.fallbackReason, 'NUMBER_NOT_IN_EVIDENCE');
});

// Each answer reads all three tools first, so only the words decide.
const MESSAGE = GOOD_HOLD.message_to_installer;
const hold = (summary: string, message: string | null = MESSAGE, step = 'ASK_INSTALLER') => ({ summary, next_step: step, message_to_installer: message });
const REJECTED: Array<[AgentFallback, AgentReply | Error]> = [
  ['CALL_FAILED', new Error('Bedrock down')],
  ['REFUSED', answer(GOOD_HOLD, { stop_reason: 'refusal' })],
  ['CUT_OFF', answer(GOOD_HOLD, { stop_reason: 'max_tokens' })],
  ['BAD_JSON', answer('not json')],
  ['BAD_JSON', answer({ ...GOOD_HOLD, summary: 5 })],
  ['BAD_JSON', answer({ ...GOOD_HOLD, next_step: 'RELEASE_NOW' })],
  ['EMPTY', answer(hold(HOLD_SUMMARY, ''))],
  ['TOO_LONG', answer(hold(`${HOLD_SUMMARY} ${'It is on hold. '.repeat(45)}`))],
  ['UNFINISHED', answer(hold(`${HOLD_SUMMARY} This inverter averaged only`))],
  ['UNFINISHED', answer(hold(`${HOLD_SUMMARY} It averaged 31% of its usual share (against 70%.`))],
  ['NAMES_A_STEP', answer(hold(`${HOLD_SUMMARY} Proposing ASK_INSTALLER.`))],
  ['NAMES_A_STEP', answer(hold(HOLD_SUMMARY, `${MESSAGE} Next step: WAIT.`))],
  ['NUMBER_NOT_IN_EVIDENCE', answer(hold(`${HOLD_SUMMARY} It made only 987 kWh that week.`))],
  ['DATE_NOT_READ', answer(hold(`${HOLD_SUMMARY} The drop began on Aug 2, 2020.`))],
  ['DATE_NOT_READ', answer(hold(HOLD_SUMMARY, `${MESSAGE} Please also send the logs for October 30, 2020.`))],
  ['NAMES_A_CAUSE', answer(hold(`${HOLD_SUMMARY} This looks like an inverter failure.`))],
  ['WRONG_PEERS', answer(hold(`${HOLD_SUMMARY} Nearby systems kept producing.`))],
  ['CALLS_IT_A_HOME', answer(hold(`${HOLD_SUMMARY} The home made no power.`))],
  // Seen in real runs: the hold read as waiting on the installer, and a reply read as what releases the money.
  ['CONTRADICTS_HOLD', answer(hold(`${HOLD_SUMMARY} The installer should account for the drop before this can proceed.`))],
  ['CONTRADICTS_HOLD', answer(hold(HOLD_SUMMARY, `${MESSAGE} Once this is explained, the payment can go ahead.`))],
];

for (const [reason, reply] of REJECTED) {
  test(`${reason}: a plain run replaces the agent's answer, so the panel is never empty`, async () => {
    const replies = reply instanceof Error ? [reply] : [READS(), reply];
    const run = await createAgent({ create: scripted(...replies).create, model: 'm' }).run(caseFor(OUTAGE));
    assert.equal(run.source, 'template');
    assert.equal(run.fallbackReason, reason);
    assert.equal(run.nextStep, 'ASK_INSTALLER');
    assert.ok(run.summary.length > 0);
    assert.ok((run.messageToInstaller ?? '').length > 0);
    assert.deepEqual(run.steps.map((s) => s.tool), ['read_verdict', 'read_days', 'read_paypal_record']);
  });
}

test('a true sentence about new data is not mistaken for the hold waiting on the installer', async () => {
  const run = await createAgent({ create: scripted(READS(), answer(hold(`${HOLD_SUMMARY} New production data is needed before the hold can be lifted.`))).create, model: 'm' }).run(caseFor(OUTAGE));
  assert.equal(run.source, 'model');
});

test('a draft that fails a check is reported back, so the model can fix it', async () => {
  const { create, requests } = scripted(
    READS(),
    tools(use('draft_installer_message', { message: `${MESSAGE} ${'Thank you. '.repeat(60)}` })),
    tools(use('draft_installer_message', { message: `${MESSAGE} Next step: ASK_INSTALLER.` })),
    tools(use('draft_installer_message', { message: MESSAGE })),
    answer(GOOD_HOLD),
  );
  const run = await createAgent({ create, model: 'm' }).run(caseFor(OUTAGE));
  assert.equal(run.source, 'model');
  const drafts = run.steps.filter((s) => s.tool === 'draft_installer_message');
  assert.deepEqual(drafts.map((s) => s.ok), [false, false, true]);
  assert.match(drafts[0]?.said ?? '', /longer than 600 characters/);
  assert.match(drafts[1]?.said ?? '', /without a next_step value/);
  assert.equal(drafts[2]?.said, 'Draft passed the checks. Nothing was sent');
  const back = toolResults(requests).filter((r) => r.name === 'draft_installer_message').map((r) => JSON.parse(r.content) as { ok: boolean });
  assert.deepEqual(back.map((r) => r.ok), [false, false, true]);
});

test('a run that never answers stops after six model calls', async () => {
  const { create, requests } = scripted(tools(use('read_verdict')));
  const run = await createAgent({ create, model: 'm' }).run(caseFor(OUTAGE));
  assert.equal(run.fallbackReason, 'TOO_MANY_TURNS');
  assert.equal(run.calls, 6);
  assert.equal(requests.length, 6);
});

test('read_days asks only for days up to the day judged, within its limit', async () => {
  const { create, requests } = scripted(tools(use('read_days', { days: 46 }), use('read_days', { days: 2.5 }), use('read_days', { days: 45 })), answer(GOOD_HOLD));
  await createAgent({ create, model: 'm' }).run(caseFor(OUTAGE));
  const [tooMany, notWhole, ok] = toolResults(requests);
  assert.equal(tooMany?.isError, true);
  assert.equal(notWhole?.isError, true);
  const days = (JSON.parse(ok?.content ?? '{}') as { days: Array<{ date: string }> }).days;
  assert.equal(days.length, 45);
  assert.equal(days.at(-1)?.date, 'Oct 12, 2020');
});

test('read_days lists each stretch of zero days, and a day with no reading ends a stretch', async () => {
  const { create, requests } = scripted(tools(use('read_days', { days: 45 })), answer(GOOD_HOLD));
  await createAgent({ create, model: 'm' }).run(caseFor(LATER));
  const real = JSON.parse(toolResults(requests)[0]?.content ?? '{}') as { zero_output_stretches: unknown; days_with_zero_output: number };
  assert.deepEqual(real.zero_output_stretches, [
    { from: 'Oct 9, 2020', through: 'Oct 21, 2020', days: 13 },
    { from: 'Oct 26, 2020', through: 'Oct 26, 2020', days: 1 },
  ]);
  assert.equal(real.days_with_zero_output, 14);

  const last4 = (await ledger.through('2020-10-12')).slice(-4);
  const kwh: Array<number | null> = [0, null, 0, 0];
  const gappy: LedgerRow[] = last4.map((row, i) => ({ ...row, kwh: kwh[i] as number | null }));
  const second = scripted(tools(use('read_days', { days: 4 })), answer(GOOD_HOLD));
  await createAgent({ create: second.create, model: 'm' }).run(caseFor(OUTAGE, AGREES, { readDays: async () => gappy }));
  const read = JSON.parse(toolResults(second.requests)[0]?.content ?? '{}') as { zero_output_stretches: unknown };
  assert.deepEqual(read.zero_output_stretches, [
    { from: 'Oct 9, 2020', through: 'Oct 9, 2020', days: 1 },
    { from: 'Oct 11, 2020', through: 'Oct 12, 2020', days: 2 },
  ]);
});

test('one run per milestone and day, and a run that couldn\'t read PayPal is tried again', async () => {
  const { create, requests } = scripted(READS(), answer(GOOD_HOLD));
  const agent = createAgent({ create, model: 'm' });
  const c = caseFor(OUTAGE);
  const [a, b] = await Promise.all([agent.run(c), agent.run(c)]);
  assert.equal(a, b);
  await agent.run(c);
  assert.equal(requests.length, 2);

  let fail = true;
  const flaky = caseFor(OUTAGE, AGREES, { readRecord: async () => { if (fail) throw new Error('PayPal down'); return AGREES; } });
  const second = scripted(READS(), answer(GOOD_HOLD), READS(), answer(GOOD_HOLD));
  const retrying = createAgent({ create: second.create, model: 'm' });
  const first = await retrying.run(flaky);
  assert.equal(first.steps.find((s) => s.tool === 'read_paypal_record')?.ok, false);
  await new Promise((resolve) => setImmediate(resolve));
  fail = false;
  const again = await retrying.run(flaky);
  assert.equal(again.steps.find((s) => s.tool === 'read_paypal_record')?.ok, true);
  assert.equal(second.requests.length, 4);
});

test('the call limit hands over to plain runs, and they are tried again later', async () => {
  const { create, requests } = scripted(READS(), answer(GOOD_HOLD), READS());
  const agent = createAgent({ create, model: 'm', maxCalls: 3 });
  assert.equal((await agent.run(caseFor(OUTAGE))).source, 'model');
  const cut = await agent.run(caseFor(OUTAGE));
  assert.equal(cut.fallbackReason, 'CALL_LIMIT');
  assert.equal(cut.calls, 1);
  assert.equal((await agent.run(caseFor(OUTAGE))).calls, 0);
  assert.equal(requests.length, 3);
});

test('past the per-minute run limit, plain runs take over until the next minute', async () => {
  let clock = 0;
  const { create, requests } = scripted(answer(GOOD_HOLD));
  const agent = createAgent({ create, model: 'm', maxRunsPerMinute: 2, now: () => clock });
  for (let i = 0; i < 3; i += 1) await agent.run(caseFor(OUTAGE));
  assert.equal(requests.length, 2);
  clock += 60_000;
  await agent.run(caseFor(OUTAGE));
  assert.equal(requests.length, 3);
});

test('with no AWS settings, the agent makes plain runs and never fails', async () => {
  const run = await createBedrockAgent({}).run(caseFor(OUTAGE));
  assert.equal(run.source, 'template');
  assert.equal(run.fallbackReason, 'NO_MODEL');
  assert.equal(run.calls, 0);
});

test('every saved run replays against its own day and passes the same checks', async () => {
  assert.ok(saved.length >= 6);
  for (const run of saved) {
    const verdict = judge(fleet, '01', run.date);
    assert.equal(verdict.status, run.status, run.date);
    const replayed = await replayRun(caseFor(verdict, AGREES, { milestone: run.milestone }), run);
    assert.equal(replayed.source, 'recorded', `${run.date}: ${replayed.fallbackReason}`);
    assert.equal(replayed.nextStep, run.nextStep);
    assert.equal(replayed.summary, run.summary);
    assert.deepEqual(replayed.steps.map((s) => s.tool), run.steps.map((s) => s.tool));
  }
});

test('a saved run replayed on another day or verdict is not shown as the agent\'s', async () => {
  const oct12 = savedOn('2020-10-12');
  const elsewhere = await replayRun(caseFor(judge(fleet, '01', '2020-10-14')), oct12);
  assert.equal(elsewhere.fallbackReason, 'NO_MODEL');
  const otherMilestone = await replayRun(caseFor(OUTAGE, AGREES, { milestone: { ...MILESTONE_1, number: 2 } }), oct12);
  assert.equal(otherMilestone.fallbackReason, 'NO_MODEL');
  // The same day with a different verdict is refused too, and so is the saved step on its own.
  const ready = await replayRun(caseFor(HEALTHY), { ...oct12, date: HEALTHY.date, status: HEALTHY.status });
  assert.equal(ready.fallbackReason, 'STEP_NOT_ALLOWED');
  const recorded = await createRecordedAgent().run(caseFor(judge(fleet, '01', '2020-10-14')));
  assert.equal(recorded.fallbackReason, 'NO_MODEL');
});
