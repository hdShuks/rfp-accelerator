import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileRunStore, MemoryRunStore, type RunStore } from "./store";
import type { RunEvent, RunInput } from "./types";

const input: RunInput = { clientName: "Acme" };

function stores(): [string, () => RunStore][] {
  return [
    ["MemoryRunStore", () => new MemoryRunStore()],
    ["FileRunStore", () => new FileRunStore(tempDir)],
  ];
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "runs-cache-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe.each(stores())("%s", (_name, makeStore) => {
  it("returns undefined for an unknown run", async () => {
    const store = makeStore();
    expect(await store.get("nope")).toBeUndefined();
  });

  it("creates a run in 'running' status with no events yet", async () => {
    const store = makeStore();
    await store.create("r1", input);
    const run = await store.get("r1");
    expect(run?.status).toBe("running");
    expect(run?.input).toEqual(input);
    expect(run?.events).toEqual([]);
    expect(run?.artifacts).toEqual({});
  });

  it("appends events in order and tracks the latest artifact per step", async () => {
    const store = makeStore();
    await store.create("r1", input);
    const started: RunEvent = {
      type: "run_started",
      runId: "r1",
      playbookId: "p",
      playbookName: "P",
      steps: [],
      classification: { type: "p", name: "P", confidence: 1, rationale: "x", source: "explicit" },
    };
    const completed: RunEvent = {
      type: "step_completed",
      stepId: "s1",
      artifact: { stepId: "s1", title: "S1", kind: "research_note", markdown: "hello" },
    };
    await store.append("r1", started);
    await store.append("r1", completed);

    const run = await store.get("r1");
    expect(run?.events).toEqual([started, completed]);
    expect(run?.artifacts.s1?.markdown).toBe("hello");
  });

  it("ignores appends/status changes for a run that doesn't exist", async () => {
    const store = makeStore();
    await store.append("ghost", { type: "run_failed", runId: "ghost", error: "x" });
    await store.setStatus("ghost", "failed");
    expect(await store.get("ghost")).toBeUndefined();
  });

  it("updates status", async () => {
    const store = makeStore();
    await store.create("r1", input);
    await store.setStatus("r1", "completed");
    expect((await store.get("r1"))?.status).toBe("completed");
  });
});

describe("FileRunStore", () => {
  it("persists across separate instances pointed at the same directory", async () => {
    const a = new FileRunStore(tempDir);
    await a.create("r1", input);
    await a.append("r1", { type: "run_failed", runId: "r1", error: "boom" });
    await a.setStatus("r1", "failed");

    const b = new FileRunStore(tempDir);
    const run = await b.get("r1");
    expect(run?.status).toBe("failed");
    expect(run?.events).toHaveLength(1);
  });

  // Regression test: Next.js bundles each Route Handler separately (true
  // even under `next dev`), so /api/run, /api/run/:id/events, and
  // /api/run/:id/resume each get their own module instance of this store —
  // proven by an end-to-end resume that silently no-op'd because an earlier
  // implementation cached writes through an internal MemoryRunStore that
  // was only ever warmed by whichever instance had called create(). No
  // single instance may be assumed to have "seen" any prior operation.
  it("lets an instance that never called create() append events and change status for a run another instance created", async () => {
    const creator = new FileRunStore(tempDir);
    await creator.create("r1", input);

    const appender = new FileRunStore(tempDir);
    await appender.append("r1", {
      type: "step_completed",
      stepId: "s1",
      artifact: { stepId: "s1", title: "S1", kind: "research_note", markdown: "hi" },
    });

    const statusSetter = new FileRunStore(tempDir);
    await statusSetter.setStatus("r1", "completed");

    const reader = new FileRunStore(tempDir);
    const run = await reader.get("r1");
    expect(run?.status).toBe("completed");
    expect(run?.events).toHaveLength(1);
    expect(run?.artifacts.s1?.markdown).toBe("hi");
  });
});
