import { after } from "next/server";
import { assertLlmReachable, MissingApiKeyError } from "@/lib/llm/anthropic";
import { prepareResume } from "@/lib/orchestrator/execute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Re-invokes a halted, failed, or orphaned run from where it left off:
 * already-completed steps replay from the store instead of recomputing.
 * Rejects if the run is already executing live or already completed.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!RUN_ID_RE.test(id)) {
    return json({ error: "Invalid run id" }, 400);
  }

  const userKey = req.headers.get("x-anthropic-key");
  try {
    assertLlmReachable(userKey);
  } catch (err) {
    const status = err instanceof MissingApiKeyError ? 401 : 500;
    return json({ error: err instanceof Error ? err.message : "Auth failed" }, status);
  }

  const result = await prepareResume(id, userKey);
  if (!result.ok) {
    return json({ error: result.error }, result.status);
  }

  after(result.run);
  return json({ runId: id }, 202);
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
