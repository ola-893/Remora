import { mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, actions } from 'near-api-js';
import { configHome } from './config.mjs';
import { atomicWrite, readOptional, safeTarget } from './files.mjs';
import { connectedOwner, ownerTransaction, verifyOwnerTransaction } from './owner-wallet.mjs';
import { DCL, EXCHANGE, LENDING, nativeWalletActivities, tokenId } from './strategy-actions.mjs';

// 0.1 test NEAR of gas per granted transaction. The allowance is a spending cap, not a locked balance.
export const yoctoPerTransaction = 100_000_000_000_000_000_000_000n;
const tokenMethods = ['ft_transfer_call'];
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
  if (!needsTokens && tokens.length) throw new Error('--tokens applies to liquidity, yield and limit orders.');
  if (tokens.some(token => !tokenId(token))) throw new Error('Each --tokens entry must be a testnet token contract.');
  const scopes = new Map();
  for (const activity of selected) {
    if (activity === 'staking-moves') addScope(scopes, stakingPool, ['storage_deposit', 'deposit_and_stake', 'unstake', 'withdraw']);
    if (activity === 'portfolio-rebalance') addScope(scopes, EXCHANGE, ['swap']);
    if (activity === 'liquidity-ranges') addScope(scopes, DCL, ['add_liquidity', 'remove_liquidity']);
    if (activity === 'yield-reallocation') addScope(scopes, LENDING, ['storage_deposit', 'execute']);
    if (activity === 'limit-orders') addScope(scopes, DCL, ['cancel_order']);
    if (activity !== 'staking-moves' && activity !== 'portfolio-rebalance') for (const token of tokens) addScope(scopes, token, tokenMethods);
  }
  return [...scopes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([receiverId, methods]) => ({
    receiverId, methodNames: [...methods].sort(),
  }));
}

export function activeKey(grant, receiverId, methodNames, now) {
  if (!grant || now >= grant.expiresAt || grant.remaining < 1) return null;
  return grant.keys.find(key => key.receiverId === receiverId && methodNames.every(method => key.methodNames.includes(method))) ?? null;
}

const grantPath = async ownerId => safeTarget(configHome(), join('grants', ownerId + '.json'));

export async function readGrant(ownerId) {
  const text = await readOptional(await grantPath(ownerId));
  return text ? JSON.parse(text) : null;
}

async function writeGrant(grant) {
  await atomicWrite(await grantPath(grant.ownerId), JSON.stringify(grant));
}

export function publicGrant(grant) {
  if (!grant) return { granted: false, next: 'agentstreams grant create --transactions 10 --hours 6 --activities portfolio-rebalance' };
  const { keys, ...rest } = grant;
  const movesTokens = keys.some(key => key.methodNames.includes('ft_transfer_call'));
  return {
    ...rest,
    granted: rest.remaining > 0 && Date.now() < rest.expiresAt,
    keys: keys.map(({ privateKey, ...key }) => key),
    privateKeysStored: true,
    protocolExpiry: false,
    note: 'NEAR function-call keys do not expire on chain. Remora stops signing when the time or transaction count runs out. grant revoke deletes the keys.'
      + (movesTokens ? ' ft_transfer_call cannot restrict the recipient argument; the gas allowance and transaction count are the on-chain limits.' : ''),
  };
}

function keyActions(material, type) {
  return material.map(item => type === 'add'
    ? { type: 'AddKey', params: { publicKey: item.publicKey, accessKey: { nonce: 0, permission: { receiverId: item.receiverId, methodNames: item.methodNames, allowance: item.allowance } } } }
    : { type: 'DeleteKey', params: { publicKey: item.publicKey } });
}

export async function showGrant() {
  const wallet = await connectedOwner({ required: true });
  return publicGrant(await readGrant(wallet.accountId));
}

export async function createGrant({ transactions, hours, activities, stakingPool, tokens, transact = ownerTransaction, keyPair = () => KeyPair.fromRandom('ed25519') } = {}) {
  const txCount = count(transactions, 100, 'transactions');
  const windowHours = count(hours, 168, 'hours');
  const wallet = await connectedOwner({ required: true });
  if (await readGrant(wallet.accountId)) throw new Error('GRANT_EXISTS: run agentstreams grant revoke before creating another.');
  const scopes = grantScopes({ activities: activities?.split(','), stakingPool, tokens: tokens ? tokens.split(',') : [] });
  const allowance = (yoctoPerTransaction * BigInt(txCount)).toString();
  const material = scopes.map(scope => {
    const key = keyPair();
    return { ...scope, publicKey: key.getPublicKey().toString(), privateKey: key.toString(), allowance };
  });
  const receipt = await transact({
    ownerId: wallet.accountId, receiverId: wallet.accountId, rpcUrl: wallet.rpcUrl,
    actions: keyActions(material, 'add'),
    label: `Let your agent sign ${txCount} restricted testnet transactions for ${windowHours} hours`,
    context: { kind: 'agent-grant', transactions: txCount, hours: windowHours },
  });
  const grant = {
    version: 1, ownerId: wallet.accountId, transactions: txCount, remaining: txCount, hours: windowHours,
    activities: [...new Set(activities.split(','))].sort(), expiresAt: Date.now() + windowHours * 3_600_000,
    keys: material, transactionHash: receipt.hash, explorerUrl: receipt.explorerUrl, signing: 'browser-wallet',
  };
  await writeGrant(grant);
  return publicGrant(grant);
}

export async function revokeGrant({ transact = ownerTransaction } = {}) {
  const wallet = await connectedOwner({ required: true });
  const grant = await readGrant(wallet.accountId);
  if (!grant) throw new Error('NO_AGENT_GRANT');
  const receipt = await transact({
    ownerId: wallet.accountId, receiverId: wallet.accountId, rpcUrl: wallet.rpcUrl,
    actions: keyActions(grant.keys, 'delete'),
    label: 'Remove the agent function-call keys from your testnet account',
    context: { kind: 'agent-grant-revoke' },
  });
  await unlink(await grantPath(wallet.accountId)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return { revoked: true, ownerId: wallet.accountId, keys: grant.keys.map(key => key.publicKey), transactionHash: receipt.hash, explorerUrl: receipt.explorerUrl, signing: 'browser-wallet' };
}

function nearActions(list) {
  return list.map(action => {
    if (action.type !== 'FunctionCall') throw new Error('AGENT_GRANT_COVERS_FUNCTION_CALLS_ONLY');
    const { methodName, args, gas, deposit } = action.params;
    return actions.functionCall(methodName, args, BigInt(gas), BigInt(deposit));
  });
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

async function sendWithKey(request, privateKey) {
  const provider = new JsonRpcProvider({ url: request.rpcUrl });
  const account = new Account(request.ownerId, provider, privateKey);
  const signed = await account.createSignedTransaction({ receiverId: request.receiverId, actions: nearActions(request.actions) });
  const outcome = await provider.sendTransactionUntil(signed, 'FINAL');
  return verifyOwnerTransaction(outcome, request);
}

export async function signGrantedTransaction(request, hooks, { load = readGrant, save = writeGrant, send = sendWithKey, lock = lockGrant } = {}) {
  const release = await lock(request.ownerId);
  try {
    const grant = await load(request.ownerId);
    const methods = request.actions.map(action => action.params?.methodName);
    const key = activeKey(grant, request.receiverId, methods, Date.now());
    if (!key) return null;
    await hooks?.beforeSubmit?.();
    const receipt = await send(request, key.privateKey);
    grant.remaining -= 1;
    await save(grant);
    return { ...receipt, signing: 'function-call-key', grantRemaining: grant.remaining, grantExpiresAt: grant.expiresAt };
  } finally {
    await release();
  }
}

export async function signStrategyTransaction(request, hooks) {
  const granted = await signGrantedTransaction(request, hooks);
  return granted ?? ownerTransaction(request, hooks);
}
