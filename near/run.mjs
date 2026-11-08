import { KeyPair } from "near-api-js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { NearAgentStreamsClient } from "./sdk/index.mjs";
import { readConfig, readKey } from "./lib/config.mjs";
import { makeSession } from "./lib/session.mjs";
import { startPolicyWorker } from "./lib/worker-client.mjs";
import { runModelAgent } from "./lib/model.mjs";
import { auditHash } from "./lib/audit.mjs";

export async function runDemo({
  configPath,
  service,
  ai = false,
  onEvent = () => {},
  signal,
} = {}) {
  const config = await readConfig(configPath);
  const credential = await readKey(
    process.env.NEAR_AGENT_KEY_FILE || config.agentKeyFile
  );
  if (credential.accountId !== config.agentId)
    throw new Error("Agent key file belongs to another account.");
  const client = new NearAgentStreamsClient({
    vaultId: config.vaultId,
    accountId: config.agentId,
    privateKey: credential.privateKey,
    rpcUrl: config.rpcUrl,
  });
  await client.assertRestrictedAgent();
  const runId = randomUUID(),
    events = [],
    results = {},
    receipts = [];
  const runDirectory = `.local/near/runs/${runId}`;
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const emit = (type, data = {}) => {
    const body = {
      schemaVersion: 1,
      runId,
      sequence: events.length + 1,
      at: new Date().toISOString(),
      type,
      ...data,
      previousHash: events.at(-1)?.eventHash || "0".repeat(64),
    };
    const event = { ...body, eventHash: auditHash(body) };
    appendFileSync(
      `${runDirectory}/events.ndjson`,
      JSON.stringify(event) + "\n",
      { mode: 0o600, flush: true }
    );
    events.push(event);
    onEvent(event);
  };
  const worker = startPolicyWorker(configPath);
  let activeSession = null,
    interrupted = false,
    uncertainTransaction = false;
  const abort = () => {
    interrupted = true;
  };
  signal?.addEventListener("abort", abort);
  const check = () => {
    if (interrupted || signal?.aborted) throw new Error("Run interrupted.");
  };
  const receipt = (action, value) => {
    receipts.push({ action, ...value });
    emit("transaction", { action, ...value });
    return value;
  };
  const submit = async (action, send) => {
    try {
      return receipt(action, await send());
    } catch (error) {
      uncertainTransaction = true;
      throw error;
    }
  };
  let failure;
  try {
    emit("started", {
      network: config.network,
      agentMode: ai ? "model" : "scripted",
      vaultId: config.vaultId,
      agentId: config.agentId,
      recipientId: config.recipientId,
    });
    const purchase = async (tier) => {
      check();
      const sessionId = `${runId.slice(0, 8)}-${tier}`;
      emit("proposal", { tier, sessionId });
      const admission = await worker.request({
        action: "OPEN",
        tier,
        sessionId,
      });
      emit("policy", {
        tier,
        sessionId,
        decision: admission.decision,
        reason: admission.reason,
        quote: admission.quote,
        prices: admission.prices,
      });
      if (admission.decision === "DENY")
        return (results[tier] = { decision: "DENY", reason: admission.reason });
      if (admission.decision !== "OPEN")
        throw new Error("Unexpected admission response.");
      check();
      // Save the intent before submitting. A timeout is uncertain and never retried.
      const directory = `.local/near/runs/${runId}`;
      await mkdir(directory, { recursive: true });
      await writeFile(
        `${directory}/open-intent.json`,
        JSON.stringify(
          { vaultId: config.vaultId, sessionId, approval: admission.approval },
          null,
          2
        )
      );
      activeSession = sessionId;
      const opened = await submit("OPEN", () =>
        client.open(admission.approval)
      );
      const session = makeSession({
        config,
        stream: opened.value,
        key: KeyPair.fromString(credential.privateKey),
      });
      const nonce = async () =>
        String(
          (
            await client.provider.viewAccessKey({
              accountId: config.agentId,
              publicKey: credential.publicKey,
            })
          ).nonce
        );
      const nonceBefore = await nonce();
      let successfulRequests = 0;
      for (let i = 0; i < 10; i++) {
        check();
        const response = await fetch(`${config.serviceUrl}/research`, {
          headers: { "x-agentpay-session": session },
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        });
        if (!response.ok)
          throw new Error(`Paid provider returned HTTP ${response.status}.`);
        const answer = await response.json();
        if (
          answer.session_id !== sessionId ||
          answer.request !== successfulRequests + 1
        )
          throw new Error("Provider request counter mismatch.");
        successfulRequests++;
        emit("request", {
          sessionId,
          count: successfulRequests,
          status: response.status,
        });
        await delay(120);
      }
      const nonceAfter = await nonce();
      if (nonceBefore !== nonceAfter)
        throw new Error("Unexpected wallet transaction during request reuse.");
      emit("reuse_verified", {
        sessionId,
        successfulRequests,
        nonceBefore,
        nonceAfter,
        extraPaymentTransactions: 0,
      });
      const healthy = await worker.request({ action: "CHECK", sessionId });
      emit("policy", {
        sessionId,
        decision: healthy.decision,
        reason: healthy.reason,
      });
      if (healthy.decision !== "CONTINUE")
        throw new Error("Service did not pass its healthy checkpoint.");
      if (service) {
        service.setUnavailable(true);
        emit("outage", { sessionId, injected: true });
      }
      const close = await worker.request({
        action: service ? "CHECK" : "SHUTDOWN",
        sessionId,
      });
      emit("policy", {
        sessionId,
        decision: close.decision,
        reason: close.reason,
      });
      if (close.decision !== "CLOSE")
        throw new Error("Policy did not approve closure.");
      const closed = await submit("CLOSE", () => client.close(close.approval));
      activeSession = null;
      service?.setUnavailable(false);
      const stream = await client.getStream(sessionId);
      if (
        !stream?.closed_at ||
        BigInt(stream.earned) + BigInt(stream.refunded) !==
          BigInt(stream.deposit)
      )
        throw new Error("Settlement verification failed.");
      emit("settled", { stream });
      return (results[tier] = {
        decision: "COMPLETED",
        successfulRequests,
        deposit: stream.deposit,
        earned: stream.earned,
        refundedToVault: stream.refunded,
        providerPayment: "claimable",
        openHash: opened.hash,
        closeHash: closed.hash,
        sessionId,
      });
    };
    if (ai) await runModelAgent(purchase, emit, { signal });
    else {
      await purchase("basic");
      await purchase("premium");
    }
  } catch (error) {
    failure = error;
    emit("error", { message: error.message });
  } finally {
    service?.setUnavailable(false);
    if (activeSession) {
      try {
        if (uncertainTransaction)
          throw new Error("Submission needs reconciliation.");
        const stream = await client.getStream(activeSession);
        if (stream && stream.closed_at === null) {
          const close = await worker.request({
            action: "SHUTDOWN",
            sessionId: activeSession,
          });
          if (close.decision !== "CLOSE")
            throw new Error("No cleanup approval.");
          receipt("CLEANUP_CLOSE", await client.close(close.approval));
          emit("cleanup", { sessionId: activeSession, closed: true });
        }
        if (!stream) throw new Error("Open intent has not been reconciled.");
      } catch {
        emit("recovery_required", {
          sessionId: activeSession,
          message:
            "Check stream state and use owner recovery. No open transaction was resubmitted.",
        });
      }
    }
    worker.stop();
    signal?.removeEventListener("abort", abort);
  }
  const run = {
    schemaVersion: 1,
    runId,
    recordedAt: new Date().toISOString(),
    network: config.network,
    agentMode: ai ? "model" : "scripted",
    vaultId: config.vaultId,
    ok: !failure,
    results,
    events,
    receipts,
    finalVault: await client.getVault(),
  };
  emit("finished", { ok: run.ok });
  const directory = `.local/near/runs/${runId}`;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/run.json`, JSON.stringify(run, null, 2));
  if (failure) {
    failure.run = run;
    throw failure;
  }
  return run;
}
