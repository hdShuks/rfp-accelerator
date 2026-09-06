import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...a: unknown[]) => spawnMock(...a) };
});

import {
  __setClaudeBin,
  callViaSubscription,
  SubscriptionError,
  SUBSCRIPTION_MODEL,
  subscriptionAvailable,
} from "./subscription";

/** Fake ChildProcess that emits `stdout` then `close` on next tick. */
function fakeChild(stdout: string, { failSpawn = false } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: () => void; end: () => void; on: () => void };
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {}, on: () => {} };
  child.kill = () => {};
  queueMicrotask(() => {
    if (failSpawn) {
      child.emit("error", new Error("ENOENT"));
      return;
    }
    if (stdout) child.stdout.emit("data", stdout);
    child.emit("close", 0);
  });
  return child;
}

afterEach(() => {
  vi.clearAllMocks();
  __setClaudeBin(undefined);
});

const okJson = (result: string) =>
  JSON.stringify({
    subtype: "success",
    is_error: false,
    result,
    total_cost_usd: 0,
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0 },
  });

describe("subscriptionAvailable", () => {
  it("is false when no binary is found", () => {
    __setClaudeBin(null);
    expect(subscriptionAvailable()).toBe(false);
  });
  it("is true when a binary path is set", () => {
    __setClaudeBin("/fake/claude");
    expect(subscriptionAvailable()).toBe(true);
  });
});

describe("callViaSubscription", () => {
  it("throws when no CLI is available", async () => {
    __setClaudeBin(null);
    await expect(callViaSubscription({ tier: "fast", system: "s", prompt: "p" })).rejects.toThrow(
      SubscriptionError,
    );
  });

  it("maps tier to a model alias and parses the CLI JSON", async () => {
    __setClaudeBin("/fake/claude");
    spawnMock.mockImplementation(() => fakeChild(okJson("hello from claude")));

    const r = await callViaSubscription({ tier: "reasoning", system: "sys", prompt: "hi" });

    expect(r.text).toBe("hello from claude");
    expect(r.usage.input_tokens).toBe(1200);
    expect(r.usage.output_tokens).toBe(300);

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args[args.indexOf("--model") + 1]).toBe(SUBSCRIPTION_MODEL.reasoning);
    expect(args).toContain("--output-format");
    expect(args).toContain("--disallowed-tools");
  });

  it("surfaces a not-logged-in CLI response as a clear error", async () => {
    __setClaudeBin("/fake/claude");
    spawnMock.mockImplementation(() =>
      fakeChild(JSON.stringify({ is_error: true, result: "Not logged in · Please run /login" })),
    );
    await expect(callViaSubscription({ tier: "fast", system: "s", prompt: "p" })).rejects.toThrow(
      /not logged in/i,
    );
  });

  it("errors clearly when the binary cannot be spawned", async () => {
    __setClaudeBin("/fake/claude");
    spawnMock.mockImplementation(() => fakeChild("", { failSpawn: true }));
    await expect(callViaSubscription({ tier: "fast", system: "s", prompt: "p" })).rejects.toThrow(
      SubscriptionError,
    );
  });
});
