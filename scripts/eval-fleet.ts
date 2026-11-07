// Compares two pay rules on every real day across the Maui roof. Usage: npm run eval:fleet
// Each inverter is judged against the other inverters, on every day all of them reported.
// There is no fault log for this site, so this is not accuracy. It counts how often each rule
// would have paid on a day that was followed, within 14 days, by a day under the 30% floor.
// Two inverters are left out (see spike/SPIKE-FLEET.md). inv06: in all 218,543 of its raw rows the
// "AC kWh" column equals its AC voltage divided by 1000, so it has no energy reading. inv11: in
// 236,874 of the 236,906 minutes it shares with inv04, all five values match inv04's, so it isn't
// an independent peer and would count inv04 twice.
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_RULES, judge } from '../src/proof/engine.ts';
import type { Fleet, Reading } from '../src/proof/engine.ts';
import { oneGoodDay } from '../src/proof/ledger.ts';
import { commonDates } from '../src/proof/maui.ts';

const INVERTERS = ['01', '02', '03', '04', '05', '07', '08', '09', '10'] as const;
const LEFT_OUT = {
  '06': 'AC kWh column equals AC voltage / 1000 in every row',
  '11': 'repeats inv04: all five values match in 236,874 of 236,906 shared minutes',
};
const LOOKAHEAD_DAYS = 14;

const fleet: Record<string, Record<string, Reading>> = {};
for (const id of INVERTERS) {
  const { days } = JSON.parse(readFileSync(new URL(`../data/maui-2105/daily_inv${id}.json`, import.meta.url), 'utf8')) as { days: Record<string, [number, number]> };
  fleet[id] = Object.fromEntries(Object.entries(days).map(([date, [kwh, sun]]) => [date, { kwh, sun }]));
}
const dates = commonDates(fleet as Fleet);

type Tally = { pays: number; relapses: number };
const tally = (): Tally => ({ pays: 0, relapses: 0 });
const total = { ours: tally(), oneGoodDay: tally(), onlyOneGoodDay: tally(), days: 0 };
const perInverter: Array<{ id: string; days: number; ours: Tally; oneGoodDay: Tally; onlyOneGoodDay: Tally }> = [];

for (const id of INVERTERS) {
  const verdicts = dates.map((date) => judge(fleet as Fleet, id, date));
  const row = { id, days: 0, ours: tally(), oneGoodDay: tally(), onlyOneGoodDay: tally() };
  verdicts.forEach((verdict, k) => {
    const simple = oneGoodDay(verdict);
    const scored = !verdict.reasons.some((r) => r.code === 'MISSING_DATA' || r.code === 'NOT_ENOUGH_HISTORY');
    if (!scored || simple === 'NO_CALL') return;
    // Only judge days with a full lookahead, so the end of the data can't hide a relapse.
    const ahead = verdicts.slice(k + 1, k + 1 + LOOKAHEAD_DAYS);
    if (ahead.length < LOOKAHEAD_DAYS) return;
    const relapse = ahead.some((later) => {
      const ratio = later.window.at(-1)?.ratio ?? null;
      return ratio !== null && ratio < DEFAULT_RULES.dayFloor;
    });
    row.days += 1;
    const count = (t: Tally) => { t.pays += 1; if (relapse) t.relapses += 1; };
    if (verdict.status === 'RELEASE_READY') count(row.ours);
    if (simple === 'PAYS') count(row.oneGoodDay);
    if (simple === 'PAYS' && verdict.status !== 'RELEASE_READY') count(row.onlyOneGoodDay);
  });
  perInverter.push(row);
  total.days += row.days;
  for (const key of ['ours', 'oneGoodDay', 'onlyOneGoodDay'] as const) {
    total[key].pays += row[key].pays;
    total[key].relapses += row[key].relapses;
  }
}

const pct = (t: Tally) => (t.pays === 0 ? 'n/a' : `${((100 * t.relapses) / t.pays).toFixed(1)}%`);
console.log(`${INVERTERS.length} inverters, ${dates.length} shared days, ${total.days} judged inverter-days (inv06 and inv11 left out)`);
console.log(`Paid, then a day under the ${DEFAULT_RULES.dayFloor * 100}% floor within ${LOOKAHEAD_DAYS} days:`);
console.log(`  ours                       ${total.ours.relapses} of ${total.ours.pays} paying days (${pct(total.ours)})`);
console.log(`  one good day               ${total.oneGoodDay.relapses} of ${total.oneGoodDay.pays} paying days (${pct(total.oneGoodDay)})`);
console.log(`  one good day, ours held    ${total.onlyOneGoodDay.relapses} of ${total.onlyOneGoodDay.pays} days (${pct(total.onlyOneGoodDay)})`);
for (const r of perInverter) console.log(`  inv${r.id} ${String(r.days).padStart(5)} days  ours ${pct(r.ours).padStart(6)} of ${r.ours.pays}  one good day ${pct(r.oneGoodDay).padStart(6)} of ${r.oneGoodDay.pays}  only one good day ${pct(r.onlyOneGoodDay).padStart(6)} of ${r.onlyOneGoodDay.pays}`);

writeFileSync(new URL('../spike/eval-fleet.json', import.meta.url), `${JSON.stringify({
  ranAt: new Date().toISOString(),
  inverters: INVERTERS,
  leftOut: LEFT_OUT,
  sharedDays: dates.length,
  firstDate: dates[0],
  lastDate: dates.at(-1),
  lookaheadDays: LOOKAHEAD_DAYS,
  dayFloor: DEFAULT_RULES.dayFloor,
  total,
  perInverter,
}, null, 2)}\n`);
