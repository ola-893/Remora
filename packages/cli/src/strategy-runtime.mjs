import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { operationKey } from './copy-activity.mjs';
import { gatewayFor } from './config.mjs';
import { agentSetupState, readAgentState, withAgentState } from './agents.mjs';
import { appendStrategyAction } from './copy-feed.mjs';
import { prepareRangeDeposit, runWalletStrategy } from './strategy-wallet.mjs';
import { activityBlocker, enforceStrategyPolicy, nativeWalletActivities, sizedStrategyAction, strategyAction } from './strategy-actions.mjs';

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

async function saveResult(agent, id, result, copiedFrom) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withAgentState(agent, async state => {
        const at = Date.now();
        const entry = { id, activity: result.activity, action: result.action, execution: 'wallet', at, expiresAt: at + 120000,
          settlementRef: result.receipt.hash, ...(copiedFrom ? { copiedFrom } : {}) };
        const publication = await appendStrategyAction(agent, state, entry).catch(error => ({ error: error.message }));
        if (copiedFrom && state.pending?.[id]) state.pending[id].status = result.status;
        strategyHistory(state, { type: 'strategy', activity: result.activity, status: result.status, actionId: id,
          transactionHash: result.receipt.hash, ...(copiedFrom ? { publisher: copiedFrom } : {}), publication });
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
  const result = await runWalletStrategy(activity, action, policy, { ...options, ownerId, operationId: id,
    orderClientId: orderClientId(agent, activity, action, id),
    authorize: async inputs => {
      options.signal?.throwIfAborted();
      const current = strategyPolicyFor(await readAgentState(agent), activity);
      enforceStrategyPolicy(activity, action, current, inputs);
      if (JSON.stringify(current) !== JSON.stringify(policy)) throw new Error('STRATEGY_POLICY_CHANGED: run a new preview.');
    },
  });
  return options.execute ? saveResult(agent, id, result) : result;
}

export async function prepareStrategyDeposit(agent, action, { execute } = {}) {
  const activity = 'liquidity-ranges';
  const policy = strategyPolicyFor(await readAgentState(agent), activity);
  const { ownerId } = await agentSetupState(agent);
  return prepareRangeDeposit(action, policy, { execute, ownerId, authorize: async inputs => {
    const current = strategyPolicyFor(await readAgentState(agent), activity);
    enforceStrategyPolicy(activity, action, current, inputs);
    if (JSON.stringify(current) !== JSON.stringify(policy)) throw new Error('STRATEGY_POLICY_CHANGED: run a new preview.');
  } });
}

function checkAge(entry, policy, now = Date.now()) {
  if (entry.at > now + 5000 || now >= entry.expiresAt || (policy && now - entry.at > policy.maxAge * 1000)) throw new Error('ACTION_EXPIRED');
}

export async function observeStrategy(agent, state, entry, emit) {
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
    if (follow.mode !== 'approve') return record('observed', { action: entry.action, transactionHash: entry.settlementRef });
    const policy = strategyPolicyFor(state, activity);
    const action = sizedStrategyAction(activity, entry.action, policy);
    const { ownerId } = await agentSetupState(agent);
    const checked = await runWalletStrategy(activity, action, policy, { ownerId,
      orderClientId: orderClientId(agent, activity, action, id, entry.publisher) });
    const preview = { action, inputs: checked.inputs, evidence: checked.evidence, transactionHash: entry.settlementRef };
    (state.pending ??= {})[id] = { status: 'pending', action: entry, preview, sessionId: follow.sessionId };
    return record('pending', preview);
  } catch (error) {
    return record('skipped', { reason: error.message });
  }
}

export async function approveStrategy(agent, id) {
  const prepared = await withAgentState(agent, state => {
    const { follow } = state, item = state.pending?.[id];
    if (follow?.status !== 'active' || follow.mode !== 'approve' || item?.status !== 'pending' ||
        item.sessionId !== follow.sessionId || item.action.activity !== follow.listing.activity) {
      throw new Error('Action is not pending for the active subscription.');
    }
    const policy = strategyPolicyFor(state, item.action.activity);
    checkAge(item.action, policy);
    item.status = 'awaiting-wallet';
    return { entry: item.action, sessionId: item.sessionId, policy };
  });
  const { entry, sessionId, policy } = prepared;
  try {
    const action = sizedStrategyAction(entry.activity, entry.action, policy);
    const { ownerId } = await agentSetupState(agent);
    const result = await runWalletStrategy(entry.activity, action, policy, { execute: true, operationId: id, ownerId,
      orderClientId: orderClientId(agent, entry.activity, action, id, entry.publisher),
      authorize: async inputs => {
        const client = await gatewayFor(agent.path);
        try {
          await withAgentState(agent, async state => {
            const current = strategyPolicyFor(state, entry.activity);
            const active = state.follow;
            if (active?.status !== 'active' || active.sessionId !== sessionId || active.mode !== 'approve' ||
                state.pending?.[id]?.status !== 'awaiting-wallet') throw new Error('COPY_AUTHORITY_EXPIRED');
            checkAge(entry, current);
            enforceStrategyPolicy(entry.activity, action, current, inputs);
            if (JSON.stringify(current) !== JSON.stringify(policy)) throw new Error('STRATEGY_POLICY_CHANGED');
            const context = await client.status();
            if (context.vault.active_session !== sessionId || !context.reusable || !Object.keys(await client.sessionHeaders()).length) {
              throw new Error('COPY_AUTHORITY_EXPIRED');
            }
            checkAge(entry, current);
            state.pending[id].status = 'submitting';
          });
        } finally { await client.dispose(); }
      },
    });
    return await saveResult(agent, id, result, entry.publisher);
  } catch (error) {
    await withAgentState(agent, state => {
      const item = state.pending?.[id];
      if (item?.status === 'awaiting-wallet') item.status = 'skipped';
      else if (item?.status === 'submitting') item.status = error.confirmedFailure ? 'failed' : 'reconcile-wallet';
      strategyHistory(state, { type: 'strategy', activity: entry.activity, actionId: id,
        status: item?.status ?? 'error', reason: error.message });
    }).catch(() => {});
    throw error;
  }
}
