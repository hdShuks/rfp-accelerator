import { beforeEach, describe, expect, it, vi } from "vitest";

// --- mocks: EDGAR network + Claude calls + the learning log ----------------
const getFinancialSummary = vi.fn();
const getNarrative = vi.fn();
const callClaude = vi.fn();
const appendLearningRecord = vi.fn();
const readLearningExcerpt = vi.fn();

vi.mock("@/lib/edgar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgar")>();
  return {
    ...actual,
    getFinancialSummary: (...a: unknown[]) => getFinancialSummary(...a),
    getNarrative: (...a: unknown[]) => getNarrative(...a),
  };
});

vi.mock("@/lib/llm/anthropic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/anthropic")>();
  return { ...actual, callClaude: (...a: unknown[]) => callClaude(...a) };
});

// no disk I/O and no cross-test state from the learning log
vi.mock("./learning", () => ({
  appendLearningRecord: (...a: unknown[]) => appendLearningRecord(...a),
  readLearningExcerpt: (...a: unknown[]) => readLearningExcerpt(...a),
}));

import { EdgarError } from "@/lib/edgar";
import { runOrchestration } from "./runner";
import type { RunEvent } from "./types";

async function collect(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function fakeSummary(ticker: string, name: string) {
  return {
    cik: "0000000001",
    ticker,
    entityName: name,
    currency: "USD",
    years: [
      {
        fiscalYear: 2023,
        periodEnd: "2023-12-31",
        revenue: 1000,
        costOfRevenue: 600,
        grossProfit: 400,
        operatingIncome: 200,
        depreciationAmortization: 50,
        ebitda: 250,
        netIncome: 150,
        operatingCashFlow: 220,
        capex: 40,
        freeCashFlow: 180,
        cashAndEquivalents: 300,
        totalDebt: 400,
        stockholdersEquity: 800,
        sharesOutstanding: 100,
        grossMargin: 0.4,
        operatingMargin: 0.2,
        netMargin: 0.15,
        fcfMargin: 0.18,
        leverage: 1.6,
      },
    ],
    revenueCagr: 0.2,
    ebitdaCagr: 0.25,
    latestFilingDate: "2024-02-01",
    sourceNote: "test",
  };
}

function fakeNarrative(ticker: string) {
  return {
    ticker,
    cik: "0000000001",
    filing: { form: "10-K", filingDate: "2024-02-01", reportDate: "2023-12-31", accessionNumber: "x", primaryDocument: "d", primaryDocUrl: "http://x" },
    items: { business: "biz", riskFactors: "risk", mdna: "mdna" },
    truncated: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MAX_RUN_USD = "0.50";
  readLearningExcerpt.mockResolvedValue(undefined);
  appendLearningRecord.mockResolvedValue(undefined);
  getFinancialSummary.mockImplementation(async (ticker: string) => fakeSummary(ticker, `${ticker} Inc.`));
  getNarrative.mockImplementation(async (ticker: string) => fakeNarrative(ticker));
  callClaude.mockImplementation(async ({ stepId, budget, tier }: any) => {
    budget?.assertWithinBudget(stepId); // mirrors the real callClaude
    budget?.record(stepId, tier === "fast" ? "claude-haiku-4-5" : "claude-sonnet-5", {
      input_tokens: 1000,
      output_tokens: 200,
    });
    return {
      text: stepId === "classify" ? '{"type":"ma_target_screen","confidence":0.9,"rationale":"acquisition language"}' : `text for ${stepId}`,
      model: tier === "fast" ? "claude-haiku-4-5" : "claude-sonnet-5",
      usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      costUsd: 0.001,
      stopReason: "end_turn",
    };
  });
});

describe("runOrchestration", () => {
  it("runs an M&A screen end to end and emits a proposal skeleton", async () => {
    const events = await collect(
      runOrchestration(
        { clientName: "Acli", targets: [{ name: "Target Co", ticker: "TGT" }], description: "We may acquire TGT" },
        "sk-test",
      ),
    );

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run_started");
    expect(types.at(-1)).toBe("run_completed");
    expect(types).toContain("plan_ready");

    const started = events.find((e) => e.type === "run_started") as Extract<RunEvent, { type: "run_started" }>;
    expect(started.playbookId).toBe("ma_target_screen");
    expect(started.classification.source).toBe("classified");

    // no explicit step instructions and no learning history -> planner
    // shouldn't even call the model
    expect(callClaude).not.toHaveBeenCalledWith(expect.objectContaining({ stepId: "plan_steps" }));

    const completed = events.find((e) => e.type === "run_completed") as Extract<RunEvent, { type: "run_completed" }>;
    expect(completed.halted).toBe(false);
    expect(completed.proposalMarkdown).toContain("text for proposal_skeleton");
    expect(completed.artifacts.map((a) => a.stepId)).toEqual([
      "market_context",
      "precedent_transactions",
      "target_financials::0",
      "target_operations::0",
      "synergy_hypotheses",
      "proposal_skeleton",
    ]);
    expect(getFinancialSummary).toHaveBeenCalledWith("TGT");
    expect(appendLearningRecord).toHaveBeenCalledWith(
      expect.objectContaining({ playbookId: "ma_target_screen", targets: ["Target Co"] }),
    );
  });

  it("runs edgar/narrative steps once per target, in order", async () => {
    const events = await collect(
      runOrchestration(
        {
          clientName: "Acli",
          targets: [
            { name: "Alpha Co", ticker: "ALP" },
            { name: "Beta Co", ticker: "BET" },
          ],
          proposalType: "ma_target_screen",
        },
        "sk-test",
      ),
    );
    const completed = events.find((e) => e.type === "run_completed") as Extract<RunEvent, { type: "run_completed" }>;
    const ids = completed.artifacts.map((a) => a.stepId);
    expect(ids).toContain("target_financials::0");
    expect(ids).toContain("target_financials::1");
    expect(ids).toContain("target_operations::0");
    expect(ids).toContain("target_operations::1");
    expect(getFinancialSummary).toHaveBeenCalledWith("ALP");
    expect(getFinancialSummary).toHaveBeenCalledWith("BET");

    // the synthesis steps should have picked up artifacts from both targets
    const synthesisPrompt = callClaude.mock.calls.find((c) => c[0].stepId === "synergy_hypotheses")?.[0].prompt;
    expect(synthesisPrompt).toContain("Alpha Co");
    expect(synthesisPrompt).toContain("Beta Co");
  });

  it("honours an explicit proposal type without calling the classifier", async () => {
    const events = await collect(
      runOrchestration({ clientName: "C", clientTicker: "CLI", proposalType: "digital" }, "sk-test"),
    );
    const started = events.find((e) => e.type === "run_started") as Extract<RunEvent, { type: "run_started" }>;
    expect(started.playbookId).toBe("digital_transformation");
    expect(started.classification.source).toBe("explicit");
    expect(callClaude).not.toHaveBeenCalledWith(expect.objectContaining({ stepId: "classify" }));
  });

  it("falls back to a no-data placeholder and an AI-generated profile when there's no ticker", async () => {
    const events = await collect(
      runOrchestration({ clientName: "Acme Widgets", proposalType: "digital_transformation" }, "sk-test"),
    );
    expect(events.filter((e) => e.type === "step_failed")).toHaveLength(0);
    expect(getFinancialSummary).not.toHaveBeenCalled();
    expect(getNarrative).not.toHaveBeenCalled();

    const completed = events.find((e) => e.type === "run_completed") as Extract<RunEvent, { type: "run_completed" }>;
    const financials = completed.artifacts.find((a) => a.stepId === "client_financials")!;
    expect(financials.kind).toBe("financial_summary");
    expect(financials.markdown).toMatch(/no SEC filing data available/i);

    const profile = completed.artifacts.find((a) => a.stepId === "client_strategy_signals")!;
    expect(profile.kind).toBe("company_profile");
    expect(profile.markdown).toMatch(/AI-generated profile/i);
    expect(callClaude).toHaveBeenCalledWith(expect.objectContaining({ stepId: "client_strategy_signals", tier: "reasoning" }));
  });

  it("falls back to a profile per-target when a target ticker doesn't resolve on EDGAR", async () => {
    getFinancialSummary.mockRejectedValueOnce(new EdgarError("not found", 404));
    getNarrative.mockRejectedValueOnce(new EdgarError("not found", 404));
    const events = await collect(
      runOrchestration(
        { clientName: "Acli", targets: [{ name: "Private Co", ticker: "NOPE" }], proposalType: "ma_target_screen" },
        "sk-test",
      ),
    );
    const completed = events.find((e) => e.type === "run_completed") as Extract<RunEvent, { type: "run_completed" }>;
    const profile = completed.artifacts.find((a) => a.stepId === "target_operations::0")!;
    expect(profile.kind).toBe("company_profile");
  });

  it("folds uploaded documents into the company artifact", async () => {
    const events = await collect(
      runOrchestration(
        {
          clientName: "Acme",
          clientDocuments: [{ filename: "notes.txt", text: "Acme's Q3 pipeline is up 20%." }],
          proposalType: "digital_transformation",
        },
        "sk-test",
      ),
    );
    const completed = events.find((e) => e.type === "run_completed") as Extract<RunEvent, { type: "run_completed" }>;
    const financials = completed.artifacts.find((a) => a.stepId === "client_financials")!;
    expect(financials.markdown).toContain("notes.txt");
    expect(financials.markdown).toContain("Q3 pipeline is up 20%");
  });

  it("lets stepInstructions add a catalog step via the planner", async () => {
    callClaude.mockImplementation(async ({ stepId, budget, tier }: any) => {
      budget?.assertWithinBudget(stepId);
      budget?.record(stepId, tier === "fast" ? "claude-haiku-4-5" : "claude-sonnet-5", { input_tokens: 500, output_tokens: 100 });
      if (stepId === "plan_steps") {
        return {
          text: '{"steps":["market_landscape","client_financials","competitor_landscape","comparable_financials","comparable_profiles","entry_hypotheses","proposal_skeleton"],"rationale":"Added competitor_landscape per the user note."}',
          model: "claude-haiku-4-5",
          usage: { input_tokens: 500, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          costUsd: 0.0005,
          stopReason: "end_turn",
        };
      }
      return {
        text: `text for ${stepId}`,
        model: tier === "fast" ? "claude-haiku-4-5" : "claude-sonnet-5",
        usage: { input_tokens: 500, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        costUsd: 0.0005,
        stopReason: "end_turn",
      };
    });

    const events = await collect(
      runOrchestration(
        {
          clientName: "Acli",
          targets: [{ name: "Comp Co", ticker: "CMP" }],
          proposalType: "market_entry",
          stepInstructions: "also look at the competitor landscape",
        },
        "sk-test",
      ),
    );
    const plan = events.find((e) => e.type === "plan_ready") as Extract<RunEvent, { type: "plan_ready" }>;
    expect(plan.plan.added).toContain("competitor_landscape");

    const completed = events.find((e) => e.type === "run_completed") as Extract<RunEvent, { type: "run_completed" }>;
    expect(completed.artifacts.some((a) => a.stepId === "competitor_landscape")).toBe(true);
    // proposal_skeleton must still run last even though the plan didn't say so explicitly out of order
    expect(completed.artifacts.at(-1)!.stepId).toBe("proposal_skeleton");
  });

  it("halts on budget exhaustion and returns partial artifacts", async () => {
    process.env.MAX_RUN_USD = "0.0001"; // tiny — first recorded call blows it
    const events = await collect(
      runOrchestration(
        { clientName: "C", targets: [{ name: "Target Co", ticker: "TGT" }], proposalType: "ma_target_screen" },
        "sk-test",
      ),
    );
    const completed = events.find((e) => e.type === "run_completed") as Extract<RunEvent, { type: "run_completed" }>;
    expect(completed.halted).toBe(true);
    expect(completed.haltReason).toMatch(/budget/i);
  });

  it("emits budget_update events as steps complete", async () => {
    const events = await collect(
      runOrchestration(
        { clientName: "C", targets: [{ name: "Target Co", ticker: "TGT" }], proposalType: "ma_target_screen" },
        "sk-test",
      ),
    );
    expect(events.filter((e) => e.type === "budget_update").length).toBeGreaterThan(1);
  });
});
