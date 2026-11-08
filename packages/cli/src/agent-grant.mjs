import { createHash } from 'node:crypto';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, PublicKey, actions, baseEncode, keyToImplicitAddress } from 'near-api-js';
import { configHome } from './config.mjs';
import { atomicWrite, readOptional, safeTarget } from './files.mjs';
import { connectedOwner, ownerTransaction, verifyOwnerTransaction } from './owner-wallet.mjs';
import { runSweep } from './grant-sweep.mjs';
import { DCL, EXCHANGE, LENDING, nativeWalletActivities, tokenId } from './strategy-actions.mjs';

const tokenMethods = ['ft_transfer_call', 'storage_deposit'];
const grantActivities = [...nativeWalletActivities].sort();

function count(value, max, label) {
  const n = Number(value);
  if (!/^\d+$/.test(value ?? '') || !Number.isInteger(n) || n < 1 || n > max) throw new Error(`Use --${label} from 1 to ${max}.`);
  return n;
}

function addScope(scopes, receiverId, methods) {
  const current = scopes.get(receiverId) ?? new Set();
  for (const method of methods) current.add(method);
  scopes.set(receiverId, current);
}

export function grantScopes({ activities, stakingPool, tokens = [] }) {
  const selected = [...new Set(activities ?? [])];
  if (!selected.length || selected.some(activity => !nativeWalletActivities.has(activity))) {
    throw new Error('Choose activities from: ' + grantActivities.join(', ') + '.');
  }
  const needsPool = selected.includes('staking-moves');
  const needsTokens = selected.some(activity => activity !== 'staking-moves' && activity !== 'portfolio-rebalance');
  if (needsPool && !tokenId(stakingPool)) throw new Error('Set --staking-pool to the testnet staking pool account.');
  if (!needsPool && stakingPool) throw new Error('--staking-pool applies only when staking-moves is included.');
  if (needsTokens && !tokens.length) throw new Error('Set --tokens to the testnet token contracts this grant may move.');
  if (!needsTokens && tokens.length && !selected.includes('portfolio-rebalance')) throw new Error('--tokens applies to liquidity, yield, limit orders and portfolio rebalance.');
  if (tokens.some(token => !tokenId(token))) throw new Error('Each --tokens entry must be a testnet token contract.');
  const scopes = new Map();
  for (const activity of selected) {
    if (activity === 'staking-moves') addScope(scopes, stakingPool, ['storage_deposit', 'deposit_and_stake', 'unstake', 'withdraw']);
    if (activity === 'portfolio-rebalance') {
      addScope(scopes, EXCHANGE, ['storage_deposit', 'swap']);
      for (const token of tokens) addScope(scopes, token, ['ft_transfer_call', 'near_deposit', 'storage_deposit']);
    }
    if (activity === 'liquidity-ranges' || activity === 'limit-orders') addScope(scopes, DCL, ['storage_deposit']);
    if (activity === 'liquidity-ranges') addScope(scopes, DCL, ['add_liquidity', 'remove_liquidity']);
    if (activity === 'yield-reallocation') addScope(scopes, LENDING, ['storage_deposit', 'execute']);
    if (activity === 'limit-orders') addScope(scopes, DCL, ['cancel_order']);
    if (activity !== 'staking-moves' && activity !== 'portfolio-rebalance') for (const token of tokens) {
      addScope(scopes, token, token === 'wrap.testnet' ? [...tokenMethods, 'near_deposit'] : tokenMethods);
    }
  }
  return [...scopes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([receiverId, methods]) => ({
    receiverId, methodNames: [...methods].sort(),
  }));
}

export function activeKey(grant, receiverId, methodNames, now) {
  if (!grant || grant.state && grant.state !== 'active' || grant.pending || now >= grant.expiresAt || grant.remaining < 1) return null;
  const scopes = grant.scopes ?? grant.keys;
  const covered = scopes.find(scope => scope.receiverId === receiverId && methodNames.every(method => scope.methodNames.includes(method)));
  if (!covered) return null;
  if (grant.executionAccountId) return grant.keys.find(key => key.privateKey && key.accountId === grant.executionAccountId) ?? (covered.privateKey ? covered : null);
  return covered.privateKey ? covered : null;
}

export const executionFundingYocto = 500_000_000_000_000_000_000_000n;

export function grantTransactionActions(deposit = executionFundingYocto) {
  return [{ type: 'Transfer', params: { deposit: deposit.toString() } }];
}

const grantPath = async ownerId => safeTarget(configHome(), join('grants', ownerId + '.json'));

export async function readGrant(ownerId) {
  const path = await grantPath(ownerId);
  const info = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || (info.mode & 0o077) || ((await stat(configHome())).mode & 0o077)) throw new Error('GRANT_STORAGE_NOT_PRIVATE');
  const grant = JSON.parse(await readOptional(path));
  if (grant?.ownerId !== ownerId) throw new Error('GRANT_OWNER_MISMATCH');
  return grant;
}

async function writeGrant(grant) {
  await atomicWrite(await grantPath(grant.ownerId), JSON.stringify(grant));
}

export const grantLimits = {
  onChain: 'The key can control all assets held by the separate execution account, including gains and later deposits.',
  cliOnly: 'Transaction count, expiry, and the receiver and method list. NEAR does not enforce these.',
};

export function publicGrant(grant) {
  if (!grant) return { granted: false, next: 'agentstreams grant create --transactions 10 --hours 6 --activities portfolio-rebalance' };
  const { keys, pending, ...rest } = grant;
  const scopes = grant.scopes ?? keys;
  const movesTokens = scopes.some(scope => scope.methodNames?.includes('ft_transfer_call'));
  return {
    ...rest,
    granted: Boolean(rest.agentId && rest.state === 'active' && !pending && rest.remaining > 0 && Date.now() < rest.expiresAt),
    ...(pending ? { pending: { hash: pending.hash } } : {}),
    keys: keys.map(({ privateKey, ...key }) => key),
    executionKeyStoredLocally: Boolean(rest.executionAccountId),
    ownerPrivateKeyStored: false,
    limits: grantLimits,
    note: 'The owner funds a separate testnet execution account once. Remora signs for the selected agent and activities from that account. Count, expiry and method limits are CLI-only. Expiry and exhaustion stop execution. Run grant revoke to recover supported balances.'
      + (movesTokens ? ' ft_transfer_call cannot restrict the recipient argument.' : '')
      + (!rest.agentId ? ' This legacy grant must be revoked before creating a named-agent grant.' : '')
      + (rest.sweep?.blocked ? ' Sweep is incomplete, so the execution account was kept.' : ''),
  };
}

export async function showGrant() {
  const wallet = await connectedOwner({ required: true });
  return publicGrant(await readGrant(wallet.accountId));
}

export async function createGrant({ agentId, ownerId, transactions, hours, activities, stakingPool, tokens, fundNear = '0.5', transact = ownerTransaction, keyPair = () => KeyPair.fromRandom('ed25519') } = {}) {
  if (!/^ap_[a-f0-9]{64}$/.test(agentId ?? '')) throw new Error('Select a named agent before creating a grant.');
  const txCount = count(transactions, 100, 'transactions');
  const windowHours = count(hours, 168, 'hours');
  if (!/^(0|[1-5])(?:\.\d{1,24})?$/.test(fundNear)) throw new Error('Use --fund-near between 0.1 and 5 test NEAR.');
  const [whole, fraction = ''] = fundNear.split('.');
  const funding = BigInt(whole + fraction.padEnd(24, '0'));
  if (funding < 10n ** 23n || funding > 5n * 10n ** 24n) throw new Error('Use --fund-near between 0.1 and 5 test NEAR.');
  const wallet = await connectedOwner({ required: true, ownerId });
  const scopes = grantScopes({ activities: activities?.split(','), stakingPool, tokens: tokens ? tokens.split(',') : [] });
  const release = await lockGrant(wallet.accountId);
  try {
    if (await readGrant(wallet.accountId)) throw new Error('GRANT_EXISTS: reconcile or revoke the existing grant before creating another.');
    const key = keyPair();
    const executionAccountId = keyToImplicitAddress(key.getPublicKey());
    const signingKey = { publicKey: key.getPublicKey().toString(), privateKey: key.toString(), accountId: executionAccountId };
    const grant = {
      version: 3, state: 'funding', ownerId: wallet.accountId, agentId, executionAccountId,
      transactions: txCount, remaining: txCount, hours: windowHours, fundedYoctoNear: funding.toString(),
      activities: [...new Set(activities.split(','))].sort(), scopes, expiresAt: Date.now() + windowHours * 3_600_000,
      keys: [signingKey], signing: 'browser-wallet',
    };
    // Persist the only key for the new account before an owner transfer can land.
    await writeGrant(grant);
    const receipt = await transact({
      ownerId: wallet.accountId, receiverId: executionAccountId, rpcUrl: wallet.rpcUrl,
      actions: grantTransactionActions(funding),
      label: `Fund your Remora execution account with ${fundNear} test NEAR for ${txCount} transactions over ${windowHours} hours`,
      context: { kind: 'agent-grant', agentId, executionAccountId },
    });
    Object.assign(grant, { state: 'active', expiresAt: Date.now() + windowHours * 3_600_000, transactionHash: receipt.hash, explorerUrl: receipt.explorerUrl });
    await writeGrant(grant);
    return publicGrant(grant);
  } finally { await release(); }
}

export async function revokeGrant({ transact = ownerTransaction, send = sendWithKey, inspect } = {}) {
  const wallet = await connectedOwner({ required: true });
  const release = await lockGrant(wallet.accountId);
  try {
    const grant = await readGrant(wallet.accountId);
    if (!grant) throw new Error('NO_AGENT_GRANT');
    if (grant.pending) throw new Error('GRANT_RECONCILIATION_REQUIRED: run grant reconcile.');
    if (grant.executionAccountId) {
      if (grant.state === 'funding') await requireFundingReconciled();
      grant.state = 'retiring';
      await writeGrant(grant);
      const report = await retireGrant(grant, wallet.rpcUrl, send, inspect, writeGrant);
      return { revoked: report.cleared, retained: !report.cleared, blocked: report.blocked, ownerId: wallet.accountId,
        executionAccountId: grant.executionAccountId, transactionHash: report.deleteTransactionHash ?? null, explorerUrl: report.explorerUrl ?? null, signing: 'grant' };
    }
    const receipt = await transact({
      ownerId: wallet.accountId, receiverId: wallet.accountId, rpcUrl: wallet.rpcUrl,
      actions: grant.keys.filter(key => key.publicKey).map(key => ({ type: 'DeleteKey', params: { publicKey: key.publicKey } })),
      label: 'Remove the agent keys from your testnet account', context: { kind: 'agent-grant-revoke' },
    });
    await unlink(await grantPath(wallet.accountId));
    return { revoked: true, ownerId: wallet.accountId, keys: grant.keys.map(key => key.publicKey), transactionHash: receipt.hash, explorerUrl: receipt.explorerUrl, signing: 'browser-wallet' };
  } finally { await release(); }
}

async function requireFundingReconciled() {
  if (await readOptional(join(configHome(), 'owner-operations', 'pending.json'))) {
    throw new Error('GRANT_FUNDING_UNCONFIRMED: run wallet reconcile first.');
  }
}

export async function reconcileGrant() {
  const wallet = await connectedOwner({ required: true });
  const release = await lockGrant(wallet.accountId);
  try {
    const grant = await readGrant(wallet.accountId);
    if (!grant) throw new Error('NO_AGENT_GRANT');
    const provider = await testnetProvider(wallet.rpcUrl);
    if (grant.state === 'funding') {
      await requireFundingReconciled();
      const key = grant.keys[0];
      const access = await provider.viewAccessKey({ accountId: grant.executionAccountId,
        publicKey: PublicKey.fromString(key.publicKey), blockQuery: { finality: 'final' } });
      if (access.permission !== 'FullAccess') throw new Error('GRANT_EXECUTION_KEY_MISMATCH');
      grant.state = 'active';
      await writeGrant(grant);
      return { resolved: true, grant: publicGrant(grant) };
    }
    if (!grant.pending) return { resolved: true, reason: 'NO_PENDING_GRANT_TRANSACTION' };
    const { hash, plan } = grant.pending;
    const outcome = await provider.viewTransactionStatus({ txHash: hash, accountId: grant.executionAccountId, waitUntil: 'FINAL' });
    let receipt;
    try { receipt = verifyOwnerTransaction(outcome, plan, hash); }
    catch (error) { if (!error.confirmedFailure) throw error; }
    delete grant.pending;
    await writeGrant(grant);
    return { resolved: true, hash, confirmedFailure: !receipt, ...(receipt ? { receipt: { ...receipt, signing: 'grant' } } : {}) };
  } finally { await release(); }
}

function nearActions(list) {
  return list.map(action => {
    if (action.type === 'DeleteKey') return actions.deleteKey(PublicKey.fromString(action.params.publicKey));
    if (action.type === 'DeleteAccount') return actions.deleteAccount(action.params.beneficiaryId);
    if (action.type !== 'FunctionCall') throw new Error('AGENT_GRANT_COVERS_FUNCTION_CALLS_ONLY');
    const { methodName, args, gas, deposit } = action.params;
    return actions.functionCall(methodName, args, BigInt(gas), BigInt(deposit));
  });
}

async function retireGrant(grant, rpcUrl, send, inspect, save) {
  const key = grant.keys?.find(item => item.privateKey && item.publicKey);
  if (!grant.executionAccountId || !key?.privateKey || !rpcUrl) return { cleared: false, blocked: ['GRANT_KEY_MISSING'] };
  const report = await runSweep({
    grant, rpcUrl, inspect, send: async plan => {
      let receipt;
      try { receipt = await send(plan, key.privateKey, async hash => {
        grant.pending = { hash, plan };
        await save(grant);
      }); }
      catch (error) {
        if (grant.pending && error.confirmedFailure) { delete grant.pending; await save(grant); }
        throw error;
      }
      delete grant.pending;
      await save(grant);
      return receipt;
    },
  });
  if (!report.cleared) {
    grant.sweep = { cleared: false, blocked: report.blocked, at: Date.now() };
    await save(grant);
    return report;
  }
  await unlink(await grantPath(grant.ownerId)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return report;
}

async function lockGrant(ownerId) {
  const home = configHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = await grantPath(ownerId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = path + '.lock';
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('AGENT_GRANT_BUSY');
    throw error;
  });
  return async () => { await lock.close(); await unlink(lockPath); };
}

async function testnetProvider(rpcUrl) {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  if ((await provider.viewNodeStatus()).chain_id !== 'testnet') throw new Error('RPC_NETWORK_MISMATCH');
  return provider;
}

async function sendWithKey(request, privateKey, beforeBroadcast) {
  const provider = await testnetProvider(request.rpcUrl);
  const account = new Account(request.ownerId, provider, privateKey);
  const signed = await account.createSignedTransaction({ receiverId: request.receiverId, actions: nearActions(request.actions) });
  const hash = baseEncode(createHash('sha256').update(signed.transaction.encode()).digest());
  await beforeBroadcast?.(hash);
  let outcome;
  try { outcome = await provider.sendTransactionUntil(signed, 'FINAL'); }
  catch (error) {
    outcome = await provider.viewTransactionStatus({ txHash: hash, accountId: request.ownerId, waitUntil: 'FINAL' }).catch(() => null);
    if (!outcome) throw error;
  }
  return verifyOwnerTransaction(outcome, request, hash);
}

export async function grantAccount(ownerId, agentId, activity) {
  const grant = agentId ? await readGrant(ownerId) : null;
  if (!grant?.executionAccountId || grant.agentId !== agentId || !grant.activities.includes(activity)) return null;
  assertGrantActive(grant);
  return grant.executionAccountId;
}

function assertGrantActive(grant) {
  if (grant.pending) throw new Error('GRANT_RECONCILIATION_REQUIRED: run grant reconcile.');
  if (grant.state !== 'active' || Date.now() >= grant.expiresAt || grant.remaining < 1) {
    throw new Error('GRANT_INACTIVE: run grant show or grant revoke.');
  }
}

export async function signGrantedTransaction(request, hooks, { load = readGrant, save = writeGrant, send = sendWithKey, lock = lockGrant } = {}) {
  if (!request.executionAccountId) return null;
  const release = await lock(request.ownerId);
  try {
    const grant = await load(request.ownerId);
    if (!grant || grant.executionAccountId !== request.executionAccountId || grant.agentId !== request.agentId ||
        !grant.activities.includes(request.context?.activity)) {
      throw new Error('GRANT_CHANGED: preview the strategy again.');
    }
    assertGrantActive(grant);
    if (!request.actions.length || request.actions.some(action => action.type !== 'FunctionCall')) throw new Error('AGENT_GRANT_COVERS_FUNCTION_CALLS_ONLY');
    const methods = request.actions.map(action => action.params.methodName);
    const key = activeKey(grant, request.receiverId, methods, Date.now());
    if (!key?.privateKey) throw new Error('GRANT_SCOPE_DENIED');
    await hooks?.beforeSubmit?.();
    assertGrantActive(grant);
    const plan = { ownerId: grant.executionAccountId, receiverId: request.receiverId, actions: request.actions, rpcUrl: request.rpcUrl };
    let receipt;
    try {
      receipt = await send(plan, key.privateKey, async hash => {
        assertGrantActive(grant);
        grant.remaining -= 1;
        grant.pending = { hash, plan };
        await save(grant);
      });
    } catch (error) {
      if (!grant.pending) throw error;
      if (!error.confirmedFailure) throw new Error(`GRANT_OUTCOME_UNCONFIRMED: run grant reconcile for ${grant.pending.hash}.`, { cause: error });
      delete grant.pending;
      await save(grant);
      throw error;
    }
    delete grant.pending;
    await save(grant);
    return { ...receipt, signing: 'grant', permission: 'execution-account', grantRemaining: grant.remaining, grantExpiresAt: grant.expiresAt };
  } finally {
    await release();
  }
}

export async function signStrategyTransaction(request, hooks) {
  const granted = await signGrantedTransaction(request, hooks);
  return granted ?? ownerTransaction(request, hooks);
}
