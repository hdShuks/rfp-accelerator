import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { EdgarError } from "@/lib/edgar";
import { financialsArtifact, narrativeOrProfileArtifact } from "./company";

const summary = {
  cik: "0000000001",
  ticker: "TGT",
  entityName: "Target Co",
  currency: "USD",
  years: [],
  revenueCagr: null,
  ebitdaCagr: null,
  latestFilingDate: null,
  sourceNote: "test",
};

const narrative = {
  ticker: "TGT",
  cik: "0000000001",
  filing: { form: "10-K", filingDate: "2024-02-01", reportDate: "2023-12-31", accessionNumber: "x", primaryDocument: "d", primaryDocUrl: "http://x" },
  items: { business: "biz", riskFactors: "risk", mdna: "mdna" },
  truncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  callClaude.mockResolvedValue({
    text: "Target Co makes widgets.",
    model: "claude-sonnet-5",
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    costUsd: 0.001,
    stopReason: "end_turn",
  });
});

describe("financialsArtifact", () => {
  it("uses EDGAR when the ticker resolves", async () => {
    getFinancialSummary.mockResolvedValue(summary);
    const a = await financialsArtifact({ name: "Target Co", ticker: "TGT" }, "Financials");
    expect(a.kind).toBe("financial_summary");
    expect(a.data).toBe(summary);
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("falls back to a placeholder (no LLM call) when the ticker isn't found", async () => {
    getFinancialSummary.mockRejectedValue(new EdgarError("not found", 404));
    const a = await financialsArtifact({ name: "Private Co", ticker: "NOPE" }, "Financials");
    expect(a.kind).toBe("financial_summary");
    expect(a.data).toBeUndefined();
    expect(a.markdown).toMatch(/no SEC filing data available/i);
    expect(a.markdown).toMatch(/NOPE.*not found/i);
    expect(callClaude).not.toHaveBeenCalled(); // never invents financial figures
  });

  it("falls back to a placeholder when there's no ticker at all", async () => {
    const a = await financialsArtifact({ name: "Private Co" }, "Financials");
    expect(a.markdown).toMatch(/likely private/i);
    expect(getFinancialSummary).not.toHaveBeenCalled();
  });

  it("re-throws non-EdgarError failures rather than masking them as 'no data'", async () => {
    getFinancialSummary.mockRejectedValue(new Error("ECONNRESET"));
    await expect(financialsArtifact({ name: "T", ticker: "TGT" }, "Financials")).rejects.toThrow("ECONNRESET");
  });

  it("appends uploaded documents to the markdown", async () => {
    getFinancialSummary.mockRejectedValue(new EdgarError("not found", 404));
    const a = await financialsArtifact(
      { name: "Private Co", documents: [{ filename: "cim.txt", text: "Revenue: $10M" }] },
      "Financials",
    );
    expect(a.markdown).toContain("cim.txt");
    expect(a.markdown).toContain("Revenue: $10M");
  });
});

describe("narrativeOrProfileArtifact", () => {
  it("uses EDGAR's 10-K when the ticker resolves", async () => {
    getNarrative.mockResolvedValue(narrative);
    const a = await narrativeOrProfileArtifact({ name: "Target Co", ticker: "TGT" }, "Ops", "sk-test", undefined, "step1");
    expect(a.kind).toBe("narrative_extract");
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("falls back to a Claude-written profile, clearly labelled, when there's no ticker", async () => {
    const a = await narrativeOrProfileArtifact({ name: "Private Co", notes: "makes widgets" }, "Ops", "sk-test", undefined, "step1");
    expect(a.kind).toBe("company_profile");
    expect(a.markdown).toMatch(/AI-generated profile/i);
    expect(a.markdown).toContain("widgets"); // sanity: contains the model's response text
    expect(callClaude).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "reasoning", stepId: "step1" }),
    );
    const prompt = callClaude.mock.calls[0][0].prompt;
    expect(prompt).toContain("makes widgets");
  });

  it("falls back to a profile when EDGAR can't resolve the ticker", async () => {
    getNarrative.mockRejectedValue(new EdgarError("not found", 404));
    const a = await narrativeOrProfileArtifact({ name: "T", ticker: "NOPE" }, "Ops", "sk-test", undefined, "step1");
    expect(a.kind).toBe("company_profile");
    expect(callClaude).toHaveBeenCalled();
  });

  it("passes uploaded documents into the fallback prompt as ground truth", async () => {
    await narrativeOrProfileArtifact(
      { name: "Private Co", documents: [{ filename: "deck.txt", text: "We serve 500 enterprise customers." }] },
      "Ops",
      "sk-test",
      undefined,
      "step1",
    );
    const prompt = callClaude.mock.calls[0][0].prompt;
    expect(prompt).toContain("500 enterprise customers");
    expect(prompt).toMatch(/ground truth/i);
  });
});
