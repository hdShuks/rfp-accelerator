import { EdgarError, getFinancialSummary, getNarrative } from "@/lib/edgar";
import { callClaude } from "@/lib/llm/anthropic";
import type { RunBudget } from "@/lib/llm/budget";
import { financialSummaryToMarkdown, narrativeToMarkdown } from "./format";
import { SYSTEM_PROMPT } from "./prompts";
import type { Artifact, CompanyRef } from "./types";

/**
 * Turns a CompanyRef into artifacts, whether or not it has a resolvable
 * ticker. This is what lets a run include private companies, foreign
 * listings, or anything else EDGAR doesn't have: the pipeline never just
 * fails a step because a ticker is missing.
 */

const DOC_CHAR_CAP = 18_000;

function docsBlock(docs?: UploadedDocLike[]): string {
  if (!docs?.length) return "";
  return docs
    .map((d) => `--- Uploaded: ${d.filename} ---\n${d.text.slice(0, DOC_CHAR_CAP)}`)
    .join("\n\n");
}

type UploadedDocLike = NonNullable<CompanyRef["documents"]>[number];

/**
 * Financial data for a company: EDGAR when there's a ticker that resolves,
 * otherwise an honest "no filing data" placeholder — this step never invents
 * numbers, even in the fallback path. Deterministic; no LLM call.
 */
export async function financialsArtifact(ref: CompanyRef, title: string): Promise<Artifact> {
  const docs = docsBlock(ref.documents);

  if (ref.ticker) {
    try {
      const summary = await getFinancialSummary(ref.ticker);
      const markdown = docs
        ? `${financialSummaryToMarkdown(summary)}\n\n### User-supplied materials\n\n${docs}`
        : financialSummaryToMarkdown(summary);
      return { stepId: "", title, kind: "financial_summary", data: summary, markdown };
    } catch (err) {
      if (!(err instanceof EdgarError)) throw err;
      // not on EDGAR — fall through to the placeholder below
    }
  }

  const lines = [
    `**${ref.name}** — no SEC filing data available` +
      (ref.ticker
        ? ` (ticker "${ref.ticker}" was not found in EDGAR — check the symbol, or it may be foreign-listed/private).`
        : " (no ticker given — likely private, or a division of another company)."),
  ];
  if (ref.notes) lines.push(`\nContext supplied: ${ref.notes}`);
  lines.push(
    docs
      ? `\n### User-supplied materials\n\n${docs}`
      : "\n_No financial documents were attached for this company. Attach a CIM, deck, or financial summary to ground this section — figures are never invented here._",
  );
  return { stepId: "", title, kind: "financial_summary", markdown: lines.join("\n") };
}

/**
 * Business/operations narrative for a company: the latest 10-K's Item 1/1A/7
 * when a ticker resolves, otherwise a Claude-written profile from general
 * knowledge plus whatever notes/documents were supplied — clearly labelled as
 * unverified, never presented as sourced from filings.
 */
export async function narrativeOrProfileArtifact(
  ref: CompanyRef,
  title: string,
  apiKey: string | null | undefined,
  budget: RunBudget | undefined,
  stepId: string,
): Promise<Artifact> {
  const docs = docsBlock(ref.documents);

  if (ref.ticker) {
    try {
      const narrative = await getNarrative(ref.ticker);
      const markdown = docs
        ? `${narrativeToMarkdown(narrative)}\n\n### User-supplied materials\n\n${docs}`
        : narrativeToMarkdown(narrative);
      return { stepId: "", title, kind: "narrative_extract", data: narrative, markdown };
    } catch (err) {
      if (!(err instanceof EdgarError)) throw err;
    }
  }

  const prompt = `Write a business profile for "${ref.name}"${
    ref.ticker
      ? ` (ticker "${ref.ticker}" — not found in SEC EDGAR; may be foreign-listed, private, or delisted)`
      : " (no public ticker supplied — likely private, or a division/subsidiary)"
  }.
${ref.notes ? `\nContext supplied about this company: ${ref.notes}\n` : ""}${
    docs ? `\nUser-supplied materials — treat these as ground truth over your general knowledge:\n\n${docs}\n` : ""
  }
Cover in ~350-500 words: what the company does, its market position, likely scale
(qualitative — do not invent specific financial figures), and notable risks. If you
don't recognise the company and no materials were supplied, say so plainly rather
than guessing. Flag every claim that rests on general knowledge rather than the
supplied materials.`;

  const res = await callClaude({
    apiKey,
    tier: "reasoning",
    system: SYSTEM_PROMPT,
    prompt,
    effort: "medium",
    budget,
    stepId,
  });

  const markdown = `> ⚠️ AI-generated profile — general knowledge${
    docs ? " plus user-supplied materials" : ""
  }, not sourced from any filing. Verify independently before relying on it.\n\n${res.text}`;

  return {
    stepId: "",
    title,
    kind: "company_profile",
    markdown,
    model: res.model,
    costUsd: res.costUsd,
  };
}
