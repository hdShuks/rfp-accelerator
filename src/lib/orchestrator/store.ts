import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Artifact, RunEvent, RunInput } from "./types";

/**
 * "halted" = the runner finished emitting events but the run's own
 * `run_completed` event said `halted: true` (budget ceiling reached) — done
 * producing events, but incomplete, and resumable. "completed" is only ever
 * set for a `run_completed` with `halted: false`; "failed" covers a genuine
 * error (an uncaught throw, or an explicit `run_failed` event). Both
 * "halted" and "failed" can be resumed; "completed" cannot.
 */
export type RunStatus = "running" | "completed" | "halted" | "failed";

/**
 * How long a "running" run can go without a store update before treating it
 * as orphaned (the process executing it died, e.g. a serverless cold start,
 * or a crash outside the runner's own error handling) rather than just
 * genuinely mid-step. Deliberately generous: a single high-effort synthesis
 * call has been observed to take well over a minute on its own (see
 * HANDOFF.md §6's live-verification note), and a step's `step_progress`
 * event lands right as that call *starts*, so the gap between updates can
 * be close to one full step's model-call latency.
 */
export const STALL_MS = 4 * 60 * 1000;

export function isStalled(run: Pick<StoredRun, "status" | "updatedAt">): boolean {
  if (run.status !== "running") return false;
  return Date.now() - new Date(run.updatedAt).getTime() > STALL_MS;
}

export interface StoredRun {
  runId: string;
  status: RunStatus;
  input: RunInput;
  events: RunEvent[];
  /** latest artifact per stepId, kept in sync as step_completed events land — lets a resumed run skip finished steps instead of redoing them. */
  artifacts: Record<string, Artifact>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Persists run state (input, event log, completed artifacts) so a run
 * survives a dropped SSE connection: a client can reconnect to
 * `GET /api/run/:id/events`, replay everything recorded so far, and keep
 * tailing. Also the substrate for resuming a halted/orphaned run — see
 * `runOrchestration`'s `resumeArtifacts` param.
 *
 * File-backed, same convention as `.edgar-cache/`: fine for local dev and a
 * single long-lived `next dev`/`next start` process. On Vercel this is
 * per-instance and ephemeral across cold starts, same caveat as the
 * learning log (see HANDOFF.md §6) — put a real store (KV/Postgres) behind
 * this before relying on it in a multi-instance production deploy.
 */
export interface RunStore {
  create(runId: string, input: RunInput): Promise<void>;
  append(runId: string, event: RunEvent): Promise<void>;
  get(runId: string): Promise<StoredRun | undefined>;
  setStatus(runId: string, status: RunStatus): Promise<void>;
}

function applyEvent(run: StoredRun, event: RunEvent): void {
  run.events.push(event);
  if (event.type === "step_completed") {
    run.artifacts[event.stepId] = event.artifact;
  }
  run.updatedAt = new Date().toISOString();
}

export class MemoryRunStore implements RunStore {
  private runs = new Map<string, StoredRun>();

  async create(runId: string, input: RunInput): Promise<void> {
    const now = new Date().toISOString();
    this.runs.set(runId, {
      runId,
      status: "running",
      input,
      events: [],
      artifacts: {},
      createdAt: now,
      updatedAt: now,
    });
  }

  async append(runId: string, event: RunEvent): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    applyEvent(run, event);
  }

  async get(runId: string): Promise<StoredRun | undefined> {
    return this.runs.get(runId);
  }

  async setStatus(runId: string, status: RunStatus): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = status;
    run.updatedAt = new Date().toISOString();
  }
}

/**
 * File-backed store: one JSON file per run under `.runs-cache/`. Every
 * operation reads-modifies-writes straight to disk — no in-process cache —
 * deliberately: Next.js bundles each Route Handler separately (true even
 * under `next dev`, and certainly true across separate Vercel invocations),
 * so `/api/run`, `/api/run/:id/events`, and `/api/run/:id/resume` do *not*
 * share a module instance of this file, only the filesystem. An earlier
 * version cached writes through an internal `MemoryRunStore` and silently
 * dropped any `append`/`setStatus` call from a route that hadn't itself
 * called `create()` — caught by an end-to-end resume test, not a unit test,
 * since every unit test happened to go through one store instance. Every
 * write here rewrites the whole file — run event logs are small (dozens of
 * events, capped-size artifacts) so this is simpler and safe enough against
 * the concurrent-append case that actually happens here (one background
 * execution appending sequentially; readers never write).
 */
export class FileRunStore implements RunStore {
  constructor(private readonly dir: string = path.join(process.cwd(), ".runs-cache")) {}

  private file(runId: string): string {
    // runId is always a UUID we generated ourselves (see runner.ts), never
    // taken verbatim from a URL param without validation — see the events
    // route, which rejects anything that doesn't look like one before it
    // reaches here.
    return path.join(this.dir, `${runId}.json`);
  }

  async create(runId: string, input: RunInput): Promise<void> {
    const now = new Date().toISOString();
    const run: StoredRun = { runId, status: "running", input, events: [], artifacts: {}, createdAt: now, updatedAt: now };
    await this.write(run);
  }

  async append(runId: string, event: RunEvent): Promise<void> {
    const run = await this.get(runId);
    if (!run) return;
    applyEvent(run, event);
    await this.write(run);
  }

  async get(runId: string): Promise<StoredRun | undefined> {
    try {
      const raw = await readFile(this.file(runId), "utf8");
      return JSON.parse(raw) as StoredRun;
    } catch {
      return undefined;
    }
  }

  async setStatus(runId: string, status: RunStatus): Promise<void> {
    const run = await this.get(runId);
    if (!run) return;
    run.status = status;
    run.updatedAt = new Date().toISOString();
    await this.write(run);
  }

  private async write(run: StoredRun): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(run.runId), JSON.stringify(run), "utf8");
  }

  /** Best-effort cleanup of runs older than `maxAgeMs`, so `.runs-cache/` doesn't grow forever in local dev. Not called automatically. */
  async pruneOlderThan(maxAgeMs: number): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - maxAgeMs;
    await Promise.all(
      names
        .filter((n) => n.endsWith(".json"))
        .map(async (n) => {
          try {
            const raw = await readFile(path.join(this.dir, n), "utf8");
            const run = JSON.parse(raw) as StoredRun;
            if (new Date(run.updatedAt).getTime() < cutoff) {
              await rm(path.join(this.dir, n));
            }
          } catch {
            /* ignore unreadable/partial files */
          }
        }),
    );
  }
}

let singleton: RunStore | undefined;

/** The store every API route shares within this process. */
export function getRunStore(): RunStore {
  if (!singleton) {
    singleton = new FileRunStore();
  }
  return singleton;
}

/** Test-only: swap in a fresh store (e.g. a MemoryRunStore) and reset the singleton. */
export function _setRunStoreForTests(store: RunStore | undefined): void {
  singleton = store;
}
