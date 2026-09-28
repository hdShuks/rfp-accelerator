import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLearningRecord, readLearningExcerpt, __resetLearningPath } from "./learning";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rfp-learning-test-"));
  process.env.LEARNING_LOG_PATH = join(dir, "sub", "learning.md"); // nested — must mkdir -p
  __resetLearningPath();
});

afterEach(() => {
  delete process.env.LEARNING_LOG_PATH;
  __resetLearningPath();
  rmSync(dir, { recursive: true, force: true });
  // the tmp-fallback test writes to the shared OS tmp path — keep it from
  // accumulating across runs
  rmSync(join(tmpdir(), "rfp-orchestration-learning.md"), { force: true });
});

const record = (overrides: Partial<Parameters<typeof appendLearningRecord>[0]> = {}) => ({
  playbookId: "ma_target_screen",
  clientName: "Acme",
  targets: ["Target Co"],
  defaultSteps: ["market_context", "target_financials", "proposal_skeleton"],
  plannedSteps: ["market_context", "precedent_transactions", "target_financials", "proposal_skeleton"],
  stepInstructions: "add precedent transactions",
  rationale: "The brief mentioned a competing acquisition.",
  ...overrides,
});

describe("learning log", () => {
  it("returns undefined for a playbook with no history", async () => {
    expect(await readLearningExcerpt("ma_target_screen")).toBeUndefined();
  });

  it("round-trips a record: write then read it back, tagged by playbook", async () => {
    await appendLearningRecord(record());
    const excerpt = await readLearningExcerpt("ma_target_screen");
    expect(excerpt).toContain("Acme");
    expect(excerpt).toContain("add precedent transactions");
    expect(excerpt).toContain("competing acquisition");
  });

  it("shows the added/removed diff against the default plan", async () => {
    await appendLearningRecord(record());
    const excerpt = await readLearningExcerpt("ma_target_screen");
    expect(excerpt).toMatch(/\[\+precedent_transactions\]/);
  });

  it("only surfaces records for the requested playbook", async () => {
    await appendLearningRecord(record({ playbookId: "ma_target_screen" }));
    await appendLearningRecord(record({ playbookId: "digital_transformation", clientName: "OtherCo" }));
    const excerpt = await readLearningExcerpt("digital_transformation");
    expect(excerpt).toContain("OtherCo");
    expect(excerpt).not.toContain("Acme");
  });

  it("caps the excerpt length, keeping the most recent tail", async () => {
    for (let i = 0; i < 30; i++) {
      await appendLearningRecord(record({ clientName: `Client${i}` }));
    }
    const excerpt = await readLearningExcerpt("ma_target_screen", 500);
    expect(excerpt!.length).toBeLessThanOrEqual(500);
    expect(excerpt).toContain("Client29"); // most recent, not the oldest
  });

  it("falls back to the OS tmp dir (without throwing) when the primary path can't be created", async () => {
    // "blocker" is a plain file, so mkdir(dir/blocker/...) fails with ENOTDIR
    writeFileSync(join(dir, "blocker"), "not a directory");
    process.env.LEARNING_LOG_PATH = join(dir, "blocker", "learning.md");
    __resetLearningPath();

    await expect(appendLearningRecord(record())).resolves.toBeUndefined();
    const excerpt = await readLearningExcerpt("ma_target_screen");
    expect(excerpt).toContain("Acme"); // the record landed somewhere readable, not lost
  });
});
