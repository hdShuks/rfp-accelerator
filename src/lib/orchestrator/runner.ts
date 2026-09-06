import { randomUUID } from "node:crypto";
import { getFinancialSummary, getNarrative, EdgarError } from "@/lib/edgar";
import { callClaude, type ModelTier } from "@/lib/llm/anthropic";
import { RunBudget, BudgetExceededError } from "@/lib/llm/budget";
import { getPlaybook } from "@/lib/playbooks/loader";
import { topoOrder, type Playbook, type Step } from "@/lib/playbooks/schema";
import { classify } from "./classifier";
import { financialSummaryToMarkdown, narrativeToMarkdown } from "./format";
import { buildResearchPrompt, buildSynthesisPrompt, SYSTEM_PROMPT } from "./prompts";
import type { Artifact, RunEvent, RunInput } from "./types";

const DEFAULT_TIER: Record<Step["tool"], ModelTier> = {
  edgar_financials: "fast",
  edgar_narrative: "fast",
  llm_research: "reasoning",
  llm_synthesis: "reasoning",
};

function ceilingUsd(): number {
  return Number(process.env.MAX_RUN_USD) || 0.5;
}

function pickTicker(step: Step, input: RunInput): { field: string; value: string | undefined } {
  const field = step.inputs?.ticker ?? "clientTicker";
  const value = (input as unknown as Record<string, unknown>)[field] as string | undefined;
  return { field, value: value?.trim() || undefined };
}

/**
 * Run one orchestration as an async event stream. The whole pipeline executes
 * inside this generator; the caller (SSE route) forwards each event to the
 * client. Halts cleanly on budget exhaustion, returning partial artifacts.
 */
export async function* runOrchestration(
  input: RunInput,
  apiKey?: string | null,
): AsyncGenerator<RunEvent, void, void> {
  const runId = randomUUID();
  const budget = new RunBudget(ceilingUsd());

  let playbook: Playbook;
  let classification;
  try {
    classification = await classify(input, apiKey, budget);
    playbook = await getPlaybook(classification.type);
  } catch (err) {
    yield { type: "run_failed", runId, error: errMsg(err) };
    return;
  }

  const order = topoOrder(playbook);
  const stepById = new Map(playbook.steps.map((s) => [s.id, s]));
  const artifacts = new Map<string, Artifact>();

  yield {
    type: "run_started",
    runId,
    playbookId: playbook.id,
    playbookName: playbook.name,
    classification,
    steps: order.map((id) => ({ id, title: stepById.get(id)!.title ?? id })),
  };
  yield budgetEvent(budget);

  let halted = false;
  let haltReason: string | undefined;

  for (const stepId of order) {
    const step = stepById.get(stepId)!;
    const title = step.title ?? step.id;
    yield { type: "step_started", stepId, title, tool: step.tool };

    // If a dependency failed to produce an artifact, skip synthesis steps.
    const deps = step.depends_on.map((d) => artifacts.get(d)).filter(Boolean) as Artifact[];
    if (step.depends_on.length && deps.length === 0) {
      yield { type: "step_failed", stepId, error: "All upstream steps failed; nothing to synthesise." };
      continue;
    }

    try {
      const artifact = yield* runStep(step, input, playbook, deps, apiKey, budget);
      artifacts.set(stepId, artifact);
      yield { type: "step_completed", stepId, artifact };
      yield budgetEvent(budget);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        halted = true;
        haltReason = err.message;
        yield { type: "step_failed", stepId, error: err.message };
        break;
      }
      yield { type: "step_failed", stepId, error: errMsg(err) };
    }
  }

  const ordered = order.map((id) => artifacts.get(id)).filter(Boolean) as Artifact[];
  const proposal = ordered.find((a) => a.kind === "proposal_skeleton") ?? null;

  yield {
    type: "run_completed",
    runId,
    halted,
    haltReason,
    proposalMarkdown: proposal?.markdown ?? null,
    artifacts: ordered,
    spentUsd: budget.spentUsd,
  };
}

async function* runStep(
  step: Step,
  input: RunInput,
  playbook: Playbook,
  deps: Artifact[],
  apiKey: string | null | undefined,
  budget: RunBudget,
): AsyncGenerator<RunEvent, Artifact, void> {
  const tier: ModelTier = step.model_tier ?? DEFAULT_TIER[step.tool];
  const title = step.title ?? step.id;

  switch (step.tool) {
    case "edgar_financials": {
      const { field, value } = pickTicker(step, input);
      if (!value) throw new EdgarError(`Step "${step.id}" needs input "${field}", which was not provided.`);
      yield { type: "step_progress", stepId: step.id, message: `Fetching EDGAR companyfacts for ${value}…` };
      const summary = await getFinancialSummary(value);
      return {
        stepId: step.id,
        title,
        kind: "financial_summary",
        data: summary,
        markdown: financialSummaryToMarkdown(summary),
      };
    }

    case "edgar_narrative": {
      const { field, value } = pickTicker(step, input);
      if (!value) throw new EdgarError(`Step "${step.id}" needs input "${field}", which was not provided.`);
      yield { type: "step_progress", stepId: step.id, message: `Fetching latest 10-K for ${value}…` };
      const narrative = await getNarrative(value);
      return {
        stepId: step.id,
        title,
        kind: "narrative_extract",
        data: narrative,
        markdown: narrativeToMarkdown(narrative),
      };
    }

    case "llm_research": {
      yield { type: "step_progress", stepId: step.id, message: `Researching (${tier})…` };
      const res = await callClaude({
        apiKey,
        tier,
        system: SYSTEM_PROMPT,
        prompt: buildResearchPrompt(step, input),
        budget,
        stepId: step.id,
      });
      return {
        stepId: step.id,
        title,
        kind: "research_note",
        markdown: res.text,
        model: res.model,
        costUsd: res.costUsd,
      };
    }

    case "llm_synthesis": {
      yield { type: "step_progress", stepId: step.id, message: `Synthesising ${deps.length} artifact(s) (${tier})…` };
      const res = await callClaude({
        apiKey,
        tier,
        system: SYSTEM_PROMPT,
        prompt: buildSynthesisPrompt(step, input, playbook, deps),
        effort: step.id === "proposal_skeleton" ? "high" : "medium",
        budget,
        stepId: step.id,
      });
      return {
        stepId: step.id,
        title,
        kind: step.id === "proposal_skeleton" ? "proposal_skeleton" : "synthesis_note",
        markdown: res.text,
        model: res.model,
        costUsd: res.costUsd,
      };
    }
  }
}

function budgetEvent(budget: RunBudget): RunEvent {
  return {
    type: "budget_update",
    spentUsd: budget.spentUsd,
    ceilingUsd: budget.ceilingUsd,
    breakdown: budget.breakdown,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
