import type { Step } from "@/lib/playbooks/schema";

/**
 * Steps available to the planner beyond whatever a playbook lists by default.
 * A playbook's own steps are still the baseline; the planner (planner.ts)
 * decides whether to splice any of these in, based on the brief, explicit
 * user step instructions, and the learning log. Kept separate from the YAML
 * playbooks because these are cross-cutting — useful to more than one
 * proposal type — rather than owned by any single one.
 */
export const STEP_CATALOG: Record<string, Step> = {
  precedent_transactions: {
    id: "precedent_transactions",
    title: "Precedent transactions",
    tool: "llm_research",
    model_tier: "reasoning",
    prompt: "precedent_transactions",
    depends_on: [],
  },
  competitor_landscape: {
    id: "competitor_landscape",
    title: "Competitor landscape",
    tool: "llm_research",
    model_tier: "reasoning",
    prompt: "competitor_landscape",
    depends_on: [],
  },
};

export function catalogDescriptions(): { id: string; title: string; purpose: string }[] {
  return [
    {
      id: "precedent_transactions",
      title: "Precedent transactions",
      purpose:
        "Comparable/similar M&A transactions done by competitors or in the same space — deal multiples, strategic rationale, what they signal about market appetite.",
    },
    {
      id: "competitor_landscape",
      title: "Competitor landscape",
      purpose:
        "A dedicated deep-dive on named competitors and how they compare — beyond the brief mention market_context already gives.",
    },
  ];
}
