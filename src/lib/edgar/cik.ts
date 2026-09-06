import { edgarGet, EdgarError } from "./client";
import type { CikRecord } from "./types";

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

// Shape: { "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." }, ... }
type TickerFile = Record<string, { cik_str: number; ticker: string; title: string }>;

let index: Map<string, CikRecord> | null = null;

export function padCik(cik: number | string): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

async function loadIndex(): Promise<Map<string, CikRecord>> {
  if (index) return index;
  const file = await edgarGet<TickerFile>(TICKERS_URL, {
    cacheKey: "company_tickers",
  });
  const map = new Map<string, CikRecord>();
  for (const row of Object.values(file)) {
    map.set(row.ticker.toUpperCase(), {
      cik: padCik(row.cik_str),
      ticker: row.ticker.toUpperCase(),
      title: row.title,
    });
  }
  index = map;
  return map;
}

export async function resolveTicker(ticker: string): Promise<CikRecord> {
  const key = ticker.trim().toUpperCase();
  if (!key) throw new EdgarError("Empty ticker");
  const map = await loadIndex();
  const rec = map.get(key);
  if (!rec) {
    throw new EdgarError(
      `Ticker "${key}" not found in SEC's company_tickers.json. It may be a non-US listing, an ETF, or delisted.`,
      404,
    );
  }
  return rec;
}

/** Best-effort search by company name substring (for the classifier / UX). */
export async function searchByName(query: string, limit = 8): Promise<CikRecord[]> {
  const map = await loadIndex();
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: CikRecord[] = [];
  for (const rec of map.values()) {
    if (rec.title.toLowerCase().includes(q)) {
      out.push(rec);
      if (out.length >= limit) break;
    }
  }
  return out;
}
