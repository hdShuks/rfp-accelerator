import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * EDGAR filings are immutable once filed, so caching is pure upside.
 *
 * Locally we persist to disk under `.edgar-cache/`. In a read-only serverless
 * filesystem we fall back to an in-process Map (survives within one warm
 * lambda; cold starts re-fetch, which is acceptable).
 */

const DISK_DIR = process.env.EDGAR_CACHE_DIR || join(process.cwd(), ".edgar-cache");
const TMP_DIR = join(tmpdir(), "rfp-edgar-cache");
const mem = new Map<string, unknown>();

let diskWritable: boolean | null = null;

async function canWriteDisk(): Promise<boolean> {
  if (diskWritable !== null) return diskWritable;
  for (const dir of [DISK_DIR, TMP_DIR]) {
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, ".probe"), "ok");
      diskWritable = true;
      activeDir = dir;
      return true;
    } catch {
      /* try next */
    }
  }
  diskWritable = false;
  return false;
}

let activeDir = DISK_DIR;

function safeKey(key: string): string {
  return key.replace(/[^a-z0-9._-]/gi, "_");
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (mem.has(key)) return mem.get(key) as T;
  if (await canWriteDisk()) {
    const file = join(activeDir, safeKey(key) + ".json");
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as T;
        mem.set(key, parsed);
        return parsed;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function cacheSet<T>(key: string, value: T): Promise<void> {
  mem.set(key, value);
  if (await canWriteDisk()) {
    const file = join(activeDir, safeKey(key) + ".json");
    try {
      await writeFile(file, JSON.stringify(value));
    } catch {
      /* mem cache still holds it */
    }
  }
}
