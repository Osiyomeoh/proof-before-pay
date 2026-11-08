// Every recorded day for one inverter, with our verdict beside a simpler rule. This is only for reading:
// a release never looks here, and asks the engine again.
import { reasonLabel } from './describe.ts';
import { DEFAULT_RULES, addDays, judge } from './engine.ts';
import type { Fleet, Rules, Verdict } from './engine.ts';

export type OneGoodDay = 'PAYS' | 'NO' | 'NO_CALL';

export type LedgerRow = {
  date: string;
  kwh: number | null;
  peerMedianKwh: number | null;
  sun: number | null;
  share: number | null;
  belowFloor: boolean;
  mean: number | null;
  status: Verdict['status'];
  reasons: string;
  oneGoodDay: OneGoodDay;
  disagree: boolean;
};

// The rule we compare with: pay as soon as one day reaches the share our rule asks of a whole week.
// With too little history or no share for the day, it makes no call, so short history can't inflate the difference.
export function oneGoodDay(verdict: Verdict, rules: Rules = DEFAULT_RULES): OneGoodDay {
  const ratio = verdict.window.at(-1)?.ratio ?? null;
  if (ratio === null || verdict.historyDays < rules.minHistoryDays) return 'NO_CALL';
  return ratio >= rules.minMean ? 'PAYS' : 'NO';
}

const rounded = (value: number | null | undefined) => (value === null || value === undefined ? null : Math.round(value * 1000) / 1000);

function rowFor(fleet: Fleet, unitId: string, date: string, rules: Rules): LedgerRow {
  const verdict = judge(fleet, unitId, date, rules);
  const today = verdict.window.at(-1);
  const simple = oneGoodDay(verdict, rules);
  const share = today?.ratio ?? null;
  return {
    date,
    kwh: rounded(today?.kwh),
    peerMedianKwh: rounded(today?.peerMedianKwh),
    sun: rounded(today?.sun),
    share: rounded(share),
    belowFloor: share !== null && share < rules.dayFloor,
    mean: rounded(verdict.mean),
    status: verdict.status,
    reasons: verdict.reasons.map(reasonLabel).join(', '),
    oneGoodDay: simple,
    disagree: simple === 'PAYS' && verdict.status === 'HOLD',
  };
}

export type RaceDay = { date: string; share: number | null; belowFloor: boolean; noReading: boolean; ours: Verdict['status']; simple: 'WAITING' | 'PAID' };

export type Race = {
  from: string;
  through: string;
  end: string;
  amountCents: number;
  simplePaidOn: string | null;
  oursReadyOn: string | null;
  underFloorSincePaid: number;
  noReadingSincePaid: number;
  days: RaceDay[];
};

// One milestone's money under both rules, day by day from its first judged day through the day being judged.
// The simple rule pays on the first day it says PAYS, and a capture can't be taken back, so every later day
// only shows what the inverter made after the money had gone. `end` is where the drawing stops, never data.
export function rulesRace(rows: readonly LedgerRow[], from: string, through: string, end: string, amountCents: number): Race {
  let simplePaidOn: string | null = null;
  let oursReadyOn: string | null = null;
  let underFloorSincePaid = 0;
  let noReadingSincePaid = 0;
  const days: RaceDay[] = [];
  for (const row of rows) {
    if (row.date < from || row.date > through) continue;
    const noReading = row.kwh === null;
    if (simplePaidOn !== null) {
      if (row.belowFloor) underFloorSincePaid += 1;
      if (noReading) noReadingSincePaid += 1;
    }
    if (simplePaidOn === null && row.oneGoodDay === 'PAYS') simplePaidOn = row.date;
    if (oursReadyOn === null && row.status === 'RELEASE_READY') oursReadyOn = row.date;
    days.push({ date: row.date, share: row.share, belowFloor: row.belowFloor, noReading, ours: row.status, simple: simplePaidOn === null ? 'WAITING' : 'PAID' });
  }
  return { from, through, end: end > through ? end : through, amountCents, simplePaidOn, oursReadyOn, underFloorSincePaid, noReadingSincePaid, days };
}

// Built once, because a verdict can't change once its day has passed. Calendar days with no reading stay in as rows,
// so a gap shows up as a gap. It gives way to other requests as it goes, because this runs on a small shared CPU.
export function createLedger(fleet: Fleet, unitId: string, lastDate: string, rules: Rules = DEFAULT_RULES) {
  let built: Promise<readonly LedgerRow[]> | null = null;

  async function build(): Promise<readonly LedgerRow[]> {
    const rows: LedgerRow[] = [];
    let date = Object.keys(fleet[unitId] ?? {}).sort()[0];
    while (date !== undefined && date <= lastDate) {
      rows.push(rowFor(fleet, unitId, date, rules));
      if (rows.length % 25 === 0) await new Promise((resolve) => setImmediate(resolve));
      date = addDays(date, 1);
    }
    return rows;
  }

  return {
    through: async (date: string): Promise<readonly LedgerRow[]> => (await (built ??= build())).filter((row) => row.date <= date),
  };
}
