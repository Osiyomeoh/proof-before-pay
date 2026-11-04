// Real Bedrock calls through the real explainer, one for each kind of verdict the Maui data produces.
//   npm run explain
// Prints every answer and whether the checks kept it, then saves the results to spike/explain-run.json.
// Makes at most 12 model calls, with at most 400 output tokens each.
import { writeFileSync } from 'node:fs';
import { createBedrockExplainer } from '../src/ai/bedrock.ts';
import { judge } from '../src/proof/engine.ts';
import type { Verdict } from '../src/proof/engine.ts';
import { commonDates, loadMauiFleet } from '../src/proof/maui.ts';

process.loadEnvFile(new URL('../.env', import.meta.url));
const fleet = loadMauiFleet();

const chosen = new Map<string, Verdict>();
for (const date of ['2020-10-08', '2020-10-12', '2020-10-23', '2020-11-18', '2020-11-19']) {
  chosen.set(date, judge(fleet, '01', date));
}
// Add the first real date for each hold reason not already covered.
const covered = new Set([...chosen.values()].flatMap((verdict) => verdict.reasons.map((reason) => reason.code)));
for (const date of commonDates(fleet)) {
  const verdict = judge(fleet, '01', date);
  if (verdict.reasons.some((reason) => !covered.has(reason.code))) {
    for (const reason of verdict.reasons) covered.add(reason.code);
    chosen.set(date, verdict);
  }
  if (chosen.size >= 12) break;
}

const explainer = createBedrockExplainer();
const results = [];
for (const [date, verdict] of chosen) {
  const started = Date.now();
  const shown = await explainer.explain(verdict);
  const ms = Date.now() - started;
  console.log(`\n${date} ${verdict.status} [${verdict.reasons.map((reason) => reason.code).join(', ')}]`);
  console.log(`  source: ${shown.source}${shown.templateReason ? ` (${shown.templateReason})` : ''}, ${ms} ms, ${shown.usage?.inputTokens ?? 0} in, ${shown.usage?.outputTokens ?? 0} out`);
  console.log(`  ${shown.explanation}`);
  if (shown.installerQuestion) console.log(`  Q: ${shown.installerQuestion}`);
  results.push({ date, status: verdict.status, reasons: verdict.reasons.map((reason) => reason.code), ms, ...shown });
}

const kept = results.filter((result) => result.source === 'model').length;
const tokens = results.reduce((sum, result) => sum + (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0), 0);
console.log(`\nkept ${kept} of ${results.length} model answers; ${tokens} tokens in total`);
writeFileSync(new URL('../spike/explain-run.json', import.meta.url), `${JSON.stringify({ ranAt: new Date().toISOString(), kept, total: results.length, tokens, results }, null, 2)}\n`);
