# Deploying

Two surfaces, kept on **separate branches** so they don't fight over the repo:

| Branch | Target | What it is |
|---|---|---|
| `main` | **Vercel** | The full app — UI + API routes + orchestration. This is the product. |
| `lovable` | **Lovable** | A standalone Vite/React frontend that talks to the deployed `main` API. For iterating on the UI design only. |

## Vercel (`main`)

1. Push `main` to GitHub (done).
2. [vercel.com/new](https://vercel.com/new) → import `hdShuks/rfp-accelerator` → framework auto-detects as Next.js.
3. **Environment Variables** (Project Settings → Environment Variables):
   | key | value | notes |
   |---|---|---|
   | `EDGAR_USER_AGENT` | `RFP Accelerator you@example.com` | **required** — SEC blocks requests without it |
   | `MAX_RUN_USD` | `0.50` | per-run cost ceiling |
   | `ANTHROPIC_API_KEY` | *(leave unset — see below)* | **never set this here** |
   | `ALLOWED_ORIGIN` | your Lovable URL | optional — locks down CORS; defaults to `*` |
4. Deploy. Every push to `main` redeploys.

### `ANTHROPIC_API_KEY` policy: **never set it on this deployment**

This link goes out to anyone evaluating the project — recruiters, other
engineers, strangers off a portfolio link — not a handful of trusted people.
Every visitor pastes their **own** Anthropic API key and spends against
**their own** budget, capped per run by `MAX_RUN_USD`; the live spend meter
in the UI shows it as it happens. The project owner's key must never be
reachable from this deployment, at any traffic level — there is deliberately
no fallback that lets a visitor spend the owner's money.

`src/lib/llm/anthropic.ts`'s dispatch, in priority order: a user-pasted key
(header) → `ANTHROPIC_API_KEY` → the local `claude` CLI on a subscription
(gated off whenever `process.env.VERCEL` is set — automatic on any Vercel
deployment, so it's never even attempted there). Concretely:
- **Local dev** (`npm run dev`, no `VERCEL` env var): leave `ANTHROPIC_API_KEY`
  unset in `.env.local` (as it already is) and it falls through to the
  `claude` CLI on your own Pro/Max subscription — no API credits spent, and
  nothing a site visitor can ever reach (this only runs on your own machine).
- **Vercel** (`main`'s public API): `ANTHROPIC_API_KEY` stays unset,
  permanently. With it unset and subscription mode impossible on Vercel
  anyway, `assertLlmReachable()` in `src/lib/llm/anthropic.ts` has no
  fallback left — a request with no pasted key gets a clear 401
  (`MissingApiKeyError`) instead of silently succeeding against your key.
  That's the point: there is no way to misconfigure this into "the owner
  pays," short of explicitly typing a key into this env var.
- **Lovable-hosted frontend**: it has no backend of its own — it only calls
  whichever `main` deployment `VITE_API_BASE` points at, so it inherits the
  same strict BYO-key requirement automatically.

Other notes:
- `/api/run` returns a `run_id` immediately and executes in the background
  (Next's `after()`); `GET /api/run/:id/events` is how a client watches it,
  replay-then-poll, surviving a dropped connection or reload. Each background
  execution is still bounded by `maxDuration = 300` (Vercel Fluid) — a run
  that doesn't finish in that window halts and `POST /api/run/:id/resume`
  picks it back up. See `SPEC.md` §7 for what's still simplified here (the
  run store is file-backed, ephemeral across cold starts on Vercel).
- Vercel **Hobby is non-commercial only** — private demo use is fine, paid client work needs Pro.

## Lovable (`lovable`)

The `lovable` branch is a Vite SPA — no backend. It calls the Vercel API via
`VITE_API_BASE`. Workflow:

1. In Lovable: connect GitHub → select this repo → the `lovable` branch.
2. Set `VITE_API_BASE` to your Vercel deployment URL (e.g. `https://rfp-accelerator.vercel.app`).
3. Iterate on the design in Lovable. It only touches the `lovable` branch.
4. When you want a design change in the real product, port the component changes
   from `lovable` into `main` by hand (don't merge the branches — they have
   different build setups).

See `lovable` branch's own `README.md` for details.
