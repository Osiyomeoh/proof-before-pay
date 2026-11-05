// The demo contract and the read-only view the UI renders. The view is built on the server from the
// real data, and it never includes a day after the date being judged.
import { niceDate, reasonSentence } from '../proof/describe.ts';
import { addDays, median } from '../proof/engine.ts';
import type { Fleet, Verdict } from '../proof/engine.ts';
import type { Contract, Milestone, MilestoneStatus, NewMilestone, Proof, TimelineEntry } from '../payments/service.ts';

export const DEMO_UNIT = '01';
export const DEMO_START = '2020-10-12'; // inverter 01 at 0.0 kWh during the real outage
export const DAYS_BETWEEN_MILESTONES = 30;
const HISTORY_DAYS = 45;

export const DEMO_DESCRIPTION = 'Proof Before Pay demo: solar install milestones';

export const DEMO_MILESTONES: readonly NewMilestone[] = [
  { title: 'System producing', amountCents: 4000, unitId: DEMO_UNIT, proofDate: DEMO_START },
  { title: `Still producing ${DAYS_BETWEEN_MILESTONES} days later`, amountCents: 6000, unitId: DEMO_UNIT, proofDate: DEMO_START },
];

// Points in the real outage worth stopping at. Dates come from spike/SPIKE-PHYSICS.md and test/engine.test.ts.
export const STORY_STOPS = [
  { date: '2020-10-22', label: 'Output returns' },
  { date: '2020-10-26', label: 'Back to zero' },
  { date: '2020-11-19', label: 'A healthy week' },
] as const;

const SETTLED: readonly MilestoneStatus[] = ['PENDING', 'CAPTURED', 'REFUNDED', 'REVERSED'];
const MONEY_OUT: readonly MilestoneStatus[] = ['PENDING', 'CAPTURED', 'CAPTURING', 'CAPTURE_UNKNOWN'];

export function currentIndex(contract: Contract): number {
  return contract.milestones.findIndex((m) => !SETTLED.includes(m.status));
}

// The first date a milestone can be judged: it opens a set number of days after the one before it.
export function opensOn(contract: Contract, index: number): string | null {
  const previous = contract.milestones[index - 1];
  return previous === undefined ? null : addDays(previous.proofDate, DAYS_BETWEEN_MILESTONES);
}

// The newest day the buyer has seen so far. Nothing newer may reach the browser.
export function seenDate(contract: Contract): string {
  return contract.milestones.map((m) => m.proofDate).sort().at(-1) ?? DEMO_START;
}

export type HistoryDay = { date: string; kwh: number | null; peerMedianKwh: number | null; sun: number | null };

export function recordedHistory(fleet: Fleet, unitId: string, until: string, days = HISTORY_DAYS): HistoryDay[] {
  const peers = Object.keys(fleet).filter((id) => id !== unitId);
  return Array.from({ length: days }, (_, k) => {
    const date = addDays(until, k - days + 1);
    const own = fleet[unitId]?.[date];
    const readings = peers.map((id) => fleet[id]?.[date]?.kwh).filter((kwh): kwh is number => typeof kwh === 'number');
    return {
      date,
      kwh: own?.kwh ?? null,
      peerMedianKwh: readings.length === peers.length && readings.length > 0 ? median(readings) : null,
      sun: own?.sun ?? null,
    };
  });
}

export type MilestoneView = {
  id: string;
  title: string;
  amountCents: number;
  status: MilestoneStatus;
  captureId: string | null;
  lastError: string | null;
  proofDate: string;
  isCurrent: boolean;
  opensOn: string | null;
  verdict: (Verdict & { reasonText: string[] }) | null;
};

export type ContractView = {
  id: string;
  mode: 'sample' | 'sandbox';
  description: string;
  currency: string;
  status: Contract['status'];
  approveUrl: string | null;
  authorizationId: string | null;
  expiresAt: string | null;
  totalCents: number;
  heldCents: number;
  releasedCents: number;
  returnedCents: number;
  clock: { date: string; label: string; lastDate: string; waitingUntil: string | null; stops: Array<{ date: string; label: string }> };
  milestones: MilestoneView[];
  history: HistoryDay[];
  timeline: TimelineEntry[];
  source: { unit: string; site: string };
};

function milestoneView(contract: Contract, milestone: Milestone, index: number, current: number, proof: Proof): MilestoneView {
  const opens = opensOn(contract, index);
  const isCurrent = index === current;
  // A later milestone has no verdict until its own date, so nothing old is shown as its result.
  const judgeable = isCurrent && (opens === null || milestone.proofDate >= opens);
  const verdict = judgeable ? proof(milestone.unitId, milestone.proofDate) : null;
  return {
    id: milestone.id,
    title: milestone.title,
    amountCents: milestone.amountCents,
    status: milestone.status,
    captureId: milestone.captureId,
    lastError: milestone.lastError,
    proofDate: milestone.proofDate,
    isCurrent,
    opensOn: opens,
    verdict: verdict === null ? null : { ...verdict, reasonText: verdict.reasons.map(reasonSentence) },
  };
}

export function buildView(contract: Contract, proof: Proof, fleet: Fleet, mode: ContractView['mode'], lastDate: string): ContractView {
  const current = currentIndex(contract);
  const milestones = contract.milestones.map((m, index) => milestoneView(contract, m, index, current, proof));
  const live = milestones[current];

  const seen = seenDate(contract);
  const waitingUntil = live !== undefined && live.opensOn !== null && live.proofDate < live.opensOn ? live.opensOn : null;
  const stops = waitingUntil !== null
    ? [{ date: waitingUntil, label: `Next check, ${DAYS_BETWEEN_MILESTONES} days on` }]
    : STORY_STOPS.filter((stop) => stop.date > seen).map((stop) => ({ ...stop }));

  const released = contract.milestones.filter((m) => MONEY_OUT.includes(m.status)).reduce((sum, m) => sum + m.amountCents, 0);
  const remaining = contract.totalCents - released;
  const isHeld = contract.status === 'HELD';

  return {
    id: contract.id,
    mode,
    description: contract.description,
    currency: contract.currency,
    status: contract.status,
    approveUrl: contract.approveUrl,
    authorizationId: contract.authorizationId,
    expiresAt: contract.expiresAt,
    totalCents: contract.totalCents,
    heldCents: isHeld ? remaining : 0,
    releasedCents: released,
    returnedCents: contract.status === 'VOIDED' ? remaining : 0,
    clock: { date: seen, label: niceDate(seen), lastDate, waitingUntil, stops },
    milestones,
    history: recordedHistory(fleet, DEMO_UNIT, seen),
    timeline: contract.timeline,
    source: { unit: `Inverter ${DEMO_UNIT}`, site: 'Maui Ocean Center, NREL PVDAQ system 2105: a real 110 kW commercial roof' },
  };
}
