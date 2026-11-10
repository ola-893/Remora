import { honorVeto } from './copy-veto.mjs';
import { recordPerformance } from './public-reporting.mjs';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { copyVetoDeadline, copyVetoDue, operationKey } from './copy-activity.mjs';
import { gatewayFor } from './config.mjs';
import { agentSetupState, readAgentState, withAgentState } from './agents.mjs';
import { appendStrategyAction } from './copy-feed.mjs';
import { prepareRangeDeposit, runWalletStrategy } from './strategy-wallet.mjs';
import { activityBlocker, enforceStrategyPolicy, nativeWalletActivities, sizedStrategyAction, strategyAction } from './strategy-actions.mjs';
import { proposeSignal, updateSignal, waitSignalWindow, checkSignalBeforeExecution } from './signals.mjs';

function strategyHistory(state, entry) {
  state.history.push({ at: new Date().toISOString(), ...entry });
  if (state.history.length > 500) state.history.shift();
}

function strategyPolicyFor(state, activity) {
  if (!nativeWalletActivities.has(activity)) throw new Error(activityBlocker);
  if (state.tasks[activity]?.mode !== 'wallet') throw new Error('Enable ' + activity + ' for NEAR testnet first.');
  return state.strategyPolicies?.[activity];
}

function orderClientId(agent, activity, action, id, publisher = 'local') {
  if (activity !== 'limit-orders') return undefined;
  return operationKey(agent.id, publisher + ':' + (action.placement ?? id)).slice(0, 32);
}

async function saveResult(agent, id, result, copiedFrom, signal) {
  let deliveryError;
  if (signal) try { await updateSignal(agent, id, 'settled', { settlementRef: result.receipt.hash }); }
  catch (error) { deliveryError = error.message; }
  for (let attempt = 0; ; attempt++) {
    try {
      return await withAgentState(agent, async state => {
        const at = Date.now();
        recordPerformance(state, { id, ...result, execution: 'wallet', at });
        const entry = { id, activity: result.activity, action: result.action, execution: 'wallet', at, expiresAt: at + 120000,
          settlementRef: result.receipt.hash, ...(copiedFrom ? { copiedFrom } : {}) };
        const publication = signal ? { journalHash: state.journal?.find(p => p.signalId === id && p.phase === 'settled')?.hash, signalId: id, phase: 'settled', deliveryConfirmed: !deliveryError, ...(deliveryError ? { deliveryError } : {}) }
          : await appendStrategyAction(agent, state, entry).catch(error => ({ error: error.message }));
        if (copiedFrom && state.pending?.[id]) state.pending[id].status = result.status;
        strategyHistory(state, { type: 'strategy', activity: result.activity, status: result.status, actionId: id,
          transactionHash: result.receipt.hash, signing: result.receipt.signing, ...(copiedFrom ? { publisher: copiedFrom } : {}), publication });
        return { ...result, actionId: id, publication };
      });
    } catch (error) {
      if (!error.message.startsWith('AGENT_BUSY') || attempt === 24) {
        throw new Error(`STRATEGY_HISTORY_UNCONFIRMED: transaction ${result.receipt.explorerUrl} · ${error.message}`, { cause: error });
      }
      await sleep(200);
    }
  }
}

export async function runStrategyTask(agent, activity, input, options = {}) {
  const action = strategyAction(activity, input);
  const policy = strategyPolicyFor(await readAgentState(agent), activity);
  const { ownerId } = await agentSetupState(agent);
  const id = operationKey(agent.id, randomUUID());
  const publishing = (await readAgentState(agent)).publish;
  let signal;
  try {
    if (options.execute && publishing?.enabled && publishing.activity === activity) {
      await runWalletStrategy(activity, action, policy, { ...options, execute: false, ownerId, agentId: agent.id });
      signal = await proposeSignal(agent, { id, activity, action, execution: 'wallet' });
      await waitSignalWindow(agent, signal, options.signal);
    }
    const result = await runWalletStrategy(activity, action, policy, { ...options, ownerId, agentId: agent.id, operationId: id,
      orderClientId: orderClientId(agent, activity, action, id),
      authorize: async (inputs, plan) => {
        options.signal?.throwIfAborted();
        const current = strategyPolicyFor(await readAgentState(agent), activity);
        enforceStrategyPolicy(activity, action, current, inputs);
        if (JSON.stringify(current) !== JSON.stringify(policy)) throw new Error('STRATEGY_POLICY_CHANGED: run a new preview.');
        if (signal) {
          await withAgentState(agent, state => {
            const active = state.leaderSignals?.[id];
            if (active?.phase !== 'proposed' || Date.now() >= active.signalExpiresAt) throw new Error('LEADER_SIGNAL_CANCELLED_OR_EXPIRED');
            active.executionPlan = plan;
          });
          await updateSignal(agent, id, 'released');
          const active = (await readAgentState(agent)).leaderSignals[id];
          if (Date.now() >= active.signalExpiresAt || active.phase !== 'released') throw new Error('LEADER_SIGNAL_EXPIRED');
        }
      },
    });
    return options.execute ? await saveResult(agent, id, result, undefined, signal) : result;
  } catch (error) {
    const active = (await readAgentState(agent)).leaderSignals?.[id];
    if (active?.phase === 'proposed') await updateSignal(agent, id, 'cancelled').catch(() => {});
    else if (active?.phase === 'released') await updateSignal(agent, id, error.confirmedFailure ? 'failed' : 'uncertain').catch(() => {});
    throw error;
  }
}

export async function prepareStrategyDeposit(agent, action, { execute } = {}) {
  const activity = 'liquidity-ranges';
  const policy = strategyPolicyFor(await readAgentState(agent), activity);
  const { ownerId } = await agentSetupState(agent);
  return prepareRangeDeposit(action, policy, { execute, ownerId, agentId: agent.id, authorize: async inputs => {
    const current = strategyPolicyFor(await readAgentState(agent), activity);
    enforceStrategyPolicy(activity, action, current, inputs);
    if (JSON.stringify(current) !== JSON.stringify(policy)) throw new Error('STRATEGY_POLICY_CHANGED: run a new preview.');
  } });
}

function checkAge(entry, policy, now = Date.now()) {
  if (entry.at > now + 5000 || now >= entry.expiresAt || (policy && now - entry.at > policy.maxAge * 1000)) throw new Error('ACTION_EXPIRED');
}

export async function observeStrategy(agent, state, entry, emit, save) {
  const { follow } = state, { activity, id } = entry;
  const record = (status, data = {}) => {
    const event = { type: 'strategy', activity, actionId: id, publisher: entry.publisher, status, ...data };
    strategyHistory(state, event);
    emit(event);
  };
  if (entry.copiedFrom) return record('skipped', { reason: 'COPIED_ACTION' });
  if (entry.execution !== 'wallet') return record('skipped', { reason: 'TESTNET_SETTLEMENT_REQUIRED' });
  try {
    checkAge(entry, state.strategyPolicies?.[activity]);
    if (!['approve', 'veto'].includes(follow.mode)) return record('observed', { action: entry.action, transactionHash: entry.settlementRef });
    const policy = strategyPolicyFor(state, activity);
    const action = sizedStrategyAction(activity, entry.action, policy);
    const { ownerId } = await agentSetupState(agent);
    const checked = await runWalletStrategy(activity, action, policy, { ownerId, agentId: agent.id, requireGrant: follow.mode === 'veto',
      orderClientId: orderClientId(agent, activity, action, id, entry.publisher) });
    const preview = { action, inputs: checked.inputs, evidence: checked.evidence, executionAccountId: checked.executionAccountId, transactionHash: entry.settlementRef };
    const deadline = copyVetoDeadline(follow, entry, policy);
    (state.pending ??= {})[id] = { status: 'pending', action: entry, preview, sessionId: follow.sessionId, ...deadline };
    await save?.();
    return record('pending', { ...preview, ...deadline });
  } catch (error) {
    return record('skipped', { reason: error.message });
  }
}

export async function approveStrategy(agent, id, { veto = false } = {}) {
  const mode = veto ? 'veto' : 'approve';
  const preparing = veto ? 'authorizing' : 'awaiting-wallet';
  const lockOptions = veto ? { waitMs: 2000 } : undefined;
  const prepared = await withAgentState(agent, state => {
    const { follow } = state, item = state.pending?.[id];
    if (follow?.status !== 'active' || follow.mode !== mode || item?.status !== 'pending' ||
        item.sessionId !== follow.sessionId || item.action.activity !== follow.listing.activity || (veto && !copyVetoDue(item, follow.sessionId))) {
      throw new Error('Action is not pending for the active subscription.');
    }
    try {
      const policy = strategyPolicyFor(state, item.action.activity);
      checkAge(item.action, policy);
      const action = sizedStrategyAction(item.action.activity, item.action.action, policy);
      if (veto && JSON.stringify(action) !== JSON.stringify(item.preview?.action)) throw new Error('COPY_CANDIDATE_CHANGED');
      item.status = preparing;
      return { entry: item.action, sessionId: item.sessionId, policy, action, preview: item.preview };
    } catch (error) {
      if (!veto) throw error;
      item.status = 'skipped';
      strategyHistory(state, { type: 'strategy', actionId: id, status: 'skipped', reason: error.message });
      return { status: 'skipped', reason: error.message };
    }
  }, lockOptions);
  if (prepared.status === 'skipped') return prepared;
  const { entry, sessionId, policy, action, preview } = prepared;
  try {
    if (entry.signalId) {
      const client = await gatewayFor(agent.path);
      let ready;
      try { ready = await checkSignalBeforeExecution(entry, (await readAgentState(agent)).follow, client); }
      finally { await client.dispose(); }
      if (!ready) {
        await withAgentState(agent, state => { if (state.pending[id]?.status === preparing) state.pending[id].status = 'pending'; }, lockOptions);
        return { status: 'waiting-signal', actionId: id };
      }
    }
    const { ownerId } = await agentSetupState(agent);
    const result = await runWalletStrategy(entry.activity, action, policy, { execute: true, operationId: id, ownerId, agentId: agent.id,
      expectedExecutionAccountId: preview?.executionAccountId ?? ownerId, requireGrant: veto,
      orderClientId: orderClientId(agent, entry.activity, action, id, entry.publisher),
      authorize: async inputs => {
        const client = await gatewayFor(agent.path);
        try {
          await withAgentState(agent, async state => {
            const current = strategyPolicyFor(state, entry.activity);
            const active = state.follow;
            if (active?.status !== 'active' || active.sessionId !== sessionId || active.mode !== mode ||
                state.pending?.[id]?.status !== preparing) throw new Error('COPY_AUTHORITY_EXPIRED');
            checkAge(entry, current);
            enforceStrategyPolicy(entry.activity, action, current, inputs);
            if (veto && Object.entries(inputs).some(([asset, amount]) => BigInt(amount) > BigInt(preview?.inputs?.[asset] ?? '0'))) {
              throw new Error('COPY_CANDIDATE_CHANGED');
            }
            if (JSON.stringify(current) !== JSON.stringify(policy)) throw new Error('STRATEGY_POLICY_CHANGED');
            const context = await client.status();
            if (context.vault.active_session !== sessionId || !context.reusable || !Object.keys(await client.sessionHeaders()).length) {
              throw new Error('COPY_AUTHORITY_EXPIRED');
            }
            if (entry.signalId && !await checkSignalBeforeExecution(entry, active, client)) throw new Error('SIGNAL_NOT_RELEASED');
            checkAge(entry, current);
            if (veto && await honorVeto(agent, state.pending[id])) throw new Error('OWNER_VETO');
            state.pending[id].status = 'submitting';
          }, lockOptions);
        } finally { await client.dispose(); }
      },
    });
    return await saveResult(agent, id, result, entry.publisher);
  } catch (error) {
    await withAgentState(agent, state => {
      const item = state.pending?.[id];
      if (item?.status === preparing) item.status = 'skipped';
      else if (item?.status === 'submitting') item.status = error.confirmedFailure ? 'failed' : 'reconcile-wallet';
      strategyHistory(state, { type: 'strategy', activity: entry.activity, actionId: id,
        status: item?.status ?? 'error', reason: error.message });
    }, lockOptions).catch(() => {});
    throw error;
  }
}
