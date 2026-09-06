import { cacheGet, cacheSet } from "./cache";

/**
 * Throttled EDGAR HTTP client.
 *
 * SEC rules we must honour:
 *  - Send a descriptive `User-Agent` (name + email) or requests are refused.
 *  - Stay under 10 requests/second. We serialize through a single queue with a
 *    minimum spacing, which keeps us well under the ceiling.
 */

const MIN_SPACING_MS = 150; // ~6.6 req/s ceiling, comfortably under SEC's 10
let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;

export class EdgarError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EdgarError";
  }
}

function userAgent(): string {
  const ua = process.env.EDGAR_USER_AGENT?.trim();
  if (!ua) {
    throw new EdgarError(
      "EDGAR_USER_AGENT is not set. SEC requires a 'Name your-email@example.com' User-Agent. See .env.example.",
    );
  }
  return ua;
}

async function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = Math.max(0, lastAt + MIN_SPACING_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    return fn();
  };
  const next = chain.then(run, run);
  // keep the chain alive but don't let one rejection poison the queue
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

interface GetOpts {
  /** cache key; when omitted the response is not cached */
  cacheKey?: string;
  /** parse mode */
  as?: "json" | "text";
  retries?: number;
}

export async function edgarGet<T = unknown>(url: string, opts: GetOpts = {}): Promise<T> {
  const { cacheKey, as = "json", retries = 3 } = opts;

  if (cacheKey) {
    const hit = await cacheGet<T>(cacheKey);
    if (hit !== null) return hit;
  }

  const value = await throttle(async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent": userAgent(),
            "Accept-Encoding": "gzip, deflate",
            Accept: as === "json" ? "application/json" : "text/html,*/*",
          },
        });
        if (res.status === 429 || res.status >= 500) {
          throw new EdgarError(`EDGAR ${res.status} for ${url}`, res.status);
        }
        if (res.status === 404) {
          throw new EdgarError(`EDGAR resource not found: ${url}`, 404);
        }
        if (!res.ok) {
          throw new EdgarError(`EDGAR ${res.status} for ${url}`, res.status);
        }
        return (as === "json" ? await res.json() : await res.text()) as T;
      } catch (err) {
        lastErr = err;
        if (err instanceof EdgarError && err.status === 404) throw err;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new EdgarError(String(lastErr));
  });

  if (cacheKey) await cacheSet(cacheKey, value);
  return value as T;
}
