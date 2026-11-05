// The ledger on the real Maui data: it must agree with the engine, leave gaps visible and stay honest about the comparison.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_RULES, judge } from '../src/proof/engine.ts';
import type { Fleet } from '../src/proof/engine.ts';
import { createLedger, oneGoodDay } from '../src/proof/ledger.ts';
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
