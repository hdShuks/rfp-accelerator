import Anthropic from "@anthropic-ai/sdk";
import { RunBudget } from "./budget";
import { costUsd } from "./pricing";
import {
  callViaSubscription,
  subscriptionAvailable,
  SubscriptionError,
} from "./subscription";

export type ModelTier = "fast" | "reasoning" | "deep";

export const TIER_MODEL: Record<ModelTier, string> = {
  fast: "claude-haiku-4-5", // classification, extraction, structured parsing
  reasoning: "claude-sonnet-5", // synthesis, hypotheses, proposal skeleton
  deep: "claude-opus-5", // available; no playbook uses it by default
};

export type LlmMode = "api" | "subscription";

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "No way to reach Claude. Either paste an Anthropic API key in the UI (stored in your browser session only) / set ANTHROPIC_API_KEY, or run locally with the `claude` CLI logged into your subscription.",
    );
    this.name = "MissingApiKeyError";
  }
}

export function resolveApiKey(userKey?: string | null): string | null {
  return (userKey || process.env.ANTHROPIC_API_KEY || "").trim() || null;
}

/**
 * How this process will reach Claude, given an optional user-supplied key:
 *  - an API key (user's, or ANTHROPIC_API_KEY) -> "api"
 *  - else the local `claude` CLI on the user's subscription -> "subscription"
 *  - else nothing.
 */
export function resolveLlmMode(userKey?: string | null): LlmMode | null {
  if (resolveApiKey(userKey)) return "api";
  if (process.env.RFP_LLM_MODE !== "api" && subscriptionAvailable()) return "subscription";
  return null;
}

export function assertLlmReachable(userKey?: string | null): LlmMode {
  const mode = resolveLlmMode(userKey);
  if (!mode) throw new MissingApiKeyError();
  return mode;
}

export function describeLlmAvailability(): {
  apiKeyEnv: boolean;
  subscription: boolean;
} {
  return {
    apiKeyEnv: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    subscription: process.env.RFP_LLM_MODE !== "api" && subscriptionAvailable(),
  };
}

let cachedClient: { key: string; client: Anthropic } | null = null;

function clientFor(apiKey: string): Anthropic {
  if (cachedClient?.key === apiKey) return cachedClient.client;
  const client = new Anthropic({ apiKey });
  cachedClient = { key: apiKey, client };
  return client;
}

export interface CallOptions {
  /** user-supplied key; falls back to ANTHROPIC_API_KEY, then subscription CLI */
  apiKey?: string | null;
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
  mode: LlmMode;
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
 * One Claude call. Model chosen by tier; routed through the API (if a key is
 * available) or the local subscription CLI. Spend is recorded against the run
 * budget — for subscription mode the CLI reports $0, so we fall back to an
 * API-rate estimate from the token counts so the budget meter still works.
 */
export async function callClaude(opts: CallOptions): Promise<CallResult> {
  const { tier, system, prompt, budget, stepId = tier } = opts;
  budget?.assertWithinBudget(stepId);

  const mode = assertLlmReachable(opts.apiKey);
  const result =
    mode === "api"
      ? await callApi(opts, resolveApiKey(opts.apiKey) as string)
      : await callSubscription(opts);

  const estimate = costUsd(result.model, result.usage);
  const spend = result.costUsd > 0 ? result.costUsd : estimate;
  budget?.record(stepId, result.model, result.usage);

  return { ...result, mode, costUsd: spend };
}

async function callApi(
  opts: CallOptions,
  apiKey: string,
): Promise<Omit<CallResult, "mode">> {
  const model = TIER_MODEL[opts.tier];
  const maxTokens = opts.maxTokens ?? (opts.tier === "fast" ? 1024 : 8000);

  const body: Anthropic.MessageCreateParamsNonStreaming & {
    output_config?: { effort: string };
  } = {
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: opts.prompt }],
  };
  if (opts.tier !== "fast") {
    body.output_config = { effort: opts.effort ?? "medium" };
  }

  const res = await clientFor(apiKey).messages.create(body);
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return {
    text,
    model,
    usage: {
      input_tokens: res.usage.input_tokens ?? 0,
      output_tokens: res.usage.output_tokens ?? 0,
      cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0,
    },
    costUsd: 0,
    stopReason: res.stop_reason ?? null,
  };
}

async function callSubscription(opts: CallOptions): Promise<Omit<CallResult, "mode">> {
  try {
    const r = await callViaSubscription({
      tier: opts.tier,
      system: opts.system,
      prompt: opts.prompt,
      timeoutMs: opts.tier === "fast" ? 90_000 : 180_000,
    });
    return { ...r, costUsd: r.costUsd, stopReason: "end_turn" };
  } catch (err) {
    if (err instanceof SubscriptionError) throw err;
    throw new SubscriptionError(err instanceof Error ? err.message : String(err));
  }
}
