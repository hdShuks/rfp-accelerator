import { z } from "zod";

export const STEP_TOOLS = [
  "edgar_financials",
  "edgar_narrative",
  "llm_research",
  "llm_synthesis",
] as const;

export const stepSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9_]+$/, "step id must be snake_case"),
  title: z.string().optional(),
  tool: z.enum(STEP_TOOLS),
  model_tier: z.enum(["fast", "reasoning", "deep"]).optional(),
  /** map of param name -> input field name, e.g. { ticker: targetTicker } */
  inputs: z.record(z.string()).optional(),
  depends_on: z.array(z.string()).optional().default([]),
  /** prompt template key under src/lib/prompts/ (llm steps) */
  prompt: z.string().optional(),
  /** free-text instruction appended to the prompt (llm steps) */
  instruction: z.string().optional(),
});

export const playbookSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string(),
  description: z.string(),
  aliases: z.array(z.string()).optional().default([]),
  inputs: z
    .object({
      required: z.array(z.string()).default([]),
      optional: z.array(z.string()).default([]),
    })
    .default({ required: [], optional: [] }),
  steps: z.array(stepSchema).min(1),
});

export type Step = z.infer<typeof stepSchema>;
export type Playbook = z.infer<typeof playbookSchema>;
export type StepTool = (typeof STEP_TOOLS)[number];

/** Validate step dependency references and detect cycles. */
export function validatePlaybookGraph(pb: Playbook): void {
  const ids = new Set(pb.steps.map((s) => s.id));
  for (const s of pb.steps) {
    for (const dep of s.depends_on) {
      if (!ids.has(dep)) {
        throw new Error(`Playbook "${pb.id}": step "${s.id}" depends on unknown step "${dep}"`);
      }
    }
  }
  // cycle check via DFS
  const state = new Map<string, 0 | 1 | 2>();
  const byId = new Map(pb.steps.map((s) => [s.id, s]));
  const visit = (id: string, path: string[]): void => {
    const st = state.get(id) ?? 0;
    if (st === 1) throw new Error(`Playbook "${pb.id}": dependency cycle: ${[...path, id].join(" -> ")}`);
    if (st === 2) return;
    state.set(id, 1);
    for (const dep of byId.get(id)!.depends_on) visit(dep, [...path, id]);
    state.set(id, 2);
  };
  for (const s of pb.steps) visit(s.id, []);
}

/** Return step ids in dependency order (stable: preserves file order among peers). */
export function topoOrder(pb: Playbook): string[] {
  const byId = new Map(pb.steps.map((s) => [s.id, s]));
  const done = new Set<string>();
  const out: string[] = [];
  const emit = (id: string): void => {
    if (done.has(id)) return;
    for (const dep of byId.get(id)!.depends_on) emit(dep);
    done.add(id);
    out.push(id);
  };
  for (const s of pb.steps) emit(s.id);
  return out;
}
