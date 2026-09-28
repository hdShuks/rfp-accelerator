import { useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "./api";
import { renderMarkdown } from "./markdown";
import type { Artifact, Classification, LlmHealth, PlanSummary, PlaybookMeta, RunEvent, UploadedDoc } from "./types";

type StepStatus = "pending" | "running" | "done" | "failed";
interface StepView {
  id: string;
  title: string;
  tool?: string;
  status: StepStatus;
  detail?: string;
}

interface TargetForm {
  name: string;
  ticker: string;
  notes: string;
  documents: UploadedDoc[];
}

const KEY_STORAGE = "rfp.anthropicKey";
const RUN_ID_STORAGE = "rfp.runId";
const MAX_UPLOAD_CHARS = 40_000; // mirrors the server-side cap in sanitize.ts

async function readFileAsText(file: File): Promise<UploadedDoc> {
  const text = await file.text();
  return { filename: file.name, text: text.slice(0, MAX_UPLOAD_CHARS) };
}

function emptyTarget(): TargetForm {
  return { name: "", ticker: "", notes: "", documents: [] };
}

export default function App() {
  const [apiKey, setApiKey] = useState("");
  const [playbooks, setPlaybooks] = useState<PlaybookMeta[]>([]);
  const [llm, setLlm] = useState<LlmHealth | null>(null);

  const [clientName, setClientName] = useState("");
  const [clientTicker, setClientTicker] = useState("");
  const [clientType, setClientType] = useState<"corporate" | "pe_sponsor">("corporate");
  const [clientNotes, setClientNotes] = useState("");
  const [clientDocuments, setClientDocuments] = useState<UploadedDoc[]>([]);
  const [proposalType, setProposalType] = useState("");
  const [description, setDescription] = useState("");
  const [stepInstructions, setStepInstructions] = useState("");
  const [targets, setTargets] = useState<TargetForm[]>([]);

  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<StepView[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [proposal, setProposal] = useState<string | null>(null);
  const [classification, setClassification] = useState<Classification | null>(null);
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [spent, setSpent] = useState(0);
  const [ceiling, setCeiling] = useState(0.5);
  const [notice, setNotice] = useState<{ kind: "warn" | "err"; text: string } | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  // Set when the events stream closes without a terminal event — the run is
  // still "running" per the server but nothing is left producing events for
  // it (dropped connection, or the process executing it died). Offers a
  // resume instead of just looking hung.
  const [stalled, setStalled] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      const k = sessionStorage.getItem(KEY_STORAGE);
      if (k) setApiKey(k);
    } catch {
      /* private mode */
    }
    fetch(apiUrl("/api/playbooks"))
      .then((r) => r.json())
      .then((d) => setPlaybooks(d.playbooks ?? []))
      .catch(() => setNotice({ kind: "err", text: "Could not reach the backend API. Check VITE_API_BASE." }));
    fetch(apiUrl("/api/health"))
      .then((r) => r.json())
      .then((d) => setLlm(d.llm ?? null))
      .catch(() => {});

    // Reload/reconnect: if a run was in flight when this tab last closed,
    // reattach to it — the events endpoint replays everything recorded so
    // far and keeps tailing if it's still going.
    try {
      const savedRunId = sessionStorage.getItem(RUN_ID_STORAGE);
      if (savedRunId) {
        setRunId(savedRunId);
        void watchRun(savedRunId);
      }
    } catch {
      /* private mode */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function persistKey(k: string) {
    setApiKey(k);
    try {
      if (k) sessionStorage.setItem(KEY_STORAGE, k);
      else sessionStorage.removeItem(KEY_STORAGE);
    } catch {
      /* ignore */
    }
  }

  const canRun = clientName.trim().length > 0 && !running;

  function addTarget() {
    setTargets((prev) => [...prev, emptyTarget()]);
  }
  function updateTarget(i: number, patch: Partial<TargetForm>) {
    setTargets((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  }
  function removeTarget(i: number) {
    setTargets((prev) => prev.filter((_, idx) => idx !== i));
  }
  async function addTargetFiles(i: number, files: FileList | null) {
    if (!files?.length) return;
    const docs = await Promise.all([...files].map(readFileAsText));
    setTargets((prev) => prev.map((t, idx) => (idx === i ? { ...t, documents: [...t.documents, ...docs] } : t)));
  }
  async function addClientFiles(files: FileList | null) {
    if (!files?.length) return;
    const docs = await Promise.all([...files].map(readFileAsText));
    setClientDocuments((prev) => [...prev, ...docs]);
  }

  function saveRunId(id: string | null) {
    setRunId(id);
    try {
      if (id) sessionStorage.setItem(RUN_ID_STORAGE, id);
      else sessionStorage.removeItem(RUN_ID_STORAGE);
    } catch {
      /* private mode */
    }
  }

  /** Kicks off a new run: POST returns a runId immediately, then we watch it. */
  async function run() {
    setRunning(true);
    setSteps([]);
    setArtifacts([]);
    setProposal(null);
    setClassification(null);
    setPlan(null);
    setSpent(0);
    setNotice(null);
    setStalled(false);
    saveRunId(null);

    try {
      const res = await fetch(apiUrl("/api/run"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "x-anthropic-key": apiKey } : {}),
        },
        body: JSON.stringify({
          clientName,
          clientTicker,
          clientType,
          clientNotes,
          clientDocuments,
          proposalType,
          description,
          stepInstructions,
          targets: targets
            .filter((t) => t.name.trim())
            .map((t) => ({
              name: t.name.trim(),
              ticker: t.ticker.trim() || undefined,
              notes: t.notes.trim() || undefined,
              documents: t.documents.length ? t.documents : undefined,
            })),
        }),
      });

      if (!res.ok) {
        const msg = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setNotice({ kind: "err", text: msg.error ?? `HTTP ${res.status}` });
        setRunning(false);
        return;
      }

      const { runId: newRunId } = (await res.json()) as { runId: string };
      saveRunId(newRunId);
      await watchRun(newRunId);
    } catch (err) {
      setNotice({ kind: "err", text: err instanceof Error ? err.message : String(err) });
      setRunning(false);
    }
  }

  /** Attaches to a run's event stream: replays everything recorded so far, then tails live events if it's still going. Also how a reload/reconnect resumes watching. */
  async function watchRun(id: string) {
    setRunning(true);
    setStalled(false);

    const ac = new AbortController();
    abortRef.current = ac;
    let sawTerminal = false;

    try {
      const res = await fetch(apiUrl(`/api/run/${id}/events`), { signal: ac.signal });
      if (!res.ok || !res.body) {
        const msg = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setNotice({ kind: "err", text: msg.error ?? `HTTP ${res.status}` });
        setRunning(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const payload = line.slice(6);
          if (!payload.trim() || payload.trim() === "{}") continue;
          try {
            const ev = JSON.parse(payload) as RunEvent;
            if (ev.type === "run_completed" || ev.type === "run_failed") sawTerminal = true;
            handleEvent(ev);
          } catch {
            /* skip malformed */
          }
        }
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        setNotice({ kind: "err", text: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      if (sawTerminal) {
        saveRunId(null);
      } else {
        setStalled(true);
      }
    }
  }

  /** Re-invokes a halted/orphaned run from where it left off, then watches it again. */
  async function resumeRun() {
    if (!runId) return;
    setNotice(null);
    try {
      const res = await fetch(apiUrl(`/api/run/${runId}/resume`), {
        method: "POST",
        headers: apiKey ? { "x-anthropic-key": apiKey } : {},
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setNotice({ kind: "err", text: msg.error ?? `HTTP ${res.status}` });
        return;
      }
      await watchRun(runId);
    } catch (err) {
      setNotice({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    }
  }

  function handleEvent(ev: RunEvent) {
    switch (ev.type) {
      case "run_started":
        setClassification(ev.classification);
        setSteps(ev.steps.map((s) => ({ id: s.id, title: s.title, status: "pending" as StepStatus })));
        break;
      case "plan_ready":
        setPlan(ev.plan);
        break;
      case "step_started":
        setSteps((prev) => {
          const found = prev.some((s) => s.id === ev.stepId);
          if (found) {
            return prev.map((s) =>
              s.id === ev.stepId ? { ...s, status: "running", tool: ev.tool, detail: undefined } : s,
            );
          }
          return [...prev, { id: ev.stepId, title: ev.title, status: "running", tool: ev.tool }];
        });
        break;
      case "step_progress":
        setSteps((prev) => prev.map((s) => (s.id === ev.stepId ? { ...s, detail: ev.message } : s)));
        break;
      case "step_completed":
        setSteps((prev) =>
          prev.map((s) =>
            s.id === ev.stepId
              ? {
                  ...s,
                  status: "done",
                  detail:
                    ev.artifact.costUsd != null && ev.artifact.costUsd > 0
                      ? `${ev.artifact.model ?? ""} · $${ev.artifact.costUsd.toFixed(4)}`
                      : (ev.artifact.model ?? undefined),
                }
              : s,
          ),
        );
        setArtifacts((prev) => [...prev.filter((a) => a.stepId !== ev.stepId), ev.artifact]);
        break;
      case "step_failed":
        setSteps((prev) => prev.map((s) => (s.id === ev.stepId ? { ...s, status: "failed", detail: ev.error } : s)));
        break;
      case "budget_update":
        setSpent(ev.spentUsd);
        setCeiling(ev.ceilingUsd);
        break;
      case "run_completed":
        setProposal(ev.proposalMarkdown);
        setSpent(ev.spentUsd);
        if (ev.halted) setNotice({ kind: "warn", text: `Run halted early — ${ev.haltReason}` });
        break;
      case "run_failed":
        setNotice({ kind: "err", text: ev.error });
        break;
    }
  }

  const meterPct = Math.min(100, ceiling > 0 ? (spent / ceiling) * 100 : 0);
  const orderedArtifacts = useMemo(() => {
    const idx = new Map(steps.map((s, i) => [s.id, i]));
    return [...artifacts].sort((a, b) => (idx.get(a.stepId) ?? 0) - (idx.get(b.stepId) ?? 0));
  }, [artifacts, steps]);

  return (
    <div className="wrap">
      <header className="page">
        <h1>RFP Accelerator</h1>
        <p>
          Classify an engagement, run an orchestrated research pass over SEC EDGAR data, and draft a
          proposal skeleton.
        </p>
      </header>

      <div className="grid">
        <div className="panel">
          <h2>Brief</h2>

          <label htmlFor="clientName">Client name *</label>
          <input id="clientName" value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Northwind Manufacturing" />

          <div className="row">
            <div>
              <label htmlFor="clientTicker">Client ticker</label>
              <input id="clientTicker" value={clientTicker} onChange={(e) => setClientTicker(e.target.value.toUpperCase())} placeholder="NWM (leave blank if private)" />
            </div>
            <div>
              <label htmlFor="clientType">Client is a…</label>
              <select id="clientType" value={clientType} onChange={(e) => setClientType(e.target.value as typeof clientType)}>
                <option value="corporate">Corporate</option>
                <option value="pe_sponsor">PE sponsor</option>
              </select>
            </div>
          </div>

          <label htmlFor="clientNotes">Client notes (if private / no ticker)</label>
          <textarea
            id="clientNotes"
            value={clientNotes}
            onChange={(e) => setClientNotes(e.target.value)}
            placeholder="What the client does, scale, anything relevant — used to ground the AI-generated profile."
            style={{ minHeight: 56 }}
          />
          <FileAttach onFiles={addClientFiles} docs={clientDocuments} onRemove={(i) => setClientDocuments((d) => d.filter((_, idx) => idx !== i))} />

          <label>Targets / comparables (optional)</label>
          <p className="hint" style={{ marginTop: -2 }}>
            Acquisition targets, portfolio companies, or competitors to research — none, one, or many.
            No ticker? Attach a doc or add notes and we&apos;ll generate an AI profile instead of EDGAR data.
          </p>
          {targets.map((t, i) => (
            <div key={i} className="target-row">
              <div className="row">
                <input value={t.name} onChange={(e) => updateTarget(i, { name: e.target.value })} placeholder="Target/comparable name *" />
                <input value={t.ticker} onChange={(e) => updateTarget(i, { ticker: e.target.value.toUpperCase() })} placeholder="Ticker (optional)" />
              </div>
              <textarea
                value={t.notes}
                onChange={(e) => updateTarget(i, { notes: e.target.value })}
                placeholder="Notes (optional) — helps if there's no ticker"
                style={{ minHeight: 44 }}
              />
              <FileAttach
                onFiles={(files) => addTargetFiles(i, files)}
                docs={t.documents}
                onRemove={(di) => updateTarget(i, { documents: t.documents.filter((_, idx) => idx !== di) })}
              />
              <button onClick={() => removeTarget(i)} style={{ marginTop: 4 }}>
                Remove
              </button>
            </div>
          ))}
          <button onClick={addTarget} style={{ marginTop: 8 }}>
            + Add target/comparable
          </button>

          <label htmlFor="proposalType">Proposal type</label>
          <select id="proposalType" value={proposalType} onChange={(e) => setProposalType(e.target.value)}>
            <option value="">Auto-detect from description</option>
            {playbooks.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <label htmlFor="description">Engagement description</label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Free text from the RFP or partner. Used to classify the engagement and steer research."
          />

          <label htmlFor="stepInstructions">Orchestration notes (optional)</label>
          <textarea
            id="stepInstructions"
            value={stepInstructions}
            onChange={(e) => setStepInstructions(e.target.value)}
            placeholder='e.g. "also look at precedent transactions" or "skip market context"'
            style={{ minHeight: 56 }}
          />

          <button className="primary" disabled={!canRun} onClick={run}>
            {running ? "Running…" : "Run accelerator"}
          </button>
          {running && (
            <button
              style={{ width: "100%", marginTop: 8 }}
              onClick={() => abortRef.current?.abort()}
              title="Stops watching — the run keeps going on the server and can be reattached to later."
            >
              Stop watching
            </button>
          )}
          {stalled && runId && (
            <div className="hint" style={{ marginTop: 8 }}>
              <p>Lost the run&rsquo;s progress stream before it finished. It may still be going server-side.</p>
              <button style={{ width: "100%" }} onClick={resumeRun} disabled={running}>
                Resume run
              </button>
            </div>
          )}

          {llm && !llm.needsUserKey && !apiKey && (
            <p className="hint" style={{ marginTop: 14 }}>
              {llm.localSubscription
                ? "Backend is using a local Claude subscription — no API key needed."
                : "Backend has a configured API key. Paste your own below to override it."}
            </p>
          )}

          <details className="disclosure" open={Boolean(llm?.needsUserKey) && !apiKey}>
            <summary>
              Anthropic API key {apiKey ? "✓ set" : llm && !llm.needsUserKey ? "— optional" : "— required"}
            </summary>
            <label htmlFor="apiKey">Key (sk-ant-…)</label>
            <input id="apiKey" type="password" value={apiKey} onChange={(e) => persistKey(e.target.value.trim())} placeholder="sk-ant-..." />
            <p className="hint">
              Held in this browser tab&apos;s <code>sessionStorage</code> only. Sent to the backend per
              run, never logged or persisted server-side.
            </p>
          </details>
        </div>

        <div className="panel">
          <h2>Run</h2>

          {notice && <div className={`notice ${notice.kind === "err" ? "err" : ""}`}>{notice.text}</div>}

          {classification && (
            <p style={{ fontSize: 13, marginTop: 0 }}>
              <span className="badge">{classification.source}</span> <strong>{classification.name}</strong> · confidence{" "}
              {(classification.confidence * 100).toFixed(0)}%
              <br />
              <span style={{ color: "var(--muted)" }}>{classification.rationale}</span>
            </p>
          )}

          {plan && (plan.added.length > 0 || plan.removed.length > 0) && (
            <p className="hint" style={{ marginTop: 0 }}>
              Orchestration adjusted: {plan.added.length > 0 && <>added <strong>{plan.added.join(", ")}</strong>. </>}
              {plan.removed.length > 0 && <>skipped <strong>{plan.removed.join(", ")}</strong>. </>}
              {plan.rationale}
            </p>
          )}

          {(running || steps.length > 0) && (
            <>
              <div className="cost">
                <span>Estimated spend</span>
                <span className="amt">
                  ${spent.toFixed(4)} <span style={{ color: "var(--muted)" }}>/ ${ceiling.toFixed(2)}</span>
                </span>
              </div>
              <div className="meter">
                <span className={meterPct > 80 ? "hot" : ""} style={{ width: `${meterPct}%` }} />
              </div>
            </>
          )}

          {steps.length > 0 && (
            <ul className="steps">
              {steps.map((s) => (
                <li key={s.id}>
                  <span className={`dot ${s.status === "pending" ? "" : s.status}`} />
                  <span>
                    <span className="step-title">{s.title}</span>
                    {s.detail && (
                      <>
                        <br />
                        <span className={`step-meta ${s.status === "failed" ? "err" : ""}`}>{s.detail}</span>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {steps.length === 0 && !running && (
            <div className="empty">Fill in the brief and run the accelerator. Steps, cost, and artifacts stream in here.</div>
          )}

          {proposal && (
            <details className="artifact proposal" open>
              <summary>Draft proposal skeleton</summary>
              <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(proposal) }} />
            </details>
          )}

          {orderedArtifacts.map((a) => (
            <details className="artifact" key={a.stepId}>
              <summary>
                <span>{a.title}</span>
                <span className="badge">{a.kind.replace(/_/g, " ")}</span>
              </summary>
              <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(a.markdown) }} />
            </details>
          ))}
        </div>
      </div>

      <details className="disclosure">
        <summary>About this tool &amp; its limits</summary>
        <p>
          Rebuilds a general pattern — classify an RFP, run an orchestrated research sequence, pull
          SEC EDGAR data, synthesize with an LLM — from public building blocks. Financial figures come
          from EDGAR XBRL <code>companyfacts</code> and ratios are computed in code. When a company has
          no ticker or EDGAR can&apos;t resolve it, its profile is AI-generated and clearly labelled as
          such — never presented as filed data. The orchestration plan itself is decided by a cheap
          planning pass that can add steps (precedent transactions, competitor landscape) when the
          brief calls for it or you ask via the orchestration notes field. Not investment advice.
        </p>
      </details>
    </div>
  );
}

function FileAttach({
  onFiles,
  docs,
  onRemove,
}: {
  onFiles: (files: FileList | null) => void;
  docs: UploadedDoc[];
  onRemove: (i: number) => void;
}) {
  return (
    <div style={{ marginTop: 6, marginBottom: 8 }}>
      <input
        type="file"
        accept=".txt,.md,text/plain,text/markdown"
        multiple
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <p className="hint" style={{ marginTop: 2 }}>
        Plain text or Markdown only for now — paste PDF/deck content into a .txt file.
      </p>
      {docs.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "4px 0 0", fontSize: 12 }}>
          {docs.map((d, i) => (
            <li key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span>
                📎 {d.filename} ({(d.text.length / 1000).toFixed(1)}k chars)
              </span>
              <button onClick={() => onRemove(i)} style={{ padding: "1px 8px", fontSize: 11 }}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
