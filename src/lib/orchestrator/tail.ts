import { isStalled, type StoredRun } from "./store";
import type { RunEvent } from "./types";

export interface TailChunk {
  /** events beyond what this client has already been sent */
  newEvents: RunEvent[];
  /** true => the caller should stop polling and close the stream after sending newEvents */
  done: boolean;
}

/**
 * Pure decision logic for one poll tick of `GET /api/run/:id/events`: given
 * the run's current full state and how many events this client has already
 * received, returns the events to send now and whether to stop polling.
 *
 * Deliberately does *not* stop the moment `newEvents` contains a
 * `run_completed`/`run_failed` event: a resumed run's log still has the
 * prior (halted/failed) attempt's terminal event sitting mid-array,
 * followed by a fresh `run_started` and more real progress appended after
 * it. `status` — kept in sync by the store on every `setStatus()` call — is
 * the only reliable signal for "is this run actually still going"; an
 * event's type alone stopped being reliable once resume entered the
 * picture. (This was a real, observed bug: a client reconnecting to a
 * resumed run would see the stale terminal event mid-replay and disconnect
 * before ever seeing the resumed run's actual outcome.)
 */
export function nextChunk(latest: Pick<StoredRun, "events" | "status" | "updatedAt">, sentCount: number): TailChunk {
  return {
    newEvents: latest.events.slice(sentCount),
    done: latest.status !== "running" || isStalled(latest),
  };
}
