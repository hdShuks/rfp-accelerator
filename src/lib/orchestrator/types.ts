import type { FinancialSummary, NarrativeExtract } from "@/lib/edgar/types";
import type { StepCost } from "@/lib/llm/budget";

/** A plain-text (or markdown) file the user attached about a company. */
export interface UploadedDoc {
  filename: string;
  text: string;
}

/** Who the client is, for prompt framing (PE sponsors and corporates read differently). */
export type ClientType = "corporate" | "pe_sponsor";

/**
 * Any company the run needs to look at besides the client itself: an
 * acquisition target, a comparable/incumbent for a market-entry study, a
 * portfolio company for a PE roll-up. Zero, one, or many per run.
 */
export interface CompanyRef {
  name: string;
  /** if present, the runner tries EDGAR first */
  ticker?: string;
  /** free text — why this company matters, what's known about it */
  notes?: string;
  documents?: UploadedDoc[];
}

export interface RunInput {
  clientName: string;
  clientTicker?: string;
  clientType?: ClientType;
  clientNotes?: string;
  clientDocuments?: UploadedDoc[];
  /** acquisition target(s), comparables, portfolio companies — 0 or more */
  targets?: CompanyRef[];
  proposalType?: string; // playbook id or alias; blank => classify
  description?: string;

  /**
   * Free text steering the orchestration plan, e.g. "skip market context, add
   * precedent transactions and a competitor landscape section". Reconciled by
   * the planner against the step catalog — see src/lib/orchestrator/planner.ts.
   */
  stepInstructions?: string;
  /** hard overrides — catalog/step ids, bypass the planner's discretion */
  forceSteps?: string[];
  skipSteps?: string[];
}

export type ArtifactKind =
  | "financial_summary"
  | "narrative_extract"
  | "company_profile" // Claude-generated, used when no ticker/EDGAR match
  | "research_note"
  | "synthesis_note"
  | "proposal_skeleton";

export interface Artifact {
  stepId: string;
  title: string;
  kind: ArtifactKind;
  /** structured payload (EDGAR steps); undefined for text-only artifacts */
  data?: FinancialSummary | NarrativeExtract | Record<string, unknown>;
  /** human-readable rendering, always present */
  markdown: string;
  model?: string;
  costUsd?: number;
}

export interface Classification {
  type: string; // playbook id
  name: string;
  confidence: number; // 0..1
  rationale: string;
  source: "explicit" | "classified";
}

export interface PlanSummary {
  steps: { id: string; title: string }[];
  added: string[]; // catalog step ids the planner spliced in beyond the default playbook
  removed: string[]; // default steps the planner or user dropped
  rationale: string;
}

export type RunEvent =
  | { type: "run_started"; runId: string; playbookId: string; playbookName: string; steps: { id: string; title: string }[]; classification: Classification }
  | { type: "plan_ready"; plan: PlanSummary }
  | { type: "step_started"; stepId: string; title: string; tool: string }
  | { type: "step_progress"; stepId: string; message: string }
  | { type: "step_completed"; stepId: string; artifact: Artifact }
  | { type: "step_failed"; stepId: string; error: string }
  | { type: "budget_update"; spentUsd: number; ceilingUsd: number; breakdown: StepCost[] }
  | { type: "run_completed"; runId: string; halted: boolean; haltReason?: string; proposalMarkdown: string | null; artifacts: Artifact[]; spentUsd: number }
  | { type: "run_failed"; runId: string; error: string };

export interface RunResult {
  runId: string;
  halted: boolean;
  haltReason?: string;
  classification: Classification;
  artifacts: Artifact[];
  proposalMarkdown: string | null;
  spentUsd: number;
  breakdown: StepCost[];
}
