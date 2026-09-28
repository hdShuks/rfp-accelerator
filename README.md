# RFP Accelerator — UI (Lovable branch)

This branch is a **standalone Vite + React frontend**. It has **no backend** — it
calls the API of the deployed Next.js app (the `main` branch, hosted on Vercel).

Keep this branch for iterating on the **UI design in Lovable**. The product lives
on `main`.

```
lovable branch  ──HTTP──▶  main branch (Vercel)  ──▶  SEC EDGAR + Claude
   (this UI)                 /api/playbooks
                             /api/health
                             /api/run                POST — starts a run, returns { runId }
                             /api/run/:id/events      GET  — SSE: replay + poll until done
                             /api/run/:id/resume      POST — resume a halted/failed run
```

A run is now two steps, not one: `POST /api/run` returns immediately with a
`runId` while the orchestration executes in the background on `main`, and
`GET /api/run/:id/events` is how this UI watches it (replays everything
recorded so far, then polls for new events). This means a dropped
connection or a page reload doesn't lose progress — the UI persists the
in-flight `runId` to `sessionStorage` and reattaches to the same events
stream on load. If the stream ever closes without a terminal event (the run
stalled — e.g. it outlived one Vercel function invocation, or hit its
budget ceiling), the UI offers a "Resume run" button that calls
`POST /api/run/:id/resume`.

## Local dev

```bash
npm install
cp .env.example .env            # set VITE_API_BASE if your backend isn't on :3000
npm run dev                     # http://localhost:5173
```

`vite.config.ts` proxies `/api` to `VITE_API_BASE` in dev, so there's no CORS
issue locally. Run the backend too (`npm run dev` on a `main` checkout).

## Using this with Lovable

1. In Lovable: **connect GitHub → this repo → the `lovable` branch**.
2. Add an env var **`VITE_API_BASE`** = your Vercel deployment URL
   (e.g. `https://rfp-accelerator.vercel.app`).
3. On the backend (Vercel), set **`ALLOWED_ORIGIN`** to your Lovable app's URL so
   CORS is scoped (it defaults to `*`).
4. Iterate on the design in Lovable. It only touches this branch.
5. To bring a design change into the real product, **port the component changes
   into `main` by hand** — don't merge the branches (different build setups: this
   is Vite, `main` is Next.js).

## What's here

| file | purpose |
|---|---|
| `src/App.tsx` | the whole UI — brief form, live SSE step/cost/artifact stream |
| `src/types.ts` | mirror of the backend's `RunEvent` / `Artifact` types |
| `src/api.ts` | `VITE_API_BASE` resolution |
| `src/markdown.ts` | markdown → sanitised HTML for rendering artifacts |
| `src/styles.css` | plain CSS, theme-aware (light/dark) |

## Deploy (standalone)

`npm run build` → static files in `dist/`. Host anywhere (Lovable's own hosting,
Netlify, Vercel as a static project). Set `VITE_API_BASE` at build time.
