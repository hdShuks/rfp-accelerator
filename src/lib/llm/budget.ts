import { costUsd, type TokenUsage } from "./pricing";

export class BudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly ceilingUsd: number,
    readonly step: string,
  ) {
    super(
      `Run budget exhausted at step "${step}": $${spentUsd.toFixed(4)} spent of $${ceilingUsd.toFixed(2)} ceiling.`,
    );
    this.name = "BudgetExceededError";
  }
}

export interface StepCost {
  step: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/**
 * Tracks token/USD spend across an orchestration run and enforces a hard
 * ceiling. Call `assertWithinBudget()` before each model call and `record()`
 * after.
 */
export class RunBudget {
  private steps: StepCost[] = [];

  constructor(readonly ceilingUsd: number) {}

  get spentUsd(): number {
    return this.steps.reduce((s, x) => s + x.usd, 0);
  }

  get breakdown(): StepCost[] {
    return [...this.steps];
  }

  /** Throw if we're already over budget (checked before spending more). */
  assertWithinBudget(nextStep: string): void {
    if (this.spentUsd >= this.ceilingUsd) {
      throw new BudgetExceededError(this.spentUsd, this.ceilingUsd, nextStep);
    }
  }

  record(step: string, model: string, usage: TokenUsage): StepCost {
    const entry: StepCost = {
      step,
      model,
      inputTokens:
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
      usd: costUsd(model, usage),
    };
    this.steps.push(entry);
    return entry;
  }
}
