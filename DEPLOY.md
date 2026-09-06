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
   | `ANTHROPIC_API_KEY` | *(leave unset)* | keeps the tool bring-your-own-key |
   | `ALLOWED_ORIGIN` | your Lovable URL | optional — locks down CORS; defaults to `*` |
4. Deploy. Every push to `main` redeploys.

Notes:
- `/api/run` streams over SSE inside one request; `maxDuration = 300` (Vercel Fluid). If runs get longer, move to the resumable design in `SPEC.md` §7.
- Local subscription mode is automatically disabled on Vercel (`process.env.VERCEL`).
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
