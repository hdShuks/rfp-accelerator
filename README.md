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

Paste an Anthropic API key in the UI (held in the browser tab's `sessionStorage`
only), or set `ANTHROPIC_API_KEY` in `.env.local` for local dev.

## Scripts

| command | what |
|---|---|
| `npm run dev` | dev server |
| `npm test` | unit tests (vitest) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | production build |

## Playbooks

One YAML file per proposal type in [`playbooks/`](./playbooks). Adding a type is a
new file — the runner is data-driven. Each playbook is an ordered list of steps;
each step is one of four tools:

| tool | deterministic | does |
|---|---|---|
| `edgar_financials` | yes | ticker → CIK → companyfacts → compact `FinancialSummary` (ratios/CAGRs computed in code) |
| `edgar_narrative` | yes | latest 10-K → Item 1 / 1A / 7 text (best-effort HTML parse) |
| `llm_research` | no | Claude answers a research prompt from general knowledge |
| `llm_synthesis` | no | Claude combines named upstream artifacts |

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
- One transitive `postcss` advisory via Next 15 (dev tooling only; fixed in Next 16).
