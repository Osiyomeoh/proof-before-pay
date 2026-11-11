// An AI agent that watches one milestone's hold. It reads the engine's verdict, the recorded days and
// PayPal's own record of the order, checks its own draft to the installer, and proposes a next step.
// Its four tools are defined and run here, and all four only read. This module imports nothing that
// can move money, and a tool name from the model is only ever compared with those four names.
// A proposal to release is kept only when the engine already says RELEASE_READY and PayPal's record,
// read in the same run, agrees with the page. Even then a person presses Release, as before.
// An answer that fails a check is replaced by a plain run of the same tools, so the panel is never empty.
import { niceDate, percent, reasonLabel } from '../proof/describe.ts';
import type { Verdict } from '../proof/engine.ts';
import type { LedgerRow } from '../proof/ledger.ts';
import { buildEvidence, reviewText, templateExplanation } from './explain.ts';
import type { TemplateReason } from './explain.ts';

export type NextStep = 'WAIT' | 'ASK_INSTALLER' | 'PROPOSE_RELEASE';
const NEXT_STEPS: readonly NextStep[] = ['WAIT', 'ASK_INSTALLER', 'PROPOSE_RELEASE'];

export type AgentFallback = TemplateReason | 'STEP_NOT_ALLOWED' | 'DID_NOT_READ' | 'TOO_LONG' | 'NAMES_A_STEP' | 'DATE_NOT_READ' | 'TOO_MANY_TURNS';

// A step's code name in the text the person reads. Upper case only, so "wait" in a sentence is fine.
const STEP_WORD = /\b(PROPOSE_RELEASE|ASK_INSTALLER|WAIT)\b/;

// A full date in words, such as "Oct 9, 2020" or "October 9 2020". Each one it writes must be a date a tool
// returned in this run, which the tools write as "Oct 9, 2020".
const DATE_IN_WORDS = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? (\d{1,2}),? (\d{4})\b/g;
function dateNotRead(seen: string, ...texts: string[]): boolean {
  return texts.some((text) => [...text.matchAll(DATE_IN_WORDS)].some((m) => !seen.includes(`"${m[1]} ${Number(m[2])}, ${m[3]}"`)));
}

// What the server passes on from PayPal's record: statuses and amounts, with no IDs and nothing about the buyer.
export type AgentRecord = {
  orderStatus: string | null;
  holdStatus: string | null;
  capturedCents: { paypal: number | null; app: number };
  holdOpen: { paypal: boolean | null; app: boolean };
  agrees: boolean;
};

export type AgentCase = {
  // One run per key. The server uses the contract, the milestone and the day judged.
  key: string;
  verdict: Verdict;
  milestone: { number: number; of: number; title: string; amountCents: number };
  // Recorded days through a date. The agent only asks through the day judged.
  readDays: (through: string) => Promise<readonly LedgerRow[]>;
  // null before a hold is placed. Throws when PayPal can't be read.
  readRecord: () => Promise<AgentRecord | null>;
};

// One tool call as the page shows it. `said` is written by this module from the result, not by the model.
export type AgentStep = { tool: string; input: Record<string, unknown>; said: string; ok: boolean };

export type AgentRun = {
  source: 'model' | 'recorded' | 'template';
  model: string | null;
  fallbackReason: AgentFallback | null;
  date: string;
  status: Verdict['status'];
  milestone: AgentCase['milestone'];
  steps: AgentStep[];
  nextStep: NextStep;
  summary: string;
  messageToInstaller: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  calls: number;
};

type TextBlock = { type: 'text'; text: string };
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
type ToolSchema = { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };

export type AgentMessage =
  | { role: 'user'; content: string | ToolResultBlock[] }
  | { role: 'assistant'; content: Array<TextBlock | ToolUseBlock> };

export type AgentRequest = {
  model: string;
  max_tokens: number;
  system: string;
  tools: Array<{ name: string; description: string; input_schema: ToolSchema }>;
  messages: AgentMessage[];
  output_config: { format: { type: 'json_schema'; schema: Record<string, unknown> } };
};

export type AgentReply = {
  stop_reason: string | null;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  content: Array<TextBlock | ToolUseBlock>;
};

export type CreateAgentMessage = (request: AgentRequest) => Promise<AgentReply>;

// Room for the reads, a draft, a second draft and the answer.
const MAX_TURNS = 6;
const MAX_DAYS = 45;
const PLAIN_DAYS = 7;
const MAX_SUMMARY_CHARS = 600;
const MAX_MESSAGE_CHARS = 600;

const SYSTEM = `You are an agent that watches one milestone payment for a solar installation. The buyer's money is held by PayPal, not paid. Each day a deterministic rule engine judges the inverter's measured output. Its verdict is final, and you can't change it.

Your job is to find out where this milestone stands and propose the next step to the person who decides.
1. Call read_verdict, read_days and read_paypal_record. You can call them together.
2. Only if next_step will be ASK_INSTALLER, check the message with draft_installer_message and fix any problem it reports.
3. Then give your final answer.

You have no payment tools. Nothing you write releases, holds or returns money, and nothing is sent to anyone: a person reads your answer and decides.

next_step:
- ASK_INSTALLER: the verdict is HOLD and the installer should account for the low production. Write the message.
- PROPOSE_RELEASE: only when the verdict is RELEASE_READY and read_paypal_record says records_agree is true. A person still presses Release.
- WAIT: otherwise, for example when PayPal's record doesn't agree with this page or couldn't be read.
On HOLD, never propose release. Only new production data can change a hold.

How to read the data:
- "This inverter" is the unit being judged. Call it "this inverter", never by a number or ID.
- The other inverters on the same roof see the same weather. Call them "the other inverters on the roof", not peers, nearby systems or neighbours.
- share_of_usual_percent compares this inverter with the other inverters, against its own past: 100 means it kept up with them as it usually does, 0 means it made nothing while they produced. It is not the other inverters' output. Say "X% of its usual share".
- verdict_that_day in read_days is the engine's verdict on that past day. The verdict that counts is the one from read_verdict.
- zero_output_stretches in read_days lists each run of back-to-back days at 0 kWh. When you name a stretch of zero days, take its dates from there. A day with a low share but some output is not a zero day.

Rules for everything you write:
- Use only numbers that appear in the tool results, exactly as written. Don't calculate, round or add new ones. The tool results include counts, so you don't need to count.
- Write dates exactly as the tool results write them, for example "Oct 8, 2020".
- Don't name or suggest a cause for low output. The data doesn't show one.
- Don't call the site a home or a house, because the data doesn't say what kind of building it is.
- On HOLD, don't suggest that an answer, a fix or a review will release the money, and don't say the hold waits on the installer (no "before this can proceed"). Asking the installer is for the person's information. Only new production data changes the verdict.
- Don't use double quotation marks in the summary or the message. Name the milestone as, for example, Milestone 1 of 2 ($40.00).
- Write in plain words for a person. Don't write a next_step value such as PROPOSE_RELEASE in the summary or the message.
- summary: at most three short sentences for the person deciding: where the milestone stands, and why you chose the next step.
- message_to_installer: for ASK_INSTALLER, a short, polite message to the installer that names the dates concerned and asks for an explanation and the monitoring logs for those dates. Otherwise an empty string.`;

const NO_INPUT: ToolSchema = { type: 'object', properties: {}, required: [], additionalProperties: false };

const TOOLS: AgentRequest['tools'] = [
  {
    name: 'read_verdict',
    description: 'The rule engine\'s final verdict on this milestone: its status, the days it judged, the hold reasons and the rule thresholds, with the milestone and its amount.',
    input_schema: NO_INPUT,
  },
  {
    name: 'read_days',
    description: `This inverter's recorded days up to the day judged, oldest first, with counts and the verdict the engine gave on each day. Use it to see how long a problem has lasted.`,
    input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: MAX_DAYS, description: `How many days back from the day judged, from 1 to ${MAX_DAYS}.` } }, required: ['days'], additionalProperties: false },
  },
  {
    name: 'read_paypal_record',
    description: 'PayPal\'s own record of this order, compared with this page: what each side has captured and whether the hold is still open. Read-only.',
    input_schema: NO_INPUT,
  },
  {
    name: 'draft_installer_message',
    description: 'Checks a draft message to the installer against the same rules as your final answer. Nothing is sent. Returns ok, or the problem to fix.',
    input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
  },
];

const ANSWER: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    next_step: { type: 'string', enum: [...NEXT_STEPS] },
    message_to_installer: { type: 'string' },
  },
  required: ['summary', 'next_step', 'message_to_installer'],
  additionalProperties: false,
};

// What a failed draft tells the model, so it can fix the draft.
const PROBLEMS: Partial<Record<AgentFallback, string>> = {
  EMPTY: 'The message is empty.',
  UNFINISHED: 'It stops mid-sentence or leaves a bracket open. Finish every sentence, and don\'t use double quotation marks.',
  TOO_LONG: `The message is longer than ${MAX_MESSAGE_CHARS} characters.`,
  NUMBER_NOT_IN_EVIDENCE: 'It uses a number that is not in the tool results.',
  NAMES_A_CAUSE: 'It names or suggests a cause, which the data doesn\'t show.',
  WRONG_PEERS: 'Call them "the other inverters on the roof".',
  CALLS_IT_A_HOME: 'The data doesn\'t say the site is a home or a house.',
  NAMES_A_STEP: 'Write it in plain words, without a next_step value such as ASK_INSTALLER.',
  DATE_NOT_READ: 'It names a date that is not in the tool results. Use only dates the tools returned.',
  CONTRADICTS_HOLD: 'It suggests an answer or a fix could release the money, or that the hold waits on the installer. Only new production data can change a hold.',
  MISREADS_EVIDENCE: 'Write dates as the tool results do, and a share as "X% of its usual share".',
};

export type RecordState = 'unread' | 'agrees' | 'differs' | 'unavailable' | 'no_hold';
type RunState = { seen: string[]; readVerdict: boolean; record: RecordState; steps: AgentStep[] };
type ToolOutput = { content: string; isError: boolean };

const newState = (): RunState => ({ seen: [], readVerdict: false, record: 'unread', steps: [] });
const dollars = (cents: number) => (cents / 100).toFixed(2);
const usd = (cents: number | null) => (cents === null ? 'an unreadable amount' : `$${dollars(cents)}`);
const round = (value: number | null, places: number) => (value === null ? null : Number(value.toFixed(places)));

// The only steps the server keeps for a verdict and a record read in this run.
export function allowedSteps(status: Verdict['status'], record: RecordState): NextStep[] {
  if (status === 'HOLD') return ['WAIT', 'ASK_INSTALLER'];
  return record === 'agrees' ? ['WAIT', 'PROPOSE_RELEASE'] : ['WAIT'];
}

function args(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

async function runTool(c: AgentCase, state: RunState, name: string, input: unknown): Promise<ToolOutput> {
  const given = args(input);
  const step = (tool: string, shown: Record<string, unknown>, said: string, ok: boolean) => state.steps.push({ tool, input: shown, said, ok });
  // Only what a read returned counts as evidence for the numbers in the answer.
  const read = (content: unknown) => {
    const json = JSON.stringify(content);
    state.seen.push(json);
    return { content: json, isError: false };
  };
  const { verdict } = c;

  switch (name) {
    case 'read_verdict': {
      state.readVerdict = true;
      const { number, of, title, amountCents } = c.milestone;
      // The labels are written to stand alone ("A day under the floor"), so lower-case all but the first in a list.
      const first = verdict.reasons.map(reasonLabel).map((label, i) => (i === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1))).join(', ');
      step(name, {}, verdict.status === 'HOLD'
        ? `HOLD on ${niceDate(verdict.date)}: ${first || 'the check could not confirm production'}`
        : `RELEASE_READY on ${niceDate(verdict.date)}: ${percent(verdict.mean)}% of its usual share over ${verdict.window.length} days`, true);
      return read({ ...buildEvidence(verdict), milestone: { number, of, title, amount_usd: dollars(amountCents) } });
    }

    case 'read_days': {
      const days = given['days'];
      if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
        step(name, { days: typeof days === 'number' ? days : null }, `Refused: days must be a whole number from 1 to ${MAX_DAYS}`, false);
        return { content: `days must be a whole number from 1 to ${MAX_DAYS}.`, isError: true };
      }
      let rows: readonly LedgerRow[];
      try {
        rows = (await c.readDays(verdict.date)).filter((row) => row.date <= verdict.date).slice(-days);
      } catch {
        step(name, { days }, 'The recorded days could not be read', false);
        return { content: 'The recorded days could not be read just now.', isError: true };
      }
      const from = rows[0];
      const through = rows.at(-1);
      const counts = {
        days_returned: rows.length,
        days_with_zero_output: rows.filter((row) => row.kwh === 0).length,
        days_with_no_reading: rows.filter((row) => row.kwh === null).length,
        days_below_lowest_allowed_share: rows.filter((row) => row.belowFloor).length,
        days_judged_hold: rows.filter((row) => row.status === 'HOLD').length,
      };
      // Each run of back-to-back days at 0 kWh, so the agent quotes a stretch rather than working one out.
      // A day with no reading ends a stretch: it isn't known to be zero.
      const stretches: Array<{ from: string; through: string; days: number }> = [];
      let open: { from: string; through: string; days: number } | null = null;
      for (const row of rows) {
        if (row.kwh !== 0) {
          open = null;
          continue;
        }
        if (open === null) {
          open = { from: niceDate(row.date), through: niceDate(row.date), days: 0 };
          stretches.push(open);
        }
        open.through = niceDate(row.date);
        open.days += 1;
      }
      const gaps = counts.days_with_no_reading > 0 ? `, ${counts.days_with_no_reading} with no reading` : '';
      step(name, { days }, from === undefined || through === undefined
        ? 'No recorded days yet'
        : `${rows.length} days, ${niceDate(from.date)} to ${niceDate(through.date)}: ${counts.days_with_zero_output} at zero${gaps}, ${counts.days_judged_hold} judged HOLD`, true);
      return read({
        from: from === undefined ? null : niceDate(from.date),
        through: through === undefined ? null : niceDate(through.date),
        ...counts,
        zero_output_stretches: stretches,
        days: rows.map((row) => ({
          date: niceDate(row.date),
          kwh: round(row.kwh, 1),
          other_inverters_median_kwh: round(row.peerMedianKwh, 1),
          measured_sun_kwh_per_m2: round(row.sun, 2),
          share_of_usual_percent: percent(row.share),
          verdict_that_day: row.status,
        })),
      });
    }

    case 'read_paypal_record': {
      let record: AgentRecord | null;
      try {
        record = await c.readRecord();
      } catch {
        state.record = 'unavailable';
        step(name, {}, 'PayPal\'s record couldn\'t be read just now', false);
        return read({ available: false, reason: 'PayPal\'s record could not be read just now.' });
      }
      if (record === null) {
        state.record = 'no_hold';
        step(name, {}, 'No hold has been placed yet', true);
        return read({ available: false, reason: 'No hold has been placed yet.' });
      }
      state.record = record.agrees ? 'agrees' : 'differs';
      step(name, {}, `PayPal: authorization ${record.holdStatus ?? 'not listed'}, ${usd(record.capturedCents.paypal)} captured. ${record.agrees ? 'Agrees with this page' : 'Differs from this page'}`, true);
      return read({
        available: true,
        order_status: record.orderStatus,
        authorization_status: record.holdStatus,
        captured_usd_at_paypal: record.capturedCents.paypal === null ? null : dollars(record.capturedCents.paypal),
        captured_usd_on_this_page: dollars(record.capturedCents.app),
        hold_open_at_paypal: record.holdOpen.paypal,
        hold_open_on_this_page: record.holdOpen.app,
        records_agree: record.agrees,
      });
    }

    case 'draft_installer_message': {
      const message = given['message'];
      const text = typeof message === 'string' ? message.trim() : '';
      const problem: AgentFallback | null = text === '' ? 'EMPTY'
        : text.length > MAX_MESSAGE_CHARS ? 'TOO_LONG'
        : STEP_WORD.test(text) ? 'NAMES_A_STEP'
        : dateNotRead(state.seen.join('\n'), text) ? 'DATE_NOT_READ'
        : reviewText(verdict.status, state.seen.join('\n'), text);
      step(name, { message: text }, problem === null ? 'Draft passed the checks. Nothing was sent' : `Draft failed a check: ${PROBLEMS[problem] ?? problem}`, problem === null);
      return { content: JSON.stringify(problem === null ? { ok: true, note: 'Passes the checks. Nothing has been sent.' } : { ok: false, problem: PROBLEMS[problem] ?? problem }), isError: false };
    }

    default:
      // Never passed on to anything. The name is shown only as text, cut short.
      step(name.slice(0, 40), {}, 'Refused: not one of its four read-only tools', false);
      return { content: 'There is no tool with that name. The only tools are read_verdict, read_days, read_paypal_record and draft_installer_message, and none of them can move money.', isError: true };
  }
}

type Answer = { nextStep: NextStep; summary: string; messageToInstaller: string | null };

// The server's checks on the final answer. The step must be one allowed for this verdict and this run's
// read of PayPal's record, and every word must pass the same checks as the explanation.
function checkAnswer(c: AgentCase, state: RunState, fields: Record<string, unknown>): Answer | AgentFallback {
  const summary = fields['summary'];
  const step = fields['next_step'];
  const message = fields['message_to_installer'];
  if (typeof summary !== 'string' || typeof message !== 'string' || !NEXT_STEPS.includes(step as NextStep)) return 'BAD_JSON';
  const nextStep = step as NextStep;
  if (!state.readVerdict) return 'DID_NOT_READ';
  if (!allowedSteps(c.verdict.status, state.record).includes(nextStep)) return 'STEP_NOT_ALLOWED';
  const text = nextStep === 'ASK_INSTALLER' ? message.trim() : '';
  if (summary.trim() === '' || (nextStep === 'ASK_INSTALLER' && text === '')) return 'EMPTY';
  if (summary.length > MAX_SUMMARY_CHARS || text.length > MAX_MESSAGE_CHARS) return 'TOO_LONG';
  if (STEP_WORD.test(summary) || STEP_WORD.test(text)) return 'NAMES_A_STEP';
  if (dateNotRead(state.seen.join('\n'), summary, text)) return 'DATE_NOT_READ';
  const problem = reviewText(c.verdict.status, state.seen.join('\n'), summary, text);
  if (problem !== null) return problem;
  return { nextStep, summary: summary.trim(), messageToInstaller: text === '' ? null : text };
}

const RECORD_NOTE: Record<RecordState, string> = {
  unread: '',
  agrees: '',
  no_hold: '',
  differs: ' PayPal\'s record doesn\'t match this page yet, so wait before releasing.',
  unavailable: ' PayPal\'s record couldn\'t be read just now, so wait and look again.',
};

// The same three reads in a fixed order, with the next step taken from the rules and the plain explanation.
export async function plainRun(c: AgentCase, reason: AgentFallback, calls = 0): Promise<AgentRun> {
  const state = newState();
  await runTool(c, state, 'read_verdict', {});
  await runTool(c, state, 'read_days', { days: PLAIN_DAYS });
  await runTool(c, state, 'read_paypal_record', {});
  const hold = c.verdict.status === 'HOLD';
  const text = templateExplanation(c.verdict, 'NO_MODEL');
  return {
    source: 'template',
    model: null,
    fallbackReason: reason,
    date: c.verdict.date,
    status: c.verdict.status,
    milestone: c.milestone,
    steps: state.steps,
    nextStep: hold ? 'ASK_INSTALLER' : state.record === 'agrees' ? 'PROPOSE_RELEASE' : 'WAIT',
    summary: `${text.explanation}${hold ? '' : RECORD_NOTE[state.record]}`,
    messageToInstaller: hold ? text.installerQuestion : null,
    usage: null,
    calls,
  };
}

export type SavedRun = Pick<AgentRun, 'source' | 'model' | 'date' | 'status' | 'milestone' | 'steps' | 'nextStep' | 'summary' | 'messageToInstaller'>;

// Sample mode: a saved run's tool calls are made again against this hold, and its answer must pass the same checks.
// A run saved for another day, verdict or milestone is never replayed: 45 days of readings hold most numbers.
export async function replayRun(c: AgentCase, saved: SavedRun): Promise<AgentRun> {
  if (saved.date !== c.verdict.date || saved.status !== c.verdict.status || saved.milestone.number !== c.milestone.number) return plainRun(c, 'NO_MODEL');
  const state = newState();
  for (const step of saved.steps) await runTool(c, state, step.tool, step.input);
  const answer = checkAnswer(c, state, { summary: saved.summary, next_step: saved.nextStep, message_to_installer: saved.messageToInstaller ?? '' });
  if (typeof answer === 'string') return plainRun(c, answer);
  return { source: 'recorded', model: saved.model, fallbackReason: null, date: c.verdict.date, status: c.verdict.status, milestone: c.milestone, steps: state.steps, ...answer, usage: null, calls: 0 };
}

export type AgentOptions = {
  create: CreateAgentMessage | null;
  model: string;
  // Each run makes up to six model calls, so the public demo stops at this many and plain runs take over.
  maxCalls?: number;
  maxRunsPerMinute?: number;
  now?: () => number;
};

export function createAgent(options: AgentOptions) {
  const { create, model, maxCalls = Number.POSITIVE_INFINITY, maxRunsPerMinute = 10, now = Date.now } = options;
  let calls = 0;
  let runsInMinute = { minute: 0, count: 0 };
  // A milestone judged on a given day gets one run. A run that couldn't reach the model or PayPal is tried again.
  const saved = new Map<string, Promise<AgentRun>>();

  function underRunLimit(): boolean {
    const minute = Math.floor(now() / 60_000);
    if (runsInMinute.minute !== minute) runsInMinute = { minute, count: 0 };
    runsInMinute.count += 1;
    return runsInMinute.count <= maxRunsPerMinute;
  }

  async function attempt(c: AgentCase): Promise<AgentRun> {
    if (create === null) return plainRun(c, 'NO_MODEL');
    if (!underRunLimit()) return plainRun(c, 'CALL_LIMIT');
    const state = newState();
    const { number, of } = c.milestone;
    const messages: AgentMessage[] = [{ role: 'user', content: `Milestone ${number} of ${of} is being judged. Find out where it stands and propose the next step.` }];
    const usage = { inputTokens: 0, outputTokens: 0 };
    let used = 0;
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      if (calls >= maxCalls) return plainRun(c, 'CALL_LIMIT', used);
      calls += 1;
      used += 1;
      let reply: AgentReply;
      try {
        reply = await create({ model, max_tokens: 1024, system: SYSTEM, tools: TOOLS, messages, output_config: { format: { type: 'json_schema', schema: ANSWER } } });
      } catch {
        return plainRun(c, 'CALL_FAILED', used);
      }
      usage.inputTokens += reply.usage.input_tokens;
      usage.outputTokens += reply.usage.output_tokens;
      if (reply.stop_reason === 'refusal') return plainRun(c, 'REFUSED', used);
      if (reply.stop_reason === 'max_tokens') return plainRun(c, 'CUT_OFF', used);

      const uses = reply.content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
      if (uses.length > 0) {
        messages.push({ role: 'assistant', content: reply.content });
        const results: ToolResultBlock[] = [];
        for (const use of uses) {
          const out = await runTool(c, state, use.name, use.input);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: results });
        continue;
      }

      const raw = reply.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
      let fields: Record<string, unknown>;
      try {
        fields = args(JSON.parse(raw));
      } catch {
        return plainRun(c, 'BAD_JSON', used);
      }
      const answer = checkAnswer(c, state, fields);
      if (typeof answer === 'string') return plainRun(c, answer, used);
      return { source: 'model', model: reply.model, fallbackReason: null, date: c.verdict.date, status: c.verdict.status, milestone: c.milestone, steps: state.steps, ...answer, usage, calls: used };
    }
    return plainRun(c, 'TOO_MANY_TURNS', used);
  }

  return {
    run(c: AgentCase): Promise<AgentRun> {
      const earlier = saved.get(c.key);
      if (earlier !== undefined) return earlier;
      const pending = attempt(c);
      saved.set(c.key, pending);
      void pending.then((run) => {
        const retry = run.fallbackReason === 'CALL_FAILED' || run.fallbackReason === 'CALL_LIMIT' || run.steps.some((s) => s.tool === 'read_paypal_record' && !s.ok);
        if (retry) saved.delete(c.key);
      }, () => saved.delete(c.key));
      return pending;
    },
  };
}
