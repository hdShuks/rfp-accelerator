import { describe, expect, it } from "vitest";
import { getPlaybook, listPlaybooks, loadPlaybooks } from "./loader";
import { topoOrder, validatePlaybookGraph } from "./schema";

describe("bundled playbooks", () => {
  it("all load and pass graph validation", async () => {
    const map = await loadPlaybooks();
    expect(map.size).toBeGreaterThanOrEqual(4);
    for (const pb of map.values()) {
      expect(() => validatePlaybookGraph(pb)).not.toThrow();
      expect(topoOrder(pb)).toHaveLength(pb.steps.length);
    }
  });

  it("each playbook ends with a proposal_skeleton step", async () => {
    const map = await loadPlaybooks();
    for (const pb of map.values()) {
      expect(pb.steps.some((s) => s.id === "proposal_skeleton")).toBe(true);
    }
  });

  it("resolves playbooks by id and by alias", async () => {
    const byId = await getPlaybook("ma_target_screen");
    const byAlias = await getPlaybook("M&A");
    expect(byAlias.id).toBe(byId.id);
  });

  it("throws a helpful error for an unknown type", async () => {
    await expect(getPlaybook("underwater_basket_weaving")).rejects.toThrow(/Known:/);
  });

  it("listPlaybooks exposes id, name, description and inputs", async () => {
    const list = await listPlaybooks();
    expect(list.every((p) => p.id && p.name && p.description && p.inputs)).toBe(true);
  });
});
