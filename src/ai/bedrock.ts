// Connects the explainer to Claude on AWS Bedrock. Credentials come from the default AWS chain
// (AWS_PROFILE on a Mac, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY when hosted).
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { createClaimSplitter } from './excuse.ts';
import { createExplainer } from './explain.ts';
import type { CreateMessage } from './explain.ts';

const TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CALLS = 100;

type Settings = { create: CreateMessage | null; model: string; maxCalls: number };

function settings(env: Record<string, string | undefined>): Settings {
  const awsRegion = env['AWS_REGION'];
  const model = env['BEDROCK_MODEL_ID'];
  // Sample mode: with no AWS settings the panels still work, from the labelled fallbacks.
  if (!awsRegion || !model) return { create: null, model: '', maxCalls: 0 };

  const client = new AnthropicBedrock({ awsRegion, timeout: TIMEOUT_MS, maxRetries: 1 });
  const create: CreateMessage = async (request) => {
    const reply = await client.messages.create(request);
    return { stop_reason: reply.stop_reason, model: reply.model, usage: reply.usage, content: reply.content };
  };
  const limit = Number(env['BEDROCK_MAX_CALLS']);
  return { create, model, maxCalls: Number.isSafeInteger(limit) && limit >= 0 && env['BEDROCK_MAX_CALLS'] ? limit : DEFAULT_MAX_CALLS };
}

export function createBedrockExplainer(env: Record<string, string | undefined> = process.env) {
  return createExplainer(settings(env));
}

// Each of the two has its own call limit.
export function createBedrockSplitter(env: Record<string, string | undefined> = process.env) {
  return createClaimSplitter(settings(env));
}
