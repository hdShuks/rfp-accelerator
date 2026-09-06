import { edgarGet } from "./client";
import { resolveTicker } from "./cik";
import type { FilingRef, NarrativeExtract } from "./types";

/**
 * Pull the narrative sections of the latest 10-K: Item 1 (Business),
 * Item 1A (Risk Factors), Item 7 (MD&A).
 *
 * 10-K HTML has no stable structure across filers, so this is best-effort:
 * strip to plain text, find the *body* header for each item (title words must
 * follow the "Item N" token — or stand alone on their own line for filers that
 * drop the prefix — it must not read as a cross-reference, and it must be
 * followed by real prose rather than a page number), then slice to the next
 * body header of a later item. `truncated` signals when a section hit the char
 * cap or a header could not be located; callers should surface the filing URL
 * so a human can read the real thing.
 */

const SECTION_CAP = 16_000; // chars per item passed onward

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

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  ndash: "-",
  mdash: "-",
  bull: "*",
  hellip: "...",
  reg: "(R)",
  trade: "(TM)",
  copy: "(C)",
};

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n < 9 || n === 127) return " ";
  let c: string;
  try {
    c = String.fromCodePoint(n);
  } catch {
    return " ";
  }
  if (/[‘’‚′]/.test(c)) return "'";
  if (/[“”„″]/.test(c)) return '"';
  if (/[–—−]/.test(c)) return "-";
  if (/[•▪●·]/.test(c)) return "*";
  return c;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/tr|\/h[1-6]|\/li)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&([a-z0-9]+);/gi, (_m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    // re-join drop-cap artifacts: "B USINESS" -> "BUSINESS", "I TEM" -> "ITEM"
    .replace(/\b([A-Z]) ([A-Z]{2,})\b/g, "$1$2")
    .trim();
}

// Part I / Part II 10-K item headers, in filing order.
const SEP = `[\\s.:;")'\\u2019\\u201d(\\u2014-]*`;
const ITEM_HEADERS: { key: string; num: string; title: string }[] = [
  { key: "1", num: "1", title: "business" },
  { key: "1A", num: "1A", title: "risk factors" },
  { key: "1B", num: "1B", title: "unresolved staff comments" },
  { key: "1C", num: "1C", title: "cybersecurity" },
  { key: "2", num: "2", title: "properties" },
  { key: "3", num: "3", title: "legal proceedings" },
  { key: "4", num: "4", title: "mine safety" },
  { key: "5", num: "5", title: "market for" },
  { key: "6", num: "6", title: "(?:reserved|selected financial)" },
  { key: "7", num: "7", title: "management.s discussion" },
  { key: "7A", num: "7A", title: "quantitative and qualitative" },
  { key: "8", num: "8", title: "financial statements" },
  { key: "9", num: "9", title: "changes in and disagreements" },
  { key: "9A", num: "9A", title: "controls and procedures" },
  { key: "9B", num: "9B", title: "other information" },
  { key: "10", num: "10", title: "directors" },
  { key: "11", num: "11", title: "executive compensation" },
  { key: "12", num: "12", title: "security ownership" },
  { key: "13", num: "13", title: "certain relationships" },
  { key: "14", num: "14", title: "principal account" },
  { key: "15", num: "15", title: "exhibit" },
];
const ORDINAL = new Map(ITEM_HEADERS.map((h, i) => [h.key, i]));

// phrases that mark a match as a cross-reference, not a section header
const CROSSREF = /^["'”\s]*(of this|of the|above|below|herein|hereof|in part|to this|and item|section)\b/i;

interface Header {
  key: string;
  index: number;
  bodyAt: number;
}

function letterCount(s: string): number {
  return (s.match(/[a-z]/gi) ?? []).length;
}

// bare title used as its own line, e.g. "\nBUSINESS\n" or "\nRisk Factors\n".
// Letters are matched with optional gaps because filers split words with styling
// spans ("B USINESS").
const BARE_TITLE: Record<string, string> = {
  "1": "business",
  "1A": "risk factors",
  "7": "managements discussion and analysis",
};
function spacedTitle(t: string): string {
  return t
    .split("")
    .map((ch) => (ch === " " ? "[ \\t]+" : `${ch}[ \\t]*`))
    .join("");
}

/** Every plausible body section header, in document order. */
function findBodyHeaders(text: string): Header[] {
  const out: Header[] = [];

  for (const spec of ITEM_HEADERS) {
    // "Item" <sep> num <sep> then the title words must follow
    const re = new RegExp(`\\bitem${SEP}${spec.num}(?![0-9A-Za-z])${SEP}(?=${spec.title})`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const bodyAt = m.index + m[0].length;
      const after = text.slice(bodyAt, bodyAt + 260);
      const rest = after.replace(new RegExp(`^${spec.title}[.:\\s-]*`, "i"), "");
      if (CROSSREF.test(rest)) continue; // "...Item 1A of this report..."
      if (letterCount(after) < 130) continue; // TOC row / stub
      // a run of further "Item N" tokens right after = table of contents
      if ((text.slice(bodyAt + 4, bodyAt + 320).match(/\bitem\s+\d/gi) ?? []).length >= 3) continue;
      out.push({ key: spec.key, index: m.index, bodyAt });
    }
  }

  // bare-title headers (filers that drop the "Item N" prefix in the body).
  // letters may carry styling gaps ("B USINESS"), so match with optional spaces.
  for (const [key, title] of Object.entries(BARE_TITLE)) {
    const re = new RegExp(`\\n[ \\t]*${spacedTitle(title)}[ \\t]*\\n`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const bodyAt = m.index + m[0].length;
      const after = text.slice(bodyAt, bodyAt + 400);
      if (CROSSREF.test(after)) continue;
      if (letterCount(after) < 300) continue; // must be followed by real prose
      out.push({ key, index: m.index, bodyAt });
    }
  }

  out.sort((a, b) => a.index - b.index);
  return out;
}

export function extractItems(text: string): {
  items: NarrativeExtract["items"];
  truncated: boolean;
} {
  const headers = findBodyHeaders(text);
  let truncated = false;

  const take = (key: string): string | null => {
    const ord = ORDINAL.get(key)!;
    const candidates = headers.filter((h) => h.key === key);
    if (!candidates.length) {
      truncated = true;
      return null;
    }
    // for each candidate, section runs to the next header of a later item
    let best = "";
    for (const start of candidates) {
      const next = headers.find((h) => h.index > start.index && ORDINAL.get(h.key)! > ord);
      const end = next ? next.index : text.length;
      const body = text.slice(start.bodyAt, end).trim();
      if (body.length > best.length) best = body;
    }
    if (!best) return null;
    if (best.length > SECTION_CAP) {
      truncated = true;
      best = best.slice(0, SECTION_CAP) + "\n\n[...truncated]";
    }
    return best;
  };

  return {
    items: { business: take("1"), riskFactors: take("1A"), mdna: take("7") },
    truncated,
  };
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
