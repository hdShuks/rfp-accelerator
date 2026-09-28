# RFP Accelerator — Spec

A private toolkit that turns a thin RFP brief into a structured research pass and a
draft proposal skeleton. It classifies the engagement type, runs an ordered
**playbook** of research steps (some deterministic, some LLM-backed), pulls
financial data from **SEC EDGAR**, and synthesizes the artifacts into a draft.

> **Provenance note.** This is a clean-room rebuild of a *general pattern*
> (classify → orchestrate research → pull EDGAR → synthesize with an LLM) from
> public building blocks. It contains no proprietary taxonomy, prompts, or
> templates from any prior employer. Keep it that way.

> **Licensing note.** Vercel Hobby forbids commercial use. This deploy is a
> private demo only. Anything touching paid client work needs Vercel Pro.

---

## 1. Core loop

```
Input: { clientName, clientTicker?, clientType?, targets?: Company[], proposalType?,
         description?, stepInstructions?, forceSteps?, skipSteps? }
   │
   ▼
Classifier ── if proposalType missing, Claude (Haiku) reads description,
              proposes { type, confidence, rationale }; user confirms/overrides
   │
   ▼
Playbook lookup ── proposalType → default ordered step list (YAML, data not code)
   │
   ▼
Planner ── cheap Haiku pass (skipped when there's nothing to reconsider) that can
           splice in catalog steps (precedent transactions, competitor landscape)
           based on the brief, explicit stepInstructions, hard force/skip
           overrides, and a Markdown learning log of past runs. Always falls
           back to the unmodified default plan on any failure.
   │
   ▼
Step runner ── for each step: gather inputs → run tool → emit typed Artifact
               (respects depends_on incl. auto-wired new steps; for_each: targets
               fans a step out across every target/comparable; halts on budget
               ceiling; a missing/unresolvable ticker falls back to an
               AI-generated company profile instead of failing)
   │
   ▼
Synthesizer ── assembles Artifacts into a proposal skeleton (Markdown)
   │
   ▼
Learning log ── appends what was planned vs. the default, and why, for next time
```

`POST /api/run` returns a `run_id` immediately; the orchestration itself runs
in the background (Next's `after()`) and persists every event to a run store
(`src/lib/orchestrator/store.ts`) as it goes. `GET /api/run/:id/events`
replays everything recorded so far over SSE, then polls the store for new
events until a terminal one lands — so a dropped connection, a page reload,
or a run outliving one Vercel function invocation (still bounded by
`maxDuration = 300`, but no longer fatal to watching it) all just mean
reconnecting to the same `run_id`. If a run goes quiet for a while
(`STALL_MS` in store.ts) without finishing, `POST /api/run/:id/resume`
re-invokes it: already-completed steps replay from the store instead of
recomputing, and prior spend counts against the budget ceiling. See §7 for
what's still simplified about this (file-backed store, no true background
worker beyond one function's `after()` window).

### Companies, not just tickers

`clientTicker` / a single `targetTicker` was the MVP shape. The real input is:
a client (`clientName`, optional `clientTicker`, `clientType`: `corporate` |
`pe_sponsor`, optional `clientNotes` + `clientDocuments`) and zero or more
`targets` — acquisition targets, PE portfolio/roll-up candidates, or
market-entry comparables — each `{ name, ticker?, notes?, documents? }`.

Any company without a ticker, or whose ticker EDGAR can't resolve, doesn't fail
the run: `edgar_financials` returns an honest "no filing data" placeholder
(never invents figures) and `edgar_narrative` falls back to a Claude-written
profile from general knowledge plus any attached notes/documents — always
labelled as unverified, never presented as sourced from a filing. See
`src/lib/orchestrator/company.ts`.

### Orchestration planning

A playbook's steps are the *default* plan, not the only plan. Between classify
and execute, `src/lib/orchestrator/planner.ts` runs a cheap Haiku call that can:
- add steps from a shared catalog (`src/lib/orchestrator/catalog.ts` —
  currently `precedent_transactions` and `competitor_landscape`) when the brief
  or the user's `stepInstructions` calls for it,
- honor hard `forceSteps` / `skipSteps` overrides (never removes the final
  deliverable step),
- and read a short excerpt of `src/lib/orchestrator/learning.ts`'s append-only
  Markdown log of past runs for this playbook type, so a repeated, explicit
  preference gets picked up without the user re-typing it every time.

The call is skipped entirely (saving the tokens) when there's no
`stepInstructions`, no force/skip overrides, and nothing relevant in the
learning log — most runs just use the default plan. Any parse failure, thrown
error, or invalid resulting step graph falls back to the unmodified default
plan; planning must never block a run. New steps are independent research
(`depends_on: []`) and get auto-wired as a dependency of every default
synthesis step, so no manual YAML edits are needed to make them count.

The learning log is a plain-text file, not a real memory system — no
embeddings, no dedupe. Disk locally (`data/orchestration-learning.md`,
gitignored); on serverless it's per-instance and does not persist across
deploys or cold starts. Treat it as a nice local-dev signal, and put a real
store (KV/Postgres) behind it before relying on it in production.

---

## 2. Playbook schema

Playbooks live in `playbooks/*.yaml`. One file per proposal type. Adding a type
means adding a file — never touching the runner.

```yaml
id: ma_target_screen
name: M&A / Acquisition Screen
description: Screen a public acquisition target for a corporate client.
inputs:                 # which top-level inputs this playbook needs
  required: [clientName, targetTicker]
  optional: [clientTicker, description]
steps:
  - id: market_context
    tool: llm_research           # LLM w/ general knowledge, no live web in MVP
    model_tier: reasoning
    prompt: market_context

  - id: target_financials
    tool: edgar_financials       # deterministic: companyfacts → compact table
    inputs: { ticker: targetTicker }

  - id: target_operations
    tool: edgar_narrative        # 10-K Items 1, 1A, 7 (text extract)
    inputs: { ticker: targetTicker }

  - id: synergy_hypotheses
    tool: llm_synthesis
    model_tier: reasoning
    depends_on: [target_financials, market_context]

  - id: proposal_skeleton
    tool: llm_synthesis
    model_tier: reasoning
    depends_on: [market_context, target_financials, target_operations, synergy_hypotheses]
```

### Step tools

| tool | deterministic? | description |
|---|---|---|
| `edgar_financials` | yes* | ticker → CIK → companyfacts → ~20-line compact table + computed ratios/CAGRs. No/unresolvable ticker → deterministic "no filing data" placeholder, never invented figures. |
| `edgar_narrative` | yes* | latest 10-K → Item 1 (Business), 1A (Risk Factors), 7 (MD&A) text. No/unresolvable ticker → Claude-written profile (general knowledge + any notes/documents), clearly labelled. |
| `llm_research` | no | Claude answers a research prompt from general knowledge |
| `llm_synthesis` | no | Claude combines named upstream artifacts into a new artifact |

A step may also set `for_each: targets` — instead of running once against the
client, it runs once per entry in `RunInput.targets`, each producing its own
artifact (`stepId::0`, `stepId::1`, ...). A downstream step that `depends_on` a
`for_each` step receives every one of those artifacts.

### Model tiers (`src/lib/llm/anthropic.ts`)

| tier | model | used for |
|---|---|---|
| `fast` | `claude-haiku-4-5` | classification, extraction, structured parsing |
| `reasoning` | `claude-sonnet-5` | synthesis, hypotheses, proposal skeleton |

`opus` is available as a tier but no playbook uses it by default.

---

## 3. EDGAR layer (`src/lib/edgar/`)

Free, no API key. Rules that are **non-negotiable**:

1. Every request sends `User-Agent: <EDGAR_USER_AGENT>` (name + email). SEC blocks
   requests without it.
2. Stay under 10 req/s. We serialize + throttle in `client.ts`.
3. CIK is zero-padded to 10 digits in `data.sec.gov` paths.

| Endpoint | Use |
|---|---|
| `www.sec.gov/files/company_tickers.json` | ticker → CIK. Cached to disk (one file, changes rarely). |
| `data.sec.gov/api/xbrl/companyfacts/CIK##########.json` | every tagged fact, all years. **5–20 MB.** Parsed deterministically — never sent to Claude. |
| `data.sec.gov/api/xbrl/companyconcept/CIK.../us-gaap/<Concept>.json` | one metric, clean series (fallback / targeted pulls). |
| `data.sec.gov/submissions/CIK##########.json` | filing index → raw 10-K/10-Q URLs. |

**Key design point:** `companyfacts` is huge. `facts.ts` reduces it to a compact
`FinancialSummary` (revenue, EBITDA proxy, net income, FCF, total debt, cash,
equity, shares, segment mix where tagged) across the last N fiscal years, plus
**code-computed** ratios and CAGRs. Only that summary reaches the model.

### Caching

`src/lib/edgar/cache.ts` — filings don't change. Key = endpoint + ticker + fiscal
period. Disk cache under `.edgar-cache/` locally; in serverless it degrades to an
in-process LRU (cold starts re-fetch, which is fine).

---

## 4. Cost control

- **Tiered models** (§2). Haiku for the cheap mechanical work.
- **Hard budget per run.** `src/lib/budget.ts` tracks input/output tokens and USD
  per step against `MAX_RUN_USD` (default $0.50). Runner halts and reports rather
  than silently continuing.
- **Prompt caching** on the system prompt + playbook context (identical across runs).
- **EDGAR cache** (§3) — no repeat fetches for the same ticker/period.
- **Deterministic math** — every ratio, CAGR, margin computed in code, never by
  the model.
- Running USD estimate streamed to the UI per step.

### Reaching Claude (`src/lib/llm/`)

Resolved per request, in priority order:

1. **User key** — pasted into a settings field, held in `sessionStorage` (gone on
   tab close), sent to the backend in the `x-anthropic-key` header over HTTPS.
   Used, never logged, never persisted.
2. **`ANTHROPIC_API_KEY`** env — local dev fallback; unset in the public deploy so
   the toolkit is truly BYO.
3. **Local subscription mode** (`subscription.ts`) — shells out to the `claude`
   CLI, which authenticates with the user's Claude Pro/Max plan. Spend counts
   against the plan, not an API balance. Gated off when `process.env.VERCEL` is
   set or `RFP_LLM_MODE=api`; unavailable when no `claude` binary is found.

All model calls go through the backend (never browser → Anthropic) so budget caps
are enforced server-side. In subscription mode the CLI reports its own
API-rate-equivalent cost estimate (confirmed against real runs — not billed to
an API balance, but a real dollar figure), which the budget uses directly;
if that ever comes back as 0 or missing, the budget falls back to computing the
same estimate itself from the token counts.

---

## 5. API

| Route | Method | Body / result |
|---|---|---|
| `/api/classify` | POST | `{ description }` → `{ type, confidence, rationale }` |
| `/api/playbooks` | GET | list of `{ id, name, description, inputs }` |
| `/api/health` | GET | `{ llm: { apiKeyFromEnv, localSubscription, needsUserKey } }` |
| `/api/run` | POST | `RunInput` → **SSE stream** of `RunEvent`s |

`RunEvent` = `run_started | plan_ready | step_started | step_progress | step_completed | step_failed | budget_update | run_completed | run_failed`.

`/api/run`'s body is sanitized by `src/lib/orchestrator/sanitize.ts` before
anything else touches it — caps target count (8), documents per company (5),
document size (40k chars), and note/instruction lengths, and drops anything
malformed rather than erroring. Never trust the request body past that
function.

---

## 6. Build milestones (vertical slices)

1. **Slice 1 — EDGAR to table.** Hardcoded ticker → CIK lookup → companyfacts →
   `FinancialSummary` with computed ratios. **Vitest fixtures + real assertions.** ✅ load-bearing
2. **Slice 2 — one LLM call.** `FinancialSummary` → single Sonnet synthesis → Markdown out. Budget tracked.
3. **Slice 3 — playbook engine.** YAML loader + schema validation + dependency-ordered runner.
4. **Slice 4 — classifier.** Haiku classifies description → type + confidence.
5. **Slice 5 — SSE run route.** Full orchestration streamed.
6. **Slice 6 — UI.** Input form → live step progress → rendered skeleton + artifacts.

Commit after each slice.

---

## 7. Later (not in MVP)

- **Resumable runs landed, but the store is still file-backed** (`.runs-cache/`,
  gitignored, same convention as the EDGAR cache and the learning log) — fine
  for local dev and a single long-lived instance, but ephemeral across Vercel
  cold starts and not shared between concurrent instances. Put a real store
  (KV/Postgres) behind `src/lib/orchestrator/store.ts`'s `RunStore` interface
  before relying on this for more than one person at a time in production.
  Also worth knowing: Next.js bundles each Route Handler separately — `/api/run`,
  `/api/run/:id/events`, and `/api/run/:id/resume` do **not** share any
  in-process module state (confirmed even under `next dev`, not just across
  Vercel invocations) — so anything that matters must go through the store,
  never an in-memory singleton/cache. An earlier draft of this feature learned
  that the hard way (see the regression test in `store.test.ts`).
- A true background worker: right now, resumed/long-running work still rides
  inside one function invocation's `after()` window (bounded by
  `maxDuration`). A run genuinely longer than that still needs a queue/worker
  (Vercel Queues, Inngest, QStash) picking up where `resume` leaves off,
  rather than a human re-POSTing `/resume`.
- Live web research tool (currently `llm_research` uses model knowledge only).
- Segment-level XBRL parsing (dimensional facts).
- Export to .docx / .pptx.
- More catalog steps / playbooks for other MBB archetypes the engine already
  supports structurally (PMI, cost transformation, turnaround) — adding one is
  a YAML file plus, if it needs a new research angle, a catalog entry.
- File uploads are plain text/Markdown only; no PDF/docx extraction yet — the
  UI asks users to paste content into a `.txt` file in the meantime.
- `forceSteps` / `skipSteps` are real in the API and planner but have no UI
  control yet — only the free-text `stepInstructions` field is wired up.
- A real memory store behind the learning log (see §1) once this needs to
  survive serverless cold starts / multiple instances.
