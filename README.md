# RFP Accelerator

A private toolkit that turns a thin RFP brief into a structured research pass and
a draft proposal skeleton. It classifies the engagement type, runs an ordered
**playbook** of research steps (some deterministic, some LLM-backed), pulls
financial data from **SEC EDGAR**, and synthesizes the artifacts into a draft.

See [`SPEC.md`](./SPEC.md) for the design.

> **Provenance.** Clean-room rebuild of a general pattern (classify → orchestrate
> research → pull EDGAR → synthesize with an LLM) from public building blocks. No
> proprietary taxonomy, prompts, or templates from any prior employer.
>
> **Licensing.** Vercel Hobby forbids commercial use — deploy this as a private
> demo only. Anything touching paid work needs Vercel Pro.

## Stack

- Next.js 15 (App Router), TypeScript, React 19
- SEC EDGAR REST/XBRL APIs (no key; requires a `User-Agent`)
- Anthropic API — tiered models (Haiku for classification/extraction, Sonnet for
  synthesis), per-run USD budget ceiling, prompt-cached system prompt
- Vitest for the EDGAR parser, budget math, playbook graph, and orchestration

## Local setup

```bash
npm install
cp .env.example .env.local   # then edit: set EDGAR_USER_AGENT to "Name your-email@example.com"
npm run dev                  # http://localhost:3000
```

### Reaching Claude — three options

The app tries these in order:

1. **API key pasted in the UI** — held in the browser tab's `sessionStorage`, sent
   per-request, never stored server-side.
2. **`ANTHROPIC_API_KEY`** in `.env.local`.
3. **Local subscription mode** — if the [`claude` CLI](https://docs.claude.com/en/docs/claude-code)
   is installed and logged into your Claude Pro/Max plan, the app shells out to it
   and spend counts against your plan / usage credits instead of an API balance.
   Local dev only — never available on Vercel. Set `RFP_LLM_MODE=api` to disable.

For a Claude Pro subscriber with no API credits, option 3 is the way to build and
test for free:

```bash
npm i -g @anthropic-ai/claude-code   # if you don't have it
claude            # then run /login and pick "Claude account with subscription"
npm run dev       # the app now uses your subscription — no key needed
```

## Scripts

| command | what |
|---|---|
| `npm run dev` | dev server |
| `npm test` | unit tests (vitest) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | production build |

CI (typecheck + test + build) runs on push/PR via
[`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

## Playbooks

One YAML file per proposal type in [`playbooks/`](./playbooks): `ma_target_screen`,
`digital_transformation`, `org_design`, `commercial_excellence`, `market_entry`.
Adding a type is a new file — the runner is data-driven. Each playbook is an
ordered list of steps; each step is one of four tools:

| tool | deterministic | does |
|---|---|---|
| `edgar_financials` | yes | ticker → CIK → companyfacts → compact `FinancialSummary` (ratios/CAGRs computed in code); no/unresolvable ticker → honest "no filing data" placeholder |
| `edgar_narrative` | yes | latest 10-K → Item 1 / 1A / 7 text (best-effort HTML parse); no/unresolvable ticker → Claude-written company profile, clearly labelled |
| `llm_research` | no | Claude answers a research prompt from general knowledge |
| `llm_synthesis` | no | Claude combines named upstream artifacts |

A step can also be `for_each: targets` to run once per company in `targets`
(acquisition targets, PE portfolio companies, market-entry comparables — 0, 1,
or many) instead of once for the client.

### Orchestration planning

The playbook's step list is a *default*, not the only option. A cheap Haiku
pass between classification and execution (`src/lib/orchestrator/planner.ts`)
can splice in steps from a shared catalog — currently `precedent_transactions`
(comparable M&A deals, on by default for M&A screens) and `competitor_landscape`
— when the brief calls for it or the user asks via the UI's "orchestration
notes" field. It reads a short append-only Markdown log of past runs
(`data/orchestration-learning.md`, local-dev only — see SPEC §1) so a repeated
preference sticks without re-typing it. Any failure here just falls back to the
plain default plan.

### Companies without a ticker

Client and targets both accept a name with no ticker, notes, and attached
`.txt`/`.md` files. No filing data is ever invented; instead the business
overview step writes an AI-generated profile from general knowledge plus
whatever you attached, clearly marked as unverified.

## Cost control

- Tiered models; deterministic math never goes to the model.
- `MAX_RUN_USD` (default $0.50) is a hard per-run ceiling — the runner halts and
  returns partial artifacts rather than overrunning.
- EDGAR responses are cached (filings are immutable).
- The `companyfacts` blob (5–20 MB) is reduced to ~20 line items in code before
  anything reaches Claude.

## Deploying to Vercel

Claude Code owns this repo → GitHub → Vercel. Import at `vercel.com/new`, set
`EDGAR_USER_AGENT` in Project Settings → Environment Variables, and **leave
`ANTHROPIC_API_KEY` unset** so the tool stays bring-your-own-key. Each push to
`main` auto-deploys. `/api/run` streams progress over SSE within one request
(`maxDuration = 300`); see SPEC §7 for the resumable design if runs get longer.

## Known limits

- 10-K narrative extraction is heuristic and varies by filer; when a section
  can't be located the UI flags it and links the source filing.
- `llm_research` uses model knowledge, not live web search.
- In-repo `.edgar-cache/` locally; serverless falls back to per-instance memory.
- File attachments are plain text/Markdown only — no PDF/docx extraction yet.
- The learning log (`data/orchestration-learning.md`) is local-dev only; it
  doesn't persist across Vercel deploys/cold starts.
- A multi-target M&A run with an added catalog step can approach Vercel's 300s
  function ceiling end-to-end — see SPEC §7 for the resumable-run design.
- `forceSteps`/`skipSteps` exist in the API but have no UI control yet.
- One transitive `postcss` advisory via Next 15 (dev tooling only; fixed in Next 16).
