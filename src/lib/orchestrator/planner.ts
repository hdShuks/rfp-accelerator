import { callClaude } from "@/lib/llm/anthropic";
import type { RunBudget } from "@/lib/llm/budget";
import { topoOrder, validatePlaybookGraph, type Playbook, type Step } from "@/lib/playbooks/schema";
import { catalogDescriptions, STEP_CATALOG } from "./catalog";
import { readLearningExcerpt } from "./learning";
import { buildPlannerPrompt, SYSTEM_PROMPT } from "./prompts";
import type { PlanSummary, RunInput } from "./types";

/**
 * Decides the actual step list for one run: starts from the playbook's
 * default steps, lets a cheap Haiku call add catalog steps (precedent
 * transactions, competitor landscape, ...) when the brief calls for them or
 * the user asked, applies any hard force/skip overrides, and always falls
 * back to the unmodified default plan if anything about this goes wrong —
 * planning failure must never block a run.
 */
export async function planSteps(
  playbook: Playbook,
  input: RunInput,
  apiKey: string | null | undefined,
  budget?: RunBudget,
): Promise<{ steps: Step[]; summary: PlanSummary }> {
  const defaultOrder = topoOrder(playbook);
  const byId = new Map(playbook.steps.map((s) => [s.id, s]));
  const defaultSteps = defaultOrder.map((id) => byId.get(id)!);
  const finalId = defaultOrder.at(-1)!; // the deliverable step (e.g. proposal_skeleton) — always last

  const fallback = (rationale: string): { steps: Step[]; summary: PlanSummary } => ({
    steps: defaultSteps,
    summary: {
      steps: defaultSteps.map((s) => ({ id: s.id, title: s.title ?? s.id })),
      added: [],
      removed: [],
      rationale,
    },
  });

  const catalogOptions = catalogDescriptions().filter((c) => !byId.has(c.id));
  const noAsk = !input.stepInstructions?.trim() && !input.forceSteps?.length && !input.skipSteps?.length;

  let proposedIds: string[] = defaultOrder;
  let rationale = "Using the default step plan.";

  if (catalogOptions.length > 0) {
    try {
      const learningExcerpt = await readLearningExcerpt(playbook.id);
      if (noAsk && !learningExcerpt) {
        // nothing to reconsider against — skip the call entirely, save the tokens
        rationale = "No orchestration notes and no relevant history — kept the default plan.";
      } else {
        const prompt = buildPlannerPrompt({
          playbookName: playbook.name,
          defaultSteps: defaultSteps.map((s) => ({ id: s.id, title: s.title ?? s.id })),
          catalog: catalogOptions,
          input,
          learningExcerpt,
        });
        const res = await callClaude({
          apiKey,
          tier: "fast",
          system: SYSTEM_PROMPT,
          prompt,
          maxTokens: 500,
          budget,
          stepId: "plan_steps",
        });
        const parsed = parsePlan(res.text);
        if (parsed) {
          proposedIds = parsed.steps;
          rationale = parsed.rationale;
        } else {
          rationale = "Planner response could not be parsed — used the default plan.";
        }
      }
    } catch (err) {
      rationale = `Planning skipped (${errMsg(err)}) — used the default plan.`;
    }
  }

  // resolve to real Step objects, dropping anything neither default nor catalog
  const knownIds = new Set([...byId.keys(), ...Object.keys(STEP_CATALOG)]);
  let ids = proposedIds.filter((id) => knownIds.has(id));

  // hard overrides win over the planner's judgment
  for (const id of input.forceSteps ?? []) {
    if (knownIds.has(id) && !ids.includes(id)) ids.push(id);
  }
  const skip = new Set((input.skipSteps ?? []).filter((id) => id !== finalId));
  ids = ids.filter((id) => !skip.has(id));

  if (!ids.includes(finalId)) ids.push(finalId);
  if (ids.length === 0) return fallback("Planner produced an empty plan — used the default plan.");

  const materialized = materializeSteps(ids, byId);

  let ordered: string[];
  try {
    const fake: Playbook = { ...playbook, steps: materialized };
    validatePlaybookGraph(fake);
    ordered = topoOrder(fake);
  } catch (err) {
    return fallback(`Planner produced an invalid step graph (${errMsg(err)}) — used the default plan.`);
  }

  const finalSteps = ordered.map((id) => materialized.find((s) => s.id === id)!);
  // finalId must be last regardless of where dependency order would otherwise put it
  const withoutFinal = finalSteps.filter((s) => s.id !== finalId);
  const steps = [...withoutFinal, materialized.find((s) => s.id === finalId)!];

  const defaultIds = defaultOrder;
  const finalIds = steps.map((s) => s.id);
  return {
    steps,
    summary: {
      steps: steps.map((s) => ({ id: s.id, title: s.title ?? s.id })),
      added: finalIds.filter((id) => !defaultIds.includes(id)),
      removed: defaultIds.filter((id) => !finalIds.includes(id)),
      rationale,
    },
  };
}

/**
 * Default steps keep their authored depends_on, minus anything that got
 * skipped out of the final plan (a dangling reference would fail graph
 * validation). Added catalog steps are independent research, so every default
 * llm_synthesis step also picks them up as a dependency — no manual YAML
 * wiring needed.
 */
function materializeSteps(ids: string[], byId: Map<string, Step>): Step[] {
  const idSet = new Set(ids);
  const added = ids.filter((id) => !byId.has(id));

  return ids.map((id) => {
    const base = byId.get(id) ?? STEP_CATALOG[id];
    const kept = base.depends_on.filter((d) => idSet.has(d));
    const extra = base.tool === "llm_synthesis" ? added.filter((a) => a !== id) : [];
    return { ...base, depends_on: [...new Set([...kept, ...extra])] };
  });
}

function parsePlan(text: string): { steps: string[]; rationale: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (!Array.isArray(o.steps) || !o.steps.every((s: unknown) => typeof s === "string")) return null;
    return { steps: o.steps, rationale: typeof o.rationale === "string" ? o.rationale : "" };
  } catch {
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
