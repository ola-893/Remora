import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { PublicKey, JsonRpcProvider } from 'near-api-js';
import { canonical } from '@ola-893/agentstreams-core/internal-evidence-audit';
import { readAgentState, withAgentState } from './agents.mjs';
import { appendSignalEvent, fetchFeed, pendingOutlayerEntries } from './copy-feed.mjs';
import { appendOutlayer } from './outlayer.mjs';
import { signalActionHash, signalEventId, signalStatusDomain, transitionSignal, assertSignalExecutable } from './signal-protocol.mjs';
import { verifyOwnerTransaction } from './owner-wallet.mjs';

function event(signal, extra = {}) {
  const at = Date.now();
  return { signalId: signal.signalId, id: signalEventId(signal.signalId, signal.phase), phase: signal.phase,
    publisher: signal.publisher, activity: signal.activity, execution: signal.execution, action: signal.action, actionHash: signal.actionHash,
    signalCreatedAt: signal.signalCreatedAt, signalExpiresAt: signal.signalExpiresAt, at, expiresAt: at + 120000, ...extra };
}

async function delivered(agent, id, phase) {
  const state = await readAgentState(agent);
  if (state.publish?.delivery === 'outlayer') {
    for (let pass = 0; pass < 128; pass++) {
      const batch = await pendingOutlayerEntries(agent);
      if (!batch.length) break;
      for (const pending of batch) {
        await appendOutlayer(agent, pending.entry);
        await withAgentState(agent, current => {
          const pointer = current.journal.find(p => p.id === pending.id);
          if (pointer) pointer.outlayerUploaded = true;
        }, { waitMs: 12000 });
      }
      if ((await readAgentState(agent)).journal.find(p => p.id === signalEventId(id, phase))?.outlayerUploaded) break;
    }
    if (!(await readAgentState(agent)).journal.find(p => p.id === signalEventId(id, phase))?.outlayerUploaded) throw new Error('SIGNAL_DELIVERY_UNCONFIRMED');
  } else {
    const response = await fetch(state.publish.origin + '/copy/health', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    const health = await response.json();
    if (!response.ok || health.ok !== true || Math.abs(Date.now() / 1000 - health.observed_at) > 30) throw new Error('SIGNAL_FEED_NOT_RUNNING');
  }
  await withAgentState(agent, current => {
    const signal = current.leaderSignals?.[id];
    if (signal) (signal.deliveredPhases ??= []).push(phase);
  }, { waitMs: 12000 });
}

export async function proposeSignal(agent, { id, activity, action, execution }) {
  const result = await withAgentState(agent, async state => {
    if (!state.publish?.enabled || state.publish.activity !== activity) return null;
    const now = Date.now();
    if (Object.values(state.leaderSignals ?? {}).some(s => s.phase === 'uncertain' || s.phase === 'released' || s.phase === 'proposed' && now < s.signalExpiresAt)) {
      throw new Error('LEADER_SIGNAL_RECONCILIATION_REQUIRED');
    }
    const window = state.publish.signalWindowSeconds ?? 30;
    const signal = { signalId: id, publisher: agent.id, activity, execution, action, actionHash: signalActionHash(action),
      signalCreatedAt: now, signalExpiresAt: now + 120000, phase: 'proposed', windowSeconds: window };
    const pointer = await appendSignalEvent(agent, state, event(signal));
    if (!pointer) throw new Error('SIGNAL_PUBLICATION_CHANGED');
    (state.leaderSignals ??= {})[id] = signal;
    return signal;
  });
  if (result) await delivered(agent, id, 'proposed');
  return result;
}

export async function updateSignal(agent, id, phase, extra = {}) {
  const result = await withAgentState(agent, async state => {
    const previous = state.leaderSignals?.[id];
    if (!previous) throw new Error('SIGNAL_NOT_FOUND');
    if (previous.phase === phase) return previous;
    const next = transitionSignal(previous, phase);
    const pointer = await appendSignalEvent(agent, state, event(next, extra));
    if (!pointer) throw new Error('SIGNAL_PUBLICATION_CHANGED');
    state.leaderSignals[id] = next;
    return next;
  }, { waitMs: 12000 });
  await delivered(agent, id, phase);
  return result;
}

export async function finishSignalInState(agent, state, id, phase, extra = {}) {
  const previous = state.leaderSignals?.[id];
  if (!previous) throw new Error('SIGNAL_NOT_FOUND');
  const next = transitionSignal(previous, phase);
  const pointer = await appendSignalEvent(agent, state, event(next, extra));
  if (!pointer) throw new Error('SIGNAL_PUBLICATION_CHANGED');
  state.leaderSignals[id] = next;
  return { ...pointer, signalId: id, phase, deliveryConfirmed: false };
}

export async function reconcileSignal(agent, id, hash) {
  const signal = (await readAgentState(agent)).leaderSignals?.[id];
  if (!signal || !['released', 'uncertain'].includes(signal.phase) || !signal.executionPlan) throw new Error('SIGNAL_RECONCILIATION_NOT_AVAILABLE');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash ?? '')) throw new Error('SIGNAL_TRANSACTION_HASH_REQUIRED');
  const plan = signal.executionPlan;
  const outcome = await new JsonRpcProvider({ url: plan.rpcUrl }).viewTransactionStatusWithReceipts({ txHash: hash, accountId: plan.executionAccountId, waitUntil: 'FINAL' });
  try {
    verifyOwnerTransaction(outcome, { ownerId: plan.executionAccountId, receiverId: plan.receiverId, actions: plan.actions }, hash);
  } catch (error) {
    if (!error.confirmedFailure) throw error;
    return updateSignal(agent, id, 'failed');
  }
  return updateSignal(agent, id, 'settled', { settlementRef: hash });
}

export async function waitSignalWindow(agent, signal, abortSignal) {
  if (!signal) return;
  const until = signal.signalCreatedAt + signal.windowSeconds * 1000;
  while (Date.now() < until) {
    abortSignal?.throwIfAborted();
    const current = (await readAgentState(agent)).leaderSignals?.[signal.signalId];
    if (current?.phase !== 'proposed') throw new Error('LEADER_SIGNAL_CANCELLED');
    await sleep(Math.min(250, until - Date.now()), undefined, { signal: abortSignal });
  }
}

export function proposalForExecution(event) {
  return { ...event, id: event.signalId, at: event.signalCreatedAt, expiresAt: event.signalExpiresAt,
    ...(event.activity === 'spot-trading' ? event.action : {}) };
}

export async function checkSignalBeforeExecution(entry, follow, client) {
  if (!entry.signalId) return;
  const nonce = randomBytes(32).toString('hex');
  const proof = await fetchFeed(follow.listing.origin, `/copy/signals/${entry.signalId}?nonce=${nonce}`, await client.sessionHeaders(), follow.listing.id);
  const body = proof?.body;
  const key = follow.listing.delivery === 'outlayer' ? follow.listing.deliveryKey : follow.listing.publicKey;
  if (!body || body.nonce !== nonce || body.sessionId !== follow.sessionId || !Number.isSafeInteger(body.observedAt) ||
      body.observedAt > Date.now() + 5000 || Date.now() - body.observedAt > 10000 ||
      !PublicKey.fromString(key).verify(Buffer.from(canonical({ domain: signalStatusDomain, body })), Buffer.from(proof.signature ?? '', 'base64'))) {
    throw new Error('SIGNAL_STATUS_INVALID');
  }
  if (body.phase === 'proposed') return false;
  assertSignalExecutable(body, entry);
  return true;
}
