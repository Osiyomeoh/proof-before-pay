// Connects the explainer to Claude on AWS Bedrock. Credentials come from the default AWS chain
// (AWS_PROFILE on a Mac, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY when hosted).
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { createExplainer } from './explain.ts';
import type { CreateMessage } from './explain.ts';

const TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CALLS = 100;

export function createBedrockExplainer(env: Record<string, string | undefined> = process.env) {
  const awsRegion = env['AWS_REGION'];
  const model = env['BEDROCK_MODEL_ID'];
  // Sample mode: with no AWS settings the panel still works, from the labelled template.
  if (!awsRegion || !model) return createExplainer({ create: null, model: '' });

  const client = new AnthropicBedrock({ awsRegion, timeout: TIMEOUT_MS, maxRetries: 1 });
  const create: CreateMessage = async (request) => {
    const reply = await client.messages.create(request);
    return { stop_reason: reply.stop_reason, model: reply.model, usage: reply.usage, content: reply.content };
  };
  const limit = Number(env['BEDROCK_MAX_CALLS']);
  return createExplainer({ create, model, maxCalls: Number.isSafeInteger(limit) && limit >= 0 && env['BEDROCK_MAX_CALLS'] ? limit : DEFAULT_MAX_CALLS });
}
