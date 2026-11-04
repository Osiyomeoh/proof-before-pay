// Measures what each hold rule costs on real windows. Usage: npm run eval
import { DEFAULT_RULES, judge } from '../src/proof/engine.ts';
import type { Rules } from '../src/proof/engine.ts';
import { commonDates, loadMauiFleet, MAUI_INVERTERS } from '../src/proof/maui.ts';

const fleet = loadMauiFleet();
const dates = commonDates(fleet);
const NO_GUARDS: Rules = { ...DEFAULT_RULES, peersDownShare: 0, minBaselineDrift: 0, minFleetYield: 0 };

function heldShare(rules: Rules): string {
  return MAUI_INVERTERS.map((unit) => {
    const scored = dates
      .map((date) => judge(fleet, unit, date, rules))
      .filter((v) => !v.reasons.some((r) => r.code === 'MISSING_DATA' || r.code === 'NOT_ENOUGH_HISTORY'));
    const held = scored.filter((v) => v.status === 'HOLD').length;
    return `inv${unit} ${((100 * held) / scored.length).toFixed(1)}% (n=${scored.length})`;
  }).join('  ');
}

const configs: readonly (readonly [string, Rules])[] = [
  ['spike rule only (mean + floor)', NO_GUARDS],
  ['+ peers down', { ...NO_GUARDS, peersDownShare: DEFAULT_RULES.peersDownShare }],
  ['+ baseline drift', { ...NO_GUARDS, minBaselineDrift: DEFAULT_RULES.minBaselineDrift }],
  ['+ fleet yield', { ...NO_GUARDS, minFleetYield: DEFAULT_RULES.minFleetYield }],
  ['all rules (default)', DEFAULT_RULES],
];
console.log('Windows held, days with enough history and complete data:');
for (const [name, rules] of configs) console.log(`  ${name.padEnd(32)} ${heldShare(rules)}`);

const counts = new Map<string, number>();
const guardWindows: string[] = [];
for (const unit of MAUI_INVERTERS) {
  for (const date of dates) {
    const verdict = judge(fleet, unit, date);
    for (const reason of verdict.reasons) counts.set(reason.code, (counts.get(reason.code) ?? 0) + 1);
    const guards = verdict.reasons
      .filter((r) => r.code === 'PEERS_DOWN' || r.code === 'BASELINE_DEGRADED' || r.code === 'FLEET_LOW_FOR_SUN')
      .map((r) => r.code);
    if (guards.length > 0) guardWindows.push(`inv${unit} ${date} ${guards.join('+')}`);
  }
}
console.log('\nReason counts across all windows (a window can have several):');
for (const [code, count] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${code.padEnd(22)} ${count}`);
console.log(`\nWindows caught by a guard: ${guardWindows.length}`);
for (const line of guardWindows.slice(0, 40)) console.log(`  ${line}`);
if (guardWindows.length > 40) console.log(`  ... ${guardWindows.length - 40} more`);

console.log('\nInverter 01 around the outage:');
const fmt = (n: number | null) => (n === null ? ' n/a' : n.toFixed(2));
for (const date of ['2020-10-07', '2020-10-08', '2020-10-12', '2020-10-23', '2020-10-25', '2020-11-07', '2020-11-18', '2020-11-19']) {
  const verdict = judge(fleet, '01', date);
  console.log(`  ${date} ${verdict.status.padEnd(13)} mean ${fmt(verdict.mean)}  ${verdict.reasons.map((r) => r.code).join(', ')}`);
}
