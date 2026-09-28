import { assertLlmReachable, MissingApiKeyError } from "@/lib/llm/anthropic";
import { runOrchestration } from "@/lib/orchestrator/runner";
import { sanitizeRunInput } from "@/lib/orchestrator/sanitize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Give the orchestration room on Vercel Fluid (see SPEC §7 for the resumable design).
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

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        for await (const event of runOrchestration(input, userKey)) {
          send(event);
        }
      } catch (err) {
        send({ type: "run_failed", runId: "", error: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
