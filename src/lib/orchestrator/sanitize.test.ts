import { describe, expect, it } from "vitest";
import { sanitizeRunInput } from "./sanitize";

describe("sanitizeRunInput", () => {
  it("returns null when clientName is missing or blank", () => {
    expect(sanitizeRunInput({})).toBeNull();
    expect(sanitizeRunInput({ clientName: "   " })).toBeNull();
    expect(sanitizeRunInput(null)).toBeNull();
    expect(sanitizeRunInput("not an object")).toBeNull();
  });

  it("trims and passes through simple fields", () => {
    const input = sanitizeRunInput({
      clientName: "  Acme  ",
      clientTicker: " acme ",
      description: " brief ",
      proposalType: " ma_target_screen ",
    });
    expect(input).toMatchObject({
      clientName: "Acme",
      clientTicker: "ACME",
      description: "brief",
      proposalType: "ma_target_screen",
    });
  });

  it("only accepts 'pe_sponsor' as a clientType, dropping anything else", () => {
    expect(sanitizeRunInput({ clientName: "C", clientType: "pe_sponsor" })!.clientType).toBe("pe_sponsor");
    expect(sanitizeRunInput({ clientName: "C", clientType: "hacker_injected" })!.clientType).toBeUndefined();
  });

  it("caps the number of targets and drops targets without a name", () => {
    const targets = Array.from({ length: 12 }, (_, i) => ({ name: `T${i}` }));
    const input = sanitizeRunInput({ clientName: "C", targets: [...targets, { ticker: "NO_NAME" }] });
    expect(input!.targets).toHaveLength(8); // MAX_TARGETS
  });

  it("caps document text length and count per company", () => {
    const bigText = "x".repeat(100_000);
    const docs = Array.from({ length: 10 }, (_, i) => ({ filename: `f${i}.txt`, text: bigText }));
    const input = sanitizeRunInput({ clientName: "C", clientDocuments: docs });
    expect(input!.clientDocuments).toHaveLength(5); // MAX_DOCS_PER_COMPANY
    expect(input!.clientDocuments![0].text.length).toBeLessThanOrEqual(40_000);
  });

  it("drops documents with no text", () => {
    const input = sanitizeRunInput({ clientName: "C", clientDocuments: [{ filename: "empty.txt" }] });
    expect(input!.clientDocuments).toBeUndefined();
  });

  it("sanitizes nested target documents the same way", () => {
    const input = sanitizeRunInput({
      clientName: "C",
      targets: [{ name: "T", documents: [{ filename: "cim.txt", text: "financials..." }] }],
    });
    expect(input!.targets![0].documents).toEqual([{ filename: "cim.txt", text: "financials..." }]);
  });

  it("passes through forceSteps/skipSteps as capped string arrays", () => {
    const many = Array.from({ length: 30 }, (_, i) => `step_${i}`);
    const input = sanitizeRunInput({ clientName: "C", forceSteps: many, skipSteps: ["a", 5, null, "b"] });
    expect(input!.forceSteps).toHaveLength(20);
    expect(input!.skipSteps).toEqual(["a", "b"]);
  });

  it("ignores non-array targets/documents without throwing", () => {
    const input = sanitizeRunInput({ clientName: "C", targets: "nope", clientDocuments: 42 });
    expect(input!.targets).toBeUndefined();
    expect(input!.clientDocuments).toBeUndefined();
  });
});
