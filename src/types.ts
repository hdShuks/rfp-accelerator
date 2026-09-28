// Mirrors the backend's src/lib/orchestrator/types.ts (structured `data` payloads
// are left as `unknown` here — the UI only renders `markdown`).

export interface PlaybookMeta {
  id: string;
  name: string;
  description: string;
}

export interface UploadedDoc {
  filename: string;
  text: string;
}

export type ClientType = "corporate" | "pe_sponsor";

export interface CompanyRef {
  name: string;
  ticker?: string;
  notes?: string;
  documents?: UploadedDoc[];
}

export interface RunInput {
  clientName: string;
  clientTicker?: string;
  clientType?: ClientType;
  clientNotes?: string;
  clientDocuments?: UploadedDoc[];
  targets?: CompanyRef[];
  proposalType?: string;
  description?: string;
  stepInstructions?: string;
  forceSteps?: string[];
  skipSteps?: string[];
}

export type ArtifactKind =
  | "financial_summary"
  | "narrative_extract"
  | "company_profile"
  | "research_note"
  | "synthesis_note"
  | "proposal_skeleton";

export interface Artifact {
  stepId: string;
  title: string;
  kind: ArtifactKind;
  data?: unknown;
  markdown: string;
  model?: string;
  costUsd?: number;
}

export interface Classification {
  type: string;
  name: string;
  confidence: number;
  rationale: string;
  source: "explicit" | "classified";
}

export interface StepCost {
  step: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface PlanSummary {
  steps: { id: string; title: string }[];
  added: string[];
  removed: string[];
  rationale: string;
}

export type RunEvent =
  | {
      type: "run_started";
      runId: string;
      playbookId: string;
      playbookName: string;
      steps: { id: string; title: string }[];
      classification: Classification;
    }
  | { type: "plan_ready"; plan: PlanSummary }
  | { type: "step_started"; stepId: string; title: string; tool: string }
  | { type: "step_progress"; stepId: string; message: string }
  | { type: "step_completed"; stepId: string; artifact: Artifact }
  | { type: "step_failed"; stepId: string; error: string }
  | { type: "budget_update"; spentUsd: number; ceilingUsd: number; breakdown: StepCost[] }
  | {
      type: "run_completed";
      runId: string;
      halted: boolean;
      haltReason?: string;
      proposalMarkdown: string | null;
      artifacts: Artifact[];
      spentUsd: number;
    }
  | { type: "run_failed"; runId: string; error: string };

export interface LlmHealth {
  apiKeyFromEnv: boolean;
  localSubscription: boolean;
  needsUserKey: boolean;
}
