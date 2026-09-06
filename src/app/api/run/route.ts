import { resolveApiKey, MissingApiKeyError } from "@/lib/llm/anthropic";
import { runOrchestration } from "@/lib/orchestrator/runner";
import type { RunInput } from "@/lib/orchestrator/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Give the orchestration room on Vercel Fluid (see SPEC §7 for the resumable design).
export const maxDuration = 300;

export async function POST(req: Request) {
  let body: Partial<RunInput>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.clientName?.trim()) {
    return json({ error: "clientName is required" }, 400);
  }

  let apiKey: string;
  try {
    apiKey = resolveApiKey(req.headers.get("x-anthropic-key"));
  } catch (err) {
    const status = err instanceof MissingApiKeyError ? 401 : 500;
    return json({ error: err instanceof Error ? err.message : "Auth failed" }, status);
  }

  const input: RunInput = {
    clientName: body.clientName.trim(),
    clientTicker: body.clientTicker?.trim() || undefined,
    targetTicker: body.targetTicker?.trim() || undefined,
    proposalType: body.proposalType?.trim() || undefined,
    description: body.description?.trim() || undefined,
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        for await (const event of runOrchestration(input, apiKey)) {
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
