// Turns a finished verdict into plain language and drafts a question for the installer.
// The verdict is already decided. This module imports nothing that can move money, sends the
// model no tools, and returns only text. The UI must take the status from the verdict, not from here.
// Every answer is checked against the evidence, and a plain template replaces any that fails, so
// the panel is never empty and also works without AWS credentials.
import { niceDate, percent, reasonSentence } from '../proof/describe.ts';
import { DEFAULT_RULES } from '../proof/engine.ts';
import type { EvidenceDay, HoldReason, Verdict } from '../proof/engine.ts';

export type ModelRequest = {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: 'user'; content: string }>;
  output_config: { format: { type: 'json_schema'; schema: Record<string, unknown> } };
};

export type ModelReply = {
  stop_reason: string | null;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  content: ReadonlyArray<{ type: string; text?: string }>;
};

export type CreateMessage = (request: ModelRequest) => Promise<ModelReply>;

export type TemplateReason =
  | 'NO_MODEL'
  | 'CALL_LIMIT'
  | 'CALL_FAILED'
  | 'REFUSED'
  | 'CUT_OFF'
  | 'BAD_JSON'
  | 'EMPTY'
  | 'NUMBER_NOT_IN_EVIDENCE'
  | 'NAMES_A_CAUSE'
  | 'WRONG_PEERS'
  | 'CALLS_IT_A_HOME'
  | 'CONTRADICTS_HOLD'
  | 'MISREADS_EVIDENCE';

export type Explanation = {
  source: 'model' | 'recorded' | 'template';
  explanation: string;
  // null when the verdict is RELEASE_READY, since there is nothing to ask.
  installerQuestion: string | null;
  model: string | null;
  templateReason: TemplateReason | null;
  usage: { inputTokens: number; outputTokens: number } | null;
};

const SYSTEM = `You explain a solar payment check to the person deciding whether to pay their installer.
The JSON evidence comes from a deterministic rule engine. Its verdict is final: you can't change it, and nothing you write can release or hold money.

How to read the evidence:
- "This inverter" is the unit being judged. Call it "this inverter", never by a number or ID.
- The other inverters on the same roof see the same weather. Call them "the other inverters on the roof", not peers, nearby systems or neighbours.
- share_of_usual_percent compares this inverter with the other inverters, against its own past: 100 means it kept up with them as it usually does, 0 means it made nothing while they produced. It is not the other inverters' output. Say "X% of its usual share".

Rules:
- Use only numbers that appear in the evidence, exactly as written. Don't calculate, round or add new ones.
- Write dates exactly as the evidence writes them, for example "Oct 8, 2020".
- Don't name or suggest a cause for low output. The evidence doesn't show one.
- Don't call the site a home or a house, because the evidence doesn't say what kind of building it is.
- explanation: at most three short sentences. Say what the verdict means for the payment, then the evidence that matters most.
- On HOLD, the money stays held and only new production data can change that. Don't suggest that an answer, a fix or a review will release it.
- installer_question: if the verdict is HOLD, one specific and polite question to send the installer, naming the dates concerned. If the verdict is RELEASE_READY, an empty string.`;

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { explanation: { type: 'string' }, installer_question: { type: 'string' } },
  required: ['explanation', 'installer_question'],
  additionalProperties: false,
};

const round = (value: number, places: number) => Number(value.toFixed(places));

function reasonEvidence(reason: HoldReason): Record<string, unknown> {
  switch (reason.code) {
    case 'MEAN_TOO_LOW':
      return { code: reason.code, average_share_of_usual_percent: percent(reason.mean), lowest_allowed_percent: percent(reason.min) };
    case 'DAY_BELOW_FLOOR':
      return { code: reason.code, dates: reason.dates.map(niceDate), lowest_allowed_percent: percent(reason.min) };
    case 'BASELINE_DEGRADED':
      return { code: reason.code, current_baseline_percent_of_earliest: percent(reason.drift), lowest_allowed_percent: percent(reason.min) };
    case 'FLEET_LOW_FOR_SUN':
      return { code: reason.code, peer_output_for_the_sun_percent_of_usual: percent(reason.ratio), lowest_allowed_percent: percent(reason.min) };
    default:
      return { ...reason };
  }
}

// What the model sees: numbers and dates from the engine, with no payment data and no free text.
export function buildEvidence(verdict: Verdict) {
  const floor = DEFAULT_RULES.dayFloor;
  return {
    verdict: verdict.status,
    judged_date: niceDate(verdict.date),
    window_days: DEFAULT_RULES.windowDays,
    lowest_allowed_average_share_percent: percent(DEFAULT_RULES.minMean),
    lowest_allowed_day_share_percent: percent(floor),
    required_history_days: DEFAULT_RULES.minHistoryDays,
    history_days: verdict.historyDays,
    average_share_of_usual_percent: percent(verdict.mean),
    days_with_zero_output: verdict.window.filter((day) => day.kwh === 0).length,
    days_below_lowest_allowed_share: verdict.window.filter((day) => day.ratio !== null && day.ratio < floor).length,
    hold_reasons: verdict.reasons.map(reasonEvidence),
    days: verdict.window.map((day) => ({
      date: niceDate(day.date),
      kwh: day.kwh === null ? null : round(day.kwh, 1),
      other_inverters_median_kwh: day.peerMedianKwh === null ? null : round(day.peerMedianKwh, 1),
      measured_sun_kwh_per_m2: day.sun === null ? null : round(day.sun, 2),
      share_of_usual_percent: percent(day.ratio),
    })),
  };
}

const NUMBER = /\d+(?:[.,]\d+)*/g;
const toNumbers = (text: string) => (text.match(NUMBER) ?? []).map((part) => Number(part.replaceAll(',', '')));

// Words a model might use for a cause. The Maui outage's cause is unknown.
const CAUSE = /\b(fail(ed|ure|ing)?|fault(y|s)?|broken|defect(ive)?|malfunction\w*|damaged?|wiring|shading|soiling|dirty|tripped)\b/i;
const WRONG_PEERS = /\b(nearby|neighbou?rs?|neighbou?ring)\b/i;
const HOME = /\b(home|house)\b/i;
const PAY_NOW = /(ready to (be )?release|safe to (pay|release)|go ahead|you (can|should|may) (now )?(release|pay)|resolved before|(once|after|until) [^.]{0,40}\b(resolved|explained|answered|fixed)\b)/i;
// The page writes "Oct 8, 2020"; an ISO date or a bare share of "peers' output" misreads the evidence.
const MISREAD = /\b\d{4}-\d{2}-\d{2}\b|\bpeers?'? output (was|of)\b|share of (its )?peers'? output\b/i;

export function reviewAnswer(verdict: Verdict, evidenceJson: string, explanation: string, question: string): TemplateReason | null {
  const text = `${explanation} ${question}`;
  if (explanation.trim() === '') return 'EMPTY';
  if (verdict.status === 'HOLD' && question.trim() === '') return 'EMPTY';
  const allowed = new Set(toNumbers(evidenceJson));
  if (toNumbers(text).some((value) => !allowed.has(value))) return 'NUMBER_NOT_IN_EVIDENCE';
  if (CAUSE.test(text)) return 'NAMES_A_CAUSE';
  if (WRONG_PEERS.test(text)) return 'WRONG_PEERS';
  if (HOME.test(text)) return 'CALLS_IT_A_HOME';
  if (verdict.status === 'HOLD' && PAY_NOW.test(text)) return 'CONTRADICTS_HOLD';
  if (MISREAD.test(text)) return 'MISREADS_EVIDENCE';
  return null;
}

function dayFact(day: EvidenceDay | undefined): string {
  if (day === undefined) return '';
  const kwh = day.kwh === null ? 'no reading' : `${round(day.kwh, 1)} kWh`;
  const peers = day.peerMedianKwh === null ? 'no reading' : `a median of ${round(day.peerMedianKwh, 1)} kWh`;
  return ` On ${niceDate(day.date)} this inverter showed ${kwh}, and the other inverters on the roof showed ${peers}.`;
}

export function templateExplanation(verdict: Verdict, reason: TemplateReason): Explanation {
  const base = { source: 'template' as const, model: null, templateReason: reason, usage: null };
  const fact = dayFact(verdict.window.at(-1));
  if (verdict.status === 'RELEASE_READY') {
    return {
      ...base,
      explanation: `This milestone passed the check, so it can be released if you choose to.${fact} Over the window it averaged ${percent(verdict.mean)}% of its usual share.`,
      installerQuestion: null,
    };
  }
  const first = verdict.reasons[0];
  const window = verdict.window;
  const span = window[0] === undefined || window.at(-1) === undefined ? niceDate(verdict.date) : `${niceDate(window[0].date)} to ${niceDate(window.at(-1)?.date ?? verdict.date)}`;
  return {
    ...base,
    explanation: `This payment stays on hold, and no money has moved.${fact} ${first === undefined ? 'The check could not confirm production.' : reasonSentence(first)}`,
    installerQuestion: `Could you explain this inverter's production from ${span}, and share its monitoring logs for those dates?`,
  };
}

export type ExplainerOptions = {
  create: CreateMessage | null;
  model: string;
  // The demo is public and each model call costs money, so calls stop here and the template takes over.
  maxCalls?: number;
};

export function createExplainer(options: ExplainerOptions) {
  const { create, model, maxCalls = Number.POSITIVE_INFINITY } = options;
  let calls = 0;
  // A verdict for a unit and date never changes, so each one costs at most one model call.
  const saved = new Map<string, Promise<Explanation>>();

  async function ask(verdict: Verdict): Promise<Explanation> {
    if (create === null) return templateExplanation(verdict, 'NO_MODEL');
    if (calls >= maxCalls) return templateExplanation(verdict, 'CALL_LIMIT');
    calls += 1;
    const evidence = JSON.stringify(buildEvidence(verdict));
    let reply: ModelReply;
    try {
      reply = await create({
        model,
        max_tokens: 400,
        system: SYSTEM,
        messages: [{ role: 'user', content: evidence }],
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      });
    } catch {
      return templateExplanation(verdict, 'CALL_FAILED');
    }
    if (reply.stop_reason === 'refusal') return templateExplanation(verdict, 'REFUSED');
    if (reply.stop_reason === 'max_tokens') return templateExplanation(verdict, 'CUT_OFF');

    const raw = reply.content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('');
    let answer: unknown;
    try {
      answer = JSON.parse(raw);
    } catch {
      return templateExplanation(verdict, 'BAD_JSON');
    }
    const fields = typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>) : {};
    const explanation = fields['explanation'];
    const question = fields['installer_question'];
    if (typeof explanation !== 'string' || typeof question !== 'string') return templateExplanation(verdict, 'BAD_JSON');

    const problem = reviewAnswer(verdict, evidence, explanation, question);
    if (problem !== null) return templateExplanation(verdict, problem);
    return {
      source: 'model',
      explanation: explanation.trim(),
      installerQuestion: verdict.status === 'HOLD' ? question.trim() : null,
      model: reply.model,
      templateReason: null,
      usage: { inputTokens: reply.usage.input_tokens, outputTokens: reply.usage.output_tokens },
    };
  }

  return {
    explain(verdict: Verdict): Promise<Explanation> {
      const key = `${verdict.unitId}|${verdict.date}|${verdict.status}`;
      const earlier = saved.get(key);
      if (earlier !== undefined) return earlier;
      const pending = ask(verdict);
      saved.set(key, pending);
      return pending;
    },
  };
}
