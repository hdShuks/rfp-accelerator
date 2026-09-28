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
- When a company has no filing data (private company, no ticker, or EDGAR couldn't
  resolve it), any profile of it is general knowledge or user-supplied materials —
  keep that framing explicit and never present it as sourced from a filing.
- When there is more than one target/comparable company, address each by name and
  don't collapse them into a single average — a proposal team needs to compare them.
- Write in crisp consulting prose. Use Markdown headings and bullets. No preamble, no
  "as an AI" language, no restating the question.
- This is a first draft for an internal team to react to, not a client deliverable.`;

function clientLine(input: RunInput): string {
  const label = input.clientType === "pe_sponsor" ? "PE sponsor" : "Corporate client";
  return `${label}: ${input.clientName}${input.clientTicker ? ` (${input.clientTicker})` : ""}${
    input.clientNotes ? ` — ${input.clientNotes}` : ""
  }`;
}

function targetsLine(input: RunInput): string {
  const targets = input.targets ?? [];
  if (!targets.length) return "";
  const kind = input.clientType === "pe_sponsor" ? "Portfolio/target companies" : "Target(s)/comparable(s)";
  const list = targets
    .map((t) => `  - ${t.name}${t.ticker ? ` (${t.ticker})` : " (no ticker)"}${t.notes ? ` — ${t.notes}` : ""}`)
    .join("\n");
  return `${kind}:\n${list}\n`;
}

const RESEARCH_TEMPLATES: Record<string, (input: RunInput) => string> = {
  market_context: (input) => `Produce a market and competitive context brief for a consulting proposal.

${clientLine(input)}
${targetsLine(input)}Engagement brief: ${input.description || "(none provided)"}

Cover, in ~400-600 words:
1. The industry / market the client operates in and its current dynamics (growth, structure, disruption).
2. The main competitors and how they are positioned.
3. The 2-3 forces most likely to shape the next 3 years.
4. What this implies for the kind of work described in the brief.

Use only general knowledge; flag anything you are unsure about. Do not fabricate specific market-size figures — give ranges or say "needs sourcing".`,

  precedent_transactions: (input) => `Identify precedent / comparable transactions relevant to this engagement.

${clientLine(input)}
${targetsLine(input)}Engagement brief: ${input.description || "(none provided)"}

List 4-6 transactions — acquisitions, mergers, or major investments by competitors
or other players in the same space (industry, adjacent segment, or the specific
sub-sector the target(s)/client compete in). For each one give: acquirer, target,
approximate year, the strategic rationale as reported, and (only if you actually
recall it — do not estimate or invent) any disclosed deal value or multiple. Mark
anything you're not confident about as "needs verification" rather than stating it
as fact. Close with 2-3 sentences on what this precedent set implies for the
current engagement (appetite, typical structure, likely pricing expectations).`,

  competitor_landscape: (input) => `Produce a competitor landscape deep-dive for a consulting proposal.

${clientLine(input)}
${targetsLine(input)}Engagement brief: ${input.description || "(none provided)"}

Name 3-5 specific competitors most relevant to this brief (not a generic industry
list — pick the ones that actually compete with this client/target(s) on this
question). For each: how they're positioned, what they do differently, and one
concrete signal of relative strength or weakness (a metric, a market-share claim,
a recent strategic move) — flag anything you're not confident about. Close with
what the client's realistic competitive position is relative to this set.`,
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
  const multiTarget = (input.targets?.length ?? 0) > 1;
  const context = deps
    .map((d) => `--- ARTIFACT: ${d.title} (${d.kind}) ---\n${d.markdown}`)
    .join("\n\n");

  const header = `Engagement: ${playbook.name}
${clientLine(input)}
${targetsLine(input)}Brief: ${input.description || "(none provided)"}

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
${multiTarget ? "\nIf multiple targets/comparables were researched, include a short comparison (not just a ranking) noting what would change the recommendation.\n" : ""}
## Proposed Approach
The 3-5 workstreams, each with: objective, key analyses, data/inputs needed, and rough duration.

## What We'd Need From the Client
Data, access, and stakeholders — call out anything a "no filing data" or AI-generated
profile artifact above flagged as unverified.

## Open Questions & Risks
The things most likely to change the answer.

Keep it to ~1 page. Cite the artifacts by name where a point rests on one.`;
  }

  return `${header}

${step.instruction ?? "Synthesise the artifacts above into a concise analytical note for the proposal team."}
${multiTarget ? "\nAddress each target/comparable company individually before any cross-company conclusion." : ""}
Keep it under ~500 words. Use Markdown. Attribute claims to the artifact they come from.`;
}

export interface PlannerContext {
  playbookName: string;
  defaultSteps: { id: string; title: string }[];
  catalog: { id: string; title: string; purpose: string }[];
  input: RunInput;
  learningExcerpt?: string;
}

export function buildPlannerPrompt(ctx: PlannerContext): string {
  const defaults = ctx.defaultSteps.map((s) => `  - ${s.id}: ${s.title}`).join("\n");
  const catalog = ctx.catalog.map((s) => `  - ${s.id}: ${s.title} — ${s.purpose}`).join("\n");
  const forced = ctx.input.forceSteps?.length ? `Must include: ${ctx.input.forceSteps.join(", ")}` : "";
  const skipped = ctx.input.skipSteps?.length ? `Must exclude: ${ctx.input.skipSteps.join(", ")}` : "";

  return `You are deciding which research steps to actually run for one consulting-proposal
engagement — you are not writing the research itself, just the plan.

Engagement type: ${ctx.playbookName}
${clientLine(ctx.input)}
${targetsLine(ctx.input)}Brief: ${ctx.input.description || "(none provided)"}
${ctx.input.stepInstructions ? `\nThe user explicitly asked for this orchestration:\n"${ctx.input.stepInstructions}"\n` : ""}${forced ? `\n${forced}` : ""}${skipped ? `\n${skipped}` : ""}

Default steps for this engagement type (already a sensible baseline — keep them
unless the user's instructions or the brief clearly argue against one):
${defaults}

Optional steps you may add if they'd genuinely help THIS brief (don't add
reflexively — only when the brief signals it matters, e.g. add precedent
transactions to a non-M&A engagement only if an acquisition or investment is part
of the ask; add competitor landscape only if competitive dynamics are central to
the question, not just "there is a market"):
${catalog}
${ctx.learningExcerpt ? `\nNotes from past runs of this engagement type (weigh a repeated, explicit user preference; ignore anything that reads as one-off):\n${ctx.learningExcerpt}\n` : ""}
Rules:
- Keep every default step unless the user explicitly asked to drop it or a "Must exclude" is listed above.
- "proposal_skeleton" must always be included and must always be last.
- Only add optional steps that clearly serve this specific brief.
- If nothing about this brief or the notes changes the picture, return the default list unchanged plus any "Must include" steps.

Respond with ONLY a JSON object, no other text:
{"steps": ["<ordered step ids, default and/or optional, ending in proposal_skeleton>"], "rationale": "<one or two sentences on what you changed and why, or that you kept the default plan>"}`;
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
