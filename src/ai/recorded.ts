// Sample mode: serves real Bedrock answers saved by `npm run explain`, labelled as recorded.
// A saved answer is only used for the same date and verdict, and only if it still passes the same
// checks as a live one. Every other day gets the plain template.
import { readFileSync } from 'node:fs';
import type { Verdict } from '../proof/engine.ts';
import { buildEvidence, reviewAnswer, templateExplanation } from './explain.ts';
import type { Explanation } from './explain.ts';

type SavedAnswer = {
  date: string;
  status: string;
  source: string;
  explanation: string;
  installerQuestion: string | null;
  model: string | null;
};

const RUN_FILE = new URL('../../spike/explain-run.json', import.meta.url);

export function createRecordedExplainer(file: URL = RUN_FILE) {
  const { results } = JSON.parse(readFileSync(file, 'utf8')) as { results: SavedAnswer[] };
  return {
    async explain(verdict: Verdict): Promise<Explanation> {
      const saved = results.find((r) => r.source === 'model' && r.date === verdict.date && r.status === verdict.status);
      if (saved === undefined) return templateExplanation(verdict, 'NO_MODEL');
      const problem = reviewAnswer(verdict, JSON.stringify(buildEvidence(verdict)), saved.explanation, saved.installerQuestion ?? '');
      if (problem !== null) return templateExplanation(verdict, problem);
      return {
        source: 'recorded',
        explanation: saved.explanation,
        installerQuestion: verdict.status === 'HOLD' ? saved.installerQuestion : null,
        model: saved.model,
        templateReason: null,
        usage: null,
      };
    },
  };
}
