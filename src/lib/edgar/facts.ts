import { edgarGet } from "./client";
import { padCik, resolveTicker } from "./cik";
import type {
  CompanyFacts,
  FinancialSummary,
  FinancialYear,
  XbrlDataPoint,
} from "./types";

/**
 * companyfacts is 5-20 MB of every XBRL tag a company ever filed. We reduce it
 * here, deterministically, to ~5 years of a compact income / cash-flow / balance
 * picture plus code-computed ratios. Only the reduced object is ever sent to a
 * model.
 */

// Concept fallback chains — XBRL tagging varies by filer and era, first hit wins.
const CONCEPTS: Record<string, string[]> = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueGoodsNet",
  ],
  costOfRevenue: [
    "CostOfRevenue",
    "CostOfGoodsAndServicesSold",
    "CostOfGoodsSold",
    "CostOfServices",
  ],
  grossProfit: ["GrossProfit"],
  operatingIncome: ["OperatingIncomeLoss"],
  depreciationAmortization: [
    "DepreciationDepletionAndAmortization",
    "DepreciationAmortizationAndAccretionNet",
    "DepreciationAndAmortization",
    "DepreciationDepletionAndAmortizationNonproductionAssets",
  ],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  operatingCashFlow: [
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
  ],
  capex: [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets",
    "PaymentsForCapitalImprovements",
  ],
  cashAndEquivalents: [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
  ],
  longTermDebt: ["LongTermDebtNoncurrent", "LongTermDebt"],
  currentDebt: [
    "LongTermDebtCurrent",
    "DebtCurrent",
    "ShortTermBorrowings",
    "LongTermDebtAndCapitalLeaseObligationsCurrent",
  ],
  stockholdersEquity: [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  ],
  sharesOutstanding: [
    "WeightedAverageNumberOfDilutedSharesOutstanding",
    "WeightedAverageNumberOfSharesOutstandingBasic",
    "CommonStockSharesOutstanding",
  ],
};

const DURATION_METRICS = new Set([
  "revenue",
  "costOfRevenue",
  "grossProfit",
  "operatingIncome",
  "depreciationAmortization",
  "netIncome",
  "operatingCashFlow",
  "capex",
]);

interface AnnualPoint {
  fy: number;
  end: string;
  val: number;
  filed: string;
}

/** Pick one annual (FY, 10-K) value per fiscal year from a concept's series. */
function pickAnnual(points: XbrlDataPoint[] | undefined, duration: boolean): Map<number, AnnualPoint> {
  const out = new Map<number, AnnualPoint>();
  if (!points) return out;
  for (const p of points) {
    if (p.fp !== "FY") continue;
    if (!p.form || !/^10-K/.test(p.form)) continue;
    if (typeof p.val !== "number" || Number.isNaN(p.val)) continue;
    if (p.fy == null) continue;
    if (duration) {
      // duration facts carry start+end ~1 year apart; skip YTD partials
      if (!p.start) continue;
      const span = (Date.parse(p.end) - Date.parse(p.start)) / 86_400_000;
      if (span < 300 || span > 400) continue;
    }
    const existing = out.get(p.fy);
    // latest-filed wins (captures restatements)
    if (!existing || (p.filed ?? "") > existing.filed) {
      out.set(p.fy, { fy: p.fy, end: p.end, val: p.val, filed: p.filed ?? "" });
    }
  }
  return out;
}

function firstConceptSeries(
  facts: CompanyFacts,
  names: string[],
): { unit: string; points: XbrlDataPoint[] } | null {
  const gaap = facts.facts["us-gaap"] ?? {};
  const dei = facts.facts["dei"] ?? {};
  for (const name of names) {
    const concept = gaap[name] ?? dei[name];
    if (!concept) continue;
    // prefer USD, else shares, else first unit
    const unitKey =
      Object.keys(concept.units).find((u) => u === "USD") ??
      Object.keys(concept.units).find((u) => u === "shares") ??
      Object.keys(concept.units)[0];
    if (!unitKey) continue;
    return { unit: unitKey, points: concept.units[unitKey] };
  }
  return null;
}

function ratio(n: number | null, d: number | null): number | null {
  if (n == null || d == null || d === 0) return null;
  return n / d;
}

function cagr(first: number | null, last: number | null, years: number): number | null {
  if (first == null || last == null || first <= 0 || last <= 0 || years <= 0) return null;
  return (last / first) ** (1 / years) - 1;
}

export interface SummarizeOpts {
  ticker: string;
  years?: number;
}

/** Pure: CompanyFacts -> FinancialSummary. No I/O. Unit-tested. */
export function summarizeCompanyFacts(
  facts: CompanyFacts,
  opts: SummarizeOpts,
): FinancialSummary {
  const wantYears = opts.years ?? (Number(process.env.EDGAR_YEARS) || 5);

  // Gather each metric's annual map.
  const metric: Record<string, Map<number, AnnualPoint>> = {};
  let currency = "USD";
  for (const [key, names] of Object.entries(CONCEPTS)) {
    const series = firstConceptSeries(facts, names);
    if (!series) {
      metric[key] = new Map();
      continue;
    }
    if (series.unit !== "shares" && series.unit !== "USD") currency = series.unit;
    metric[key] = pickAnnual(series.points, DURATION_METRICS.has(key));
  }

  // Fiscal years present across the core metrics, newest first, capped.
  const allFy = new Set<number>();
  for (const key of ["revenue", "netIncome", "operatingCashFlow", "stockholdersEquity"]) {
    for (const fy of metric[key].keys()) allFy.add(fy);
  }
  const fyList = [...allFy].sort((a, b) => b - a).slice(0, wantYears).sort((a, b) => a - b);

  const get = (key: string, fy: number): number | null => metric[key].get(fy)?.val ?? null;

  const years: FinancialYear[] = fyList.map((fy) => {
    const revenue = get("revenue", fy);
    const costOfRevenue = get("costOfRevenue", fy);
    let grossProfit = get("grossProfit", fy);
    if (grossProfit == null && revenue != null && costOfRevenue != null) {
      grossProfit = revenue - costOfRevenue;
    }
    const operatingIncome = get("operatingIncome", fy);
    const dna = get("depreciationAmortization", fy);
    const ebitda = operatingIncome != null && dna != null ? operatingIncome + dna : null;
    const netIncome = get("netIncome", fy);
    const ocf = get("operatingCashFlow", fy);
    const capexRaw = get("capex", fy);
    const capex = capexRaw != null ? Math.abs(capexRaw) : null;
    const fcf = ocf != null && capex != null ? ocf - capex : null;
    const cash = get("cashAndEquivalents", fy);
    const ltDebt = get("longTermDebt", fy);
    const curDebt = get("currentDebt", fy);
    const totalDebt =
      ltDebt != null || curDebt != null ? (ltDebt ?? 0) + (curDebt ?? 0) : null;
    const equity = get("stockholdersEquity", fy);
    const shares = get("sharesOutstanding", fy);
    const periodEnd =
      metric.revenue.get(fy)?.end ??
      metric.netIncome.get(fy)?.end ??
      metric.stockholdersEquity.get(fy)?.end ??
      `${fy}`;

    return {
      fiscalYear: fy,
      periodEnd,
      revenue,
      costOfRevenue,
      grossProfit,
      operatingIncome,
      depreciationAmortization: dna,
      ebitda,
      netIncome,
      operatingCashFlow: ocf,
      capex,
      freeCashFlow: fcf,
      cashAndEquivalents: cash,
      totalDebt,
      stockholdersEquity: equity,
      sharesOutstanding: shares,
      grossMargin: ratio(grossProfit, revenue),
      operatingMargin: ratio(operatingIncome, revenue),
      netMargin: ratio(netIncome, revenue),
      fcfMargin: ratio(fcf, revenue),
      leverage: ratio(totalDebt, ebitda),
    };
  });

  const span = years.length > 1 ? years[years.length - 1].fiscalYear - years[0].fiscalYear : 0;
  const revenueCagr = cagr(years[0]?.revenue ?? null, years.at(-1)?.revenue ?? null, span);
  const ebitdaCagr = cagr(years[0]?.ebitda ?? null, years.at(-1)?.ebitda ?? null, span);

  let latestFiling: string | null = null;
  for (const m of Object.values(metric)) {
    for (const p of m.values()) {
      if (p.filed && (!latestFiling || p.filed > latestFiling)) latestFiling = p.filed;
    }
  }

  return {
    cik: padCik(facts.cik),
    ticker: opts.ticker.toUpperCase(),
    entityName: facts.entityName,
    currency,
    years,
    revenueCagr,
    ebitdaCagr,
    latestFilingDate: latestFiling,
    sourceNote:
      "SEC EDGAR XBRL companyfacts (10-K, fiscal-year figures). Ratios and CAGRs computed in code. EBITDA is an operating-income + D&A proxy.",
  };
}

export async function getFinancialSummary(
  ticker: string,
  years?: number,
): Promise<FinancialSummary> {
  const rec = await resolveTicker(ticker);
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${rec.cik}.json`;
  const facts = await edgarGet<CompanyFacts>(url, {
    cacheKey: `companyfacts_${rec.cik}`,
  });
  return summarizeCompanyFacts(facts, { ticker: rec.ticker, years });
}
