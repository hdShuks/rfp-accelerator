import type { FinancialSummary, NarrativeExtract } from "@/lib/edgar/types";
import type { StepCost } from "@/lib/llm/budget";

export interface RunInput {
  clientName: string;
  clientTicker?: string;
  /** M&A target, when distinct from the client */
  targetTicker?: string;
  proposalType?: string; // playbook id or alias; blank => classify
  description?: string;
}

export type ArtifactKind =
  | "financial_summary"
  | "narrative_extract"
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

export type RunEvent =
  | { type: "run_started"; runId: string; playbookId: string; playbookName: string; steps: { id: string; title: string }[]; classification: Classification }
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
