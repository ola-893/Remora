import { createHash } from 'node:crypto';
import { canonical } from '@ola-893/agentstreams-core/internal-evidence-audit';
import { assetId, rawAmount, spot } from './copy-activity.mjs';
import { nativeWalletActivities, strategyAction } from './strategy-actions.mjs';

export const signalDomain = 'remora.signal.v1';
export const signalStatusDomain = 'remora.signal-status.v1';
export const signalPhases = ['proposed', 'released', 'cancelled', 'settled', 'failed', 'uncertain'];
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const signalActionHash = action => digest(canonical(action));
export const signalEventId = (id, phase) => digest(signalDomain + '\n' + id + '\n' + phase);

export function validateSignalEvent(event) {
  if (!hash(event?.signalId) || !signalPhases.includes(event.phase) || event.id !== signalEventId(event.signalId, event.phase) ||
      !Number.isSafeInteger(event.signalCreatedAt) || event.signalCreatedAt <= 0 || !Number.isSafeInteger(event.signalExpiresAt) ||
      event.signalExpiresAt <= event.signalCreatedAt || event.signalExpiresAt - event.signalCreatedAt > 120000 ||
      !Number.isSafeInteger(event.at) || event.at < event.signalCreatedAt ||
      event.actionHash !== signalActionHash(event.action)) throw new Error('INVALID_SIGNAL_EVENT');
  if (event.activity === spot) {
    const a = event.action;
    if (!['paper', 'agent-connect'].includes(event.execution) || !assetId(a.from) || !assetId(a.to) || a.from === a.to ||
        !rawAmount(a.amountIn) || !rawAmount(a.amountOut) || Object.keys(a).some(k => !['from', 'to', 'amountIn', 'amountOut'].includes(k))) throw new Error('INVALID_SIGNAL_ACTION');
  } else if (!nativeWalletActivities.has(event.activity) || event.execution !== 'wallet' ||
      canonical(strategyAction(event.activity, event.action)) !== canonical(event.action)) throw new Error('INVALID_SIGNAL_ACTION');
  if (event.phase === 'settled' && (typeof event.settlementRef !== 'string' || !event.settlementRef || event.settlementRef.length > 160)) throw new Error('SIGNAL_SETTLEMENT_REQUIRED');
  return event;
}

export function transitionSignal(signal, phase, at = Date.now()) {
  const allowed = { proposed: ['released', 'cancelled'], released: ['settled', 'failed', 'uncertain'], uncertain: ['settled', 'failed'] };
  if (!allowed[signal.phase]?.includes(phase)) throw new Error('SIGNAL_TRANSITION_DENIED');
  if (['released'].includes(phase) && at >= signal.signalExpiresAt) throw new Error('SIGNAL_EXPIRED');
  return { ...signal, phase, updatedAt: at };
}

export function signalState(events, now = Date.now()) {
  if (!events.length) throw new Error('SIGNAL_NOT_FOUND');
  const first = events.find(e => e.phase === 'proposed');
  if (!first) throw new Error('SIGNAL_PROPOSAL_REQUIRED');
  const phases = new Set();
  for (const event of events) {
    validateSignalEvent(event);
    if (['signalId', 'publisher', 'activity', 'execution', 'actionHash', 'signalCreatedAt', 'signalExpiresAt'].some(k => event[k] !== first[k])) throw new Error('SIGNAL_IDENTITY_MISMATCH');
    if (phases.has(event.phase)) throw new Error('SIGNAL_DUPLICATE_PHASE');
    phases.add(event.phase);
  }
  if (phases.has('cancelled') && phases.has('released') || phases.has('settled') && phases.has('failed') ||
      !phases.has('released') && ['settled', 'failed', 'uncertain'].some(p => phases.has(p))) throw new Error('SIGNAL_CONFLICT');
  const phase = ['cancelled', 'settled', 'failed', 'uncertain', 'released', 'proposed'].find(p => phases.has(p));
  return { signalId: first.signalId, publisher: first.publisher, activity: first.activity, actionHash: first.actionHash,
    signalCreatedAt: first.signalCreatedAt, signalExpiresAt: first.signalExpiresAt,
    phase: now >= first.signalExpiresAt && !['settled', 'failed', 'cancelled'].includes(phase) ? 'expired' : phase };
}

export function assertSignalExecutable(status, proposal, now = Date.now()) {
  if (['signalId', 'publisher', 'activity', 'actionHash', 'signalCreatedAt', 'signalExpiresAt'].some(k => status[k] !== proposal[k])) throw new Error('SIGNAL_IDENTITY_MISMATCH');
  if (now >= proposal.signalExpiresAt || now < proposal.signalCreatedAt - 5000) throw new Error('SIGNAL_EXPIRED');
  if (!['released', 'settled'].includes(status.phase)) throw new Error('SIGNAL_NOT_EXECUTABLE:' + status.phase);
  return true;
}

export function applySignalUpdate(state, event) {
  const follow = state.follow;
  const signals = follow.signals ??= {};
  const previous = signals[event.signalId];
  const events = previous?.events ?? [];
  const same = events.find(e => e.phase === event.phase);
  if (same) {
    if (canonical(same) !== canonical(event)) throw new Error('SIGNAL_PHASE_CHANGED');
    return { duplicate: true, proposal: previous.proposal };
  }
  const current = signalState([...events, event]);
  signals[event.signalId] = { events: [...events, event], proposal: previous?.proposal ?? event, current };
  const pending = state.pending?.[event.signalId];
  if (pending && ['cancelled', 'failed', 'uncertain', 'expired'].includes(current.phase) && ['pending', 'approved'].includes(pending.status)) {
    pending.status = 'cancelled';
    pending.reason = 'LEADER_SIGNAL_' + current.phase.toUpperCase();
  }
  return { duplicate: false, proposal: signals[event.signalId].proposal, current };
}
