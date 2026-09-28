import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * A running, append-only Markdown log the planner reads before deciding a
 * step list and writes to after each run. This is deliberately simple — plain
 * text, no embeddings, no dedupe — a human can open it and read it. It's
 * meant to catch "this user always wants X for this engagement type", not to
 * be a real memory system.
 *
 * File-based like the EDGAR cache: disk locally, falls back to the OS tmp dir
 * if the working directory isn't writable. On serverless (Vercel) this is
 * per-instance and does NOT persist across deploys or cold starts — treat it
 * as a nice-to-have locally, and swap in a real store (KV/Postgres) before
 * relying on it in production. Every operation here is best-effort and never
 * throws — a broken log must never break a run.
 */

function candidatePaths(): string[] {
  const disk = process.env.LEARNING_LOG_PATH || join(process.cwd(), "data", "orchestration-learning.md");
  const tmp = join(tmpdir(), "rfp-orchestration-learning.md");
  return [disk, tmp];
}

let resolvedPath: string | null | undefined;

async function resolvePath(): Promise<string | null> {
  if (resolvedPath !== undefined) return resolvedPath;
  for (const p of candidatePaths()) {
    try {
      await mkdir(dirname(p), { recursive: true });
      await appendFile(p, ""); // touch — throws if the directory isn't writable
      resolvedPath = p;
      return p;
    } catch {
      /* try the next candidate */
    }
  }
  resolvedPath = null;
  return null;
}

export interface LearningRecord {
  playbookId: string;
  clientName: string;
  clientType?: string;
  targets: string[];
  defaultSteps: string[];
  plannedSteps: string[];
  stepInstructions?: string;
  rationale: string;
}

function formatRecord(rec: LearningRecord): string {
  const added = rec.plannedSteps.filter((s) => !rec.defaultSteps.includes(s));
  const removed = rec.defaultSteps.filter((s) => !rec.plannedSteps.includes(s));
  const lines = [
    `\n## ${new Date().toISOString()} — playbook: ${rec.playbookId}`,
    `- client: ${rec.clientName}${rec.clientType ? ` (${rec.clientType})` : ""}`,
    `- targets: ${rec.targets.length ? rec.targets.join(", ") : "(none)"}`,
    `- default steps: ${rec.defaultSteps.join(", ")}`,
    `- planned steps: ${rec.plannedSteps.join(", ")}${added.length ? ` [+${added.join(", ")}]` : ""}${removed.length ? ` [-${removed.join(", ")}]` : ""}`,
  ];
  if (rec.stepInstructions) lines.push(`- user instructions: "${rec.stepInstructions}"`);
  lines.push(`- planner rationale: ${rec.rationale}`);
  return lines.join("\n") + "\n";
}

export async function appendLearningRecord(rec: LearningRecord): Promise<void> {
  try {
    const p = await resolvePath();
    if (!p) return;
    await appendFile(p, formatRecord(rec));
  } catch {
    /* best-effort — never let logging break a run */
  }
}

/** Past records for this playbook, most recent last, capped to maxChars. */
export async function readLearningExcerpt(playbookId: string, maxChars = 4000): Promise<string | undefined> {
  try {
    const p = await resolvePath();
    if (!p || !existsSync(p)) return undefined;
    const full = await readFile(p, "utf8");
    const sections = full.split(/\n(?=## )/).filter((s) => s.includes(`playbook: ${playbookId}`));
    if (!sections.length) return undefined;
    const joined = sections.join("\n").trim();
    return joined.length > maxChars ? joined.slice(-maxChars) : joined;
  } catch {
    return undefined;
  }
}

/** test seam */
export function __resetLearningPath(): void {
  resolvedPath = undefined;
}
