// Real Bedrock calls through the real claim splitter, one for each preset installer reply on the page.
//   npm run excuse
// Prints each split and the findings for the Oct 12, 2020 hold, then saves spike/excuse-run.json,
// which sample mode serves as recorded answers. Makes at most 5 model calls, 500 output tokens each.
import { writeFileSync } from 'node:fs';
import { createBedrockSplitter } from '../src/ai/bedrock.ts';
import { checkClaim, claimContext, loadMauiLogger } from '../src/proof/claims.ts';
import { DEFAULT_RULES, judge } from '../src/proof/engine.ts';
import { MAUI_INVERTERS, loadMauiFleet } from '../src/proof/maui.ts';
import { EXCUSE_PRESETS } from '../src/server/demo.ts';

process.loadEnvFile(new URL('../.env', import.meta.url));
const fleet = loadMauiFleet();
const logger = loadMauiLogger(MAUI_INVERTERS);
const verdict = judge(fleet, '01', '2020-10-12');
const context = claimContext(verdict, fleet, logger, DEFAULT_RULES.dayFloor);

const splitter = createBedrockSplitter();
const results = [];
for (const { reply } of EXCUSE_PRESETS) {
  const started = Date.now();
  const split = await splitter.split(reply);
  const ms = Date.now() - started;
  console.log(`\n"${reply}"\n  source: ${split.source}${split.fallbackReason ? ` (${split.fallbackReason})` : ''}, ${ms} ms`);
  for (const claim of split.claims) console.log(`  ${claim.kind}: "${claim.quote}" -> ${checkClaim(claim.kind, claim.quote, context).finding}`);
  results.push({ reply, ms, ...split });
}
const kept = results.filter((result) => result.source === 'model').length;
console.log(`\nkept ${kept} of ${results.length} model splits`);
writeFileSync(new URL('../spike/excuse-run.json', import.meta.url), `${JSON.stringify({ ranAt: new Date().toISOString(), kept, total: results.length, results }, null, 2)}\n`);
