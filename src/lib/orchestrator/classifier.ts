import { callClaude } from "@/lib/llm/anthropic";
import type { RunBudget } from "@/lib/llm/budget";
import { getPlaybook, listPlaybooks } from "@/lib/playbooks/loader";
import { SYSTEM_PROMPT, buildClassifierPrompt } from "./prompts";
import type { Classification, RunInput } from "./types";

/**
 * Decide which playbook a run should use.
 *  - explicit proposalType (id or alias)  -> use it, confidence 1
 *  - otherwise                            -> Haiku reads the description
 */
export async function classify(
  input: RunInput,
  apiKey?: string | null,
  budget?: RunBudget,
): Promise<Classification> {
  if (input.proposalType?.trim()) {
    const pb = await getPlaybook(input.proposalType);
    return {
      type: pb.id,
      name: pb.name,
      confidence: 1,
      rationale: "Proposal type supplied in the brief.",
      source: "explicit",
    };
  }

  const playbooks = await listPlaybooks();
  const description = input.description?.trim();
  if (!description) {
    // Nothing to go on — default to the broadest playbook, low confidence.
    const fallback = playbooks[0];
    return {
      type: fallback.id,
      name: fallback.name,
      confidence: 0.2,
      rationale: "No proposal type and no description supplied; defaulted.",
      source: "classified",
    };
  }

  const res = await callClaude({
    apiKey,
    tier: "fast",
    system: SYSTEM_PROMPT,
    prompt: buildClassifierPrompt(description, playbooks),
    maxTokens: 300,
    budget,
    stepId: "classify",
  });

  const parsed = parseClassification(res.text);
  const match = playbooks.find((p) => p.id === parsed?.type) ?? playbooks[0];
  return {
    type: match.id,
    name: match.name,
    confidence: parsed ? clamp01(parsed.confidence) : 0.3,
    rationale: parsed?.rationale ?? "Model response could not be parsed; defaulted.",
    source: "classified",
  };
}

function parseClassification(
  text: string,
): { type: string; confidence: number; rationale: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (typeof o.type !== "string") return null;
    return {
      type: o.type,
      confidence: typeof o.confidence === "number" ? o.confidence : 0.5,
      rationale: typeof o.rationale === "string" ? o.rationale : "",
    };
  } catch {
    return null;
  }
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
