# RFP Accelerator — Handoff

Written 2026-09-28 for continuity into a fresh Claude Code session. Paste this
whole file as your opening instruction, or point the session at it
(`Read HANDOFF.md and continue from there`) after cloning the repo.

Repo: `hdShuks/rfp-accelerator` (GitHub). Branches: `main` (the product),
`lovable` (a separate frontend-only UI shell — see §Branches below).

## 1. What this is

A private toolkit that turns a thin RFP brief into a structured research pass
and a draft proposal skeleton: classify the engagement → run a data-driven
"playbook" of research steps → pull SEC EDGAR financials/filings (or fall back
to an AI-generated profile when there's no ticker) → synthesize a draft.
Modeled on a pattern Harsh saw at a Strategy& internship hackathon — **this is
a clean-room rebuild of the general pattern only**, no proprietary taxonomy,
prompts, or templates. Keep it that way; Harsh is returning to PwC full-time.

Full design doc: [`SPEC.md`](./SPEC.md) — read that for the authoritative
architecture. This file is a status snapshot + pointers, not a replacement.

## 2. Stack

Next.js 15 (App Router) + TypeScript + React 19, on `main`. Vitest for tests
(113 passing as of this handoff). No database — EDGAR responses cache to disk
(`.edgar-cache/`, gitignored), and a small append-only Markdown "learning log"
lives at `data/orchestration-learning.md` (gitignored, local-dev only).

## 3. Branches — read this before touching anything

- **`main`** — the actual product: UI + API routes + all orchestration logic.
  Deploy target = Vercel. CI (`.github/workflows/ci.yml`) runs typecheck +
  test + build on every push/PR and is green.
- **`lovable`** — a **separate, standalone Vite+React frontend**, no backend.
  Calls `main`'s deployed API via `VITE_API_BASE`. Exists so the UI can be
  redesigned in Lovable without Lovable and Claude Code fighting over the same
  repo. Its `src/types.ts` and `src/App.tsx` are mirrors of `main`'s contract —
  **when you change `RunInput`/`RunEvent` shape on `main`, mirror it here too**,
  or the Lovable UI silently breaks against the real API. See its own README.
- Don't merge these branches into each other — different build tooling
  (Next vs. Vite), by design.
- `DEPLOY.md` on `main` has the full Vercel + Lovable deploy runbook.

## 4. Reaching Claude — three modes, resolved per request

1. **User-pasted API key** — sent per-request via `x-anthropic-key` header,
   held client-side in `sessionStorage`, never logged/persisted server-side.
2. **`ANTHROPIC_API_KEY`** env var — **set on the Vercel deployment** (see
   DEPLOY.md) so anyone hitting `main`'s API there — directly, or via the
   Lovable-hosted frontend pointed at it — uses this key's API credits
   without needing to paste one. Bounded per run by `MAX_RUN_USD`; the
   accepted trade-off for a private/unlisted demo link (see DEPLOY.md for
   the BYO-key alternative if you'd rather not take that exposure).
3. **Local subscription mode** (`src/lib/llm/subscription.ts`) — shells out to
   the `claude` CLI (spawn + stdin, parses its `--output-format json`), which
   authenticates with a Claude Pro/Max subscription. **This is what Harsh uses
   locally** — he has Pro + usage credits but no separate API balance. Gated
   off automatically when `process.env.VERCEL` is set, or via `RFP_LLM_MODE=api`
   — so it's simply never reachable on Vercel/Lovable regardless of the above;
   the one `main` codebase picks the right mode per environment on its own.
   Keep `ANTHROPIC_API_KEY` unset in `.env.local` (as it is now) so local dev
   keeps falling through to this instead of spending API credits.

**If you're running this in a Claude Code cloud/remote environment**: check
whether a `claude` binary is on `PATH` there (`which claude`) — if the cloud
sandbox has Claude Code's own CLI available, subscription mode should work
the same way it does locally and will draw on the same account's usage
credits. If not, fall back to option 1 or 2 (buy a small amount of API credit
at console.anthropic.com — this is a **separate product/balance** from
claude.ai Pro/usage credits, they do not share billing). This distinction
tripped Harsh up once already — don't assume Pro-plan credits work with a
pasted API key, they don't.

Live-verified fact worth knowing: the `claude` CLI's `--output-format json`
reports a real, non-zero `total_cost_usd` even under subscription billing
(it's not literally charged against an API balance, but it's a real
API-rate-equivalent figure) — `callClaude` uses it directly for the budget
meter, falling back to a code-computed estimate only if it's ever 0/missing.

## 5. Architecture map

```
src/lib/edgar/          SEC EDGAR client, CIK resolution, companyfacts →
                         FinancialSummary reducer (ratios/CAGRs computed in
                         code, never by the model), 10-K narrative extraction
                         (best-effort HTML parsing, filer-dependent quality)

src/lib/llm/            anthropic.ts (tiered models + 3-mode dispatch above),
                         subscription.ts (claude CLI shell-out), budget.ts
                         (per-run USD ceiling), pricing.ts

src/lib/playbooks/      schema.ts (zod schema incl. for_each), loader.ts
playbooks/*.yaml        5 playbooks: ma_target_screen, digital_transformation,
                         org_design, commercial_excellence, market_entry

src/lib/orchestrator/
  types.ts               RunInput/RunEvent/Artifact/CompanyRef/PlanSummary —
                          THE contract; mirror changes into lovable/src/types.ts
  classifier.ts           explicit type passthrough, or Haiku reads the brief
  catalog.ts              optional steps a playbook doesn't list by default
                          (precedent_transactions, competitor_landscape)
  planner.ts              the "agent decides the steps" layer — see §6
  learning.ts             append-only Markdown log the planner reads/writes
  company.ts              ticker→EDGAR, or AI-profile fallback — see §6
  sanitize.ts             caps/validates the API request body
  prompts.ts              all prompt templates, incl. the planner's prompt
  format.ts               FinancialSummary/NarrativeExtract → Markdown
  runner.ts               the async-generator orchestration loop; takes an
                          optional resumeArtifacts/resumeSpent to skip
                          already-completed steps — see §7 item 1
  store.ts                RunStore: durable run state (input/events/status/
                          artifacts), file-backed under .runs-cache/
  tail.ts                 pure decision logic for one events-route poll tick
  execute.ts              glue: store + runner, used by all three routes below

src/app/                 Next.js UI (page.tsx) + API routes:
  api/playbooks           GET — list available playbooks
  api/classify             POST — classify a brief without running it
  api/health               GET — how Claude is currently reachable
  api/run                  POST — starts a run in the background, returns { runId }
  api/run/[id]/events      GET — SSE: replay + poll until a terminal event
  api/run/[id]/resume      POST — re-invoke a halted/failed/orphaned run
  middleware.ts             CORS for /api/* (so the lovable frontend can call it)
```

## 6. What makes this more than a fixed pipeline (the newest, least-tested-by-time work)

This was added in direct response to feedback mid-session — **verify it holds
up under more real use**, it's the newest code here:

- **`RunInput.targets` is an array**, not a single ticker: 0 targets (most
  playbooks), 1 (a normal M&A screen), or many (PE roll-up screen, or
  `market_entry`'s comparable set). A step marked `for_each: targets` in a
  playbook YAML runs once per target; downstream steps that `depends_on` it
  automatically collect every resulting artifact. `clientType`:
  `corporate` | `pe_sponsor` shapes prompt framing.
- **No ticker, or EDGAR can't resolve one → never fails the step.**
  `company.ts`: `edgar_financials` returns an honest "no filing data"
  placeholder (this tool never invents financial figures, even here);
  `edgar_narrative` falls back to a Claude-written profile from general
  knowledge plus any attached notes/documents, always labelled unverified.
- **File attachments** — plain text/Markdown only for now (no PDF/docx
  extraction), on the client and every target, capped and sanitized.
- **The orchestration plan is itself decided by an agent, not fixed per
  playbook.** `planner.ts`: after classification, a cheap Haiku call can
  splice catalog steps into the playbook's default step list based on the
  brief, the user's free-text `stepInstructions`, and a short excerpt of the
  learning log. Hard `forceSteps`/`skipSteps` overrides exist in the API
  (**no UI control yet** — only the free-text field is wired up). The call is
  skipped entirely when there's nothing to reconsider (saves the tokens), and
  any failure anywhere in this path falls back to the plain default plan —
  planning must never block a run. New steps auto-wire as a dependency of
  every default synthesis step; no manual YAML edits needed.
- **Learning log** (`learning.ts`) — plain Markdown, not a real memory system,
  file-based like the EDGAR cache. Local-dev only: ephemeral on Vercel
  (per-instance, doesn't survive cold starts/redeploys). Put a real store
  (KV/Postgres) behind it before relying on this in production.

### Live verification already done (real subscription billing, real EDGAR)

Ran the M&A playbook twice end-to-end with: a corporate client, two targets
(Coca-Cola/KO — real ticker — and a fictional private "Riverside Bottling Co"
with an attached teaser doc), and `stepInstructions: "also look at the
competitor landscape"`. Results:
- Planner correctly added `competitor_landscape`, citing both the brief's
  mention of consolidation and the explicit ask, in a genuinely well-reasoned
  rationale.
- KO resolved real EDGAR financials + 10-K narrative; Riverside correctly fell
  back to the no-data placeholder (financials) and an AI-written, clearly
  labelled profile (narrative) using the attached document.
- Total spend $0.29 of the $0.50 default ceiling; budget tracking was accurate
  throughout.
- The proposal skeleton was analytically sharp — it correctly treated KO as a
  category comparable rather than the actual target, and named real competing
  consolidators (Coca-Cola Consolidated, Reyes).
- **Real finding, not a bug:** this run took over 240 seconds and hadn't
  finished by then (a second, uncapped run confirmed it does finish, ~4-5 min
  total). A multi-target run with an added catalog step genuinely approaches
  Vercel's 300s function ceiling. This is the most load-bearing item in §7
  below — prioritize it if this serves more than one or two people at once.

## 7. Immediate next steps, roughly in priority order

1. ~~**Resumable runs**~~ — **done.** `POST /api/run` returns a `run_id`
   immediately and executes in the background (Next's `after()`);
   `GET /api/run/:id/events` replays everything recorded so far, then polls
   the store for new events (see `src/lib/orchestrator/store.ts` / `tail.ts`
   / `execute.ts`); `POST /api/run/:id/resume` re-invokes a halted/failed/
   orphaned run, skipping already-completed steps and honoring prior spend.
   Live-verified end to end (real subscription-mode calls, a tiny-budget
   halt, then a resume under a normal budget that correctly skipped the two
   cached steps and finished the run). Two real bugs surfaced along the way,
   both with regression tests, both worth knowing if you touch this code:
   - **Next.js bundles each Route Handler separately** — `/api/run`,
     `/api/run/:id/events`, and `/api/run/:id/resume` share *no* in-process
     module state, even under `next dev`, not just across separate Vercel
     invocations. An in-memory pub/sub for live-tailing was tried first and
     abandoned for exactly this reason. The run store must be the only
     shared source of truth, and no call site may assume it's the same
     store instance that saw any prior operation — see the regression test
     in `store.test.ts`.
   - A resumed run's event log keeps the prior attempt's terminal event
     sitting mid-array, followed by a fresh `run_started` and more real
     progress — the events route must not treat seeing a
     `run_completed`/`run_failed` *type* during replay as "stop", only the
     store's current `status` field decides that. See `tail.ts` and its
     tests.
   - **Still simplified, flagged in SPEC §7**: the store is file-backed
     (`.runs-cache/`, gitignored, same convention as the EDGAR cache) —
     ephemeral across Vercel cold starts, not a fix for multiple concurrent
     instances; and a run longer than one function invocation's `after()`
     window still needs something to call `/resume`, there's no true
     background worker yet.
   - **`lovable` was NOT updated to match** — its `src/App.tsx` still
     expects the old single-request SSE contract from `POST /api/run`. Port
     the two-step POST-then-watch flow from `src/app/page.tsx` (the
     `run()`/`watchRun()`/`resumeRun()` functions) into `lovable` before
     deploying that branch against this `main`.
2. **UI for `forceSteps`/`skipSteps`** — the backend/planner already support
   hard overrides; only a free-text field is exposed. A checklist of
   default+catalog steps the user can tick/untick would close this cleanly.
3. **PDF/docx extraction** for attachments (currently .txt/.md only — users
   have to paste content in manually).
4. **More catalog steps / playbooks** for other MBB archetypes the engine
   already supports structurally without new plumbing — PMI, cost
   transformation, turnaround are natural next playbooks (each is just a YAML
   file; a genuinely new research angle would be a new catalog.ts entry).
5. **A real store behind the learning log** if this needs to survive
   serverless cold starts / run across multiple instances.
6. Live web search tool for `llm_research` (currently general-knowledge only).
7. Segment-level XBRL parsing (dimensional facts) in the EDGAR reducer.
8. Export the proposal skeleton to .docx/.pptx.

## 8. Setup

```bash
git clone git@github.com:hdShuks/rfp-accelerator.git
cd rfp-accelerator
git checkout main        # the product; use `lovable` only for frontend work
npm install
cp .env.example .env.local
# edit .env.local: set EDGAR_USER_AGENT="Name your-email@example.com" — SEC
# blocks requests without a real contact
npm run dev               # http://localhost:3000
```

Claude access: paste a key in the running UI, or set `ANTHROPIC_API_KEY` in
`.env.local`, or (Harsh's normal path) install/log into the `claude` CLI —
see §4.

```bash
npm test          # vitest — 113 tests as of this handoff
npm run typecheck # tsc --noEmit
npm run build     # next build
```

Read [`SPEC.md`](./SPEC.md) in full before making structural changes — it's
kept current and is more detailed than this file on every subsystem.

## 9. Ground rules carried over from this session

- **Provenance**: general pattern only, never reconstruct anything specific
  to the internship's actual work product.
- **Never invent financial figures** — this is enforced in the system prompt
  and structurally in `company.ts` (the no-ticker fallback path never asks
  Claude for numbers, only qualitative profile text).
- **Cost discipline**: tiered models (Haiku for cheap/mechanical work, Sonnet
  for synthesis), a hard per-run USD ceiling that halts and returns partial
  results rather than overrunning, deterministic math wherever possible.
- **`ANTHROPIC_API_KEY` is deliberately set on the Vercel deployment** (as of
  this handoff) so the deployed link and the Lovable frontend work without a
  pasted key — a conscious choice to accept per-run-bounded (`MAX_RUN_USD`)
  exposure on that key for a private/unlisted link, not a public one. If this
  is ever shared more broadly, switch back to BYO-key (leave the var unset)
  per DEPLOY.md.
- Small, tested, honestly-documented steps over big untested leaps — every
  subsystem above has unit tests, and the newest/riskiest layer (§6) got a
  live end-to-end check before being called done, not just mocked tests.
