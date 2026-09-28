import { beforeEach, describe, expect, it, vi } from "vitest";

const callClaude = vi.fn();
const readLearningExcerpt = vi.fn();

vi.mock("@/lib/llm/anthropic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/anthropic")>();
  return { ...actual, callClaude: (...a: unknown[]) => callClaude(...a) };
});

vi.mock("./learning", () => ({
  readLearningExcerpt: (...a: unknown[]) => readLearningExcerpt(...a),
  appendLearningRecord: vi.fn(),
}));

import { playbookSchema, type Playbook } from "@/lib/playbooks/schema";
import { planSteps } from "./planner";

const playbook: Playbook = playbookSchema.parse({
  id: "test_pb",
  name: "Test Playbook",
  description: "d",
  steps: [
    { id: "market_context", tool: "llm_research" },
    { id: "client_financials", tool: "edgar_financials" },
    { id: "synthesis", tool: "llm_synthesis", depends_on: ["market_context", "client_financials"] },
    { id: "proposal_skeleton", tool: "llm_synthesis", depends_on: ["market_context", "client_financials", "synthesis"] },
  ],
});

function claudeJson(text: string) {
  return {
    text,
    model: "claude-haiku-4-5",
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    costUsd: 0.0001,
    stopReason: "end_turn",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  readLearningExcerpt.mockResolvedValue(undefined);
});

describe("planSteps", () => {
  it("skips the planner call and keeps the default plan when there's nothing to reconsider", async () => {
    const { steps, summary } = await planSteps(playbook, { clientName: "C" }, "sk-test");
    expect(callClaude).not.toHaveBeenCalled();
    expect(steps.map((s) => s.id)).toEqual(["market_context", "client_financials", "synthesis", "proposal_skeleton"]);
    expect(summary.added).toEqual([]);
    expect(summary.removed).toEqual([]);
  });

  it("calls the planner (fast tier) when the user gives step instructions", async () => {
    callClaude.mockResolvedValue(
      claudeJson('{"steps":["market_context","client_financials","competitor_landscape","synthesis","proposal_skeleton"],"rationale":"Added competitor landscape."}'),
    );
    const { steps, summary } = await planSteps(
      playbook,
      { clientName: "C", stepInstructions: "add a competitor landscape section" },
      "sk-test",
    );
    expect(callClaude).toHaveBeenCalledWith(expect.objectContaining({ tier: "fast", stepId: "plan_steps" }));
    expect(steps.map((s) => s.id)).toContain("competitor_landscape");
    expect(summary.added).toEqual(["competitor_landscape"]);
    expect(summary.rationale).toContain("competitor landscape");
  });

  it("also calls the planner when there is relevant learning history, even with no explicit ask", async () => {
    readLearningExcerpt.mockResolvedValue("## past run\n- planned steps: ... [+precedent_transactions]");
    callClaude.mockResolvedValue(claudeJson('{"steps":["market_context","client_financials","synthesis","proposal_skeleton"],"rationale":"kept default"}'));
    await planSteps(playbook, { clientName: "C" }, "sk-test");
    expect(callClaude).toHaveBeenCalled();
    const prompt = callClaude.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("precedent_transactions");
  });

  it("always keeps the final default step last, even if the model puts it elsewhere", async () => {
    callClaude.mockResolvedValue(
      claudeJson('{"steps":["proposal_skeleton","market_context","client_financials","synthesis"],"rationale":"reordered"}'),
    );
    const { steps } = await planSteps(playbook, { clientName: "C", stepInstructions: "anything" }, "sk-test");
    expect(steps.at(-1)!.id).toBe("proposal_skeleton");
  });

  it("falls back to the default plan when the model response isn't valid JSON", async () => {
    callClaude.mockResolvedValue(claudeJson("not json at all"));
    const { steps, summary } = await planSteps(playbook, { clientName: "C", stepInstructions: "x" }, "sk-test");
    expect(steps.map((s) => s.id)).toEqual(["market_context", "client_financials", "synthesis", "proposal_skeleton"]);
    expect(summary.rationale).toMatch(/could not be parsed/i);
  });

  it("falls back to the default plan when the model call throws", async () => {
    callClaude.mockRejectedValue(new Error("network down"));
    const { steps, summary } = await planSteps(playbook, { clientName: "C", stepInstructions: "x" }, "sk-test");
    expect(steps.map((s) => s.id)).toEqual(["market_context", "client_financials", "synthesis", "proposal_skeleton"]);
    expect(summary.rationale).toMatch(/network down/);
  });

  it("silently drops unknown step ids from the model's response", async () => {
    callClaude.mockResolvedValue(
      claudeJson('{"steps":["market_context","made_up_step","client_financials","synthesis","proposal_skeleton"],"rationale":"r"}'),
    );
    const { steps } = await planSteps(playbook, { clientName: "C", stepInstructions: "x" }, "sk-test");
    expect(steps.map((s) => s.id)).not.toContain("made_up_step");
  });

  it("forceSteps adds a step even if the model didn't propose it", async () => {
    callClaude.mockResolvedValue(
      claudeJson('{"steps":["market_context","client_financials","synthesis","proposal_skeleton"],"rationale":"kept default"}'),
    );
    const { steps, summary } = await planSteps(
      playbook,
      { clientName: "C", forceSteps: ["competitor_landscape"] },
      "sk-test",
    );
    expect(steps.map((s) => s.id)).toContain("competitor_landscape");
    expect(summary.added).toContain("competitor_landscape");
  });

  it("forceSteps and skipSteps apply even when there's no catalog step left to offer", async () => {
    const noOptionalPlaybook: Playbook = playbookSchema.parse({
      id: "no_catalog_left",
      name: "N",
      description: "d",
      steps: [
        { id: "precedent_transactions", tool: "llm_research" },
        { id: "competitor_landscape", tool: "llm_research" },
        { id: "proposal_skeleton", tool: "llm_synthesis", depends_on: ["precedent_transactions", "competitor_landscape"] },
      ],
    });
    const { steps } = await planSteps(
      noOptionalPlaybook,
      { clientName: "C", skipSteps: ["competitor_landscape"] },
      "sk-test",
    );
    expect(callClaude).not.toHaveBeenCalled(); // nothing optional to plan for
    expect(steps.map((s) => s.id)).toEqual(["precedent_transactions", "proposal_skeleton"]);
  });

  it("skipSteps can never remove the final deliverable step", async () => {
    const { steps } = await planSteps(playbook, { clientName: "C", skipSteps: ["proposal_skeleton"] }, "sk-test");
    expect(steps.map((s) => s.id)).toContain("proposal_skeleton");
  });

  it("auto-wires an added catalog step into every synthesis step's dependencies", async () => {
    callClaude.mockResolvedValue(
      claudeJson('{"steps":["market_context","client_financials","competitor_landscape","synthesis","proposal_skeleton"],"rationale":"r"}'),
    );
    const { steps } = await planSteps(playbook, { clientName: "C", stepInstructions: "x" }, "sk-test");
    const synthesis = steps.find((s) => s.id === "synthesis")!;
    const proposal = steps.find((s) => s.id === "proposal_skeleton")!;
    expect(synthesis.depends_on).toContain("competitor_landscape");
    expect(proposal.depends_on).toContain("competitor_landscape");
  });
});
