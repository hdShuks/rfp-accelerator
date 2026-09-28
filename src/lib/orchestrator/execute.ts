import { randomUUID } from "node:crypto";
import type { StepCost } from "@/lib/llm/budget";
import { runOrchestration, type ResumeOptions } from "./runner";
import { getRunStore, isStalled } from "./store";
import type { Artifact, RunEvent, RunInput } from "./types";

/**
 * Glue between the runner (a pure async generator) and the store (durable
 * record). Runs in the background — callers don't await this to completion;
 * `/api/run` returns the `runId` as soon as the store record exists, and
 * `/api/run/:id/events` is how a client actually watches progress, by
 * polling the same store record (see that route) rather than any in-memory
 * channel: a client's `GET` and this run's execution can easily land in
 * different processes/instances (definitely true across separate Vercel
 * invocations, and observed to happen even under `next dev` for two
 * sequential requests), so the store is the only thing both sides can
 * actually rely on being shared.
 */
async function drive(runId: string, input: RunInput, apiKey: string | null | undefined, opts: ResumeOptions) {
  const store = getRunStore();
  try {
    let halted = false;
    for await (const event of runOrchestration(input, apiKey, { ...opts, runId })) {
      await store.append(runId, event);
      if (event.type === "run_completed") halted = event.halted;
    }
    await store.setStatus(runId, halted ? "halted" : "completed");
  } catch (err) {
    const event: RunEvent = { type: "run_failed", runId, error: err instanceof Error ? err.message : String(err) };
    await store.append(runId, event);
    await store.setStatus(runId, "failed");
  }
}

/**
 * Creates the store record for a new run and returns its id plus a `run()`
 * thunk the caller schedules to actually execute (e.g. via Next's `after()`,
 * so the work isn't cut off the moment the initiating response is sent).
 */
export async function prepareRun(
  input: RunInput,
  apiKey?: string | null,
): Promise<{ runId: string; run: () => Promise<void> }> {
  const runId = randomUUID();
  await getRunStore().create(runId, input);
  return { runId, run: () => drive(runId, input, apiKey, {}) };
}

export type PrepareResumeResult =
  | { ok: true; run: () => Promise<void> }
  | { ok: false; error: string; status: number };

/**
 * Re-invokes a run that halted (budget ceiling) or failed, or was orphaned
 * (the process that was executing it died mid-run — e.g. a serverless cold
 * start). Already-completed steps replay from the store instead of
 * recomputing, and prior spend counts against the budget ceiling. Like
 * `prepareRun`, returns a `run()` thunk for the caller to schedule rather
 * than executing it directly.
 */
export async function prepareResume(runId: string, apiKey?: string | null): Promise<PrepareResumeResult> {
  const store = getRunStore();
  const stored = await store.get(runId);
  if (!stored) return { ok: false, error: "Run not found", status: 404 };
  if (stored.status === "completed") return { ok: false, error: "Run already completed", status: 409 };
  if (stored.status === "running" && !isStalled(stored)) {
    return { ok: false, error: "Run is still in progress", status: 409 };
  }
  // "halted" (budget ceiling) and "failed" (an error) both fall through
  // here and are resumable — as is a "running" run that's gone stale past
  // isStalled()'s threshold, i.e. orphaned.

  await store.setStatus(runId, "running");
  const resumeArtifacts = new Map<string, Artifact>(Object.entries(stored.artifacts));
  const resumeSpent = lastBreakdown(stored.events);
  return { ok: true, run: () => drive(runId, stored.input, apiKey, { resumeArtifacts, resumeSpent }) };
}

function lastBreakdown(events: RunEvent[]): StepCost[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "budget_update") return e.breakdown;
  }
  return [];
}
