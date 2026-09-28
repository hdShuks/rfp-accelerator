import type { ClientType, CompanyRef, RunInput, UploadedDoc } from "./types";

/**
 * Turns an arbitrary request body into a safe RunInput: caps array lengths and
 * string sizes so one request can't balloon memory/tokens or wedge the
 * planner with a nonsense payload. Never throws — always returns the best
 * input it can, dropping anything malformed.
 */

const MAX_TARGETS = 8;
const MAX_DOCS_PER_COMPANY = 5;
const MAX_DOC_CHARS = 40_000;
const MAX_FILENAME_CHARS = 200;
const MAX_NOTES_CHARS = 4_000;
const MAX_INSTRUCTIONS_CHARS = 2_000;
const MAX_STEP_OVERRIDES = 20;

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

function sanitizeDocs(v: unknown): UploadedDoc[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const docs = v
    .slice(0, MAX_DOCS_PER_COMPANY)
    .map((d): UploadedDoc | null => {
      if (typeof d !== "object" || d === null) return null;
      const filename = str((d as Record<string, unknown>).filename, MAX_FILENAME_CHARS) ?? "untitled";
      const text = str((d as Record<string, unknown>).text, MAX_DOC_CHARS);
      return text ? { filename, text } : null;
    })
    .filter((d): d is UploadedDoc => d !== null);
  return docs.length ? docs : undefined;
}

function sanitizeTargets(v: unknown): CompanyRef[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const targets = v
    .slice(0, MAX_TARGETS)
    .map((t): CompanyRef | null => {
      if (typeof t !== "object" || t === null) return null;
      const rec = t as Record<string, unknown>;
      const name = str(rec.name, 200);
      if (!name) return null;
      return {
        name,
        ticker: str(rec.ticker, 15)?.toUpperCase(),
        notes: str(rec.notes, MAX_NOTES_CHARS),
        documents: sanitizeDocs(rec.documents),
      };
    })
    .filter((t): t is CompanyRef => t !== null);
  return targets.length ? targets : undefined;
}

function sanitizeStepIds(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const ids = v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, MAX_STEP_OVERRIDES);
  return ids.length ? ids : undefined;
}

export function sanitizeRunInput(body: unknown): RunInput | null {
  if (typeof body !== "object" || body === null) return null;
  const rec = body as Record<string, unknown>;
  const clientName = str(rec.clientName, 200);
  if (!clientName) return null;

  const clientType: ClientType | undefined = rec.clientType === "pe_sponsor" ? "pe_sponsor" : undefined;

  return {
    clientName,
    clientTicker: str(rec.clientTicker, 15)?.toUpperCase(),
    clientType,
    clientNotes: str(rec.clientNotes, MAX_NOTES_CHARS),
    clientDocuments: sanitizeDocs(rec.clientDocuments),
    targets: sanitizeTargets(rec.targets),
    proposalType: str(rec.proposalType, 100),
    description: str(rec.description, 8_000),
    stepInstructions: str(rec.stepInstructions, MAX_INSTRUCTIONS_CHARS),
    forceSteps: sanitizeStepIds(rec.forceSteps),
    skipSteps: sanitizeStepIds(rec.skipSteps),
  };
}
