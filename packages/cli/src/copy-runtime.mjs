import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { assessQuote } from '@ola-893/agentstreams-core';
import { gatewayFor } from './config.mjs';
import { settings, setService } from './settings.mjs';
import { agentSetupState, readAgentState, withAgentState } from './agents.mjs';
import { checkQuote, operationKey, proposedOrder, rawAmount, spot } from './copy-activity.mjs';
import { paperBalances, paperFill, paperQuote } from './paper-trading.mjs';
import { credential, intentsAdapter, minimumOutput } from './copy-intents.mjs';
import { nativeWalletActivities } from './strategy-actions.mjs';
import { observeStrategy } from './strategy-runtime.mjs';
import { appendFill, checkListingQuote, fetchFeed, feedPath, getListing, healthPath, originOf, quotePath, readJsonResponse, serveFeed, verifyPage } from './copy-feed.mjs';

const addHistory = (state, item) => {
  state.history.push({ at: new Date().toISOString(), ...item });
  if (state.history.length > 500) state.history.shift();
};

function current(state) {
  if (!state.follow) throw new Error('No copy subscription. Run agentstreams copy start first.');
  return state.follow;
}

async function gateway(agent, work) {
  const client = await gatewayFor(agent.path);
  try { return await work(client); }
  finally { await client.dispose(); }
}

async function offer(agent, state, id, url) {
  if (id === agent.id) throw new Error('Choose another agent to copy.');
  const source = url ?? state.directory[id];
  if (!source) throw new Error('Supply --url with the publisher’s feed origin on first lookup.');
  return getListing(id, originOf(source));
}

async function readQuote(listing, config) {
  const quote = await fetchFeed(listing.origin, `${quotePath(config.vaultId)}?tier=basic`);
  return { quote, hash: checkListingQuote(listing, config.vaultId, config.tokenId, quote) };
}

export async function previewCopy(agent, id, url) {
  const state = await readAgentState(agent);
  const listing = await offer(agent, state, id, url);
  let maxEscrowRawUSDC = listing.duration === 0 ? null : (BigInt(listing.rate) * BigInt(listing.duration)).toString();
  let admission = { decision: 'DENY', reason: 'VAULT_SETUP_REQUIRED' };
  if ((await agentSetupState(agent)).configured) {
    const { config } = await settings(agent.path);
    admission = await gateway(agent, async client => {
      const [{ vault }, { quote }, health] = await Promise.all([client.status(), readQuote(listing, config), fetchFeed(listing.origin, healthPath)]);
      if (listing.duration === 0) maxEscrowRawUSDC = vault.policy.max_deposit;
      return assessQuote({ vault: { ...vault, vault_id: config.vaultId }, quote, health });
    });
  }
  return { listing, maxEscrowRawUSDC, admission, signedTransactions: 0, next: 'agentstreams copy start ' + id + ' --url ' + listing.origin };
}

async function openCopy(agent, state, save, listing, mode) {
  const { profile, config } = await settings(agent.path);
  if (!profile.paymentsEnabled) throw new Error('PAYMENTS_DISABLED: run agentstreams payments --enable after checking the subscription limits.');
  const { hash, quote } = await readQuote(listing, config);
  if (!config.runtimePolicy.reuseStream) throw new Error('Enable reuse with agentstreams config set --reuse true.');
  await setService(agent.path, { url: listing.origin, recipient: listing.recipient, healthPath, quotePath: quotePath(config.vaultId, quote.expires_at), requestPath: feedPath, tiers: ['basic'] });
  return gateway(agent, async client => {
    const checked = await client.check({ tier: 'basic', expectedQuoteHash: hash });
    if (checked.decision !== 'OPEN') throw new Error(checked.reason ?? 'COPY_OPEN_DENIED');
    state.directory[listing.id] = listing.origin;
    state.follow = { listing, status: 'opening', mode, cursor: state.cursors?.[listing.id] ?? 0, failures: 0, startedAt: Date.now() };
    await save();
    const opened = await client.open({ approvalId: checked.approvalId });
    Object.assign(state.follow, { status: 'active', sessionId: opened.sessionId, openHash: opened.receipt.hash });
    return { ...state.follow, payment: opened.receipt, explorerUrl: `https://testnet.nearblocks.io/txns/${opened.receipt.hash}` };
  });
}

export async function startCopy(agent, { id, url, activity, resume = false }) {
  return withAgentState(agent, async (state, save) => {
    const follow = state.follow;
    if (resume ? follow?.status !== 'paused' : ['active', 'opening', 'closing'].includes(follow?.status)) throw new Error('Resolve or close the current subscription before opening another.');
    const listing = await offer(agent, state, resume ? follow.listing.id : id, resume ? follow.listing.origin : url);
    if (activity && listing.activity !== activity) throw new Error('PUBLISHER_ACTIVITY_MISMATCH');
    if (resume && ['recipient', 'rate', 'duration', 'activity'].some(field => follow.listing[field] !== listing[field])) throw new Error('Offer changed. Preview it and start a new subscription to accept new terms.');
    return openCopy(agent, state, save, listing, 'observe');
  });
}

async function closeCopy(agent, state, save, status, reason, client) {
  const follow = current(state);
  if (!['active', 'opening', 'closing'].includes(follow.status)) {
    follow.status = status;
    return follow;
  }
  follow.status = 'closing';
  follow.closeTarget = status;
  follow.reason = reason;
  await save();
  const close = async activeClient => {
    const context = await activeClient.status();
    if (context.vault.active_session && (!context.reusable || (follow.sessionId && context.vault.active_session !== follow.sessionId))) throw new Error('ACTIVE_SESSION_RECOVERY_REQUIRED');
    return context.vault.active_session ? activeClient.close({ sessionId: context.vault.active_session }) : { alreadyClosed: true };
  };
  const result = client ? await close(client) : await gateway(agent, close);
  follow.status = status;
  follow.closeHash = result.receipt?.hash ?? null;
  for (const item of Object.values(state.pending ?? {})) {
    if (['pending', 'approved', 'awaiting-wallet'].includes(item.status)) item.status = 'cancelled';
  }
  addHistory(state, { type: 'subscription', status, reason, sessionId: follow.sessionId, transactionHash: follow.closeHash });
  return { ...follow, ...(result.receipt ? { receipt: result.receipt, explorerUrl: `https://testnet.nearblocks.io/txns/${result.receipt.hash}` } : {}) };
}

export async function stopCopy(agent, status, reason = 'OPERATOR_REQUEST') {
  return withAgentState(agent, (state, save) => closeCopy(agent, state, save, status, reason));
}

export async function changeMode(agent, mode) {
  if (!['observe', 'approve', 'auto'].includes(mode)) throw new Error('Choose observe, approve or auto.');
  return withAgentState(agent, state => {
    const follow = current(state);
    if (follow.status !== 'active') throw new Error('Subscription is not active.');
    const activity = follow.listing.activity, task = state.tasks[activity];
    const canExecute = activity === spot ? Boolean((task?.live || task?.mode === 'paper') && state.executionPolicy) :
      Boolean(nativeWalletActivities.has(activity) && task?.mode === 'wallet' && state.strategyPolicies?.[activity]);
    if (mode === 'auto' && activity !== spot) throw new Error('NEAR_WALLET_APPROVAL_REQUIRED: use copy mode approve.');
    if (mode !== 'observe' && !canExecute) throw new Error('Enable execution and set an activity execution guard first.');
    if (mode !== 'approve') for (const item of Object.values(state.pending ?? {})) {
      if (['pending', 'approved', 'awaiting-wallet'].includes(item.status)) item.status = 'cancelled';
    }
    follow.mode = mode;
    return { mode, sessionId: follow.sessionId };
  });
}

export async function decideAction(agent, id, decision) {
  return withAgentState(agent, state => {
    const follow = current(state);
    const item = state.pending?.[id];
    if (follow.status !== 'active' || !item || item.sessionId !== follow.sessionId || item.status !== 'pending') throw new Error('Action is not pending for the active subscription.');
    if (decision === 'approved' && follow.mode !== 'approve') throw new Error('Use copy mode approve before approving actions.');
    if (Date.now() >= item.action.expiresAt) throw new Error('ACTION_EXPIRED');
    item.status = decision;
    addHistory(state, { type: 'decision', actionId: id, status: decision });
    return { actionId: id, status: decision };
  });
}

async function executeSwap(agent, state, save, adapter, order, record) {
  if (state.tradePending) throw new Error('TRADE_RECONCILIATION_REQUIRED');
  credential(state.tasks[spot].grantEnv);
  const key = operationKey(agent.id, record.id);
  state.tradePending = { ...record, order, key, createdAt: Date.now() };
  await save();
  const first = await adapter.execute(order, key);
  if (first.correlation_id) {
    state.tradePending.correlationId = first.correlation_id;
    await save();
  }
  return finishSwap(agent, state, save, await adapter.settle(first, order));
}

async function finishSwap(agent, state, save, result) {
  const trade = state.tradePending;
  if (!result.final) return { status: result.status, correlationId: result.correlationId, reconciliationRequired: true };
  if (result.status === 'SUCCESS') {
    const fill = result.details;
    if (!rawAmount(fill?.amount_out)) throw new Error('SETTLED_OUTPUT_MISSING: reconcile the recorded trade before another execution.');
    if (!trade.settled) {
      const at = result.updatedAt;
      trade.settled = { id: trade.id, at, expiresAt: at + 60000, from: trade.order.origin_asset, to: trade.order.destination_asset, amountIn: trade.order.amount, amountOut: fill.amount_out,
        execution: 'agent-connect', settlementRef: fill.tx_hash ?? fill.destination_tx_hash ?? result.correlationId, ...(trade.source ? { copiedFrom: trade.source } : {}) };
      await save();
    }
    const publication = await appendFill(agent, state, trade.settled);
    addHistory(state, { type: 'trade', status: result.status, actionId: trade.id, correlationId: result.correlationId, publication });
  } else addHistory(state, { type: 'trade', status: result.status, actionId: trade.id, correlationId: result.correlationId });
  if (state.pending?.[trade.id]) state.pending[trade.id].status = result.status.toLowerCase();
  state.tradePending = null;
  return { status: result.status, correlationId: result.correlationId, amountOut: result.details?.amount_out ?? null, transactionHash: result.details?.tx_hash ?? null };
}

async function recordPaper(agent, state, order, quote, id, copiedFrom) {
  const balances = paperBalances(state.paper, order, quote);
  const fill = paperFill(order, quote, id, copiedFrom);
  const publication = await appendFill(agent, state, fill);
  state.paper.balances = balances;
  const evidence = { ...fill, quote: quote.signedResponse };
  state.paper.fills = [...state.paper.fills.slice(-99), evidence];
  if (state.pending?.[id]) state.pending[id].status = 'paper-filled';
  addHistory(state, { type: 'trade', status: 'paper-filled', execution: 'paper', actionId: id, publication });
  return { status: 'paper-filled', mode: 'paper', fill, balances, publication, signedTransactions: 0 };
}

export async function runSpotTask(agent, order, execute, { requirePaper = false, referenceQuote } = {}) {
  return withAgentState(agent, async (state, save) => {
    const config = state.tasks[spot];
    if (!config) throw new Error('Enable spot-trading with paper balances or an Agent Connect account first.');
    const p = state.executionPolicy;
    const paper = config.mode === 'paper';
    if (requirePaper && !paper) throw new Error('PAPER_TRADING_REQUIRED');
    if (execute && !paper && !config.live) throw new Error('INTENTS_LIVE_DISABLED');
    if ((execute || requirePaper) && (!p || order.origin_asset !== p.inputAsset || !p.assets.includes(order.destination_asset) ||
        BigInt(order.amount) > BigInt(p.maxInput))) throw new Error('ORDER_OUTSIDE_EXECUTION_POLICY');
    if (referenceQuote && Date.now() - Date.parse(referenceQuote.observedAt) > 30000) throw new Error('TRADE_PREVIEW_STALE');
    const adapter = paper ? null : intentsAdapter(config);
    const quote = paper ? await paperQuote(order, p?.slippageBps ?? 50) : await adapter.quote(order);
    if (!execute) return { mode: 'preview', execution: paper ? 'paper' : 'agent-connect', quote, signedTransactions: 0 };
    const refusal = checkQuote(quote, order, referenceQuote ?? quote, p);
    if (refusal || quote.warnings.length) throw new Error(refusal ?? 'INTENTS_QUOTE_WARNING');
    const id = operationKey(agent.id, randomUUID());
    if (paper) return recordPaper(agent, state, order, quote, id);
    const min = minimumOutput(quote, order, p);
    return executeSwap(agent, state, save, adapter, { ...order, min_amount_out: min }, { id });
  });
}

export async function reconcileCopy(agent) {
  return withAgentState(agent, async (state, save) => {
    const report = {};
    if (state.tradePending) {
      const trade = state.tradePending;
      if (!trade.correlationId) report.trade = { resolved: false, reason: 'CORRELATION_ID_UNKNOWN', idempotencyKey: trade.key };
      else {
        const adapter = intentsAdapter(state.tasks[spot]);
        report.trade = await finishSwap(agent, state, save, await adapter.settle(await adapter.status(trade.correlationId), trade.order, { attempts: 0 }));
      }
    }
    if (['opening', 'closing'].includes(state.follow?.status)) {
      await gateway(agent, async client => {
        report.payment = await client.reconcile();
        if (!report.payment.resolved) return;
        const { vault, reusable } = await client.status();
        if (state.follow.status === 'opening' && vault.active_session && reusable) Object.assign(state.follow, { status: 'active', sessionId: vault.active_session });
        else if (!vault.active_session) state.follow.status = state.follow.closeTarget ?? 'paused';
        else report.payment = { resolved: false, reason: 'ACTIVE_SESSION_RECOVERY_REQUIRED' };
      });
    }
    return { resolved: !state.tradePending && !['opening', 'closing'].includes(state.follow?.status), ...report };
  });
}

async function observeAction(agent, state, save, action, emit, client, approved = false) {
  if (action.activity !== spot) return observeStrategy(agent, state, action, emit);
  const follow = current(state), policy = state.executionPolicy;
  const result = proposedOrder(action, policy);
  const record = data => {
    const item = { type: 'action', actionId: action.id, sequence: action.sequence, publisher: action.publisher, ...data };
    addHistory(state, item);
    emit(item);
  };
  if (result.reason) {
    if (approved) state.pending[action.id].status = 'skipped';
    return record({ status: 'skipped', reason: result.reason, action });
  }
  if (action.copiedFrom) {
    if (approved) state.pending[action.id].status = 'skipped';
    return record({ status: 'skipped', reason: 'COPIED_ACTION', action });
  }
  const config = state.tasks[spot];
  if (!config) return record({ status: 'observed', reason: 'INTENTS_ADAPTER_REQUIRED', order: result.order, action });
  const paper = config.mode === 'paper';
  if (!paper && action.execution === 'paper' && follow.mode !== 'observe') {
    if (approved) state.pending[action.id].status = 'skipped';
    return record({ status: 'skipped', reason: 'PAPER_ACTION_REQUIRES_PAPER_EXECUTOR' });
  }
  const adapter = paper ? null : intentsAdapter(config);
  const quote = paper ? await paperQuote(result.order, policy.slippageBps) : await adapter.quote(result.order);
  const { signedResponse, ...summary } = quote;
  const reason = checkQuote(quote, result.order, action, policy) || (quote.warnings.length ? 'INTENTS_QUOTE_WARNING' : null);
  if (reason) {
    if (approved) state.pending[action.id].status = 'skipped';
    return record({ status: 'skipped', reason, quote: summary, action });
  }
  if (follow.mode === 'observe') return record({ status: 'observed', quote: summary, order: result.order, action });
  if (follow.mode === 'approve' && !approved) {
    (state.pending ??= {})[action.id] = { status: 'pending', action, quote: summary, sessionId: follow.sessionId };
    return record({ status: 'pending', quote: summary, order: result.order });
  }
  if (!paper && (!config.live || state.tradePending)) return record({ status: 'skipped', reason: state.tradePending ? 'TRADE_RECONCILIATION_REQUIRED' : 'INTENTS_LIVE_DISABLED' });
  const context = await client.status();
  if (context.vault.active_session !== follow.sessionId || !context.reusable || !Object.keys(await client.sessionHeaders()).length || proposedOrder(action, policy).reason) {
    if (approved) state.pending[action.id].status = 'skipped';
    return record({ status: 'skipped', reason: 'COPY_AUTHORITY_EXPIRED' });
  }
  if (paper) {
    let filled;
    try { filled = await recordPaper(agent, state, result.order, quote, action.id, follow.listing.id); }
    catch (error) {
      if (!['INSUFFICIENT_PAPER_BALANCE', 'ONE_CLICK_QUOTE_STALE'].includes(error.message)) throw error;
      if (approved) state.pending[action.id].status = 'skipped';
      return record({ status: 'skipped', reason: error.message });
    }
    await save();
    return emit({ type: 'execution', actionId: action.id, ...filled });
  }
  const order = { ...result.order, min_amount_out: minimumOutput(action, result.order, policy) };
  if (approved) state.pending[action.id].status = 'executing';
  emit({ type: 'execution', actionId: action.id, ...await executeSwap(agent, state, save, adapter, order, { id: action.id, source: follow.listing.id }) });
}

export async function copyTick(agent, emit = () => {}) {
  if ((await readAgentState(agent)).follow?.status !== 'active') return;
  return withAgentState(agent, async (state, save) => {
    if (state.follow?.status !== 'active') return;
    const follow = state.follow;
    const guard = state.feedGuard ?? { staleSeconds: 45, failures: 3 };
    return gateway(agent, async client => {
      const { vault } = await client.status();
      if (vault.active_session !== follow.sessionId) return closeCopy(agent, state, save, 'paused', 'STREAM_ENDED', client);
      const checked = await client.check({ tier: 'basic' });
      if (checked.decision === 'CLOSE') return closeCopy(agent, state, save, 'paused', checked.reason, client);
      if (checked.decision !== 'CONTINUE') throw new Error(checked.reason ?? 'COPY_PAYMENT_UNAVAILABLE');
      const headers = await client.sessionHeaders();
      if (!Object.keys(headers).length) return closeCopy(agent, state, save, 'paused', 'LEASE_EXPIRED', client);
      let page;
      try {
        const response = await fetch(`${follow.listing.origin}${feedPath}?after=${follow.cursor}`, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) }).catch(async () => {
          const transport = await client.observeResult({ kind: 'transport' });
          if (transport.decision === 'CLOSE') return transport;
          throw new Error('FEED_TRANSPORT_ERROR');
        });
        if (response.decision === 'CLOSE') return closeCopy(agent, state, save, 'paused', response.reason, client);
        const observed = await client.observeResult({ kind: 'response', status: response.status });
        if (observed.decision === 'CLOSE') return closeCopy(agent, state, save, 'paused', observed.reason, client);
        if (!response.ok) throw new Error(`FEED_HTTP_${response.status}`);
        page = verifyPage(await readJsonResponse(response), follow.listing, follow.sessionId, follow.cursor, guard.staleSeconds);
      } catch (error) {
        follow.failures++;
        const stale = Date.now() - (follow.lastFeedAt ?? follow.startedAt) >= guard.staleSeconds * 1000;
        if (stale || follow.failures >= guard.failures) return closeCopy(agent, state, save, 'paused', stale ? 'FEED_STALE' : 'FEED_FAILURE_LIMIT', client);
        emit({ type: 'feed-error', reason: error.message, failures: follow.failures });
        return;
      }
      follow.lastFeedAt = Date.now();
      follow.failures = 0;
      for (const action of page.actions) {
        // Persist the cursor before any external execution. A lost reply cannot replay the order.
        follow.cursor = action.sequence;
        (state.cursors ??= {})[follow.listing.id] = action.sequence;
        const seen = state.seen ??= {};
        if (seen[action.id]) continue;
        seen[action.id] = true;
        await save();
        try { await observeAction(agent, state, save, action, emit, client); }
        catch (error) { addHistory(state, { type: 'action', actionId: action.id, status: 'error', reason: error.message }); emit({ type: 'action-error', actionId: action.id, reason: error.message }); }
      }
      follow.cursor = page.cursor;
      (state.cursors ??= {})[follow.listing.id] = page.cursor;
      if (follow.mode === 'approve') for (const item of Object.values(state.pending ?? {})) {
        if (item.status === 'approved' && item.sessionId === follow.sessionId) await observeAction(agent, state, save, item.action, emit, client, true);
      }
      return { cursor: page.cursor, received: page.actions.length };
    });
  });
}

export async function runCopyAgent(agent, { once, rpc, emit }) {
  if (once) {
    const events = [];
    const result = (await copyTick(agent, item => events.push(item))) ?? { received: 0, status: 'idle' };
    return { ...result, ...(events.length ? { events } : {}) };
  }
  const lockPath = join(agent.path, 'runner.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error(`AGENT_RUNNER_BUSY: inspect ${lockPath} for its PID.`);
    throw error;
  });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let server, listening;
  try {
    await lock.writeFile(`${process.pid}\n`);
    emit({ running: true, agentId: agent.id });
    do {
      try {
        const state = await readAgentState(agent);
        const target = state.publish?.enabled ? `${state.publish.origin}|${state.publish.port}` : null;
        if (target !== listening) {
          await server?.close();
          server = undefined;
          listening = null;
          if (target) {
            server = await serveFeed(agent, { rpcUrl: rpc });
            listening = target;
            emit({ publisher: state.publish.origin, port: server.port });
          }
        }
      } catch (error) { emit({ type: 'publisher-error', reason: error.message }); }
      try {
        const result = await copyTick(agent, emit);
        if (result?.status === 'paused') emit({ type: 'subscription', ...result });
      } catch (error) {
        emit({ type: 'runner-error', reason: error.message });
      }
      const state = await readAgentState(agent);
      const seconds = state.follow?.status === 'active' ? (await settings(agent.path)).config.runtimePolicy.healthPollSeconds : 2;
      await sleep(seconds * 1000, undefined, { signal: controller.signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
    } while (!controller.signal.aborted);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    try {
      await server?.close();
      if ((await readAgentState(agent)).follow?.status === 'active') {
        const { config } = await settings(agent.path);
        if (config.runtimePolicy.closeOnExit) emit(await stopCopy(agent, 'paused', 'RUNNER_EXIT'));
      }
    } catch (error) { emit({ type: 'closure-unconfirmed', reason: error.message }); process.exitCode = 1; }
    finally { await lock.close(); await unlink(lockPath); }
  }
}
