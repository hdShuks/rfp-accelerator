import { randomUUID } from "node:crypto";
import { callClaude, type ModelTier } from "@/lib/llm/anthropic";
import { RunBudget, BudgetExceededError } from "@/lib/llm/budget";
import { getPlaybook } from "@/lib/playbooks/loader";
import { topoOrder, type Playbook, type Step } from "@/lib/playbooks/schema";
import { classify } from "./classifier";
import { financialsArtifact, narrativeOrProfileArtifact } from "./company";
import { appendLearningRecord } from "./learning";
import { planSteps } from "./planner";
import { buildResearchPrompt, buildSynthesisPrompt, SYSTEM_PROMPT } from "./prompts";
import type { StepCost } from "@/lib/llm/budget";
import type { Artifact, CompanyRef, RunEvent, RunInput } from "./types";

const DEFAULT_TIER: Record<Step["tool"], ModelTier> = {
  edgar_financials: "fast",
  edgar_narrative: "fast",
  llm_research: "reasoning",
  llm_synthesis: "reasoning",
};

function ceilingUsd(): number {
  return Number(process.env.MAX_RUN_USD) || 0.5;
}

function clientRef(input: RunInput): CompanyRef {
  return {
    name: input.clientName,
    ticker: input.clientTicker?.trim() || undefined,
    notes: input.clientNotes,
    documents: input.clientDocuments,
  };
}

/** id used for one iteration of a for_each step's artifact/event stream */
function subId(stepId: string, index: number): string {
  return `${stepId}::${index}`;
}

export interface ResumeOptions {
  /** Reuse an existing run id (resuming a run already tracked in the store) instead of minting a new one. */
  runId?: string;
  /**
   * Artifacts already produced for these concrete step ids in a prior
   * attempt — replayed as `step_completed` instead of recomputed. Keyed by
   * the same id the step would otherwise be stamped with (`subId()` for a
   * `for_each` iteration), so a partially-completed fan-out resumes only the
   * targets that hadn't finished. If the freshly-planned steps don't line up
   * with these ids (planner picked a different plan on resume), the affected
   * steps simply recompute — never incorrect, just not free.
   */
  resumeArtifacts?: Map<string, Artifact>;
  /** Spend already recorded in a prior attempt, so the budget ceiling accounts for it rather than resetting. */
  resumeSpent?: StepCost[];
}

/**
 * Run one orchestration as an async event stream. The whole pipeline executes
 * inside this generator; the caller (the run store's background executor)
 * persists and forwards each event to any listening client. Halts cleanly on
 * budget exhaustion, returning partial artifacts — and can be resumed via
 * `opts.resumeArtifacts`/`resumeSpent` from wherever it left off.
 */
export async function* runOrchestration(
  input: RunInput,
  apiKey?: string | null,
  opts: ResumeOptions = {},
): AsyncGenerator<RunEvent, void, void> {
  const runId = opts.runId ?? randomUUID();
  const budget = new RunBudget(ceilingUsd(), opts.resumeSpent ?? []);
  const resumeArtifacts = opts.resumeArtifacts ?? new Map<string, Artifact>();

  let basePlaybook: Playbook;
  let classification;
  try {
    classification = await classify(input, apiKey, budget);
    basePlaybook = await getPlaybook(classification.type);
  } catch (err) {
    yield { type: "run_failed", runId, error: errMsg(err) };
    return;
  }

  const { steps: plannedSteps, summary: plan } = await planSteps(basePlaybook, input, apiKey, budget);
  const playbook: Playbook = { ...basePlaybook, steps: plannedSteps };

  const order = topoOrder(playbook);
  const stepById = new Map(playbook.steps.map((s) => [s.id, s]));
  const artifacts = new Map<string, Artifact>();

  yield {
    type: "run_started",
    runId,
    playbookId: playbook.id,
    playbookName: playbook.name,
    classification,
    // for_each steps aren't pre-listed — their rows appear as they start,
    // one per target, since we don't know a stable count until here.
    steps: order
      .filter((id) => !stepById.get(id)!.for_each)
      .map((id) => ({ id, title: stepById.get(id)!.title ?? id })),
  };
  yield { type: "plan_ready", plan };
  yield budgetEvent(budget);

  let halted = false;
  let haltReason: string | undefined;

  const resolveDeps = (step: Step): Artifact[] => {
    const deps: Artifact[] = [];
    for (const depId of step.depends_on) {
      if (stepById.get(depId)?.for_each) {
        for (const [key, artifact] of artifacts) {
          if (key.startsWith(`${depId}::`)) deps.push(artifact);
        }
      } else {
        const a = artifacts.get(depId);
        if (a) deps.push(a);
      }
    }
    return deps;
  };

  outer: for (const stepId of order) {
    const step = stepById.get(stepId)!;
    const title = step.title ?? step.id;
    const deps = resolveDeps(step);
    if (step.depends_on.length && deps.length === 0) {
      yield { type: "step_failed", stepId, error: "All upstream steps failed; nothing to synthesise." };
      continue;
    }

    if (step.for_each === "targets") {
      const targets = input.targets ?? [];
      if (targets.length === 0) {
        yield { type: "step_failed", stepId, error: `"${title}" needs at least one target, but none were provided.` };
        continue;
      }
      for (let i = 0; i < targets.length; i++) {
        const id = subId(stepId, i);
        const itemTitle = `${title} — ${targets[i].name}`;
        const cached = resumeArtifacts.get(id);
        if (cached) {
          yield { type: "step_started", stepId: id, title: itemTitle, tool: step.tool };
          artifacts.set(id, cached);
          yield { type: "step_completed", stepId: id, artifact: cached };
          yield budgetEvent(budget);
          continue;
        }
        yield { type: "step_started", stepId: id, title: itemTitle, tool: step.tool };
        try {
          const artifact = yield* runStep(step, input, playbook, deps, apiKey, budget, {
            target: targets[i],
            id,
            title: itemTitle,
          });
          artifacts.set(id, artifact);
          yield { type: "step_completed", stepId: id, artifact };
          yield budgetEvent(budget);
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            halted = true;
            haltReason = err.message;
            yield { type: "step_failed", stepId: id, error: err.message };
            break outer;
          }
          yield { type: "step_failed", stepId: id, error: errMsg(err) };
        }
      }
      continue;
    }

    const cachedSingle = resumeArtifacts.get(stepId);
    if (cachedSingle) {
      yield { type: "step_started", stepId, title, tool: step.tool };
      artifacts.set(stepId, cachedSingle);
      yield { type: "step_completed", stepId, artifact: cachedSingle };
      yield budgetEvent(budget);
      continue;
    }

    yield { type: "step_started", stepId, title, tool: step.tool };
    try {
      const artifact = yield* runStep(step, input, playbook, deps, apiKey, budget, {
        id: stepId,
        title,
      });
      artifacts.set(stepId, artifact);
      yield { type: "step_completed", stepId, artifact };
      yield budgetEvent(budget);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        halted = true;
        haltReason = err.message;
        yield { type: "step_failed", stepId, error: err.message };
        break outer;
      }
      yield { type: "step_failed", stepId, error: errMsg(err) };
    }
  }

  const ordered = [...artifacts.values()];
  // the deliverable is whatever the plan's final step produced, not a literal id match —
  // planSteps() guarantees the playbook's last default step stays last regardless of what
  // the planner spliced in ahead of it.
  const proposal = artifacts.get(order.at(-1) ?? "") ?? null;

  await appendLearningRecord({
    playbookId: basePlaybook.id,
    clientName: input.clientName,
    clientType: input.clientType,
    targets: (input.targets ?? []).map((t) => t.name),
    defaultSteps: topoOrder(basePlaybook),
    plannedSteps: order,
    stepInstructions: input.stepInstructions,
    rationale: plan.rationale,
  });

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

interface StepIdentity {
  id: string; // the concrete id to stamp on the returned artifact (may be "step::i")
  title: string;
  target?: CompanyRef; // present only for a for_each iteration
}

async function* runStep(
  step: Step,
  input: RunInput,
  playbook: Playbook,
  deps: Artifact[],
  apiKey: string | null | undefined,
  budget: RunBudget,
  identity: StepIdentity,
): AsyncGenerator<RunEvent, Artifact, void> {
  const { id, title, target } = identity;
  const ref = target ?? clientRef(input);
  const tier: ModelTier = step.model_tier ?? DEFAULT_TIER[step.tool];

  switch (step.tool) {
    case "edgar_financials": {
      yield { type: "step_progress", stepId: id, message: `Gathering financials for ${ref.name}…` };
      const artifact = await financialsArtifact(ref, title);
      return { ...artifact, stepId: id };
    }

    case "edgar_narrative": {
      yield { type: "step_progress", stepId: id, message: `Gathering business profile for ${ref.name}…` };
      const artifact = await narrativeOrProfileArtifact(
        ref,
        title,
        apiKey,
        budget,
        id,
      );
      return { ...artifact, stepId: id };
    }

    case "llm_research": {
      yield { type: "step_progress", stepId: id, message: `Researching (${tier})…` };
      const res = await callClaude({
        apiKey,
        tier,
        system: SYSTEM_PROMPT,
        prompt: buildResearchPrompt(step, input),
        budget,
        stepId: id,
      });
      return {
        stepId: id,
        title,
        kind: "research_note",
        markdown: res.text,
        model: res.model,
        costUsd: res.costUsd,
      };
    }

    case "llm_synthesis": {
      yield { type: "step_progress", stepId: id, message: `Synthesising ${deps.length} artifact(s) (${tier})…` };
      const res = await callClaude({
        apiKey,
        tier,
        system: SYSTEM_PROMPT,
        prompt: buildSynthesisPrompt(step, input, playbook, deps),
        effort: step.id === "proposal_skeleton" ? "high" : "medium",
        budget,
        stepId: id,
      });
      return {
        stepId: id,
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
