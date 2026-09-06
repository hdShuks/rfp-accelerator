import Anthropic from "@anthropic-ai/sdk";
import { RunBudget } from "./budget";

export type ModelTier = "fast" | "reasoning" | "deep";

export const TIER_MODEL: Record<ModelTier, string> = {
  fast: "claude-haiku-4-5", // classification, extraction, structured parsing
  reasoning: "claude-sonnet-5", // synthesis, hypotheses, proposal skeleton
  deep: "claude-opus-5", // available; no playbook uses it by default
};

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "No Anthropic API key. Paste your key in the UI (stored in your browser session only) or set ANTHROPIC_API_KEY for local dev.",
    );
    this.name = "MissingApiKeyError";
  }
}

export function resolveApiKey(userKey?: string | null): string {
  const key = (userKey || process.env.ANTHROPIC_API_KEY || "").trim();
  if (!key) throw new MissingApiKeyError();
  return key;
}

let cachedClient: { key: string; client: Anthropic } | null = null;

function clientFor(apiKey: string): Anthropic {
  if (cachedClient?.key === apiKey) return cachedClient.client;
  const client = new Anthropic({ apiKey });
  cachedClient = { key: apiKey, client };
  return client;
}

export interface CallOptions {
  apiKey: string;
  tier: ModelTier;
  system: string;
  prompt: string;
  maxTokens?: number;
  /** effort for the reasoning/deep tiers; ignored for `fast` (Haiku rejects it) */
  effort?: "low" | "medium" | "high";
  budget?: RunBudget;
  stepId?: string;
}

export interface CallResult {
  text: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  costUsd: number;
  stopReason: string | null;
}

/**
 * One Claude call, model chosen by tier, spend recorded against the run budget.
 * The system prompt is marked cacheable — it's identical across steps and runs.
 */
export async function callClaude(opts: CallOptions): Promise<CallResult> {
  const { apiKey, tier, system, prompt, budget, stepId = tier } = opts;
  const model = TIER_MODEL[tier];
  const maxTokens = opts.maxTokens ?? (tier === "fast" ? 1024 : 8000);

  budget?.assertWithinBudget(stepId);

  const body: Anthropic.MessageCreateParamsNonStreaming & {
    output_config?: { effort: string };
  } = {
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: prompt }],
  };

  if (tier !== "fast") {
    // effort lives inside output_config; Haiku rejects it entirely.
    body.output_config = { effort: opts.effort ?? "medium" };
  }

  const res = await clientFor(apiKey).messages.create(body);

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const usage = {
    input_tokens: res.usage.input_tokens ?? 0,
    output_tokens: res.usage.output_tokens ?? 0,
    cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0,
  };

  const recorded = budget?.record(stepId, model, usage);

  return {
    text,
    model,
    usage,
    costUsd: recorded?.usd ?? 0,
    stopReason: res.stop_reason ?? null,
  };
}
