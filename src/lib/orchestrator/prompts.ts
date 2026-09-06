import type { Playbook, Step } from "@/lib/playbooks/schema";
import type { Artifact, RunInput } from "./types";

export const SYSTEM_PROMPT = `You are a research assistant supporting a management-consulting proposal team.
You help turn a thin RFP brief into a structured research pass and a draft proposal skeleton.

Ground rules:
- Be concrete and specific. Prefer numbers, named comparables, and testable claims.
- Clearly separate what the provided data supports from what is inference or industry knowledge.
- Never invent financial figures. If a number is not in the supplied data, say so.
- Financial data supplied to you is already parsed from SEC EDGAR filings and ratios
  are pre-computed — treat those numbers as authoritative and do not recompute them.
- Write in crisp consulting prose. Use Markdown headings and bullets. No preamble, no
  "as an AI" language, no restating the question.
- This is a first draft for an internal team to react to, not a client deliverable.`;

const RESEARCH_TEMPLATES: Record<string, (input: RunInput) => string> = {
  market_context: (input) => `Produce a market and competitive context brief for a consulting proposal.

Client: ${input.clientName}${input.clientTicker ? ` (${input.clientTicker})` : ""}
${input.targetTicker ? `Acquisition target under consideration: ${input.targetTicker}\n` : ""}Engagement brief: ${input.description || "(none provided)"}

Cover, in ~400-600 words:
1. The industry / market the client operates in and its current dynamics (growth, structure, disruption).
2. The main competitors and how they are positioned.
3. The 2-3 forces most likely to shape the next 3 years.
4. What this implies for the kind of work described in the brief.

Use only general knowledge; flag anything you are unsure about. Do not fabricate specific market-size figures — give ranges or say "needs sourcing".`,
};

export function buildResearchPrompt(step: Step, input: RunInput): string {
  const key = step.prompt ?? "market_context";
  const base = (RESEARCH_TEMPLATES[key] ?? RESEARCH_TEMPLATES.market_context)(input);
  return step.instruction ? `${base}\n\nAdditional focus for this step:\n${step.instruction}` : base;
}

export function buildSynthesisPrompt(
  step: Step,
  input: RunInput,
  playbook: Playbook,
  deps: Artifact[],
): string {
  const isSkeleton = step.tool === "llm_synthesis" && step.id === "proposal_skeleton";
  const context = deps
    .map((d) => `--- ARTIFACT: ${d.title} (${d.kind}) ---\n${d.markdown}`)
    .join("\n\n");

  const header = `Engagement: ${playbook.name}
Client: ${input.clientName}${input.clientTicker ? ` (${input.clientTicker})` : ""}${
    input.targetTicker ? `\nTarget: ${input.targetTicker}` : ""
  }
Brief: ${input.description || "(none provided)"}

You have the following upstream research artifacts:

${context}
`;

  if (isSkeleton) {
    return `${header}

Assemble a DRAFT PROPOSAL SKELETON the team can react to. Structure:

## Situation
2-3 sentences on the client's context and why now.

## Complication / Question
The core question this engagement answers.

## Hypothesised Answer
Your current best answer in 1-2 sentences, then 3-4 supporting arguments.

## Proposed Approach
The 3-5 workstreams, each with: objective, key analyses, data/inputs needed, and rough duration.

## What We'd Need From the Client
Data, access, and stakeholders.

## Open Questions & Risks
The things most likely to change the answer.

Keep it to ~1 page. Cite the artifacts by name where a point rests on one.`;
  }

  return `${header}

${step.instruction ?? "Synthesise the artifacts above into a concise analytical note for the proposal team."}

Keep it under ~500 words. Use Markdown. Attribute claims to the artifact they come from.`;
}

export function buildClassifierPrompt(
  description: string,
  playbooks: { id: string; name: string; description: string }[],
): string {
  const options = playbooks
    .map((p) => `- id: ${p.id}\n  name: ${p.name}\n  when: ${p.description.replace(/\s+/g, " ").trim()}`)
    .join("\n");
  return `Classify the following RFP / engagement brief into exactly one proposal type.

Proposal types:
${options}

Brief:
"""
${description}
"""

Respond with ONLY a JSON object, no other text:
{"type": "<one id from the list>", "confidence": <0..1>, "rationale": "<one sentence>"}`;
}
