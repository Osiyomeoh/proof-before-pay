// The ledger on the real Maui data: it must agree with the engine, leave gaps visible and stay honest about the comparison.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_RULES, judge } from '../src/proof/engine.ts';
import type { Fleet } from '../src/proof/engine.ts';
import { createLedger, oneGoodDay, rulesRace } from '../src/proof/ledger.ts';
import { commonDates, loadMauiFleet } from '../src/proof/maui.ts';

const fleet = loadMauiFleet();
const lastDate = commonDates(fleet).at(-1) as string;
const rows = await createLedger(fleet, '01', lastDate).through(lastDate);
const on = (date: string) => {
  const row = rows.find((r) => r.date === date);
  assert.ok(row, date);
  return row;
};

test('every row agrees with the engine on that day', () => {
  for (const row of rows) {
    const verdict = judge(fleet, '01', row.date);
    assert.equal(row.status, verdict.status, row.date);
    assert.equal(row.oneGoodDay, oneGoodDay(verdict), row.date);
    assert.equal(row.disagree, row.oneGoodDay === 'PAYS' && verdict.status === 'HOLD', row.date);
  }
});

test('the rows cover every calendar day, in order, so a gap in the data stays visible', () => {
  const first = new Date(`${rows[0]?.date}T00:00:00Z`).getTime();
  rows.forEach((row, k) => assert.equal(new Date(`${row.date}T00:00:00Z`).getTime(), first + k * 86_400_000));
  for (const date of ['2020-11-05', '2020-11-06']) {
    assert.equal(on(date).kwh, null, `${date} has no daily total`);
    assert.equal(on(date).status, 'HOLD');
    assert.equal(on(date).oneGoodDay, 'NO_CALL');
  }
});

test('both pay rules on the same $40.00: one good day pays on Oct 23, this check on Nov 19', () => {
  const race = rulesRace(rows, '2020-10-12', '2020-11-19', '2020-11-19', 4000);
  assert.equal(race.simplePaidOn, '2020-10-23');
  assert.equal(race.oursReadyOn, '2020-11-19');
  assert.equal(race.days.length, 39);
  // After the simple rule paid: 16 days at zero, and Nov 5 and 6 with no daily total.
  assert.equal(race.underFloorSincePaid, 16);
  assert.equal(race.noReadingSincePaid, 2);
  assert.deepEqual(race.days.filter((d) => d.noReading).map((d) => d.date), ['2020-11-05', '2020-11-06']);
  for (const day of race.days.filter((d) => d.date > '2020-10-23' && d.belowFloor)) assert.equal(on(day.date).kwh, 0, day.date);
  // A capture can't be taken back, so the simple rule stays paid on every later day.
  for (const day of race.days) assert.equal(day.simple, day.date >= '2020-10-23' ? 'PAID' : 'WAITING', day.date);
});

test('the race stops at the day being judged, and only its drawing reaches further', () => {
  const race = rulesRace(rows, '2020-10-12', '2020-10-22', '2020-11-19', 4000);
  assert.equal(race.days.at(-1)?.date, '2020-10-22');
  assert.equal(race.days.length, 11);
  assert.equal(race.simplePaidOn, null);
  assert.equal(race.end, '2020-11-19');
  // An end before the day judged is moved up to it.
  assert.equal(rulesRace(rows, '2020-10-12', '2020-11-25', '2020-11-19', 4000).end, '2020-11-25');
});

test('through a date, no later row is returned', async () => {
  const ledger = createLedger(fleet, '01', lastDate);
  const until = await ledger.through('2020-10-12');
  assert.equal(until.at(-1)?.date, '2020-10-12');
  assert.ok(until.every((row) => row.date <= '2020-10-12'));
});

test('during the real outage, one good day pays on Oct 23-24 and from Nov 14, and ours is never ready', () => {
  const outage = rows.filter((r) => r.date >= '2020-10-08' && r.date <= '2020-11-18');
  assert.deepEqual(outage.filter((r) => r.status === 'RELEASE_READY').map((r) => r.date), []);
  assert.deepEqual(outage.filter((r) => r.oneGoodDay === 'PAYS').map((r) => r.date), ['2020-10-23', '2020-10-24', '2020-11-14', '2020-11-15', '2020-11-16', '2020-11-17', '2020-11-18']);
  // Oct 26 to Nov 12 was back at zero, so Oct 23-24 would have paid too early. The Nov 14-18 production really had returned, so there ours is only slower.
  assert.equal(on('2020-11-19').status, 'RELEASE_READY');
});

test('the whole record: how often each rule says yes, and the limit of both', () => {
  assert.equal(rows.length, 1730);
  assert.equal(rows.filter((r) => r.status === 'RELEASE_READY').length, 1510);
  assert.equal(rows.filter((r) => r.oneGoodDay === 'PAYS').length, 1599);
  assert.equal(rows.filter((r) => r.disagree).length, 90);
  // Ours can't see the future either: the 7 days before the outage began were all ready.
  for (const day of ['01', '02', '03', '04', '05', '06', '07']) assert.equal(on(`2020-10-${day}`).status, 'RELEASE_READY');
});

test('a day with too little history makes no call, so it can\'t inflate the difference', () => {
  const early = rows[0];
  assert.equal(early?.oneGoodDay, 'NO_CALL');
  assert.equal(early?.disagree, false);
  const fresh: Fleet = { a: { '2020-01-01': { kwh: 10, sun: 5 } }, b: { '2020-01-01': { kwh: 10, sun: 5 } }, c: { '2020-01-01': { kwh: 10, sun: 5 } } };
  assert.equal(oneGoodDay(judge(fresh, 'a', '2020-01-01')), 'NO_CALL');
});

test('the wording on the page matches the rule values', () => {
  const page = readFileSync(new URL('../public/ledger.js', import.meta.url), 'utf8');
  assert.equal(DEFAULT_RULES.windowDays, 7);
  assert.match(page, new RegExp(`at least ${DEFAULT_RULES.minMean * 100}% of the usual share, with no day under ${DEFAULT_RULES.dayFloor * 100}%`));
});

test('the roof-wide figure on the page matches the saved fleet run', () => {
  const run = JSON.parse(readFileSync(new URL('../spike/eval-fleet.json', import.meta.url), 'utf8')) as {
    inverters: string[];
    total: { days: number; ours: { pays: number; relapses: number }; oneGoodDay: { pays: number; relapses: number }; onlyOneGoodDay: { pays: number } };
  };
  const page = readFileSync(new URL('../public/ledger.js', import.meta.url), 'utf8');
  const pct = (t: { pays: number; relapses: number }) => `${((100 * t.relapses) / t.pays).toFixed(1)}%`;
  assert.ok(page.includes(`Across ${run.inverters.length} inverters on this roof and ${run.total.days.toLocaleString('en-US')} judged days:`));
  assert.ok(page.includes(`within 14 days ${pct(run.total.ours)} of the time. For the one-good-day rule it was ${pct(run.total.oneGoodDay)}.`));
  assert.ok(page.includes(`ours held ${run.total.onlyOneGoodDay.pays} days`));
});
