import { edgarGet } from "./client";
import { resolveTicker } from "./cik";
import type { FilingRef, NarrativeExtract } from "./types";

/**
 * Pull the narrative sections of the latest 10-K: Item 1 (Business),
 * Item 1A (Risk Factors), Item 7 (MD&A).
 *
 * 10-K HTML has no stable structure across filers, so this is a best-effort
 * text pass: strip to plain text, locate item headers (using the *last*
 * occurrence to skip the table of contents), slice between them, and cap each
 * section. `truncated` signals when caps or missing anchors bit.
 */

const SECTION_CAP = 14_000; // chars per item sent onward

interface SubmissionsFile {
  cik: string;
  name: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
      form: string[];
      primaryDocument: string[];
    };
  };
}

export async function findLatest10K(cik: string): Promise<FilingRef> {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const data = await edgarGet<SubmissionsFile>(url, { cacheKey: `submissions_${cik}` });
  const r = data.filings.recent;
  for (let i = 0; i < r.form.length; i++) {
    if (r.form[i] === "10-K") {
      const accn = r.accessionNumber[i];
      const accnPlain = accn.replace(/-/g, "");
      const cikPlain = String(Number(cik));
      return {
        form: r.form[i],
        filingDate: r.filingDate[i],
        reportDate: r.reportDate[i],
        accessionNumber: accn,
        primaryDocument: r.primaryDocument[i],
        primaryDocUrl: `https://www.sec.gov/Archives/edgar/data/${cikPlain}/${accnPlain}/${r.primaryDocument[i]}`,
      };
    }
  }
  throw new Error(`No 10-K found in recent filings for CIK ${cik}`);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&#8217;/g, "'")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** last index where an "Item N." header plausibly starts (skips TOC entries) */
function itemStart(text: string, label: string): number {
  // label like "1", "1A", "7" — allow "Item 1." / "Item 1 —" / "ITEM 1:"
  const re = new RegExp(`item\\s+${label}\\s*[\\.\\:\\—\\-\\)]`, "gi");
  let idx = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) idx = m.index;
  return idx;
}

function slice(text: string, from: number, to: number): string | null {
  if (from < 0) return null;
  const end = to > from ? to : text.length;
  const out = text.slice(from, end).trim();
  return out.length ? out : null;
}

export function extractItems(text: string): {
  items: NarrativeExtract["items"];
  truncated: boolean;
} {
  const i1 = itemStart(text, "1");
  const i1a = itemStart(text, "1A");
  const i1b = itemStart(text, "1B");
  const i2 = itemStart(text, "2");
  const i7 = itemStart(text, "7");
  const i7a = itemStart(text, "7A");
  const i8 = itemStart(text, "8");

  const businessEnd = i1a > i1 ? i1a : i1b > i1 ? i1b : i2;
  const riskEnd = i1b > i1a ? i1b : i2;
  const mdnaEnd = i7a > i7 ? i7a : i8;

  let business = slice(text, i1, businessEnd);
  let riskFactors = slice(text, i1a, riskEnd);
  let mdna = slice(text, i7, mdnaEnd);

  let truncated = i1 < 0 || i1a < 0 || i7 < 0;
  const cap = (s: string | null): string | null => {
    if (s && s.length > SECTION_CAP) {
      truncated = true;
      return s.slice(0, SECTION_CAP) + "\n\n[...truncated]";
    }
    return s;
  };
  business = cap(business);
  riskFactors = cap(riskFactors);
  mdna = cap(mdna);

  return { items: { business, riskFactors, mdna }, truncated };
}

export async function getNarrative(ticker: string): Promise<NarrativeExtract> {
  const rec = await resolveTicker(ticker);
  const filing = await findLatest10K(rec.cik);
  const html = await edgarGet<string>(filing.primaryDocUrl, {
    as: "text",
    cacheKey: `tenk_${rec.cik}_${filing.accessionNumber}`,
  });
  const text = htmlToText(html);
  const { items, truncated } = extractItems(text);
  return { ticker: rec.ticker, cik: rec.cik, filing, items, truncated };
}
