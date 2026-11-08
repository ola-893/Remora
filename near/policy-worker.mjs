import { createInterface } from "node:readline";
import { readConfig, readKey } from "./lib/config.mjs";
import { assessQuote, fetchPrices, approve } from "./lib/policy.mjs";
import { signPermit } from "./lib/permit.mjs";
import { NearAgentStreamsClient } from "./sdk/index.mjs";
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { updateObservation, closeReason } from './lib/runtime-policy.mjs';

const config = await readConfig();
const credential = await readKey(
  process.env.NEAR_POLICY_KEY_FILE || config.policyKeyFile
);
const client = new NearAgentStreamsClient({
  vaultId: config.vaultId,
  rpcUrl: config.rpcUrl,
});
const stateDir = process.env.AGENTPAY_STATE_DIR || join(dirname(process.env.NEAR_CONFIG || '.local/near/deployment.json'), 'service-state');
const circuitFile = join(stateDir, createHash('sha256').update(`${config.vaultId}|${config.serviceUrl}|${config.recipientId}`).digest('hex') + '.circuit.json');
const json = async (path) => {
  const response = await fetch(`${config.serviceUrl}${path}`, {
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("SERVICE_UNAVAILABLE");
  return response.json();
};

async function evaluate(request) {
  // Operator policy edits take effect without trusting model-supplied settings.
  const current = await readConfig();
  config.runtimePolicy = current.runtimePolicy;
  config.service = current.service;
  if (current.serviceUrl !== config.serviceUrl || current.recipientId !== config.recipientId) throw new Error('SERVICE_CONFIG_CHANGED_RESTART_REQUIRED');
  const vault = await client.getVault();
  if (
    vault.policy_key !== credential.publicKey ||
    vault.agent_id !== config.agentId ||
    vault.token_id !== config.tokenId
  )
    throw new Error("POLICY_AUTHORITY_MISMATCH");
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(vault.now)) > 30)
    throw new Error("STALE_CHAIN");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(request.sessionId ?? ""))
    throw new Error("INVALID_SESSION");
  if (request.action === "OPEN") {
    try {
      const circuit = JSON.parse(await readFile(circuitFile, 'utf8'));
      if (Number(vault.now) < circuit.until) return { decision: 'DENY', reason: 'SERVICE_COOLDOWN', retryAfter: circuit.until };
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!config.service.tiers.includes(request.tier))
      throw new Error("INVALID_TIER");
    const [health, quote] = await Promise.all([
      json(config.service.healthPath),
      json(`${config.service.quotePath}?tier=${encodeURIComponent(request.tier)}`),
    ]);
    if (quote.recipient_id !== config.recipientId)
      throw new Error("PROVIDER_IDENTITY_MISMATCH");
    const result = assessQuote({
      vault: { ...vault, vault_id: config.vaultId },
      quote,
      health,
    });
    if (result.decision !== "OPEN") return { ...result, quote };
    const prices =
      config.network === "sandbox"
        ? {
            decision: "ALLOW",
            reason: "SANDBOX_FIXTURE_NO_MARKET_PRICE",
            samples: [],
          }
        : await fetchPrices();
    if (prices.decision !== "ALLOW") return { ...prices, decision: "DENY" };
    if (await client.getStream(request.sessionId))
      return { decision: "DENY", reason: "SESSION_REPLAY" };
    return {
      ...result,
      quote,
      prices,
      approval: approve({
        config,
        vault,
        quote,
        sessionId: request.sessionId,
        action: "OPEN",
        privateKey: credential.privateKey,
      }),
    };
  }
  if (!["CHECK", "SHUTDOWN", "OBSERVE"].includes(request.action))
    throw new Error("INVALID_ACTION");
  const stream = await client.getStream(request.sessionId);
  if (
    !stream ||
    stream.closed_at !== null ||
    vault.active_session !== request.sessionId
  )
    return { decision: "DENY", reason: "STREAM_NOT_ACTIVE" };
  let reason = 'CLIENT_SHUTDOWN', health;
  if (request.action !== 'SHUTDOWN') {
    let observation;
    if (request.action === 'CHECK') {
      health = await json(config.service.healthPath).catch(() => ({ ok: false }));
      observation = { kind: 'health', ok: health.ok === true && Number.isSafeInteger(health.observed_at) && Math.abs(Math.floor(Date.now() / 1000) - health.observed_at) <= 30 };
    } else {
      // Only the host HTTP transport calls OBSERVE; this is never an MCP/model tool.
      observation = request.observation;
      if (!observation || !['response', 'transport'].includes(observation.kind)) throw new Error('INVALID_OBSERVATION');
    }
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const file = join(stateDir, createHash('sha256').update(`${config.vaultId}|${request.sessionId}`).digest('hex') + '.observations.json');
    let lock;
    try { lock = await open(file + '.lock', 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') throw new Error('OBSERVATION_BUSY_OR_INTERRUPTED'); throw e; }
    let state;
    try {
      let previous = { lastRequestAt: Number(stream.started_at) };
      try { previous = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      state = updateObservation(previous, observation);
      const temp = file + `.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
      await rename(temp, file);
    } finally { await lock.close(); await unlink(file + '.lock'); }
    reason = closeReason(config.runtimePolicy, state, stream);
    if (reason && ['SERVICE_5XX_LIMIT', 'SERVICE_TRANSPORT_LIMIT', 'SERVICE_UNAVAILABLE', 'SERVICE_ACCESS_REJECTED'].includes(reason)) {
      const temp = circuitFile + `.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ until: Number(vault.now) + config.runtimePolicy.failureCooldownSeconds, reason }), { mode: 0o600 });
      await rename(temp, circuitFile);
    }
    if (!reason) return { decision: 'CONTINUE', reason: request.action === 'CHECK' ? 'SERVICE_HEALTHY_OR_WITHIN_FAILURE_LIMIT' : 'REQUEST_WITHIN_POLICY', health, counters: state };
  }
  const permit = {
    domain: "agentpay.near.v1",
    vault_id: config.vaultId,
    agent_id: config.agentId,
    action: "CLOSE",
    session_id: request.sessionId,
    recipient_id: stream.recipient_id,
    rate: stream.rate,
    duration_seconds: stream.duration_seconds,
    quote_hash: stream.quote_hash,
    nonce: vault.next_nonce,
    expires_at: String(Number(vault.now) + 90),
  };
  return {
    decision: "CLOSE",
    reason,
    health,
    approval: signPermit(permit, credential.privateKey),
  };
}

// Single dedicated process. It reads observations itself and never offers generic signing.
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  let request;
  try {
    request = JSON.parse(line);
    process.stdout.write(
      JSON.stringify({
        id: request.id,
        ok: true,
        result: await evaluate(request),
      }) + "\n"
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        id: request?.id,
        ok: false,
        error: /^[A-Z_]+$/.test(error.message)
          ? error.message
          : "POLICY_EVALUATION_FAILED",
      }) + "\n"
    );
  }
}
