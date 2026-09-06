import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractItems, htmlToText } from "./narrative";

const html = readFileSync(
  fileURLToPath(new URL("./__fixtures__/acme-10k.html", import.meta.url)),
  "utf8",
);

describe("htmlToText", () => {
  it("strips tags, scripts, styles and decodes common entities", () => {
    const text = htmlToText(html);
    expect(text).not.toMatch(/<[^>]+>/);
    expect(text).not.toMatch(/color:red/);
    expect(text).toMatch(/Management's Discussion/); // &#8217; -> '
    expect(text).toMatch(/R&D/); // &amp; -> &
  });
});

describe("extractItems", () => {
  const { items, truncated } = extractItems(htmlToText(html));

  it("locates Item 1 Business using the body header, not the TOC line", () => {
    expect(items.business).toMatch(/designs and manufactures autonomous warehouse robots/);
    // must not bleed into risk factors
    expect(items.business).not.toMatch(/intense competition/);
  });

  it("locates Item 1A Risk Factors and stops before Item 1B", () => {
    expect(items.riskFactors).toMatch(/contract manufacturers concentrated/);
    expect(items.riskFactors).not.toMatch(/Unresolved Staff Comments/);
  });

  it("locates Item 7 MD&A and stops before Item 7A", () => {
    expect(items.mdna).toMatch(/Revenue increased 25%/);
    expect(items.mdna).not.toMatch(/interest rate risk on our variable-rate debt/);
  });

  it("does not flag truncation when all anchors are found and sections are short", () => {
    expect(truncated).toBe(false);
  });

  it("flags truncation when an anchor is missing", () => {
    const { truncated: t } = extractItems("Item 1. Business only, no risk section here.");
    expect(t).toBe(true);
  });
});
