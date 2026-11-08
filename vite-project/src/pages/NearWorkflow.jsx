import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  ExternalLink,
  FileJson,
  Layers3,
  LoaderCircle,
  Search,
  ShieldCheck,
  TriangleAlert,
  Wallet,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { Link } from "react-router-dom";
import {
  decisionComparison,
  describe,
  eventLabels,
  filterHistory,
  historyRows,
  outcome,
  sessionOf,
  summarize,
  timestamp,
  usdc,
  isRepositoryAnalysis,
} from "../lib/near-view.mjs";
import "../near.css";
import "../near-workflow.css";

const local = !window.__AGENTSTREAMS_RECORDED_ONLY__ && ["localhost", "127.0.0.1", "[::1]"].includes(
  window.location.hostname
);

function Badge({ label, tone = "neutral" }) {
  const Icon =
    tone === "warn"
      ? TriangleAlert
      : tone === "error"
      ? XCircle
      : tone === "success"
      ? Check
      : Circle;
  return (
    <span className={`ap-badge ap-${tone}`}>
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}

function Field({ label, children }) {
  return (
    <div className="ap-field">
      <dt>{label}</dt>
      <dd>{children ?? "Not recorded"}</dd>
    </div>
  );
}

function EvidenceDrawer({ event, run, vault, network, onClose }) {
  const dialog = useRef(null);
  const closeButton = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    const node = dialog.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    node.showModal();
    closeButton.current?.focus();
    return () => {
      node.close();
      document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  const comparisons = decisionComparison(event, vault?.policy);
  const permit = event.permit || event.approval?.permit;
  const status = outcome(event);
  const transaction = event.type === "transaction";
  const source = run?.recordedAt ? "Recorded evidence" : "Live run evidence";
  function keepFocus(event) {
    if (event.key !== "Tab") return;
    const controls = [
      ...dialog.current.querySelectorAll(
        'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'
      ),
    ].filter((node) => node.getClientRects().length > 0 && !node.disabled);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  return (
    <dialog
      ref={dialog}
      className="ap-drawer"
      aria-labelledby="ap-evidence-title"
      onKeyDown={keepFocus}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ap-drawer-inner">
        <header className="ap-drawer-header">
          <div>
            <span className="ap-eyebrow">DECISION & EXECUTION EVIDENCE</span>
            <h2 id="ap-evidence-title">
              {event.action === "PROVIDER_CLAIM"
                ? "Provider claim"
                : eventLabels[event.type] || event.type}
            </h2>
          </div>
          <button
            ref={closeButton}
            className="ap-icon-button"
            aria-label="Close evidence"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="ap-drawer-body">
          <Badge {...status} />
          <p className="ap-evidence-description">{describe(event)}</p>
          <dl className="ap-metadata">
            <Field label="Source">
              {source} · {network || "Network unavailable"}
            </Field>
            <Field label="Observation">
              {event.attachedReceipt
                ? "Separate receipt attached to this capture; timestamp not recorded."
                : timestamp(event.at)}
            </Field>
            <Field label="Run">
              <code>{run?.runId || event.runId || "Not recorded"}</code>
            </Field>
            {sessionOf(event) && (
              <Field label="Session">
                <code>{sessionOf(event)}</code>
              </Field>
            )}
            {event.failedTransactionHash && network === "testnet" && (
              <Field label="Rejected transaction">
                <a href={`https://testnet.nearblocks.io/txns/${encodeURIComponent(event.failedTransactionHash)}`} target="_blank" rel="noreferrer">Inspect contract rejection <ExternalLink size={12} /></a>
              </Field>
            )}
            {event.reason && (
              <Field label="Reason">
                <code>{event.reason}</code>
              </Field>
            )}
          </dl>

          {comparisons.length > 0 && (
            <section className="ap-evidence-section">
              <h3>Observed input & vault limit</h3>
              <p>Compared with the vault snapshot included in this view.</p>
              <div className="ap-comparisons">
                <div className="ap-comparison ap-comparison-heading">
                  <span>Rule</span>
                  <span>Offered</span>
                  <span>Snapshot limit</span>
                </div>
                {comparisons.map((c) => (
                  <div
                    className={`ap-comparison ${
                      c.failed ? "ap-comparison-failed" : ""
                    }`}
                    key={c.label}
                  >
                    <strong>{c.label}</strong>
                    <span>{c.observed}</span>
                    <span>{c.bound}</span>
                  </div>
                ))}
              </div>
              {event.decision === "DENY" && (
                <p className="ap-explanation">
                  This proposal was denied. No payment transaction is attached
                  to this decision.
                </p>
              )}
              {event.prices && (
                <p className="ap-explanation">
                  Market check:{" "}
                  {event.prices.reason === "SANDBOX_FIXTURE_NO_MARKET_PRICE"
                    ? "Skipped for the sandbox fixture; no market-price attestation."
                    : event.prices.reason || event.prices.decision}
                </p>
              )}
            </section>
          )}

          {event.type === "policy" && (
            <section className="ap-evidence-section">
              <h3>Policy authority</h3>
              <p>
                The standalone worker observes the service and signs approved
                lifecycle actions. The NEAR contract independently checks the
                permit and financial limits.
              </p>
              {permit ? (
                <pre>{JSON.stringify(permit, null, 2)}</pre>
              ) : (
                <p className="ap-explanation">
                  {event.decision === "DENY"
                    ? "No permit issued for this denial."
                    : "Permit fields are not included in this event. Inspect the original local intent artifact for nonce and expiry."}
                </p>
              )}
            </section>
          )}

          {transaction && (
            <section className="ap-evidence-section">
              <h3>
                {event.action === "PROVIDER_CLAIM"
                  ? "Provider payout receipt"
                  : "NEAR execution receipt"}
              </h3>
              <dl className="ap-metadata">
                <Field label="Operation">{event.action}</Field>
                <Field label="Signer">
                  <code>{event.signerId || "Not recorded"}</code>
                </Field>
                <Field label="Receiver">
                  <code>{event.receiverId || "Not recorded"}</code>
                </Field>
                <Field label="Transaction hash">
                  {network === "testnet" ? (
                    <a
                      href={`https://testnet.nearblocks.io/txns/${encodeURIComponent(
                        event.hash
                      )}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {event.hash}
                      <ExternalLink size={12} />
                    </a>
                  ) : (
                    <code>{event.hash}</code>
                  )}
                </Field>
                <Field label="Execution receipts">
                  {event.receiptIds?.length ?? "Not recorded"}
                </Field>
              </dl>
              {network === "sandbox" && (
                <p className="ap-explanation">
                  Local sandbox transaction. Its receipt is included below; it
                  has no public explorer link.
                </p>
              )}
              {event.action === "PROVIDER_CLAIM" && (
                <p className="ap-explanation">
                  {event.value === true && !event.receiptFailures?.length
                    ? "The provider's separate token payout completed successfully."
                    : "Inspect the receipt outcome before retrying the provider payout."}
                </p>
              )}
            </section>
          )}

          {event.type === "request" && isRepositoryAnalysis(event.body?.source) && (
            <section className="ap-evidence-section">
              <h3>Repository analysis · {event.body.view}</h3>
              <p>{event.body.scope}</p>
              <dl className="ap-metadata">
                <Field label="Coverage">{event.body.coverage?.files} files · {event.body.coverage?.lines} lines</Field>
                <Field label="Repository fingerprint"><code>{event.body.fingerprint}</code></Field>
              </dl>
              {event.body.findings?.map(finding => (
                <article className="ap-finding" key={finding.id}>
                  <Badge label={finding.severity.toUpperCase()} tone={finding.severity === "high" ? "warn" : "neutral"} />
                  <h4>{finding.title}</h4>
                  <code>{finding.file}:{finding.line}</code>
                  <p>{finding.recommendation}</p>
                </article>
              ))}
              {event.body.dependencies && <p>{event.body.total} dependencies observed. Vulnerability database checks were not performed.</p>}
            </section>
          )}

          {event.type === "settled" && (
            <section className="ap-evidence-section">
              <h3>Settlement</h3>
              <dl className="ap-metadata">
                <Field label="Funded">{usdc(event.stream?.deposit)} USDC</Field>
                <Field label="Earned">{usdc(event.stream?.earned)} USDC</Field>
                <Field label="Returned to vault">
                  {usdc(event.stream?.refunded)} USDC
                </Field>
              </dl>
              <p>
                Session closure credits earnings. The provider's claim is a
                separate transaction.
              </p>
            </section>
          )}
          {event.type === "reuse_verified" && (
            <section className="ap-evidence-section">
              <h3>Reuse verification</h3>
              <dl className="ap-metadata">
                <Field label="Successful requests">
                  {event.successfulRequests}
                </Field>
                <Field label="Extra payment transactions">
                  {event.extraPaymentTransactions}
                </Field>
                <Field label="Nonce before">{event.nonceBefore}</Field>
                <Field label="Nonce after">{event.nonceAfter}</Field>
              </dl>
            </section>
          )}
          {event.type === "summary" && (
            <section className="ap-evidence-section">
              <h3>Model explanation · unverified</h3>
              <p className="ap-model-text">{event.text}</p>
            </section>
          )}
          {event.type === "recovery_required" && (
            <section className="ap-evidence-section">
              <h3>Owner recovery</h3>
              <p>
                Execution needs reconciliation before another wallet action.
                Inspect the local receipt and use the owner's supported recovery
                path.
              </p>
              <Link to="/docs" onClick={onClose}>
                Read recovery and trust boundaries <ArrowRight size={14} />
              </Link>
            </section>
          )}
          <details className="ap-raw">
            <summary>
              <Code2 size={14} />
              Original event / receipt JSON
            </summary>
            <pre>{JSON.stringify(event, null, 2)}</pre>
          </details>
          {event.eventHash && (
            <div className="ap-journal-hash">
              <span>Journal event digest</span>
              <code>{event.eventHash}</code>
              <small>
                A journal digest identifies the saved observation. It does not
                independently attest HTTP inputs.
              </small>
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}

export default function NearWorkflow() {
  const [mode, setMode] = useState("recorded");
  const [agentMode, setAgentMode] = useState("scripted");
  const [recording, setRecording] = useState(null);
  const [live, setLive] = useState(null);
  const [recordError, setRecordError] = useState("");
  const [liveError, setLiveError] = useState("");
  const [liveAt, setLiveAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState(null);
  const [lastSelected, setLastSelected] = useState(null);

  const readRecording = useCallback(async (signal) => {
    setLoading(true);
    setRecordError("");
    try {
      const response = await fetch("/near/latest.json", {
        signal,
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(
          "No recorded NEAR run is available. Capture one with npm run demo:capture."
        );
      const data = await response.json();
      if (
        data.schemaVersion !== 1 ||
        !Array.isArray(data.events) ||
        !["sandbox", "testnet"].includes(data.network)
      )
        throw new Error("The recorded run has an unsupported evidence format.");
      setRecording(data);
    } catch (e) {
      if (e.name !== "AbortError") setRecordError(e.message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    readRecording(abort.signal);
    return () => abort.abort();
  }, [readRecording]);

  const refresh = useCallback(async (signal) => {
    const response = await fetch("/api/near/state", {
      signal,
      cache: "no-store",
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("application/json")
    )
      throw new Error(
        "Local runner unavailable. Start npm run dev:live to connect."
      );
    const data = await response.json();
    if (!data.vault || !["sandbox", "testnet"].includes(data.network))
      throw new Error("Local runner returned an unsupported state.");
    if (!signal?.aborted) {
      setLive(data);
      setLiveAt(new Date().toISOString());
      setLiveError("");
    }
  }, []);
  useEffect(() => {
    if (mode !== "live" || !local) return;
    const abort = new AbortController();
    let timer;
    const poll = async () => {
      try {
        await refresh(abort.signal);
      } catch (e) {
        if (e.name !== "AbortError") setLiveError(e.message);
      }
      if (!abort.signal.aborted) timer = setTimeout(poll, 1200);
    };
    poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [mode, refresh]);

  async function start() {
    setSubmitting(true);
    setLiveError("");
    try {
      const response = await fetch("/api/near/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csrf: live?.csrf, mode: agentMode }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "The agent run could not start.");
      await refresh();
    } catch (e) {
      setLiveError(e.message);
    } finally {
      setSubmitting(false);
    }
  }
  function chooseMode(next) {
    setMode(next);
    setSelection(null);
    setLastSelected(null);
    setFilter("all");
    setSearch("");
  }

  const run = mode === "live" ? live?.run : recording;
  const vault = mode === "live" ? live?.vault : run?.finalVault;
  const events = run?.events || [];
  const network = mode === "live" ? live?.network : run?.network;
  const running = mode === "live" && (live?.running || submitting);
  const error = mode === "live" ? liveError : recordError;
  const sourceAt = mode === "live" ? liveAt : run?.recordedAt;
  const contextKey = `${mode}:${run?.runId || events[0]?.runId || "idle"}`;
  const summary = summarize(run, vault);
  const rows = historyRows(run);
  const visible = filterHistory(rows, filter, search);
  const started = events.find((e) => e.type === "started");
  const analysisEvents = events.filter(e => e.type === "request" && isRepositoryAnalysis(e.body?.source));
  const findingsEvent = [...analysisEvents].reverse().find(e => e.body.findings?.length);
  const observedSession = summary.stream;
  const asset =
    network === "sandbox"
      ? "fixture USDC"
      : network === "testnet"
      ? "test USDC"
      : "USDC";
  const runLabel = running
    ? "Running"
    : run?.ok === true
    ? "Run complete"
    : run?.ok === false
    ? "Needs attention"
    : mode === "recorded" && loading
    ? "Loading"
    : "Awaiting run";
  const select = (event) => {
    if (!event) return;
    const next = { key: contextKey, event };
    setSelection(next);
    setLastSelected(next);
  };
  const stageEvent = (predicate) => [...events].reverse().find(predicate);
  const stages = [
    {
      title: "Agent",
      subtitle: "Requests access",
      icon: Zap,
      tag: started
        ? run?.agentMode === "model"
          ? "Model tool calls"
          : run?.agentMode === "mixed"
          ? "Model + operator checks"
          : "Scripted run"
        : "Awaiting request",
      event: stageEvent((e) => e.type === "proposal" || e.type === "model"),
    },
    {
      title: "Policy",
      subtitle: "Observes & approves",
      icon: ShieldCheck,
      tag: summary.denied
        ? "Guardrail applied"
        : events.some((e) => e.type === "policy")
        ? "Policy evaluated"
        : "Awaiting check",
      event: summary.denied || stageEvent((e) => e.type === "policy"),
    },
    {
      title: "NEAR vault",
      subtitle: "Enforces the limits",
      icon: Wallet,
      tag: summary.session,
      event: stageEvent((e) => e.type === "transaction"),
    },
    {
      title: "Paid API",
      subtitle: "Serves the session",
      icon: Layers3,
      tag: summary.reuse
        ? `${summary.reuse.successfulRequests} requests verified`
        : "Awaiting requests",
      event: summary.reuse || stageEvent((e) => e.type === "request"),
    },
  ];

  return (
    <div className="near-page ap-dashboard">
      <header className="ap-heading">
        <div>
          <div className="ap-eyebrow">
            <span className="ap-live-dot" />
            AGENTSTREAMS / NEAR WORKSPACE
          </div>
          <h1>
            Agent payments, <span>under control.</span>
          </h1>
          <p>
            Give your coding agent a spending allowance for paid tools.
          </p>
        </div>
        <Link className="ap-doc-link" to="/docs">
          How it works <ArrowUpRight size={15} />
        </Link>
      </header>

      <section className="ap-source-bar" aria-label="Execution source">
        <div
          className="ap-source-tabs"
          role="group"
          aria-label="Execution source"
        >
          <button
            aria-pressed={mode === "recorded"}
            onClick={() => chooseMode("recorded")}
          >
            <Clock3 size={14} />
            Replay real NEAR run
          </button>
          <button
            aria-pressed={mode === "live"}
            disabled={!local}
            title={
              !local
                ? "Live execution is available on the local dashboard."
                : undefined
            }
            onClick={() => chooseMode("live")}
          >
            <Zap size={14} />
            Live local
          </button>
        </div>
        <div className="ap-source-info">
          <span className="ap-network-label">
            {network === "sandbox"
              ? "NEAR Sandbox"
              : network === "testnet"
              ? "NEAR Testnet"
              : "Network unavailable"}
          </span>
          <span>
            {mode === "recorded"
              ? "Captured"
              : error
              ? "Last observed"
              : "Observed"}{" "}
            {sourceAt ? timestamp(sourceAt) : "—"}
          </span>
        </div>
      </section>
      {mode === "recorded" && recording && (
        <p className="ap-notice">
          Replay of a real {network === "testnet" ? "NEAR testnet" : "local NEAR sandbox"} run,
          captured {sourceAt ? timestamp(sourceAt) : "at an unavailable time"}.
          {network === "testnet"
            ? " Final transaction hashes link to the testnet explorer. Saved HTTP observations are offchain evidence; this replay is not a live balance feed."
            : " Executed on a local blockchain with fixture tokens. This is not public testnet evidence and has no public explorer links."}
        </p>
      )}
      {analysisEvents.length > 0 && (
        <section className="ap-product-proof" aria-label="Paid repository analysis">
          <div>
            <span className="ap-eyebrow">USEFUL WORK / REPOSITORY ANALYSIS</span>
            <h2>A paid tool. Actual findings.</h2>
            <p>{analysisEvents.filter(e => e.actor === "model").length} model-selected analysis requests · {analysisEvents.filter(e => e.actor !== "model").length} operator request for the failure test. Static findings identify review targets and require human review.</p>
            <p>{analysisEvents.at(-1).body.coverage.files} files inspected · {analysisEvents.at(-1).body.coverage.lines} lines · time-based access</p>
          </div>
          <div>
            {run.runtimePolicy && <p>Close after {run.runtimePolicy.maxConsecutive5xx} consecutive 5xx responses · idle limit {run.runtimePolicy.idleTimeoutSeconds}s · reuse {run.runtimePolicy.reuseStream ? "enabled" : "disabled"}</p>}
            <button className="ap-doc-link" onClick={() => select(findingsEvent || analysisEvents.at(-1))}>Inspect analysis evidence <ArrowUpRight size={15} /></button>
            <small>Accrual continues until closure or prepaid funds run out, including idle time and time before failure closure. Explicitly timed streams also stop accruing at expiry.</small>
          </div>
        </section>
      )}
      {error && (
        <div className="ap-notice" role="alert">
          <TriangleAlert size={17} />
          <div>
            <strong>
              {mode === "live"
                ? "Runner connection interrupted"
                : "Recording unavailable"}
            </strong>
            <p>
              {error}
              {mode === "live" && live
                ? " Displayed values are the last successful snapshot."
                : ""}
            </p>
          </div>
          {mode === "recorded" && (
            <button onClick={() => readRecording()}>Retry</button>
          )}
        </div>
      )}

      <section
        className="ap-money"
        aria-label="Vault and selected session amounts"
      >
        {[
          {
            label: "Available vault funds",
            value: vault?.available,
            note: sourceAt
              ? `Vault snapshot · ${
                  mode === "live" && error ? "stale" : "observed"
                }`
              : "No vault snapshot",
            icon: Wallet,
          },
          {
            label: "Session funded",
            value: observedSession?.deposit,
            note: observedSession?.session_id || "No session observed",
            icon: ArrowUpRight,
          },
          {
            label: "Provider earned",
            value:
              summary.settled?.earned ??
              (observedSession?.closed_at ? observedSession.earned : undefined),
            note: summary.payoutState,
            icon: Check,
          },
          {
            label: "Returned to vault",
            value:
              summary.settled?.refunded ??
              (observedSession?.closed_at
                ? observedSession.refunded
                : undefined),
            note:
              summary.settled || observedSession?.closed_at
                ? "Unused session funds"
                : "Awaiting confirmed settlement",
            icon: ArrowDownLeft,
          },
        ].map(({ label, value, note, icon: Icon }) => (
          <div className="ap-money-card" key={label}>
            <div>
              <span>{label}</span>
              <Icon size={15} aria-hidden="true" />
            </div>
            <strong>{usdc(value)}</strong>
            <small>{asset}</small>
            <p>{note}</p>
          </div>
        ))}
      </section>
      <p className="ap-scope-note">
        Available funds are vault-wide. Funded, earned and returned amounts
        refer to the latest observed session, identified above. The reuse check identifies its own session in the evidence drawer.
      </p>

      <div className="ap-workspace-grid">
        <section className="ap-panel ap-flow" aria-label="Payment workflow">
          <div className="ap-panel-heading">
            <div>
              <span className="ap-eyebrow">PAYMENT WORKFLOW</span>
              <h2>One session. Many requests.</h2>
            </div>
            <Badge
              label={runLabel}
              tone={
                running
                  ? "neutral"
                  : run?.ok === true
                  ? "success"
                  : run?.ok === false
                  ? "error"
                  : "neutral"
              }
            />
          </div>
          <div className="ap-flow-canvas">
            <div className="ap-workflow-nodes">
              {stages.map(({ title, subtitle, icon: Icon, tag, event }, i) => (
                <div className="ap-node-wrap" key={title}>
                  <button
                    className={`ap-node ${event ? "ap-node-observed" : ""}`}
                    disabled={!event}
                    onClick={() => select(event)}
                    aria-label={`Inspect ${title} evidence`}
                  >
                    <span className="ap-node-symbol">
                      <Icon size={25} strokeWidth={1.5} />
                      <span>0{i + 1}</span>
                    </span>
                    <strong>{title}</strong>
                    <span className="ap-node-subtitle">{subtitle}</span>
                    <span className="ap-node-tag">{tag}</span>
                  </button>
                  {i < stages.length - 1 && (
                    <ArrowRight
                      className="ap-flow-arrow"
                      size={19}
                      aria-hidden="true"
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="ap-flow-legends">
              <span>
                <i />
                Offchain policy observation
              </span>
              <span>
                <ShieldCheck size={12} />
                Onchain payment enforcement
              </span>
            </div>
          </div>
          <div className="ap-reuse-strip">
            <div>
              <strong>{summary.reuse?.successfulRequests ?? "—"}</strong>
              <span>requests in one session</span>
            </div>
            <span className="ap-reuse-divider" />
            <div>
              <strong>{summary.reuse?.extraPaymentTransactions ?? "—"}</strong>
              <span>extra payment transactions</span>
            </div>
            <button
              disabled={!summary.reuse}
              onClick={() => select(summary.reuse)}
            >
              Inspect reuse <ArrowUpRight size={14} />
            </button>
          </div>
          <div className="ap-run-controls">
            {mode === "live" ? (
              <>
                <label>
                  Agent execution
                  <select
                    value={agentMode}
                    onChange={(e) => setAgentMode(e.target.value)}
                    disabled={running}
                  >
                    <option value="scripted">Scripted demonstration</option>
                    <option value="model">
                      AI tool calls · configured model
                    </option>
                  </select>
                </label>
                <button
                  className="ap-primary"
                  disabled={!live || !!liveError || running}
                  onClick={start}
                >
                  {running ? (
                    <LoaderCircle size={15} className="near-spin" />
                  ) : (
                    <Zap size={15} />
                  )}
                  {running ? "Agent running…" : "Run agent"}
                </button>
              </>
            ) : (
              <>
                <div>
                  <span className="ap-run-mode">
                    {run?.agentMode === "model"
                      ? "AI tool calls"
                      : run?.agentMode === "mixed"
                      ? "Local model + operator failure checks"
                      : run
                      ? "Scripted demonstration"
                      : "Execution evidence"}
                  </span>
                  <p>
                    {run?.runId
                      ? `Run ${run.runId.slice(
                          0,
                          8
                        )} · select a node to inspect its evidence`
                      : "Capture a run with npm run demo:capture"}
                  </p>
                </div>
                <a
                  className="ap-secondary"
                  href="/near/latest.json"
                  target="_blank"
                  rel="noreferrer"
                >
                  <FileJson size={14} />
                  Source recording
                </a>
              </>
            )}
          </div>
          <p className="ap-footnote">
            {summary.injected
              ? "This sandbox demonstration injects an outage after the requests. "
              : ""}
            Earnings accrue by elapsed time until closure or the session cap.{" "}
            {network === "sandbox"
              ? "Fixture tokens on an isolated NEAR node."
              : "Testnet tokens have no monetary value."}
          </p>
        </section>

        <aside
          className="ap-panel ap-owner"
          aria-label="Owner limits and authority"
        >
          <div className="ap-panel-heading">
            <div>
              <span className="ap-eyebrow">OWNER GUARDRAILS</span>
              <h2>Funds with boundaries.</h2>
            </div>
            <ShieldCheck size={19} />
          </div>
          <dl className="ap-limit-list">
            <Field label="Cumulative budget">
              {usdc(vault?.policy?.budget)} <small>USDC</small>
            </Field>
            <Field label="Maximum session">
              {usdc(vault?.policy?.max_deposit)} <small>USDC</small>
            </Field>
            <Field label="Maximum rate">
              {usdc(vault?.policy?.max_rate)} <small>USDC / s</small>
            </Field>
            <Field label="Maximum duration">
              {vault?.policy?.max_duration_seconds === 0 ? "No time limit" : <>{vault?.policy?.max_duration_seconds ?? "—"} <small>seconds</small></>}
            </Field>
          </dl>
          <p className="ap-owner-note">
            Enforced by the vault contract. Cumulative spending authority has no
            automatic daily or monthly reset.
          </p>
          <div className="ap-authority">
            <div>
              <ShieldCheck size={15} />
              <strong>Restricted agent key</strong>
            </div>
            <p>
              <code>open_stream</code>
              <code>close_stream</code>
            </p>
            <small>
              The key's gas allowance is separate from the USDC budget. Its
              allowance value is not in this snapshot.
            </small>
          </div>
          <details className="ap-authority-details">
            <summary>
              Accounts & authority <ChevronRight size={13} />
            </summary>
            <dl className="ap-metadata">
              <Field label="Vault">
                <code>
                  {(mode === "live" ? live?.vaultId : run?.vaultId) ||
                    "Not observed"}
                </code>
              </Field>
              <Field label="Owner">
                <code>{vault?.owner_id || "Not observed"}</code>
              </Field>
              <Field label="Agent">
                <code>{vault?.agent_id || "Not observed"}</code>
              </Field>
              <Field label="Approved providers">
                {vault?.policy?.recipients?.join(", ") || "Not observed"}
              </Field>
              <Field label="Admission">
                {vault ? (vault.paused ? "Paused" : "Enabled") : "Not observed"}
              </Field>
            </dl>
            <p>
              The owner can configure, pause and recover. A separate policy key
              signs permits; the agent key alone cannot approve spending.
            </p>
          </details>
        </aside>
      </div>

      <section
        className="ap-operational"
        aria-label="Separate service, session and payout states"
      >
        <div>
          <span>Provider · last observation</span>
          <strong
            className={
              summary.health?.reason === "SERVICE_UNAVAILABLE"
                ? "ap-text-warn"
                : ""
            }
          >
            {summary.serviceState}
          </strong>
          <small>
            {summary.health
              ? timestamp(summary.health.at, true)
              : "No health checkpoint recorded"}
          </small>
        </div>
        <div>
          <span>Session state</span>
          <strong>{summary.session}</strong>
          <small>
            {summary.settled
              ? "Confirmed settlement recorded"
              : "State from execution evidence"}
          </small>
        </div>
        <div>
          <span>Provider payout</span>
          <strong>{summary.payoutState}</strong>
          <small>Separate from session closure</small>
        </div>
      </section>
      {summary.denied && (
        <button className="ap-denial" onClick={() => select(summary.denied)}>
          <span className="ap-denial-icon">
            <ShieldCheck size={17} />
          </span>
          <div>
            <strong>
              {summary.denied.tier
                ? `${summary.denied.tier[0].toUpperCase()}${summary.denied.tier.slice(
                    1
                  )} request denied`
                : "Request denied"}{" "}
              <span>Guardrail applied</span>
            </strong>
            <p>
              {summary.denied.reason === "RATE_LIMIT"
                ? `Offered rate ${usdc(
                    summary.denied.quote?.rate
                  )} USDC / s exceeds the ${usdc(
                    vault?.policy?.max_rate
                  )} snapshot limit.`
                : describe(summary.denied)}
            </p>
          </div>
          <span className="ap-denial-action">
            Inspect decision <ArrowRight size={15} />
          </span>
        </button>
      )}

      <section className="ap-panel ap-history" aria-label="Execution history">
        <div className="ap-panel-heading">
          <div>
            <span className="ap-eyebrow">EXECUTION HISTORY</span>
            <h2>The full trail, in context.</h2>
          </div>
          <span className="ap-event-count">
            {rows.length} observations & receipts
          </span>
        </div>
        <div className="ap-history-toolbar">
          <div
            className="ap-history-tabs"
            role="group"
            aria-label="Filter execution history"
          >
            {[
              ["all", "All events"],
              ["decisions", "Decisions"],
              ["transactions", "Transactions"],
            ].map(([value, label]) => (
              <button
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
                <span>{filterHistory(rows, value, "").length}</span>
              </button>
            ))}
          </div>
          <label className="ap-history-search">
            <Search size={14} />
            <input
              aria-label="Search execution history"
              placeholder="Search events or session…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
        <div className="ap-history-columns" aria-hidden="true">
          <span>EVENT / OBSERVATION</span>
          <span>OUTCOME</span>
          <span>SESSION / OPERATION</span>
          <span>TIME · UTC</span>
          <span />
        </div>
        {visible.length ? (
          <ol className="ap-history-list">
            {visible.map((event) => {
              const status = outcome(event);
              const selected =
                lastSelected?.key === contextKey &&
                lastSelected.event.sequence === event.sequence;
              return (
                <li key={`${contextKey}-${event.sequence}`}>
                  <button
                    className={`ap-history-row ${
                      selected ? "ap-row-selected" : ""
                    }`}
                    onClick={() => select(event)}
                    aria-label={`Inspect ${
                      event.action === "PROVIDER_CLAIM"
                        ? "provider claim"
                        : eventLabels[event.type] || event.type
                    } ${event.sequence}`}
                  >
                    <span className="ap-row-event">
                      <span className="ap-event-number">
                        {typeof event.sequence === "number"
                          ? String(event.sequence).padStart(2, "0")
                          : event.sequence}
                      </span>
                      <span>
                        <strong>
                          {event.action === "PROVIDER_CLAIM"
                            ? "Provider claim"
                            : eventLabels[event.type] || event.type}
                        </strong>
                        <small>{describe(event)}</small>
                      </span>
                    </span>
                    <Badge {...status} />
                    <code className="ap-row-session">
                      {sessionOf(event) || event.action || "—"}
                    </code>
                    <time dateTime={event.at}>
                      {event.attachedReceipt
                        ? "Attached receipt"
                        : timestamp(event.at, true).replace(" UTC", "")}
                    </time>
                    <ArrowUpRight size={14} className="ap-row-arrow" />
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="ap-empty">
            <Search size={23} />
            <strong>
              {rows.length
                ? "No matching events"
                : mode === "recorded" && loading
                ? "Loading execution evidence…"
                : "No run to inspect yet"}
            </strong>
            <p>
              {rows.length
                ? "Try another event, reason or session identifier."
                : mode === "live"
                ? "Connect the local runner and run the agent to build its execution trail."
                : "Generate recorded evidence with npm run demo:capture."}
            </p>
            {rows.length > 0 && (
              <button
                onClick={() => {
                  setFilter("all");
                  setSearch("");
                }}
              >
                Reset all filters
              </button>
            )}
          </div>
        )}
        <div className="ap-history-footer">
          <span>
            {visible.length} of {rows.length} entries · sequence preserves event
            order
          </span>
          <span>
            {run?.runId ? `Run ${run.runId.slice(0, 8)}` : "No run selected"}
          </span>
        </div>
      </section>
      <footer className="ap-dashboard-footer">
        <span>
          Native NEAR payments ·{" "}
          {network === "sandbox" ? "Sandbox fixture tokens" : "Testnet tokens"}{" "}
          · No monetary value
        </span>
        <Link to="/docs">
          Architecture & trust boundaries <ArrowUpRight size={13} />
        </Link>
      </footer>
      {selection?.key === contextKey && (
        <EvidenceDrawer
          event={selection.event}
          run={run}
          vault={vault}
          network={network}
          onClose={() => setSelection(null)}
        />
      )}
    </div>
  );
}
