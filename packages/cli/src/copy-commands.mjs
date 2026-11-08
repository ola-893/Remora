import { ownerVaultAction } from './owner-actions.mjs';
import { resolve } from 'node:path';
import { readAgentState, withAgentState, agentSetupState, createAgent, listAgents, selectAgent } from './agents.mjs';
import { initProject } from './config.mjs';
import { activities, executionPolicy, spot, spotOrder } from './copy-activity.mjs';
import { activityBlocker, activityMode, nativeWalletActivities, strategyActivities, strategyPolicy } from './strategy-actions.mjs';
import { approveStrategy, runStrategyTask } from './strategy-runtime.mjs';
import { paperSeed } from './paper-trading.mjs';
import { intentsConfig } from './copy-intents.mjs';
import { configurePublish, getListing, originOf, publicationHistory, subscribers } from './copy-feed.mjs';
import { changeMode, decideAction, previewCopy, reconcileCopy, runCopyAgent, runSpotTask, startCopy, stopCopy } from './copy-runtime.mjs';
import { settings, setLimits, setRuntime, reconcileLimits, usdc, durationSeconds } from './settings.mjs';
import { setupTestnet } from './setup.mjs';
import { payout, reconcilePayouts } from './vault-money.mjs';
import { readKey } from '@ola-893/agentstreams-core/internal-config';
import { inspectNearProfile, NearAgentStreamsClient } from '@ola-893/agentstreams-core/near';

export const copyFlags = {
  'agent:create': '', 'agent:list': '', 'agent:use': '', 'agent:show': '',
  'agent:setup': 'network deployment owner-id owner-key recipient vault-name agent-name rpc service deploy resume no-open',
  'task:list': '', 'task:enable': 'paper-balances intents-agent-id intents-key-env intents-grant-env live confidential', 'task:disable': '', 'task:portfolio': '',
  'task:run': 'from to amount-raw action-json execute no-open',
  'publish:set': 'activities url port rate duration recipient nova-group nova-account nova-network nova-key-env performance-file',
  'publish:start': '', 'publish:stop': '', 'publish:status': '', 'publish:history': '',
  'earnings:show': '', 'earnings:claim': 'from recipient-key', discover: 'activity url id',
  'copy:preview': 'url', 'copy:start': 'url activity', 'copy:mode': '', 'copy:pending': '', 'copy:approve': 'no-open', 'copy:reject': '',
  'copy:pause': '', 'copy:resume': '', 'copy:stop': '', 'copy:status': '', 'copy:history': '',
  'guard:show': '', 'guard:set': 'activity targets max-inputs copy-bps budget max-stream max-rate max-duration recipient owner-key max-5xx max-transport-errors max-health-failures idle-timeout max-requests reuse poll-seconds close-on-exit failure-cooldown assets input-asset max-input-raw copy-input-raw max-age max-slippage-bps max-notional stale-seconds feed-failures',
  withdraw: 'owner-key no-open', 'agent:withdraw': 'owner-key no-open', 'stream:top-up': 'owner-key no-open', balance: '', status: '',
};

export const copyPositionals = new Set(['agent:withdraw', 'stream:top-up', 'agent:create', 'agent:use', 'agent:show', 'task:enable', 'task:disable', 'task:run', 'copy:start', 'copy:mode', 'copy:approve', 'copy:reject', 'guard:set']);
const paymentLimits = { budget: 'budget', 'max-stream': 'max_deposit', 'max-rate': 'max_rate', 'max-duration': 'max_duration_seconds', recipient: 'recipients' };
const runtimeLimits = { 'max-5xx': 'maxConsecutive5xx', 'max-transport-errors': 'maxConsecutiveTransportErrors', 'max-health-failures': 'maxConsecutiveHealthFailures', 'idle-timeout': 'idleTimeoutSeconds', 'max-requests': 'maxRequestsPerStream', 'poll-seconds': 'healthPollSeconds', 'failure-cooldown': 'failureCooldownSeconds', reuse: 'reuseStream', 'close-on-exit': 'closeOnExit' };
const strategyFlags = ['targets', 'max-inputs', 'copy-bps', 'assets', 'max-age', 'max-slippage-bps'];
const executionFlags = 'assets input-asset max-input-raw copy-input-raw max-age max-slippage-bps max-notional'.split(' ');

function positive(value, max = 3600) {
  const n = Number(value);
  if (!/^\d+$/.test(value ?? '') || !Number.isInteger(n) || n < 1 || n > max) throw new Error(`Use an integer from 1 to ${max}.`);
  return n;
}

async function guard(agent, scope, flags, provided) {
  const payment = Object.keys(paymentLimits), runtime = Object.keys(runtimeLimits);
  const selectedActivity = flags.activity ?? spot;
  const guardFlags = selectedActivity === spot ? executionFlags : strategyFlags;
  const accepted = { payment: [...payment, ...runtime, 'owner-key'], execution: ['activity', ...guardFlags], feed: ['stale-seconds', 'feed-failures'] }[scope];
  if (!accepted) throw new Error('Use guard set payment, execution or feed.');
  for (const flag of provided) if (!accepted.includes(flag)) throw new Error(`--${flag} does not apply to the ${scope} guard.`);
  if (!provided.length) throw new Error('Supply at least one guardrail. See --help.');
  return withAgentState(agent, async state => {
    if (scope === 'execution') {
      if (!provided.some(flag => guardFlags.includes(flag))) throw new Error('Supply at least one execution guardrail.');
      if (selectedActivity === spot) return { activity: spot, execution: state.executionPolicy = executionPolicy(flags, state.executionPolicy) };
      if (!strategyActivities.has(selectedActivity)) throw new Error('Unknown activity.');
      if (!nativeWalletActivities.has(selectedActivity)) throw new Error(activityBlocker);
      const policies = state.strategyPolicies ??= {};
      policies[selectedActivity] = strategyPolicy(selectedActivity, flags, policies[selectedActivity]);
      return { activity: selectedActivity, execution: policies[selectedActivity] };
    }
    if (scope === 'feed') {
      const prior = state.feedGuard ?? { staleSeconds: 45, failures: 3 };
      return { feed: state.feedGuard = {
        staleSeconds: flags['stale-seconds'] ? positive(flags['stale-seconds']) : prior.staleSeconds,
        failures: flags['feed-failures'] ? positive(flags['feed-failures'], 100) : prior.failures,
      } };
    }
    const financial = {}, local = {};
    for (const flag of payment.filter(k => flags[k] !== undefined)) {
      financial[paymentLimits[flag]] = flag === 'recipient' ? flags[flag].split(',') : flag === 'max-duration' ? durationSeconds(flags[flag]) : usdc(flags[flag]);
    }
    for (const flag of runtime.filter(k => flags[k] !== undefined)) {
      if (['reuse', 'close-on-exit'].includes(flag)) {
        if (!['true', 'false'].includes(flags[flag])) throw new Error(`Use true or false for --${flag}.`);
        local[runtimeLimits[flag]] = flags[flag] === 'true';
      } else local[runtimeLimits[flag]] = positive(flags[flag], 1000000);
    }
    if (Object.keys(financial).length && Object.keys(local).length) throw new Error('Set on-chain limits and local runtime thresholds in separate commands.');
    if (Object.keys(financial).length) return setLimits(agent.path, financial, flags['owner-key']);
    return setRuntime(agent.path, local);
  });
}

async function vaultBalance(project) {
  const { profile, config } = await settings(project);
  const { client } = await inspectNearProfile(profile.configPath, profile.stateRoot);
  const [vault, ownerWallet] = await Promise.all([client.getVault(), client.tokenBalance(config.ownerId, config.tokenId)]);
  return { network: config.network, vaultId: config.vaultId, units: 'raw USDC (1 USDC = 1000000)', ownerWallet, vault };
}

async function earnings(agent, action, flags) {
  const items = await subscribers(agent);
  if (action === 'show') {
    const sessions = await Promise.all(items.map(async item => {
      const client = new NearAgentStreamsClient({ rpcUrl: item.rpcUrl, vaultId: item.vaultId });
      const stream = await client.getStream(item.sessionId);
      return { vaultId: item.vaultId, sessionId: item.sessionId, recipient: item.recipient, stream };
    }));
    const vaults = await Promise.all([...new Map(items.map(item => [`${item.vaultId}:${item.recipient}`, item])).values()].map(async item => {
      const client = new NearAgentStreamsClient({ rpcUrl: item.rpcUrl, vaultId: item.vaultId });
      return { vaultId: item.vaultId, recipient: item.recipient, claimableRawUSDC: await client.getClaim(item.recipient) };
    }));
    return { network: 'testnet', sessions, vaults };
  }
  const item = items.find(sub => sub.vaultId === flags.from);
  if (!item || !flags['recipient-key']) throw new Error('Use earnings claim --from a vault listed by earnings show --recipient-key PATH.');
  const recipient = await readKey(resolve(flags['recipient-key']));
  if (!items.some(sub => sub.vaultId === item.vaultId && sub.recipient === recipient.accountId)) throw new Error('RECIPIENT_CREDENTIAL_MISMATCH');
  const client = new NearAgentStreamsClient({ vaultId: item.vaultId, rpcUrl: item.rpcUrl, accountId: recipient.accountId, privateKey: recipient.privateKey });
  if (BigInt(await client.getClaim(recipient.accountId)) === 0n) return { reason: 'NOTHING_CLAIMABLE' };
  return payout(agent, client, 'claim');
}

export async function runCopyCommand(command, p, v, workspace, agent, emit, provided) {
  const arg = p[2];
  switch (command) {
    case 'agent:create': return createAgent(workspace, arg);
    case 'agent:list': return listAgents(workspace);
    case 'agent:use': if (!arg) throw new Error('Supply an agent name.'); return selectAgent(workspace, arg);
    case 'stream:top-up': return ownerVaultAction(agent, agent?.path ?? workspace, p[2], v['owner-key'], { topUp: true, noOpen: v['no-open'] });
    case 'balance': return vaultBalance(agent?.path ?? workspace);
    case 'withdraw': return ownerVaultAction(agent, agent?.path ?? workspace, p[1], v['owner-key'], { noOpen: v['no-open'] });
    case 'agent:withdraw': return ownerVaultAction(agent, agent?.path ?? workspace, p[2], v['owner-key'], { noOpen: v['no-open'] });
  }
  if (!agent) throw new Error('Run agentstreams agent create NAME or select an existing agent.');
  const state = await readAgentState(agent);
  switch (command) {
    case 'agent:show': {
      const { path, ...identity } = agent;
      return { ...identity, setup: await agentSetupState(agent) };
    }
    case 'agent:setup': {
      if (v.network && v.network !== 'testnet') throw new Error('Only native NEAR testnet is supported.');
      if (v.deployment && v.deploy) throw new Error('Choose --deployment or --deploy.');
      if (v.deployment) return initProject(agent.path, { deployment: v.deployment });
      const suffix = agent.id.slice(3, 11);
      const result = await setupTestnet(agent.path, {
        ownerId: v['owner-id'], ownerKeyFile: v['owner-key'], recipientId: v.recipient,
        vaultLabel: provided.includes('vault-name') ? v['vault-name'] : 'v' + suffix,
        agentLabel: provided.includes('agent-name') ? v['agent-name'] : 'a' + suffix,
        rpcUrl: provided.includes('rpc') ? v.rpc : undefined, serviceUrl: v.service, deploy: v.deploy, resume: v.resume, noOpen: v['no-open'], setupCommand: 'agentstreams agent setup',
      });
      if (result.readyToDeploy === false) process.exitCode = 1;
      return result;
    }
    case 'agent:run': return runCopyAgent(agent, { once: v.once, rpc: v.rpc, emit });
    case 'task:list': return { activities: Object.entries(activities).map(([id, description]) => {
      const execution = activityMode(state, id), blocked = id !== spot && !nativeWalletActivities.has(id);
      return { id, description, status: blocked ? 'blocked' : execution ? 'enabled' : 'available',
        live: id === spot ? Boolean(state.tasks[id]?.live) : execution === 'wallet', execution,
        supportedModes: id === spot ? ['paper', 'agent-connect'] : blocked ? [] : ['wallet'],
        ...(blocked ? { reason: activityBlocker } : {}) };
    }) };
    case 'task:enable':
    case 'task:disable':
      if (!Object.hasOwn(activities, arg ?? '')) throw new Error('Choose an activity from agentstreams task list.');
      return withAgentState(agent, current => {
        if (current.tradePending) throw new Error('TRADE_RECONCILIATION_REQUIRED');
        if (command === 'task:enable') {
          if (current.follow?.status === 'active' && current.follow.mode !== 'observe') throw new Error('Switch to copy mode observe before changing execution mode.');
          if (arg !== spot) {
            if (!nativeWalletActivities.has(arg)) throw new Error(activityBlocker);
            if (provided.some(flag => flag !== 'live')) throw new Error('This activity uses a NEAR testnet browser wallet. Use task enable ACTIVITY.');
            current.tasks[arg] = { mode: 'wallet' };
          } else if (v['paper-balances'] !== undefined) {
            if (provided.some(flag => flag !== 'paper-balances')) throw new Error('Choose paper balances or Agent Connect options.');
            const seed = paperSeed(v['paper-balances']);
            if (current.paper && (Object.keys(current.paper.initial).length !== Object.keys(seed).length ||
                Object.entries(seed).some(([asset, amount]) => current.paper.initial[asset] !== amount))) throw new Error('This agent already has a paper portfolio. Create a new named agent to use a different starting balance.');
            current.paper ??= { initial: seed, balances: { ...seed }, fills: [] };
            current.tasks[arg] = { mode: 'paper' };
          } else {
            if (!v['intents-agent-id']) throw new Error('Provide --paper-balances ASSET=RAW for paper trading or --intents-agent-id ID for Agent Connect.');
            current.tasks[arg] = intentsConfig(v);
          }
        }
        else { delete current.tasks[arg]; if (current.follow?.listing.activity === arg) current.follow.mode = 'observe'; }
        return { activity: arg, enabled: Boolean(current.tasks[arg]), config: current.tasks[arg] ?? null };
      });
    case 'task:portfolio': return { mode: 'paper', portfolio: state.paper ?? null };
    case 'task:run':
      if (arg === spot) {
        if (v['action-json'] !== undefined || v['no-open']) throw new Error('Spot trading uses --from, --to and --amount-raw.');
        return runSpotTask(agent, spotOrder({ from: v.from, to: v.to, amount: v['amount-raw'] }), v.execute);
      }
      if (!strategyActivities.has(arg)) throw new Error('Choose an activity from agentstreams task list.');
      if (!nativeWalletActivities.has(arg)) throw new Error(activityBlocker);
      if (v.from || v.to || v['amount-raw'] || typeof v['action-json'] !== 'string' || v['action-json'].length > 8192) throw new Error('Use task run ACTIVITY --action-json JSON [--execute].');
      return runStrategyTask(agent, arg, JSON.parse(v['action-json']), { execute: v.execute, noOpen: v['no-open'] });
    case 'publish:set':
      return configurePublish(agent, { ...v, port: provided.includes('port') ? v.port : undefined, recipient: v.recipient ?? (await agentSetupState(agent)).ownerId });
    case 'publish:start':
    case 'publish:stop':
      return withAgentState(agent, current => {
        if (!current.publish) throw new Error('Configure publish set first.');
        current.publish.enabled = command === 'publish:start';
        return { enabled: current.publish.enabled, id: agent.id, origin: current.publish.origin, ...(current.publish.enabled ? { next: 'Run agentstreams agent run to serve the listing and gated journal.' } : {}) };
      });
    case 'publish:status': return { agentId: agent.id, publication: state.publish ?? null, entries: state.journal?.length ?? 0 };
    case 'publish:history': return publicationHistory(agent);
    case 'earnings:show': return earnings(agent, 'show', v);
    case 'earnings:claim': return earnings(agent, 'claim', v);
    case 'discover': {
      if (v.activity && !Object.hasOwn(activities, v.activity)) throw new Error('Unknown activity.');
      if (Boolean(v.id) !== Boolean(v.url)) throw new Error('Provide --id and --url together to verify and remember a publisher.');
      if (v.url) {
        const listing = await getListing(v.id, originOf(v.url));
        await withAgentState(agent, current => { current.directory[listing.id] = listing.origin; });
        return { listings: !v.activity || v.activity === listing.activity ? [listing] : [] };
      }
      const results = await Promise.allSettled(Object.entries(state.directory).map(([id, origin]) => getListing(id, origin)));
      const ids = Object.keys(state.directory);
      return { listings: results.flatMap(item => item.status === 'fulfilled' && (!v.activity || item.value.activity === v.activity) ? [item.value] : []), unavailable: results.flatMap((item, i) => item.status === 'rejected' ? [ids[i]] : []) };
    }
    case 'copy:preview': return previewCopy(agent, p[1], v.url);
    case 'copy:start': if (!arg) throw new Error('Supply a publisher agent ID.'); return startCopy(agent, { id: arg, url: v.url, activity: v.activity });
    case 'copy:resume': return startCopy(agent, { resume: true });
    case 'copy:pause': return stopCopy(agent, 'paused');
    case 'copy:stop': return stopCopy(agent, 'stopped');
    case 'copy:mode': return changeMode(agent, arg);
    case 'copy:approve':
      if (strategyActivities.has(state.pending?.[arg]?.action.activity)) return approveStrategy(agent, arg, { noOpen: v['no-open'] });
      if (v['no-open']) throw new Error('--no-open applies to NEAR testnet activity wallet approval.');
      return decideAction(agent, arg, 'approved');
    case 'copy:reject': return decideAction(agent, arg, 'rejected');
    case 'copy:status': return { subscription: state.follow ?? null, tradePending: Boolean(state.tradePending) };
    case 'copy:pending': return { actions: Object.values(state.pending ?? {}).filter(item => item.sessionId === state.follow?.sessionId && item.status === 'pending' && item.action.expiresAt > Date.now()) };
    case 'copy:history': return { history: state.history };
    case 'guard:set': return guard(agent, arg, v, provided);
    case 'guard:show': {
      const setup = await agentSetupState(agent);
      return { payment: setup.configured ? await vaultBalance(agent.path).then(x => x.vault.policy) : null, runtime: setup.configured ? (await settings(agent.path)).config.runtimePolicy : null, execution: state.executionPolicy ?? null, strategyExecution: state.strategyPolicies ?? {}, feed: state.feedGuard ?? { staleSeconds: 45, failures: 3 } };
    }
    case 'status': return { name: agent.name, id: agent.id, setup: await agentSetupState(agent), publicationEnabled: Boolean(state.publish?.enabled), subscription: state.follow ?? null, pendingTrade: Boolean(state.tradePending), lastRun: state.lastRun ?? null, lastActivity: state.history.findLast(item => item.type === 'strategy') ?? null,
      paper: state.paper ? { balances: state.paper.balances, recentFills: state.paper.fills.length, lastFill: state.paper.fills.at(-1)?.id ?? null } : null };
    case 'reconcile': {
      const copy = await reconcileCopy(agent);
      const payouts = await reconcilePayouts(agent);
      if (!(await agentSetupState(agent)).configured) return { resolved: copy.resolved && payouts.resolved, copy, payouts };
      const { gatewayFor } = await import('./config.mjs');
      const client = await gatewayFor(agent.path);
      try {
        const payment = await client.reconcile();
        const policy = await reconcileLimits(agent.path);
        return { resolved: copy.resolved && payment.resolved && policy.resolved && payouts.resolved, copy, payment, policy, payouts };
      } finally { await client.dispose(); }
    }
    default: throw new Error('Unknown command. Run agentstreams --help.');
  }
}
