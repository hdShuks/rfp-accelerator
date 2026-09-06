// First-party Anthropic API rates, USD per 1M tokens. Keep in sync with
// https://docs.claude.com/en/docs/about-claude/pricing
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number; // ~1.25x input
  cacheRead: number; // ~0.1x input
}

export const PRICING: Record<string, ModelPrice> = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-opus-5": { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
};

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function costUsd(model: string, usage: TokenUsage): number {
  const p = PRICING[model];
  if (!p) return 0;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cw = usage.cache_creation_input_tokens ?? 0;
  const cr = usage.cache_read_input_tokens ?? 0;
  return (
    (input * p.input +
      output * p.output +
      cw * p.cacheWrite +
      cr * p.cacheRead) /
    1_000_000
  );
}
