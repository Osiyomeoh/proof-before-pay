// Readings come from the real Maui data. Where a test needs a fault the data doesn't contain,
// it edits a copy of the real data and says so in the test name.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RULES, judge } from '../src/proof/engine.ts';
import type { Fleet, Reading, Rules, Verdict } from '../src/proof/engine.ts';
import { commonDates, loadMauiFleet, MAUI_INVERTERS } from '../src/proof/maui.ts';

const fleet = loadMauiFleet();
const UNIT = '01';
// Oct 5, 2020 is in the healthy stretch before the outage.
const HEALTHY = '2020-10-05';
const GUARDS_OFF: Rules = { ...DEFAULT_RULES, peersDownShare: 0, minBaselineDrift: 0, minFleetYield: 0 };

function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function windowEnding(date: string): string[] {
  const start = new Date(`${date}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 6);
  return dateRange(start.toISOString().slice(0, 10), date);
}

function edit(
  source: Fleet,
  unitIds: readonly string[],
  dates: readonly string[],
  change: (reading: Reading) => Reading | undefined,
): Fleet {
  const copy: Record<string, Record<string, Reading>> = {};
  for (const [id, series] of Object.entries(source)) copy[id] = { ...series };
  for (const id of unitIds) {
    const series = copy[id] as Record<string, Reading>;
    for (const date of dates) {
      const reading = series[date];
      if (!reading) continue;
      const next = change(reading);
      if (next) series[date] = next;
      else delete series[date];
    }
  }
  return copy;
}

const codes = (v: Verdict) => v.reasons.map((r) => r.code);
const peersOf = (unit: string) => MAUI_INVERTERS.filter((id) => id !== unit);

test('the week before the outage is RELEASE_READY, so the outage tests below mean something', () => {
  for (const date of dateRange('2020-10-01', '2020-10-07')) {
    const verdict = judge(fleet, UNIT, date);
    assert.equal(verdict.status, 'RELEASE_READY', `${date}: ${codes(verdict).join()}`);
    assert.deepEqual(verdict.reasons, []);
  }
});

test('Oct 8, 2020, the collapse, is HOLD because of that one day', () => {
  const verdict = judge(fleet, UNIT, '2020-10-08');
  assert.equal(verdict.status, 'HOLD');
  const floor = verdict.reasons.find((r) => r.code === 'DAY_BELOW_FLOOR');
  assert.ok(floor && floor.code === 'DAY_BELOW_FLOOR');
  assert.deepEqual(floor.dates, ['2020-10-08']);
  // The mean alone would still pass here. The daily floor is what catches it.
  assert.ok((verdict.mean as number) >= DEFAULT_RULES.minMean);
});

test('Oct 9 to 21, 2020, at zero output, is HOLD', () => {
  for (const date of dateRange('2020-10-09', '2020-10-21')) {
    assert.equal(judge(fleet, UNIT, date).status, 'HOLD', date);
    assert.equal(fleet[UNIT]?.[date]?.kwh, 0, `${date} should be a zero day in the data`);
  }
});

test('Oct 22 to 25, 2020, the 4-day recovery, stays HOLD', () => {
  for (const date of dateRange('2020-10-22', '2020-10-25')) {
    assert.ok((fleet[UNIT]?.[date]?.kwh as number) > 10, `${date} should have production in the data`);
    assert.equal(judge(fleet, UNIT, date).status, 'HOLD', date);
  }
});

test('Nov 18, 2020 is HOLD while the window has a zero day, and Nov 19 is RELEASE_READY', () => {
  const nov18 = judge(fleet, UNIT, '2020-11-18');
  assert.equal(nov18.status, 'HOLD');
  assert.equal(fleet[UNIT]?.['2020-11-12']?.kwh, 0);
  assert.ok(codes(nov18).includes('DAY_BELOW_FLOOR'));

  const nov19 = judge(fleet, UNIT, '2020-11-19');
  assert.equal(nov19.status, 'RELEASE_READY', codes(nov19).join());
});

test('real missing days in the data, Nov 5 and 6, 2020, are HOLD and named', () => {
  assert.equal(fleet[UNIT]?.['2020-11-05'], undefined);
  const verdict = judge(fleet, UNIT, '2020-11-07');
  assert.equal(verdict.status, 'HOLD');
  const missing = verdict.reasons.find((r) => r.code === 'MISSING_DATA');
  assert.ok(missing && missing.code === 'MISSING_DATA');
  assert.deepEqual(missing.dates, ['2020-11-05', '2020-11-06']);
});

test('removing one healthy day from real data turns a pass into HOLD', () => {
  assert.equal(judge(fleet, UNIT, HEALTHY).status, 'RELEASE_READY');
  const gapInUnit = edit(fleet, [UNIT], [HEALTHY], () => undefined);
  assert.ok(codes(judge(gapInUnit, UNIT, HEALTHY)).includes('MISSING_DATA'));
  const gapInPeer = edit(fleet, ['07'], [HEALTHY], () => undefined);
  assert.ok(codes(judge(gapInPeer, UNIT, HEALTHY)).includes('MISSING_DATA'));
  assert.equal(judge(gapInUnit, UNIT, HEALTHY).status, 'HOLD');
  assert.equal(judge(gapInPeer, UNIT, HEALTHY).status, 'HOLD');
});

test('bad readings edited into real data can only produce HOLD', () => {
  const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1];
  for (const kwh of bad) {
    const broken = edit(fleet, [UNIT], [HEALTHY], (r) => ({ ...r, kwh }));
    assert.equal(judge(broken, UNIT, HEALTHY).status, 'HOLD', `unit kwh ${kwh}`);
    const brokenPeer = edit(fleet, ['02'], [HEALTHY], (r) => ({ ...r, kwh }));
    assert.equal(judge(brokenPeer, UNIT, HEALTHY).status, 'HOLD', `peer kwh ${kwh}`);
  }
  for (const sun of [null, 0, -1, Number.NaN]) {
    const broken = edit(fleet, [UNIT], [HEALTHY], (r) => ({ ...r, sun }));
    assert.equal(judge(broken, UNIT, HEALTHY).status, 'HOLD', `sun ${sun}`);
  }
});

test('every peer at zero, edited into real data, is HOLD and never a divide-by-zero pass', () => {
  const peersZero = edit(fleet, peersOf(UNIT), windowEnding(HEALTHY), (r) => ({ ...r, kwh: 0 }));
  const verdict = judge(peersZero, UNIT, HEALTHY);
  assert.equal(verdict.status, 'HOLD');
  assert.ok(codes(verdict).includes('PEERS_DOWN'));
  assert.equal(verdict.mean, null);

  const oneDay = edit(fleet, peersOf(UNIT), [HEALTHY], (r) => ({ ...r, kwh: 0 }));
  assert.ok(codes(judge(oneDay, UNIT, HEALTHY)).includes('PEERS_DOWN'));

  const allZero = edit(fleet, MAUI_INVERTERS, windowEnding(HEALTHY), (r) => ({ ...r, kwh: 0 }));
  assert.equal(judge(allZero, UNIT, HEALTHY).status, 'HOLD');
});

test('peers near zero, edited into real data, are HOLD and do not inflate the ratio', () => {
  const nearZero = edit(fleet, peersOf(UNIT), [HEALTHY], (r) => ({ ...r, kwh: 0.001 }));
  const verdict = judge(nearZero, UNIT, HEALTHY);
  assert.equal(verdict.status, 'HOLD');
  assert.ok(codes(verdict).includes('PEERS_DOWN'));
});

test('a new install with too little history is HOLD at every point', () => {
  const firstDates = commonDates(fleet).slice(0, 36);
  for (const date of firstDates) {
    const verdict = judge(fleet, UNIT, date);
    assert.equal(verdict.status, 'HOLD', date);
    assert.ok(verdict.historyDays < DEFAULT_RULES.minHistoryDays, date);
    assert.ok(codes(verdict).includes('NOT_ENOUGH_HISTORY'), date);
  }
});

test('later data can never change a verdict', () => {
  const later = commonDates(fleet).filter((d) => d > HEALTHY);
  const without = edit(fleet, MAUI_INVERTERS, later, () => undefined);
  const zeroed = edit(fleet, MAUI_INVERTERS, later, (r) => ({ ...r, kwh: 0 }));
  const expected = judge(fleet, UNIT, HEALTHY);
  assert.deepEqual(judge(without, UNIT, HEALTHY), expected);
  assert.deepEqual(judge(zeroed, UNIT, HEALTHY), expected);
});

test('the baseline ignores the window being judged', () => {
  const verdict = judge(fleet, UNIT, HEALTHY);
  const inWindow = edit(fleet, [UNIT], windowEnding(HEALTHY), (r) => ({ ...r, kwh: r.kwh * 0.9 }));
  assert.equal(judge(inWindow, UNIT, HEALTHY).baseline, verdict.baseline);
});

test('a long low stretch edited into real data cannot make low output look normal', () => {
  // 30 real days, then 60 days at 10% of real output. The median baseline sinks to the low level.
  const dates = commonDates(fleet);
  const low = dates.slice(30, 90);
  const date = low[low.length - 1] as string;
  const degraded = edit(fleet, [UNIT], low, (r) => ({ ...r, kwh: r.kwh * 0.1 }));

  assert.equal(judge(degraded, UNIT, date, GUARDS_OFF).status, 'RELEASE_READY', 'without the guard this pays out');
  const verdict = judge(degraded, UNIT, date);
  assert.equal(verdict.status, 'HOLD');
  assert.ok(codes(verdict).includes('BASELINE_DEGRADED'));
});

test('the whole site at 10%, edited into real data, is HOLD even though share of peers looks normal', () => {
  const week = windowEnding(HEALTHY);
  const siteDown = edit(fleet, MAUI_INVERTERS, week, (r) => ({ ...r, kwh: r.kwh * 0.1 }));

  assert.equal(judge(siteDown, UNIT, HEALTHY, GUARDS_OFF).status, 'RELEASE_READY', 'without the guard this pays out');
  const verdict = judge(siteDown, UNIT, HEALTHY);
  assert.equal(verdict.status, 'HOLD');
  assert.ok(codes(verdict).includes('FLEET_LOW_FOR_SUN'));
});

test('invalid requests are HOLD and do not throw', () => {
  for (const date of ['', 'yesterday', '2020-13-01', '2020-02-30', '2020-10-5']) {
    assert.deepEqual(codes(judge(fleet, UNIT, date)), ['INVALID_DATE'], date);
  }
  assert.deepEqual(codes(judge(fleet, 'nope', HEALTHY)), ['UNKNOWN_UNIT']);
  assert.deepEqual(codes(judge({}, UNIT, HEALTHY)), ['UNKNOWN_UNIT']);
});

test('fewer than two peers is HOLD', () => {
  const pair: Fleet = { [UNIT]: fleet[UNIT] as Fleet[string], '02': fleet['02'] as Fleet[string] };
  const verdict = judge(pair, UNIT, HEALTHY);
  assert.equal(verdict.status, 'HOLD');
  assert.ok(codes(verdict).includes('TOO_FEW_PEERS'));
});

test('dates with no data at all are HOLD', () => {
  assert.equal(judge(fleet, UNIT, '1999-01-01').status, 'HOLD');
  assert.equal(judge(fleet, UNIT, '2040-01-01').status, 'HOLD');
});

test('across all real windows, RELEASE_READY always means the rule was met on a full window', () => {
  let ready = 0;
  for (const unit of MAUI_INVERTERS) {
    for (const date of commonDates(fleet)) {
      const verdict = judge(fleet, unit, date);
      if (verdict.status !== 'RELEASE_READY') {
        assert.ok(verdict.reasons.length > 0, `${unit} ${date} held with no reason`);
        continue;
      }
      ready += 1;
      assert.deepEqual(verdict.reasons, []);
      assert.equal(verdict.window.length, DEFAULT_RULES.windowDays);
      assert.ok((verdict.mean as number) >= DEFAULT_RULES.minMean);
      assert.ok(verdict.historyDays >= DEFAULT_RULES.minHistoryDays);
      for (const day of verdict.window) assert.ok((day.ratio as number) >= DEFAULT_RULES.dayFloor);
    }
  }
  assert.ok(ready > 0);
});

test('Feb 17, 2023, a real day with all four inverters at zero, is HOLD', () => {
  for (const id of MAUI_INVERTERS) assert.equal(fleet[id]?.['2023-02-17']?.kwh, 0, `inv${id}`);
  for (const unit of MAUI_INVERTERS) {
    const verdict = judge(fleet, unit, '2023-02-17');
    assert.equal(verdict.status, 'HOLD', `inv${unit}`);
    assert.ok(codes(verdict).includes('PEERS_DOWN'), `inv${unit}`);
  }
});

test('Jan 12, 2020, a real day with the median peer at zero, is HOLD for the next week too', () => {
  assert.equal(fleet['02']?.['2020-01-12']?.kwh, 0);
  assert.equal(fleet['03']?.['2020-01-12']?.kwh, 0);
  assert.ok((fleet[UNIT]?.['2020-01-12']?.kwh as number) > 0);
  for (const date of dateRange('2020-01-12', '2020-01-18')) {
    const verdict = judge(fleet, UNIT, date);
    assert.equal(verdict.status, 'HOLD', date);
    assert.ok(codes(verdict).includes('PEERS_DOWN'), date);
  }
});

test('Nov 14, 2021, a real day with the median peer at 0.4 kWh, is HOLD', () => {
  // Inverter 01 made 7.2 kWh, 18 times the median peer. Dividing by that would inflate the mean.
  const verdict = judge(fleet, UNIT, '2021-11-14');
  assert.equal(verdict.status, 'HOLD');
  assert.ok(codes(verdict).includes('PEERS_DOWN'));
});

test('without the new guards, the engine matches spike/verdict.py', () => {
  const heldPercent: Record<string, string> = {};
  const windows: Record<string, number> = {};
  for (const unit of MAUI_INVERTERS) {
    const scored = commonDates(fleet)
      .map((date) => judge(fleet, unit, date, GUARDS_OFF))
      .filter((v) => !codes(v).includes('MISSING_DATA') && !codes(v).includes('NOT_ENOUGH_HISTORY'));
    windows[unit] = scored.length;
    heldPercent[unit] = ((100 * scored.filter((v) => v.status === 'HOLD').length) / scored.length).toFixed(1);
  }
  assert.deepEqual(windows, { '01': 1598, '02': 1598, '03': 1598, '07': 1598 });
  assert.deepEqual(heldPercent, { '01': '4.5', '02': '4.3', '03': '5.3', '07': '2.4' });

  const outage = commonDates(fleet)
    .filter((d) => d >= '2020-10-01' && d <= '2020-12-01')
    .filter((d) => judge(fleet, UNIT, d, GUARDS_OFF).status === 'HOLD');
  assert.equal(outage[0], '2020-10-08');
  assert.equal(outage[outage.length - 1], '2020-11-18');
});
