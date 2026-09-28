import { getRunStore } from "@/lib/orchestrator/store";
import { nextChunk } from "@/lib/orchestrator/tail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL_MS = 750;

/**
 * Replays every event recorded for this run so far, then — while it's still
 * "running" — polls the store for new ones until a terminal event
 * (`run_completed`/`run_failed`) arrives or the client disconnects.
 *
 * Polls the store rather than subscribing to anything in-process: this
 * run's execution (`drive()` in execute.ts) can easily be happening in a
 * different process or instance than the one serving this request — that's
 * simply how separate Vercel invocations work, and was observed to happen
 * even between two sequential `next dev` requests locally. The store record
 * is the only thing both sides are guaranteed to share.
 *
 * If a run goes quiet for a while (see `STALL_MS` in store.ts) without a
 * terminal event, the stream just closes instead of polling forever — the
 * client can tell it didn't get a terminal event and offer to
 * `POST /api/run/:id/resume`.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!RUN_ID_RE.test(id)) {
    return json({ error: "Invalid run id" }, 400);
  }

  const store = getRunStore();
  const stored = await store.get(id);
  if (!stored) {
    return json({ error: "Run not found" }, 404);
  }

  const encoder = new TextEncoder();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let sentCount = 0;

      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      const closeStream = () => {
        if (stopped) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const tick = async () => {
        if (stopped) return;
        const latest = await store.get(id);
        if (!latest) {
          closeStream();
          return;
        }
        const { newEvents, done } = nextChunk(latest, sentCount);
        for (const event of newEvents) send(event);
        sentCount += newEvents.length;
        if (done) {
          closeStream();
          return;
        }
        timer = setTimeout(() => void tick(), POLL_MS);
      };

      void tick();
      req.signal.addEventListener("abort", () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      });
    },
    cancel() {
      stopped = true;
      if (timer) clearTimeout(timer);
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
