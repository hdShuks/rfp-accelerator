import { beforeEach, describe, expect, it, vi } from "vitest";

// --- mocks: EDGAR network + Claude calls ---------------------------------
const getFinancialSummary = vi.fn();
const getNarrative = vi.fn();
const callClaude = vi.fn();

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

import { runOrchestration } from "./runner";
import type { RunEvent } from "./types";

async function collect(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const fakeSummary = {
  cik: "0000000001",
  ticker: "TGT",
  entityName: "Target Co",
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

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MAX_RUN_USD = "0.50";
  getFinancialSummary.mockResolvedValue(fakeSummary);
  getNarrative.mockResolvedValue({
    ticker: "TGT",
    cik: "0000000001",
    filing: { form: "10-K", filingDate: "2024-02-01", reportDate: "2023-12-31", accessionNumber: "x", primaryDocument: "d", primaryDocUrl: "http://x" },
    items: { business: "biz", riskFactors: "risk", mdna: "mdna" },
    truncated: false,
  });
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
        { clientName: "Acli", targetTicker: "TGT", description: "We may acquire TGT" },
        "sk-test",
      ),
    );

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run_started");
    expect(types.at(-1)).toBe("run_completed");

    const started = events.find((e) => e.type === "run_started") as Extract<RunEvent, { type: "run_started" }>;
    expect(started.playbookId).toBe("ma_target_screen");
    expect(started.classification.source).toBe("classified");

    const completed = events.find((e) => e.type === "run_completed") as Extract<RunEvent, { type: "run_completed" }>;
    expect(completed.halted).toBe(false);
    expect(completed.proposalMarkdown).toContain("text for proposal_skeleton");
    expect(completed.artifacts.map((a) => a.stepId)).toEqual([
      "market_context",
      "target_financials",
      "target_operations",
      "synergy_hypotheses",
      "proposal_skeleton",
    ]);
    expect(getFinancialSummary).toHaveBeenCalledWith("TGT");
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

  it("fails an EDGAR step when its ticker input is missing but still finishes the run", async () => {
    const events = await collect(
      runOrchestration({ clientName: "C", proposalType: "digital_transformation" }, "sk-test"),
    );
    const failed = events.filter((e) => e.type === "step_failed") as Extract<RunEvent, { type: "step_failed" }>[];
    expect(failed.some((e) => e.stepId === "client_financials")).toBe(true);
    expect(events.at(-1)!.type).toBe("run_completed");
  });

  it("halts on budget exhaustion and returns partial artifacts", async () => {
    process.env.MAX_RUN_USD = "0.0001"; // tiny — first recorded call blows it
    const events = await collect(
      runOrchestration({ clientName: "C", targetTicker: "TGT", proposalType: "ma_target_screen" }, "sk-test"),
    );
    const completed = events.find((e) => e.type === "run_completed") as Extract<RunEvent, { type: "run_completed" }>;
    expect(completed.halted).toBe(true);
    expect(completed.haltReason).toMatch(/budget/i);
  });

  it("emits budget_update events as steps complete", async () => {
    const events = await collect(
      runOrchestration({ clientName: "C", targetTicker: "TGT", proposalType: "ma_target_screen" }, "sk-test"),
    );
    expect(events.filter((e) => e.type === "budget_update").length).toBeGreaterThan(1);
  });
});
