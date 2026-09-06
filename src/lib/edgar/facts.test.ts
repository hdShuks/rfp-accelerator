import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { summarizeCompanyFacts } from "./facts";
import type { CompanyFacts } from "./types";

const facts = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./__fixtures__/acme-companyfacts.json", import.meta.url)),
    "utf8",
  ),
) as CompanyFacts;

const near = (a: number | null, b: number, tol = 1e-6) => {
  expect(a).not.toBeNull();
  expect(Math.abs((a as number) - b)).toBeLessThan(tol);
};

describe("summarizeCompanyFacts", () => {
  const summary = summarizeCompanyFacts(facts, { ticker: "acme", years: 5 });

  it("pads CIK and carries entity metadata", () => {
    expect(summary.cik).toBe("0001234567");
    expect(summary.ticker).toBe("ACME");
    expect(summary.entityName).toBe("Acme Robotics Inc.");
    expect(summary.currency).toBe("USD");
  });

  it("returns fiscal years ascending and ignores non-FY / non-10-K points", () => {
    expect(summary.years.map((y) => y.fiscalYear)).toEqual([2021, 2022, 2023]);
    const fy23 = summary.years[2];
    // the Q1 10-Q point (val 360) must not have been chosen
    expect(fy23.revenue).toBe(1500);
    expect(fy23.periodEnd).toBe("2023-12-31");
  });

  it("computes gross profit from revenue - cost when GrossProfit is untagged", () => {
    const fy23 = summary.years[2];
    expect(fy23.grossProfit).toBe(650);
    near(fy23.grossMargin, 650 / 1500);
  });

  it("derives an EBITDA proxy and leverage in code", () => {
    const fy23 = summary.years[2];
    expect(fy23.ebitda).toBe(410); // 350 operating + 60 D&A
    expect(fy23.totalDebt).toBe(370); // 350 noncurrent + 20 current
    near(fy23.leverage, 370 / 410);
  });

  it("computes free cash flow as OCF minus |capex|", () => {
    const fy23 = summary.years[2];
    expect(fy23.freeCashFlow).toBe(320); // 370 - 50
    near(fy23.fcfMargin, 320 / 1500);
  });

  it("computes margins for each year", () => {
    const fy21 = summary.years[0];
    near(fy21.operatingMargin, 200 / 1000);
    near(fy21.netMargin, 150 / 1000);
  });

  it("computes revenue and EBITDA CAGR across the window", () => {
    near(summary.revenueCagr, (1500 / 1000) ** (1 / 2) - 1);
    near(summary.ebitdaCagr, (410 / 250) ** (1 / 2) - 1); // fy21 ebitda 200+50
  });

  it("reports the latest filing date seen", () => {
    expect(summary.latestFilingDate).toBe("2024-02-01");
  });

  it("respects the years cap", () => {
    const two = summarizeCompanyFacts(facts, { ticker: "acme", years: 2 });
    expect(two.years.map((y) => y.fiscalYear)).toEqual([2022, 2023]);
  });

  it("degrades gracefully when a concept is entirely missing", () => {
    const stripped = JSON.parse(JSON.stringify(facts)) as CompanyFacts;
    delete stripped.facts["us-gaap"].OperatingIncomeLoss;
    const s = summarizeCompanyFacts(stripped, { ticker: "acme" });
    expect(s.years[2].operatingIncome).toBeNull();
    expect(s.years[2].ebitda).toBeNull();
    expect(s.years[2].revenue).toBe(1500); // other metrics still resolve
  });
});
