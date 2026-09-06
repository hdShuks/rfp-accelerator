"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "@/lib/markdown";
import type { Artifact, RunEvent } from "@/lib/orchestrator/types";

interface PlaybookMeta {
  id: string;
  name: string;
  description: string;
}

type StepStatus = "pending" | "running" | "done" | "failed";
interface StepView {
  id: string;
  title: string;
  tool?: string;
  status: StepStatus;
  detail?: string;
}

const KEY_STORAGE = "rfp.anthropicKey";

export default function Home() {
  const [apiKey, setApiKey] = useState("");
  const [playbooks, setPlaybooks] = useState<PlaybookMeta[]>([]);
  const [llm, setLlm] = useState<{
    needsUserKey: boolean;
    localSubscription: boolean;
    apiKeyFromEnv: boolean;
  } | null>(null);

  const [clientName, setClientName] = useState("");
  const [clientTicker, setClientTicker] = useState("");
  const [targetTicker, setTargetTicker] = useState("");
  const [proposalType, setProposalType] = useState("");
  const [description, setDescription] = useState("");

  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<StepView[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [proposal, setProposal] = useState<string | null>(null);
  const [classification, setClassification] = useState<
    Extract<RunEvent, { type: "run_started" }>["classification"] | null
  >(null);
  const [spent, setSpent] = useState(0);
  const [ceiling, setCeiling] = useState(0.5);
  const [notice, setNotice] = useState<{ kind: "warn" | "err"; text: string } | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      const k = sessionStorage.getItem(KEY_STORAGE);
      if (k) setApiKey(k);
    } catch {
      /* private mode */
    }
    fetch("/api/playbooks")
      .then((r) => r.json())
      .then((d) => setPlaybooks(d.playbooks ?? []))
      .catch(() => {});
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => setLlm(d.llm ?? null))
      .catch(() => {});
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
  const showTarget = useMemo(() => {
    const t = proposalType.toLowerCase();
    return t === "" || t.includes("ma_") || t.includes("m&a") || t.includes("acqui");
  }, [proposalType]);

  async function run() {
    setRunning(true);
    setSteps([]);
    setArtifacts([]);
    setProposal(null);
    setClassification(null);
    setSpent(0);
    setNotice(null);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        signal: ac.signal,
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "x-anthropic-key": apiKey } : {}),
        },
        body: JSON.stringify({
          clientName,
          clientTicker,
          targetTicker,
          proposalType,
          description,
        }),
      });

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
            handleEvent(JSON.parse(payload) as RunEvent);
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
    }
  }

  function handleEvent(ev: RunEvent) {
    switch (ev.type) {
      case "run_started":
        setClassification(ev.classification);
        setSteps(
          ev.steps.map((s) => ({ id: s.id, title: s.title, status: "pending" as StepStatus })),
        );
        break;
      case "step_started":
        setSteps((prev) =>
          prev.map((s) =>
            s.id === ev.stepId ? { ...s, status: "running", tool: ev.tool, detail: undefined } : s,
          ),
        );
        break;
      case "step_progress":
        setSteps((prev) =>
          prev.map((s) => (s.id === ev.stepId ? { ...s, detail: ev.message } : s)),
        );
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
                      : ev.artifact.model ?? undefined,
                }
              : s,
          ),
        );
        setArtifacts((prev) => [...prev.filter((a) => a.stepId !== ev.stepId), ev.artifact]);
        break;
      case "step_failed":
        setSteps((prev) =>
          prev.map((s) => (s.id === ev.stepId ? { ...s, status: "failed", detail: ev.error } : s)),
        );
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
          <input
            id="clientName"
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            placeholder="Northwind Manufacturing"
          />

          <div className="row">
            <div>
              <label htmlFor="clientTicker">Client ticker</label>
              <input
                id="clientTicker"
                value={clientTicker}
                onChange={(e) => setClientTicker(e.target.value.toUpperCase())}
                placeholder="NWM"
              />
            </div>
            {showTarget && (
              <div>
                <label htmlFor="targetTicker">Target ticker</label>
                <input
                  id="targetTicker"
                  value={targetTicker}
                  onChange={(e) => setTargetTicker(e.target.value.toUpperCase())}
                  placeholder="ACME"
                />
              </div>
            )}
          </div>

          <label htmlFor="proposalType">Proposal type</label>
          <select
            id="proposalType"
            value={proposalType}
            onChange={(e) => setProposalType(e.target.value)}
          >
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

          <button className="primary" disabled={!canRun} onClick={run}>
            {running ? "Running…" : "Run accelerator"}
          </button>
          {running && (
            <button
              style={{ width: "100%", marginTop: 8 }}
              onClick={() => abortRef.current?.abort()}
            >
              Stop
            </button>
          )}

          {llm && !llm.needsUserKey && !apiKey && (
            <p className="hint" style={{ marginTop: 14 }}>
              {llm.localSubscription
                ? "Using your local Claude CLI subscription — no API key needed. Paste one below to use the API instead."
                : "Using the server's configured API key. Paste your own below to override it."}
            </p>
          )}

          <details className="disclosure" open={Boolean(llm?.needsUserKey) && !apiKey}>
            <summary>
              Anthropic API key{" "}
              {apiKey ? "✓ set" : llm && !llm.needsUserKey ? "— optional" : "— required"}
            </summary>
            <label htmlFor="apiKey">Key (sk-ant-…)</label>
            <input
              id="apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => persistKey(e.target.value.trim())}
              placeholder="sk-ant-..."
            />
            <p className="hint">
              Held in this browser tab&apos;s <code>sessionStorage</code> only (cleared when the tab
              closes). Sent to this app&apos;s backend per run to call Claude on your account, and
              never logged or persisted server-side.
            </p>
          </details>
        </div>

        <div className="panel">
          <h2>Run</h2>

          {notice && (
            <div className={`notice ${notice.kind === "err" ? "err" : ""}`}>{notice.text}</div>
          )}

          {classification && (
            <p style={{ fontSize: 13, marginTop: 0 }}>
              <span className="badge">{classification.source}</span>{" "}
              <strong>{classification.name}</strong> · confidence{" "}
              {(classification.confidence * 100).toFixed(0)}%
              <br />
              <span style={{ color: "var(--muted)" }}>{classification.rationale}</span>
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
                        <span className={`step-meta ${s.status === "failed" ? "err" : ""}`}>
                          {s.detail}
                        </span>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {steps.length === 0 && !running && (
            <div className="empty">
              Fill in the brief and run the accelerator. Steps, cost, and artifacts stream in here.
            </div>
          )}

          {proposal && (
            <details className="artifact proposal" open>
              <summary>Draft proposal skeleton</summary>
              <div
                className="md"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(proposal) }}
              />
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
          from EDGAR XBRL <code>companyfacts</code> (10-K, fiscal-year) and ratios are computed in
          code; the EBITDA figure is an operating-income + D&amp;A proxy. Narrative extraction from
          10-K HTML is best-effort. LLM research steps use model general knowledge, not live web
          search. Not investment advice. Vercel Hobby is non-commercial use only.
        </p>
      </details>
    </div>
  );
}
