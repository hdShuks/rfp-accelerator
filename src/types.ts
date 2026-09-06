// Mirrors the backend's src/lib/orchestrator/types.ts (structured `data` payloads
// are left as `unknown` here — the UI only renders `markdown`).

export interface PlaybookMeta {
  id: string;
  name: string;
  description: string;
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

export type RunEvent =
  | {
      type: "run_started";
      runId: string;
      playbookId: string;
      playbookName: string;
      steps: { id: string; title: string }[];
      classification: Classification;
    }
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
