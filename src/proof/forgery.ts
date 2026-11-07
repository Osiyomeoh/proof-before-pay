// A what-if for the demo: rewrites the low days in a held window to look normal, re-runs the engine
// on that copy, and compares the forged totals with the logger's DC voltage. It changes nothing:
// the real fleet, verdict and hold are untouched, and it reads no day after the one being judged.
import type { Logger } from './claims.ts';
import { DEFAULT_RULES, addDays, judge, median } from './engine.ts';
import type { Fleet, Verdict } from './engine.ts';

const MIN_CLAIMED_KWH = 5;
const USUAL_DAYS = 30;

export type ForgedDay = { date: string; realKwh: number; forgedKwh: number; dcMaxV: number | null; flagged: boolean };
export type ForgeryResult = { date: string; forgedStatus: Verdict['status']; usualDcPeakV: number | null; days: ForgedDay[]; flagged: number };

export function forgeryTest(verdict: Verdict, fleet: Fleet, logger: Logger, dayFloor = DEFAULT_RULES.dayFloor): ForgeryResult {
  const unit = verdict.unitId;
  const own = fleet[unit] ?? {};
  const peers = Object.keys(fleet).filter((id) => id !== unit);
  const start = verdict.window[0]?.date ?? verdict.date;

  // This inverter's usual share of the others' median, and its usual DC peak on producing days, both from before the window.
  const shares: number[] = [];
  const peaks: number[] = [];
  for (let k = 1; k <= 120 && (shares.length < USUAL_DAYS || peaks.length < USUAL_DAYS); k += 1) {
    const date = addDays(start, -k);
    const kwh = own[date]?.kwh;
    if (typeof kwh !== 'number' || kwh <= 0) continue;
    const values = peers.map((id) => fleet[id]?.[date]?.kwh);
    if (shares.length < USUAL_DAYS && values.every((v): v is number => typeof v === 'number') && median(values) > 0) shares.push(kwh / median(values));
    const peak = logger[unit]?.[date]?.[2];
    if (peaks.length < USUAL_DAYS && typeof peak === 'number') peaks.push(peak);
  }
  const usualDcPeakV = peaks.length >= USUAL_DAYS / 2 ? median(peaks) : null;
  const share = shares.length >= USUAL_DAYS / 2 ? median(shares) : null;

  const forgedSeries = { ...own };
  const days: ForgedDay[] = [];
  for (const day of verdict.window) {
    const reading = own[day.date];
    if (share === null || reading === undefined || day.kwh === null || day.peerMedianKwh === null || day.ratio === null || day.ratio >= dayFloor) continue;
    const forgedKwh = Math.round(share * day.peerMedianKwh * 10) / 10;
    forgedSeries[day.date] = { ...reading, kwh: forgedKwh };
    const dcMaxV = logger[unit]?.[day.date]?.[2] ?? null;
    days.push({ date: day.date, realKwh: day.kwh, forgedKwh, dcMaxV, flagged: forgedKwh >= MIN_CLAIMED_KWH && dcMaxV !== null && usualDcPeakV !== null && dcMaxV < usualDcPeakV / 2 });
  }
  const forged = judge({ ...fleet, [unit]: forgedSeries }, unit, verdict.date);
  return { date: verdict.date, forgedStatus: forged.status, usualDcPeakV, days, flagged: days.filter((d) => d.flagged).length };
}
