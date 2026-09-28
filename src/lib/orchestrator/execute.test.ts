import { beforeEach, describe, expect, it, vi } from "vitest";

const runOrchestration = vi.fn();

vi.mock("./runner", () => ({
  runOrchestration: (...a: unknown[]) => runOrchestration(...a),
}));

import { prepareResume, prepareRun } from "./execute";
import { _setRunStoreForTests, getRunStore, MemoryRunStore, STALL_MS } from "./store";
import type { RunEvent, RunInput } from "./types";

const input: RunInput = { clientName: "Acme" };

async function* gen(events: RunEvent[]): AsyncGenerator<RunEvent, void, void> {
  for (const e of events) yield e;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  _setRunStoreForTests(new MemoryRunStore());
});

describe("prepareRun / drive", () => {
  it("creates the store record synchronously, then run() persists every event as it streams", async () => {
    const events: RunEvent[] = [
      { type: "run_started", runId: "will-be-replaced", playbookId: "p", playbookName: "P", steps: [], classification: { type: "p", name: "P", confidence: 1, rationale: "x", source: "explicit" } },
      { type: "run_completed", runId: "will-be-replaced", halted: false, proposalMarkdown: "done", artifacts: [], spentUsd: 0 },
    ];
    runOrchestration.mockReturnValue(gen(events));

    const { runId, run } = await prepareRun(input, "sk-test");
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);

    // store record exists before run() is ever invoked, since /api/run
    // needs the id back immediately.
    const store = _storeUnderTest();
    const beforeRun = await store.get(runId);
    expect(beforeRun?.status).toBe("running");
    expect(beforeRun?.events).toEqual([]);

    await run();

    const after = await store.get(runId);
    expect(after?.status).toBe("completed");
    expect(after?.events).toEqual(events);
    expect(runOrchestration).toHaveBeenCalledWith(input, "sk-test", expect.objectContaining({ runId }));
  });

  it("marks the run 'halted' (not 'completed') when the terminal run_completed event says halted: true", async () => {
    runOrchestration.mockReturnValue(
      gen([
        { type: "run_started", runId: "x", playbookId: "p", playbookName: "P", steps: [], classification: { type: "p", name: "P", confidence: 1, rationale: "x", source: "explicit" } },
        { type: "run_completed", runId: "x", halted: true, haltReason: "budget", proposalMarkdown: null, artifacts: [], spentUsd: 0.5 },
      ]),
    );
    const { runId, run } = await prepareRun(input);
    await run();
    expect((await _storeUnderTest().get(runId))?.status).toBe("halted");
  });

  it("marks the run failed and appends a run_failed event if the generator throws", async () => {
    runOrchestration.mockReturnValue(
      (async function* (): AsyncGenerator<RunEvent, void, void> {
        yield { type: "run_started", runId: "x", playbookId: "p", playbookName: "P", steps: [], classification: { type: "p", name: "P", confidence: 1, rationale: "x", source: "explicit" } };
        throw new Error("kaboom");
      })(),
    );

    const { runId, run } = await prepareRun(input);
    await run();

    const store = _storeUnderTest();
    const after = await store.get(runId);
    expect(after?.status).toBe("failed");
    expect(after?.events.at(-1)).toEqual({ type: "run_failed", runId, error: "kaboom" });
  });
});

describe("prepareResume", () => {
  it("rejects an unknown run", async () => {
    const result = await prepareResume("nope");
    expect(result).toEqual({ ok: false, error: "Run not found", status: 404 });
  });

  it("rejects a run that's still actively running (recently updated)", async () => {
    const { runId } = await prepareRun(input); // status "running", updatedAt just now
    const result = await prepareResume(runId);
    expect(result).toEqual({ ok: false, error: "Run is still in progress", status: 409 });
  });

  it("rejects a run that already completed", async () => {
    const store = _storeUnderTest();
    await store.create("r1", input);
    await store.setStatus("r1", "completed");
    const result = await prepareResume("r1");
    expect(result).toEqual({ ok: false, error: "Run already completed", status: 409 });
  });

  it("allows resuming a 'running' run that's gone quiet past the stall threshold (orphaned)", async () => {
    vi.useFakeTimers();
    const store = _storeUnderTest();
    await store.create("r1", input); // sets updatedAt to "now"
    vi.setSystemTime(Date.now() + STALL_MS + 1000);

    runOrchestration.mockReturnValue(gen([{ type: "run_completed", runId: "r1", halted: false, proposalMarkdown: null, artifacts: [], spentUsd: 0 }]));
    const result = await prepareResume("r1");
    expect(result.ok).toBe(true);
    vi.useRealTimers();
  });

  it("passes prior artifacts and the last budget breakdown to runOrchestration, and flips status back to running", async () => {
    const store = _storeUnderTest();
    await store.create("r1", input);
    await store.append("r1", {
      type: "step_completed",
      stepId: "market_context",
      artifact: { stepId: "market_context", title: "Market context", kind: "research_note", markdown: "cached" },
    });
    await store.append("r1", {
      type: "budget_update",
      spentUsd: 0.02,
      ceilingUsd: 0.5,
      breakdown: [{ step: "market_context", model: "claude-sonnet-5", inputTokens: 100, outputTokens: 50, usd: 0.02 }],
    });
    await store.setStatus("r1", "failed");

    runOrchestration.mockReturnValue(gen([{ type: "run_completed", runId: "r1", halted: false, proposalMarkdown: null, artifacts: [], spentUsd: 0.02 }]));

    const result = await prepareResume("r1", "sk-test");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect((await store.get("r1"))?.status).toBe("running");

    await result.run();

    expect(runOrchestration).toHaveBeenCalledWith(
      input,
      "sk-test",
      expect.objectContaining({
        resumeArtifacts: new Map([["market_context", { stepId: "market_context", title: "Market context", kind: "research_note", markdown: "cached" }]]),
        resumeSpent: [{ step: "market_context", model: "claude-sonnet-5", inputTokens: 100, outputTokens: 50, usd: 0.02 }],
      }),
    );
    expect((await store.get("r1"))?.status).toBe("completed");
  });
});

// execute.ts talks to the store only via the shared getRunStore() singleton
// (swapped to a fresh MemoryRunStore in beforeEach), so reading it back the
// same way lets assertions see exactly what drive() persisted.
function _storeUnderTest() {
  return getRunStore();
}
