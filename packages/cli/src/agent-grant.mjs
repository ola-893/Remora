import { mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, PublicKey, actions, keyToImplicitAddress } from 'near-api-js';
import { configHome } from './config.mjs';
import { atomicWrite, readOptional, safeTarget } from './files.mjs';
import { connectedOwner, ownerTransaction, verifyOwnerTransaction } from './owner-wallet.mjs';
import { DCL, EXCHANGE, LENDING, nativeWalletActivities, tokenId } from './strategy-actions.mjs';

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
  if (!needsTokens && tokens.length && !selected.includes('portfolio-rebalance')) throw new Error('--tokens applies to liquidity, yield, limit orders and portfolio rebalance.');
  if (tokens.some(token => !tokenId(token))) throw new Error('Each --tokens entry must be a testnet token contract.');
  const scopes = new Map();
  for (const activity of selected) {
    if (activity === 'staking-moves') addScope(scopes, stakingPool, ['storage_deposit', 'deposit_and_stake', 'unstake', 'withdraw']);
    if (activity === 'portfolio-rebalance') {
      addScope(scopes, EXCHANGE, ['storage_deposit', 'swap']);
      for (const token of tokens) addScope(scopes, token, ['ft_transfer_call', 'near_deposit', 'storage_deposit']);
    }
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
  const text = await readOptional(await grantPath(ownerId));
  return text ? JSON.parse(text) : null;
}

async function writeGrant(grant) {
  await atomicWrite(await grantPath(grant.ownerId), JSON.stringify(grant));
}

export function publicGrant(grant) {
  if (!grant) return { granted: false, next: 'agentstreams grant create --transactions 10 --hours 6 --activities portfolio-rebalance' };
  const { keys, ...rest } = grant;
  const scopes = grant.scopes ?? keys;
  const movesTokens = scopes.some(scope => scope.methodNames?.includes('ft_transfer_call'));
  return {
    ...rest,
    granted: rest.remaining > 0 && Date.now() < rest.expiresAt,
    keys: keys.map(({ privateKey, ...key }) => key),
    privateKeysStored: true,
    note: 'The owner funds a separate execution account once. That account can attach deposits. Remora signs only the granted receivers and methods from it, then returns the balance when the count or time runs out.'
      + (movesTokens ? ' ft_transfer_call cannot restrict the recipient argument.' : ''),
  };
}

export async function showGrant() {
  const wallet = await connectedOwner({ required: true });
  return publicGrant(await readGrant(wallet.accountId));
}

export async function createGrant({ transactions, hours, activities, stakingPool, tokens, transact = ownerTransaction, keyPair = () => KeyPair.fromRandom('ed25519') } = {}) {
  const txCount = count(transactions, 100, 'transactions');
  const windowHours = count(hours, 168, 'hours');
  const wallet = await connectedOwner({ required: true });
  const existing = await readGrant(wallet.accountId);
  if (existing?.executionAccountId) throw new Error('GRANT_EXISTS: run agentstreams grant revoke before creating another.');
  const scopes = grantScopes({ activities: activities?.split(','), stakingPool, tokens: tokens ? tokens.split(',') : [] });
  const key = keyPair();
  const executionAccountId = keyToImplicitAddress(key.getPublicKey());
  const signingKey = { publicKey: key.getPublicKey().toString(), privateKey: key.toString(), accountId: executionAccountId };
  const receipt = await transact({
    ownerId: wallet.accountId, receiverId: executionAccountId, rpcUrl: wallet.rpcUrl,
    actions: grantTransactionActions(),
    label: `Fund your agent execution account for ${txCount} testnet transactions over ${windowHours} hours`,
    context: { kind: 'agent-grant', transactions: txCount, hours: windowHours, executionAccountId },
  });
  const grant = {
    version: 2, ownerId: wallet.accountId, executionAccountId, transactions: txCount, remaining: txCount, hours: windowHours,
    activities: [...new Set(activities.split(','))].sort(), scopes, expiresAt: Date.now() + windowHours * 3_600_000,
    keys: [signingKey], transactionHash: receipt.hash, explorerUrl: receipt.explorerUrl, signing: 'browser-wallet',
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
    actions: grant.keys.filter(key => key.publicKey).map(key => ({ type: 'DeleteKey', params: { publicKey: key.publicKey } })),
    label: 'Remove the agent function-call keys from your testnet account',
    context: { kind: 'agent-grant-revoke' },
  });
  await unlink(await grantPath(wallet.accountId)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return { revoked: true, ownerId: wallet.accountId, keys: grant.keys.map(key => key.publicKey), transactionHash: receipt.hash, explorerUrl: receipt.explorerUrl, signing: 'browser-wallet' };
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

async function retireGrant(grant, rpcUrl, send) {
  const key = grant.keys?.find(item => item.privateKey && item.publicKey);
  if (!grant.executionAccountId || !key || !rpcUrl) return;
  try {
    await send({
      ownerId: grant.executionAccountId, receiverId: grant.executionAccountId, rpcUrl,
      actions: [{ type: 'DeleteAccount', params: { beneficiaryId: grant.ownerId } }],
    }, key.privateKey);
  } catch (error) {
    if (!/does not exist|AccountDoesNotExist/i.test(`${error.name} ${error.message}`)) throw error;
  }
  await unlink(await grantPath(grant.ownerId)).catch(error => { if (error.code !== 'ENOENT') throw error; });
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
    if (grant && !grant.executionAccountId) return null;
    if (grant && (Date.now() >= grant.expiresAt || grant.remaining < 1)) {
      await retireGrant(grant, request.rpcUrl, send);
      return null;
    }
    const methods = request.actions.map(action => action.params?.methodName);
    const key = activeKey(grant, request.receiverId, methods, Date.now());
    if (!key?.privateKey || !grant?.executionAccountId) return null;
    await hooks?.beforeSubmit?.();
    const receipt = await send({ ...request, ownerId: grant.executionAccountId }, key.privateKey);
    grant.remaining -= 1;
    await save(grant);
    if (grant.remaining < 1) await retireGrant(grant, request.rpcUrl, send);
    return { ...receipt, signing: 'grant', permission: key.permission ?? 'FunctionCall', grantRemaining: grant.remaining, grantExpiresAt: grant.expiresAt };
  } finally {
    await release();
  }
}

export async function signStrategyTransaction(request, hooks) {
  const granted = await signGrantedTransaction(request, hooks);
  return granted ?? ownerTransaction(request, hooks);
}
