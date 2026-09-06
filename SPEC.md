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
Input: { clientName, clientTicker?, targetTicker?, proposalType?, description }
   │
   ▼
Classifier ── if proposalType missing, Claude (Haiku) reads description,
              proposes { type, confidence, rationale }; user confirms/overrides
   │
   ▼
Playbook lookup ── proposalType → ordered step list (YAML, data not code)
   │
   ▼
Step runner ── for each step: gather inputs → run tool → emit typed Artifact
               (respects depends_on; halts on budget ceiling)
   │
   ▼
Synthesizer ── assembles Artifacts into a proposal skeleton (Markdown)
```

Each run streams progress to the client over SSE. The whole orchestration
executes inside one streaming HTTP response (fits Vercel Fluid's 300s ceiling for
the MVP; see §7 for the resumable design we'd move to if runs get longer).

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
| `edgar_financials` | yes | ticker → CIK → companyfacts → ~20-line compact table + computed ratios/CAGRs |
| `edgar_narrative` | yes | latest 10-K → Item 1 (Business), 1A (Risk Factors), 7 (MD&A) text |
| `llm_research` | no | Claude answers a research prompt from general knowledge |
| `llm_synthesis` | no | Claude combines named upstream artifacts into a new artifact |

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
are enforced server-side. In subscription mode the CLI reports $0 spend, so the
budget falls back to an API-rate estimate from the token counts.

---

## 5. API

| Route | Method | Body / result |
|---|---|---|
| `/api/classify` | POST | `{ description }` → `{ type, confidence, rationale }` |
| `/api/playbooks` | GET | list of `{ id, name, description, inputs }` |
| `/api/run` | POST | `{ input }` → **SSE stream** of `RunEvent`s |

`RunEvent` = `run_started | step_started | step_progress | step_completed | step_failed | budget_update | run_completed | run_failed`.

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

- Resumable runs: `POST /api/run` returns `run_id` immediately, steps persisted to
  a store (KV/Postgres), `GET /api/run/:id/events` replays + tails via SSE, each
  step independently retryable. Needed if runs exceed the function ceiling.
- Live web research tool (currently `llm_research` uses model knowledge only).
- Segment-level XBRL parsing (dimensional facts).
- Export to .docx / .pptx.
