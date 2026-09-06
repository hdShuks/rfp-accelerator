import type { FinancialSummary, NarrativeExtract } from "@/lib/edgar/types";

const B = 1_000_000_000;
const M = 1_000_000;

export function money(n: number | null): string {
  if (n == null) return "n/a";
  const abs = Math.abs(n);
  if (abs >= B) return `${(n / B).toFixed(2)}B`;
  if (abs >= M) return `${(n / M).toFixed(1)}M`;
  return n.toLocaleString("en-US");
}

export function pct(n: number | null): string {
  return n == null ? "n/a" : `${(n * 100).toFixed(1)}%`;
}

export function financialSummaryToMarkdown(s: FinancialSummary): string {
  const rows = [
    ["Fiscal year", ...s.years.map((y) => String(y.fiscalYear))],
    ["Period end", ...s.years.map((y) => y.periodEnd)],
    ["Revenue", ...s.years.map((y) => money(y.revenue))],
    ["Gross margin", ...s.years.map((y) => pct(y.grossMargin))],
    ["Operating income", ...s.years.map((y) => money(y.operatingIncome))],
    ["Operating margin", ...s.years.map((y) => pct(y.operatingMargin))],
    ["EBITDA (proxy)", ...s.years.map((y) => money(y.ebitda))],
    ["Net income", ...s.years.map((y) => money(y.netIncome))],
    ["Net margin", ...s.years.map((y) => pct(y.netMargin))],
    ["Operating cash flow", ...s.years.map((y) => money(y.operatingCashFlow))],
    ["Capex", ...s.years.map((y) => money(y.capex))],
    ["Free cash flow", ...s.years.map((y) => money(y.freeCashFlow))],
    ["Cash & equivalents", ...s.years.map((y) => money(y.cashAndEquivalents))],
    ["Total debt", ...s.years.map((y) => money(y.totalDebt))],
    ["Net debt / EBITDA", ...s.years.map((y) => (y.leverage == null ? "n/a" : y.leverage.toFixed(2) + "x"))],
    ["Stockholders' equity", ...s.years.map((y) => money(y.stockholdersEquity))],
  ];
  const header = `| Metric | ${s.years.map((y) => y.fiscalYear).join(" | ")} |`;
  const sep = `| --- | ${s.years.map(() => "---:").join(" | ")} |`;
  const body = rows.slice(2).map((r) => `| ${r.join(" | ")} |`).join("\n");

  return [
    `**${s.entityName}** (${s.ticker}, CIK ${s.cik}) — ${s.currency}`,
    "",
    header,
    sep,
    body,
    "",
    `- Revenue CAGR over window: ${pct(s.revenueCagr)}`,
    `- EBITDA CAGR over window: ${pct(s.ebitdaCagr)}`,
    `- Latest filing: ${s.latestFilingDate ?? "n/a"}`,
    "",
    `_${s.sourceNote}_`,
  ].join("\n");
}

export function narrativeToMarkdown(n: NarrativeExtract): string {
  const parts: string[] = [
    `**${n.ticker}** — 10-K filed ${n.filing.filingDate} (period ${n.filing.reportDate})`,
    `Source: ${n.filing.primaryDocUrl}`,
  ];
  if (n.truncated) parts.push("\n> ⚠️ Some sections were truncated or not cleanly located in the filing HTML.");
  const section = (label: string, text: string | null) => {
    parts.push(`\n### ${label}\n`);
    parts.push(text ? text : "_Not located in filing._");
  };
  section("Item 1 — Business", n.items.business);
  section("Item 1A — Risk Factors", n.items.riskFactors);
  section("Item 7 — MD&A", n.items.mdna);
  return parts.join("\n");
}
