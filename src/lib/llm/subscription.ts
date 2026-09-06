import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * "Local mode": call Claude through the Claude Code CLI, which authenticates
 * with the user's Claude subscription (Pro/Max) instead of an API key. Spend
 * counts against the plan / usage credits, not an API balance.
 *
 * Requires the `claude` CLI installed and logged in (`claude` → `/login` →
 * subscription). Never available on Vercel/serverless — there is no binary —
 * so the app falls back to bring-your-own API key there.
 */

export const SUBSCRIPTION_MODEL: Record<string, string> = {
  fast: "haiku",
  reasoning: "sonnet",
  deep: "opus",
};

let resolvedBin: string | null | undefined;

function candidateBins(): string[] {
  const home = homedir();
  return [
    process.env.RFP_CLAUDE_BIN,
    // standalone installer
    join(home, ".claude", "local", "claude"),
    join(home, ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ].filter((x): x is string => Boolean(x));
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Locate a usable `claude` binary, or null. Result is cached for the process. */
export function findClaudeBin(): string | null {
  if (resolvedBin !== undefined) return resolvedBin;
  if (process.env.VERCEL || process.env.RFP_LLM_MODE === "api") {
    resolvedBin = null;
    return null;
  }
  for (const c of candidateBins()) {
    if (isExecutable(c)) {
      resolvedBin = c;
      return c;
    }
  }
  // PATH lookup
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", ["claude"], {
      encoding: "utf8",
    })
      .split("\n")[0]
      .trim();
    if (out && isExecutable(out)) {
      resolvedBin = out;
      return out;
    }
  } catch {
    /* not on PATH */
  }
  resolvedBin = null;
  return null;
}

export function subscriptionAvailable(): boolean {
  return findClaudeBin() !== null;
}

/** test seam */
export function __setClaudeBin(bin: string | null | undefined): void {
  resolvedBin = bin;
}

export interface SubscriptionCallOpts {
  tier: string;
  system: string;
  prompt: string;
  timeoutMs?: number;
}

export interface SubscriptionCallResult {
  text: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  costUsd: number;
}

interface CliJson {
  result?: string;
  is_error?: boolean;
  subtype?: string;
  total_cost_usd?: number;
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export class SubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionError";
  }
}

export async function callViaSubscription(
  opts: SubscriptionCallOpts,
): Promise<SubscriptionCallResult> {
  const bin = findClaudeBin();
  if (!bin) throw new SubscriptionError("No `claude` CLI found for local subscription mode.");

  const model = SUBSCRIPTION_MODEL[opts.tier] ?? "sonnet";
  const args = [
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--system-prompt",
    opts.system,
    "--disallowed-tools",
    "*",
    "--max-turns",
    "1",
  ];

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { env: { ...process.env } });
    let out = "";
    let errOut = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new SubscriptionError("claude CLI timed out"));
    }, opts.timeoutMs ?? 180_000);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new SubscriptionError(`could not run claude CLI: ${e.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      // the CLI writes its JSON result to stdout even on a non-zero exit
      if (out.trim()) resolve(out);
      else reject(new SubscriptionError(`claude CLI produced no output. ${errOut.slice(0, 300)}`));
    });

    child.stdin.on("error", () => {});
    child.stdin.write(opts.prompt);
    child.stdin.end();
  });

  let json: CliJson;
  try {
    json = JSON.parse(stdout.trim().split("\n").at(-1) as string);
  } catch {
    throw new SubscriptionError(`Could not parse claude CLI output: ${stdout.slice(0, 200)}`);
  }

  const text = (json.result ?? "").trim();
  if (json.is_error || /not logged in|please run \/login/i.test(text)) {
    throw new SubscriptionError(
      /not logged in|\/login/i.test(text)
        ? "The `claude` CLI is not logged in. Run `claude` then `/login` and pick your subscription."
        : `claude CLI returned an error: ${text || json.subtype || "unknown"}`,
    );
  }

  const u = json.usage ?? {};
  const fullModelId =
    Object.keys(json.modelUsage ?? {}).find((k) => k.includes(model.replace(/\[.*\]/, ""))) ??
    `claude-${model === "haiku" ? "haiku-4-5" : model === "opus" ? "opus-5" : "sonnet-5"}`;

  return {
    text,
    model: fullModelId,
    usage: {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    },
    costUsd: json.total_cost_usd ?? 0,
  };
}
