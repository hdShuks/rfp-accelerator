import { describe, expect, it, vi } from "vitest";
import { nextChunk } from "./tail";
import { STALL_MS } from "./store";
import type { RunEvent } from "./types";

const progressEvent: RunEvent = { type: "step_progress", stepId: "s1", message: "…" };
const staleTerminal: RunEvent = { type: "run_completed", runId: "r", halted: true, haltReason: "budget", proposalMarkdown: null, artifacts: [], spentUsd: 0.02 };
const freshRunStarted: RunEvent = { type: "run_started", runId: "r", playbookId: "p", playbookName: "P", steps: [], classification: { type: "p", name: "P", confidence: 1, rationale: "x", source: "explicit" } };

function runAt(events: RunEvent[], status: "running" | "completed" | "halted" | "failed", updatedAt = new Date().toISOString()) {
  return { events, status, updatedAt };
}

describe("nextChunk", () => {
  it("returns events beyond sentCount and done: false while status is running", () => {
    const result = nextChunk(runAt([progressEvent, progressEvent], "running"), 1);
    expect(result.newEvents).toEqual([progressEvent]);
    expect(result.done).toBe(false);
  });

  it("marks done when status is a terminal one", () => {
    for (const status of ["completed", "halted", "failed"] as const) {
      expect(nextChunk(runAt([], status), 0).done).toBe(true);
    }
  });

  it("does NOT stop on a stale terminal event buried mid-array by a resume, as long as status still says running", () => {
    // exactly the shape of a resumed run's log: the first attempt's
    // run_completed sits at index 0, followed by a fresh run_started and
    // more real progress from the resumed attempt.
    const events = [staleTerminal, freshRunStarted, progressEvent];
    const result = nextChunk(runAt(events, "running"), 0);
    expect(result.newEvents).toEqual(events);
    expect(result.done).toBe(false);
  });

  it("stops once status catches up to a genuinely final terminal event", () => {
    const events = [freshRunStarted, staleTerminal];
    const result = nextChunk(runAt(events, "completed"), 0);
    expect(result.newEvents).toEqual(events);
    expect(result.done).toBe(true);
  });

  it("is done when a 'running' run has gone stale past the stall threshold (orphaned)", () => {
    vi.useFakeTimers();
    const staleUpdatedAt = new Date().toISOString();
    vi.setSystemTime(Date.now() + STALL_MS + 1000);
    const result = nextChunk(runAt([], "running", staleUpdatedAt), 0);
    expect(result.done).toBe(true);
    vi.useRealTimers();
  });

  it("returns no new events once the client has already caught up", () => {
    const result = nextChunk(runAt([progressEvent], "running"), 1);
    expect(result.newEvents).toEqual([]);
    expect(result.done).toBe(false);
  });
});
