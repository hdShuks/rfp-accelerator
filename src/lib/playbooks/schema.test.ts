import { describe, expect, it } from "vitest";
import {
  playbookSchema,
  topoOrder,
  validatePlaybookGraph,
  type Playbook,
} from "./schema";

const base = {
  id: "t",
  name: "T",
  description: "d",
  steps: [
    { id: "a", tool: "llm_research" },
    { id: "b", tool: "llm_synthesis", depends_on: ["a"] },
    { id: "c", tool: "llm_synthesis", depends_on: ["a", "b"] },
  ],
};

describe("playbook schema", () => {
  it("parses a minimal playbook and applies defaults", () => {
    const pb = playbookSchema.parse(base);
    expect(pb.aliases).toEqual([]);
    expect(pb.inputs).toEqual({ required: [], optional: [] });
    expect(pb.steps[0].depends_on).toEqual([]);
  });

  it("rejects a non-snake_case step id", () => {
    expect(() =>
      playbookSchema.parse({ ...base, steps: [{ id: "Bad-Id", tool: "llm_research" }] }),
    ).toThrow();
  });

  it("rejects an unknown tool", () => {
    expect(() =>
      playbookSchema.parse({ ...base, steps: [{ id: "a", tool: "sql" }] }),
    ).toThrow();
  });
});

describe("validatePlaybookGraph", () => {
  it("accepts a valid DAG", () => {
    expect(() => validatePlaybookGraph(playbookSchema.parse(base))).not.toThrow();
  });

  it("rejects a dependency on an unknown step", () => {
    const pb = playbookSchema.parse({
      ...base,
      steps: [{ id: "a", tool: "llm_research", depends_on: ["ghost"] }],
    });
    expect(() => validatePlaybookGraph(pb)).toThrow(/unknown step/);
  });

  it("detects a cycle", () => {
    const pb = playbookSchema.parse({
      ...base,
      steps: [
        { id: "a", tool: "llm_synthesis", depends_on: ["b"] },
        { id: "b", tool: "llm_synthesis", depends_on: ["a"] },
      ],
    });
    expect(() => validatePlaybookGraph(pb)).toThrow(/cycle/);
  });
});

describe("topoOrder", () => {
  it("orders dependencies before dependents", () => {
    const order = topoOrder(playbookSchema.parse(base) as Playbook);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
  });
});
