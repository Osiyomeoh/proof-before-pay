// The neighbour contract: a neighbour buys one inverter's measured output for four weeks. PayPal holds
// the most it could cost, each week is billed at a fixed demo price once its last day is recorded,
// a person taps to capture it, and the unused hold goes back at the end.
// Four weeks, because a PayPal authorization is valid for 29 days:
// https://developer.paypal.com/docs/checkout/standard/customize/authorization/
import { niceDate } from '../proof/describe.ts';
import { addDays } from '../proof/engine.ts';
import type { Fleet } from '../proof/engine.ts';
import { billCents, readMeter } from '../proof/meter.ts';
import type { MeterDay } from '../proof/meter.ts';
import type { Contract, MilestoneStatus, NewMilestone, TimelineEntry } from '../payments/service.ts';
import { remainingCents } from '../payments/service.ts';
import { DEMO_SOURCE, DEMO_UNIT, MONEY_OUT, currentIndex, recordedHistory, seenDate } from './demo.ts';
import type { HistoryDay } from './demo.ts';

// Inverter 01 was healthy in the week of Sep 28, 2020, failed on Oct 8, was at zero from Oct 9 to 21,
// and came back on Oct 22 to 25 (spike/SPIKE-PHYSICS.md, result 1).
export const NEIGHBOUR_START = '2020-09-28';
export const NEIGHBOUR_WEEKS = 4;
// A demo price, not a tariff.
export const PRICE_CENTS_PER_KWH = 10;
// Above inverter 01's best full week of 2020 before this window, 289.6 kWh as the meter reads it
// (test/neighbour.test.ts), so a healthy week is billed in full and the hold covers it.
export const WEEK_CAP_KWH = 300;
const WEEK_CAP_CENTS = WEEK_CAP_KWH * PRICE_CENTS_PER_KWH;

export const NEIGHBOUR_DESCRIPTION = 'Proof Before Pay demo: a neighbour buys measured solar power';

export const NEIGHBOUR_MILESTONES: readonly NewMilestone[] = Array.from({ length: NEIGHBOUR_WEEKS }, (_, i) => {
  const from = addDays(NEIGHBOUR_START, 7 * i);
  return {
    title: `Week ${i + 1}`,
    amountCents: WEEK_CAP_CENTS,
    unitId: DEMO_UNIT,
    // The day before the week, so none of its days has been seen yet.
    proofDate: addDays(from, -1),
    metering: { from, through: addDays(from, 6), priceCentsPerKwh: PRICE_CENTS_PER_KWH, capCents: WEEK_CAP_CENTS },
  };
});

export type WeekView = {
  id: string;
  title: string;
  from: string;
  through: string;
  status: MilestoneStatus;
  captureId: string | null;
  lastError: string | null;
  isCurrent: boolean;
  // Every day of the week has been recorded, so it can be billed.
  due: boolean;
  capCents: number;
  // The days of this week seen so far, and what they come to. Final once the week is due.
  days: MeterDay[];
  tenths: number;
  cents: number;
  missingDays: number;
};

export type NeighbourView = {
  kind: 'neighbour';
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
  clock: { date: string; label: string; lastDate: string; waitingUntil: null; stops: Array<{ date: string; label: string }> };
  weeks: WeekView[];
  history: HistoryDay[];
  timeline: TimelineEntry[];
  source: { unit: string; site: string };
  terms: { priceCentsPerKwh: number; capKwh: number; weeks: number; start: string };
};

export function buildNeighbourView(contract: Contract, fleet: Fleet, mode: NeighbourView['mode'], lastDate: string): NeighbourView {
  const current = currentIndex(contract);
  const seen = seenDate(contract);
  const weeks = contract.milestones.flatMap((m, index): WeekView[] => {
    if (m.metering === null) return [];
    const { from, through, priceCentsPerKwh, capCents } = m.metering;
    // Never a day after the newest one seen.
    const reading = readMeter(fleet, m.unitId, from, through < seen ? through : seen);
    const billed = m.billedTenths !== null;
    return [{
      id: m.id,
      title: m.title,
      from,
      through,
      status: m.status,
      captureId: m.captureId,
      lastError: m.lastError,
      isCurrent: index === current,
      due: m.proofDate >= through,
      capCents,
      days: reading.days,
      tenths: billed ? (m.billedTenths ?? 0) : reading.tenths,
      cents: billed ? m.amountCents : billCents(reading.tenths, priceCentsPerKwh, capCents),
      missingDays: reading.missingDays,
    }];
  });

  const live = weeks[current];
  const isHeld = contract.status === 'HELD';
  const stops = isHeld && live !== undefined && !live.due ? [{ date: live.through, label: `End of ${live.title.toLowerCase()}` }] : [];
  const released = contract.milestones.filter((m) => MONEY_OUT.includes(m.status)).reduce((sum, m) => sum + m.amountCents, 0);
  const remaining = remainingCents(contract);

  return {
    kind: 'neighbour',
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
    clock: { date: seen, label: niceDate(seen), lastDate, waitingUntil: null, stops },
    weeks,
    history: recordedHistory(fleet, DEMO_UNIT, seen),
    timeline: contract.timeline,
    source: DEMO_SOURCE,
    terms: { priceCentsPerKwh: PRICE_CENTS_PER_KWH, capKwh: WEEK_CAP_KWH, weeks: NEIGHBOUR_WEEKS, start: NEIGHBOUR_START },
  };
}
