// Shapes for the slices of EDGAR responses we actually touch.

/** One XBRL fact observation inside companyfacts. */
export interface XbrlDataPoint {
  end: string; // ISO date, period end
  start?: string; // ISO date, period start (duration facts only)
  val: number;
  fy?: number; // fiscal year the filing covers
  fp?: string; // "FY", "Q1".. — fiscal period
  form?: string; // "10-K", "10-K/A", "10-Q"...
  filed?: string; // ISO date the filing was submitted
  frame?: string; // e.g. "CY2023" — SEC's calendar-aligned bucket
  accn?: string;
}

export interface CompanyFacts {
  cik: number;
  entityName: string;
  facts: Record<string, Record<string, XbrlConcept>>;
}

export interface XbrlConcept {
  label?: string;
  description?: string;
  units: Record<string, XbrlDataPoint[]>;
}

/** One fiscal year of the reduced picture we hand to the model. */
export interface FinancialYear {
  fiscalYear: number;
  periodEnd: string;
  revenue: number | null;
  costOfRevenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  depreciationAmortization: number | null;
  ebitda: number | null; // operatingIncome + D&A (proxy)
  netIncome: number | null;
  operatingCashFlow: number | null;
  capex: number | null;
  freeCashFlow: number | null; // operatingCashFlow - capex
  cashAndEquivalents: number | null;
  totalDebt: number | null;
  stockholdersEquity: number | null;
  sharesOutstanding: number | null;
  // computed ratios (code, never the model)
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  fcfMargin: number | null;
  leverage: number | null; // totalDebt / ebitda
}

export interface FinancialSummary {
  cik: string; // zero-padded 10-digit
  ticker: string;
  entityName: string;
  currency: string;
  years: FinancialYear[]; // ascending by fiscalYear
  revenueCagr: number | null; // over the window
  ebitdaCagr: number | null;
  latestFilingDate: string | null;
  sourceNote: string;
}

export interface CikRecord {
  cik: string; // zero-padded 10-digit
  ticker: string;
  title: string;
}

export interface FilingRef {
  form: string;
  filingDate: string;
  reportDate: string;
  accessionNumber: string;
  primaryDocument: string;
  primaryDocUrl: string;
}

export interface NarrativeExtract {
  ticker: string;
  cik: string;
  filing: FilingRef;
  items: {
    business: string | null; // Item 1
    riskFactors: string | null; // Item 1A
    mdna: string | null; // Item 7
  };
  truncated: boolean;
}
