import { describe, expect, it } from "vitest";
import { RunBudget, BudgetExceededError } from "./budget";
import { costUsd } from "./pricing";

describe("costUsd", () => {
  it("prices input, output and cache tokens per model rate", () => {
    // haiku: $1/1M in, $5/1M out
    const c = costUsd("claude-haiku-4-5", { input_tokens: 1_000_000, output_tokens: 200_000 });
    expect(c).toBeCloseTo(1.0 + 1.0, 6); // $1 in + $1 out
  });

  it("returns 0 for an unknown model rather than NaN", () => {
    expect(costUsd("mystery-model", { input_tokens: 100 })).toBe(0);
  });
});

describe("RunBudget", () => {
  it("accumulates spend and exposes a per-step breakdown", () => {
    const b = new RunBudget(1.0);
    b.record("classify", "claude-haiku-4-5", { input_tokens: 10_000, output_tokens: 500 });
    b.record("synthesis", "claude-sonnet-5", { input_tokens: 20_000, output_tokens: 4_000 });
    expect(b.breakdown).toHaveLength(2);
    expect(b.spentUsd).toBeGreaterThan(0);
    expect(b.spentUsd).toBeCloseTo(
      costUsd("claude-haiku-4-5", { input_tokens: 10_000, output_tokens: 500 }) +
        costUsd("claude-sonnet-5", { input_tokens: 20_000, output_tokens: 4_000 }),
      9,
    );
  });

  it("counts cache tokens toward the step input total", () => {
    const b = new RunBudget(1.0);
    const entry = b.record("s", "claude-sonnet-5", {
      input_tokens: 100,
      cache_read_input_tokens: 900,
      output_tokens: 10,
    });
    expect(entry.inputTokens).toBe(1000);
  });

  it("throws once spend reaches the ceiling", () => {
    const b = new RunBudget(0.01);
    b.record("big", "claude-opus-5", { input_tokens: 2_000_000, output_tokens: 0 }); // $10
    expect(() => b.assertWithinBudget("next")).toThrow(BudgetExceededError);
  });

  it("does not throw while under the ceiling", () => {
    const b = new RunBudget(5.0);
    b.record("small", "claude-haiku-4-5", { input_tokens: 1000, output_tokens: 100 });
    expect(() => b.assertWithinBudget("next")).not.toThrow();
  });
});
