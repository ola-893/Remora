export const isRepositoryAnalysis = source => ['agentStreams repository analysis', 'AgentPay repository analysis'].includes(source);

export function usdc(raw) {
  if (raw === undefined || raw === null || !/^\d+$/.test(String(raw)))
    return "—";
  const n = BigInt(raw);
  return `${n / 1000000n}.${String(n % 1000000n).padStart(6, "0")}`;
}

export function timestamp(value, short = false) {
  if (!value || !Number.isFinite(new Date(value).getTime()))
    return "Time unavailable";
  return (
    new Intl.DateTimeFormat("en-GB", {
      ...(short ? {} : { day: "2-digit", month: "short", year: "numeric" }),
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: "UTC",
    }).format(new Date(value)) + " UTC"
  );
}

export const eventLabels = {
  started: "Agent started",
  proposal: "Service requested",
  policy: "Policy checkpoint",
  transaction: "NEAR transaction",
  request: "Paid API request",
  reuse_verified: "Session reuse verified",
  outage: "Provider outage injected",
  settled: "Session settled",
  model: "Model tool call",
  summary: "Model explanation",
  finished: "Run finished",
  error: "Run stopped",
  cleanup: "Cleanup completed",
  recovery_required: "Owner recovery required",
};

export const sessionOf = (event) =>
  event?.sessionId ||
  event?.stream?.session_id ||
  event?.value?.session_id ||
  "";
export function describe(event) {
  if (event.type === "policy")
    return (event.reason || "No reason recorded")
      .replaceAll("_", " ")
      .toLowerCase();
  if (event.type === "request")
    return `Request ${event.count} · HTTP ${event.status}${isRepositoryAnalysis(event.body?.source) ? ` · repository ${event.body.view}` : ' · funded session'}`;
  if (event.type === "transaction") return `${event.action} · ${event.hash}`;
  if (event.type === "settled")
    return `${usdc(event.stream?.earned)} earned · ${usdc(
      event.stream?.refunded
    )} returned`;
  if (event.type === "reuse_verified")
    return `${event.successfulRequests} requests · ${event.extraPaymentTransactions} extra payment transactions`;
  if (event.type === "summary")
    return "Model-generated explanation · not a verified decision";
  if (event.type === "outage")
    return event.injected
      ? "Explicitly injected service failure"
      : "Provider observation";
  return (
    event.message ||
    event.model ||
    event.tool ||
    event.tier ||
    event.agentMode ||
    (event.type === "finished"
      ? event.ok
        ? "Completed"
        : "Failed"
      : "Execution observation")
  );
}

export function outcome(event) {
  if (event.action === "PROVIDER_CLAIM" && event.value === false)
    return { label: "PAYOUT FAILED", tone: "error" };
  if (
    event.type === "error" ||
    event.type === "recovery_required" ||
    event.receiptFailures?.length ||
    (event.type === "finished" && !event.ok)
  )
    return {
      label: event.type === "recovery_required" ? "RECOVERY" : "ERROR",
      tone: "error",
    };
  if (event.decision === "DENY") return { label: "DENY", tone: "warn" };
  if (event.type === "outage") return { label: "OUTAGE", tone: "warn" };
  if (event.decision)
    return {
      label: event.decision,
      tone: event.decision === "CLOSE" ? "neutral" : "success",
    };
  if (event.type === "transaction")
    return { label: "CONFIRMED", tone: "success" };
  if (event.type === "request")
    return {
      label: `HTTP ${event.status}`,
      tone: event.status >= 400 ? "error" : "neutral",
    };
  if (event.type === "settled") return { label: "CLOSED", tone: "success" };
  if (event.type === "reuse_verified")
    return { label: "VERIFIED", tone: "success" };
  return {
    label: event.type === "finished" ? "COMPLETE" : "RECORDED",
    tone: "neutral",
  };
}

export function historyRows(run) {
  const events = run?.events || [];
  // A provider claim is a separate operation and may be attached outside the event journal.
  const payout = run?.providerPayout;
  if (!payout?.hash || events.some((e) => e.hash === payout.hash))
    return events;
  return [
    ...events,
    {
      ...payout,
      type: "transaction",
      action: "PROVIDER_CLAIM",
      sequence: "P",
      runId: run.runId,
      attachedReceipt: true,
    },
  ];
}

export function filterHistory(rows, filter, search) {
  const query = search.trim().toLowerCase();
  return rows.filter(
    (event) =>
      (filter === "all" ||
        (filter === "decisions" && event.type === "policy") ||
        (filter === "transactions" && event.type === "transaction")) &&
      (!query ||
        [
          eventLabels[event.type],
          describe(event),
          sessionOf(event),
          event.decision,
          event.reason,
          event.action,
          event.hash,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query))
  );
}

export function summarize(run, vault) {
  const events = run?.events || [];
  const last = (predicate) => [...events].reverse().find(predicate);
  const settled = last((e) => e.type === "settled")?.stream;
  const opened = last(
    (e) => e.type === "transaction" && e.action === "OPEN"
  )?.value;
  const recovery = last((e) => e.type === "recovery_required");
  const close = last((e) => e.type === "policy" && e.decision === "CLOSE");
  const closedReceipt = last(
    (e) =>
      e.type === "transaction" &&
      ["CLOSE", "CLEANUP_CLOSE"].includes(e.action) &&
      e.value?.closed_at &&
      !e.receiptFailures?.length
  );
  const stream = settled || closedReceipt?.value || opened;
  const session = recovery
    ? "Recovery required"
    : settled || closedReceipt
    ? "Closed"
    : vault?.active_session
    ? "Active"
    : close
    ? "Closure requested"
    : opened
    ? "Opened · final state unavailable"
    : "No session observed";
  const health = last(
    (e) =>
      e.type === "policy" &&
      ["SERVICE_UNAVAILABLE", "SERVICE_HEALTHY"].includes(e.reason)
  );
  const injected = events.some((e) => e.type === "outage" && e.injected);
  const payout = run?.providerPayout;
  let payoutState = "Not observed";
  if (payout?.value === true && !payout.receiptFailures?.length)
    payoutState = "Paid · claim confirmed";
  else if (payout?.value === false || payout?.receiptFailures?.length)
    payoutState = "Payout failed · inspect receipt";
  else if (payout?.hash) payoutState = "Claim outcome unavailable";
  else if (
    settled &&
    Object.values(run?.results || {}).some(
      (r) =>
        r.sessionId === settled.session_id && r.providerPayment === "claimable"
    )
  )
    payoutState = "Claimable at settlement";
  return {
    stream,
    settled,
    reuse: last((e) => e.type === "reuse_verified"),
    denied: last((e) => e.type === "policy" && e.decision === "DENY"),
    session,
    health,
    injected,
    payoutState,
    serviceState: health
      ? `${
          health.reason === "SERVICE_UNAVAILABLE" ? "Unavailable" : "Healthy"
        }${injected ? " · fixture" : ""}`
      : "Not observed",
  };
}

export function decisionComparison(event, policy) {
  if (event.type !== "policy" || !event.quote) return [];
  const q = event.quote;
  return [
    {
      label: "Rate",
      observed: `${usdc(q.rate)} USDC / s`,
      bound: `${usdc(policy?.max_rate)} USDC / s`,
      failed: event.reason === "RATE_LIMIT",
    },
    {
      label: "Duration",
      observed: q.duration_seconds == null ? "—" : q.duration_seconds === 0 ? "Until closed" : `${q.duration_seconds} s`,
      bound:
        policy?.max_duration_seconds == null
          ? "—"
          : policy.max_duration_seconds === 0 ? "No time limit" : `${policy.max_duration_seconds} s`,
      failed: event.reason === "DURATION_LIMIT",
    },
  ];
}
