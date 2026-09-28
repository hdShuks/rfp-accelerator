import { after } from "next/server";
import { assertLlmReachable, MissingApiKeyError } from "@/lib/llm/anthropic";
import { prepareRun } from "@/lib/orchestrator/execute";
import { sanitizeRunInput } from "@/lib/orchestrator/sanitize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The run itself now executes via after() below, decoupled from this
// response — see /api/run/[id]/events for how a client watches it. This
// ceiling still bounds how long the background work gets on Vercel Fluid;
// see SPEC §7.
export const maxDuration = 300;

export async function POST(req: Request) {
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const input = sanitizeRunInput(rawBody);
  if (!input) {
    return json({ error: "clientName is required" }, 400);
  }

  const userKey = req.headers.get("x-anthropic-key");
  try {
    assertLlmReachable(userKey);
  } catch (err) {
    const status = err instanceof MissingApiKeyError ? 401 : 500;
    return json({ error: err instanceof Error ? err.message : "Auth failed" }, status);
  }

  const { runId, run } = await prepareRun(input, userKey);
  after(run);

  return json({ runId }, 202);
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
