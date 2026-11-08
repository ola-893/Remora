import { DCL, EXCHANGE, LENDING } from './strategy-actions.mjs';
import { integerAmount, testnetViews } from './strategy-markets.mjs';

const WRAP = 'wrap.testnet';
const ONE = '1';
const ZERO = '0';
const gasFor = receiver => receiver === DCL ? '180000000000000' : '150000000000000';

const positive = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(value)) return false;
  return BigInt(value) > 0n;
};

export const emptySnapshot = () => ({
  accountExists: true,
  accountId: null,
  executionRegistered: {},
  exchangeDeposits: {},
  tokenBalances: {},
  staking: [],
  liquidities: [],
  orders: [],
  dclAssets: {},
  lending: { borrowed: [], supplied: [] },
  tokenStorage: [],
  ownerRegistered: {},
  storageMin: {},
  exchangeRegistered: false,
  exchangeStorageAvailable: '0',
  venueStorage: [],
});

function call(receiverId, methodName, args, deposit) {
  return { request: { receiverId, actions: [{ type: 'FunctionCall', params: { methodName, args, gas: gasFor(receiverId), deposit } }] } };
}

export function nextSweepStep(snapshot, ownerId) {
  for (const [token, amount] of Object.entries(snapshot.exchangeDeposits ?? {})) {
    if (positive(amount)) {
      if (!snapshot.executionRegistered?.[token]) {
        if (!positive(snapshot.storageMin?.[token]) || !snapshot.accountId) return { blocked: [`TOKEN_STORAGE_UNKNOWN:${token}`] };
        return call(token, 'storage_deposit', { account_id: snapshot.accountId, registration_only: true }, snapshot.storageMin[token]);
      }
      return call(EXCHANGE, 'withdraw', { token_id: token, amount, unregister: true }, ONE);
    }
    if (amount === '0') return call(EXCHANGE, 'withdraw', { token_id: token, amount: '0', unregister: true }, ONE);
  }
  for (const position of snapshot.staking ?? []) {
    if (positive(position.staked)) return call(position.pool, 'unstake', { amount: position.staked }, ZERO);
    if (positive(position.unstaked) && position.canWithdraw !== true) return { blocked: [`STAKING_UNBONDING:${position.pool}`] };
    if (positive(position.unstaked)) return call(position.pool, 'withdraw', { amount: position.unstaked }, ZERO);
  }
  for (const order of snapshot.orders ?? []) {
    if (!order.order_id || typeof order.remain_amount !== 'string') return { blocked: ['DCL_ORDER_STATE_UNKNOWN'] };
    for (const token of [order.sell_token, order.buy_token]) {
      if (token === WRAP || snapshot.executionRegistered?.[token]) continue;
      if (!positive(snapshot.storageMin?.[token])) return { blocked: [`TOKEN_STORAGE_UNKNOWN:${token}`] };
      return call(token, 'storage_deposit', { account_id: snapshot.accountId, registration_only: true }, snapshot.storageMin[token]);
    }
    return call(DCL, 'cancel_order', { order_id: order.order_id, amount: order.remain_amount }, ZERO);
  }
  for (const position of snapshot.liquidities ?? []) {
    if (positive(position.amount) && position.lpt_id) {
      return call(DCL, 'remove_liquidity', { lpt_id: position.lpt_id, amount: position.amount, min_amount_x: ZERO, min_amount_y: ZERO }, ZERO);
    }
  }
  for (const [token, amount] of Object.entries(snapshot.dclAssets ?? {})) {
    if (positive(amount)) return call(DCL, 'withdraw_asset', { token_id: token, amount }, ZERO);
  }
  if ((snapshot.lending?.borrowed ?? []).some(item => positive(item.balance))) return { blocked: ['LENDING_BORROW_OPEN'] };
  const supplied = (snapshot.lending?.supplied ?? []).find(item => positive(item.balance));
  if (supplied) {
    return call(LENDING, 'execute', { actions: [{ Withdraw: { token_id: supplied.token_id, max_amount: supplied.balance } }] }, ONE);
  }
  for (const [token, amount] of Object.entries(snapshot.tokenBalances ?? {})) {
    if (!positive(amount)) continue;
    if (token === WRAP) return call(WRAP, 'near_withdraw', { amount }, ONE);
    if (!snapshot.ownerRegistered?.[token]) {
      if (!positive(snapshot.storageMin?.[token])) return { blocked: [`TOKEN_STORAGE_UNKNOWN:${token}`] };
      return call(token, 'storage_deposit', { account_id: ownerId, registration_only: true }, snapshot.storageMin[token]);
    }
    return call(token, 'ft_transfer', { receiver_id: ownerId, amount, memo: null }, ONE);
  }
  for (const token of snapshot.tokenStorage ?? []) return call(token, 'storage_unregister', { force: false }, ONE);
  for (const venue of snapshot.venueStorage ?? []) return call(venue, 'storage_unregister', { force: false }, ONE);
  if (snapshot.exchangeRegistered) {
    if (positive(snapshot.exchangeStorageAvailable)) return call(EXCHANGE, 'storage_withdraw', { amount: snapshot.exchangeStorageAvailable }, ONE);
    return call(EXCHANGE, 'storage_unregister', { force: false }, ONE);
  }
  return { done: true };
}

async function optional(view, contract, method, args) {
  try { return await view(contract, method, args); }
  catch (error) {
    const text = `${error?.name ?? ''} ${error?.message ?? ''} ${error?.type ?? ''}`;
    if (/not registered|account is not registered/i.test(text) && !/UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(text)) return undefined;
    throw error;
  }
}

export async function inspectExecutionAccount(grant, rpcUrl, views = testnetViews) {
  const rpc = await views(rpcUrl);
  const account = grant.executionAccountId;
  let accountExists = true;
  try { await rpc.provider.viewAccount({ accountId: account, blockQuery: { blockId: rpc.blockHash } }); }
  catch (error) {
    if (/UNKNOWN_ACCOUNT|does not exist|AccountDoesNotExist/i.test(`${error.name} ${error.message} ${error.type}`)) accountExists = false;
    else throw error;
  }
  if (!accountExists) return { ...emptySnapshot(), accountExists: false };
  const pools = (grant.scopes ?? []).filter(scope => scope.methodNames?.includes('deposit_and_stake')).map(scope => scope.receiverId);
  const tokens = new Set((grant.scopes ?? []).filter(scope => scope.methodNames?.some(method => ['ft_transfer_call', 'near_deposit', 'ft_transfer'].includes(method))).map(scope => scope.receiverId));
  const deposits = await optional(rpc.view, EXCHANGE, 'get_deposits', { account_id: account }) ?? {};
  if (typeof deposits !== 'object' || Array.isArray(deposits)) throw new Error('INVALID_EXCHANGE_BALANCE_SNAPSHOT');
  Object.values(deposits).forEach(integerAmount);
  for (const token of Object.keys(deposits)) tokens.add(token);
  const dclAssets = await optional(rpc.view, DCL, 'list_user_assets', { account_id: account }) ?? {};
  if (typeof dclAssets !== 'object' || Array.isArray(dclAssets)) throw new Error('INVALID_DCL_BALANCE_SNAPSHOT');
  Object.values(dclAssets).forEach(integerAmount);
  for (const token of Object.keys(dclAssets)) tokens.add(token);
  const [liquidities, orders] = await Promise.all([
    optional(rpc.view, DCL, 'list_liquidities', { account_id: account }),
    optional(rpc.view, DCL, 'list_active_orders', { account_id: account }),
  ]);
  if (liquidities !== undefined && !Array.isArray(liquidities) || orders !== undefined && !Array.isArray(orders)) {
    throw new Error('INVALID_DCL_POSITION_SNAPSHOT');
  }
  for (const order of orders ?? []) { tokens.add(order.sell_token); tokens.add(order.buy_token); }
  const staking = [];
  for (const pool of pools) {
    const position = await optional(rpc.view, pool, 'get_account', { account_id: account });
    if (!position) continue;
    staking.push({ pool, staked: String(position.staked_balance ?? '0'), unstaked: String(position.unstaked_balance ?? '0'), canWithdraw: position.can_withdraw === true });
  }
  const lendingAccount = await optional(rpc.view, LENDING, 'get_account', { account_id: account });
  const tokenBalances = {}, ownerRegistered = {}, executionRegistered = {}, storageMin = {}, tokenStorage = [];
  for (const token of tokens) {
    const balance = await optional(rpc.view, token, 'ft_balance_of', { account_id: account });
    if (balance !== undefined) { integerAmount(balance); tokenBalances[token] = balance; }
    const storage = await optional(rpc.view, token, 'storage_balance_of', { account_id: account });
    executionRegistered[token] = Boolean(storage);
    if (storage && balance === '0') tokenStorage.push(token);
    ownerRegistered[token] = Boolean(await optional(rpc.view, token, 'storage_balance_of', { account_id: grant.ownerId }));
    const bounds = await optional(rpc.view, token, 'storage_balance_bounds', {});
    if (typeof bounds?.min === 'string') storageMin[token] = bounds.min;
  }
  const exchangeStorage = await optional(rpc.view, EXCHANGE, 'storage_balance_of', { account_id: account });
  const venueStorage = [];
  for (const venue of [DCL, LENDING]) {
    if (await optional(rpc.view, venue, 'storage_balance_of', { account_id: account })) venueStorage.push(venue);
  }
  return {
    accountExists, accountId: account, executionRegistered, exchangeDeposits: deposits, tokenBalances, staking,
    liquidities: liquidities ?? [], orders: orders ?? [], venueStorage,
    dclAssets: dclAssets && typeof dclAssets === 'object' ? dclAssets : {},
    lending: { borrowed: lendingAccount?.borrowed ?? [], supplied: lendingAccount?.supplied ?? [] },
    tokenStorage, ownerRegistered, storageMin,
    exchangeRegistered: Boolean(exchangeStorage),
    exchangeStorageAvailable: typeof exchangeStorage?.available === 'string' ? exchangeStorage.available : '0',
  };
}

function blockedText(error) {
  const text = `${error?.message ?? error}`.replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{20,}/g, '[redacted]');
  return text.slice(0, 240);
}

export async function runSweep({ grant, rpcUrl, send, inspect }) {
  const read = inspect ?? (() => inspectExecutionAccount(grant, rpcUrl));
  for (let step = 0; step < 32; step++) {
    let snapshot;
    try { snapshot = await read(); }
    catch (error) { return { cleared: false, blocked: [`SWEEP_VIEW_FAILED:${blockedText(error)}`] }; }
    if (snapshot.accountExists === false) return { cleared: true, blocked: [], reason: 'ACCOUNT_ALREADY_ABSENT' };
    const next = nextSweepStep(snapshot, grant.ownerId);
    if (next.blocked) return { cleared: false, blocked: next.blocked };
    if (next.done) {
      try {
        const receipt = await send({
          ownerId: grant.executionAccountId, receiverId: grant.executionAccountId, rpcUrl,
          actions: [{ type: 'DeleteAccount', params: { beneficiaryId: grant.ownerId } }],
        });
        return { cleared: true, blocked: [], deleteTransactionHash: receipt?.hash ?? null, explorerUrl: receipt?.explorerUrl ?? null };
      } catch (error) {
        return { cleared: false, blocked: [`SWEEP_DELETE_FAILED:${blockedText(error)}`] };
      }
    }
    try { await send({ ownerId: grant.executionAccountId, receiverId: next.request.receiverId, rpcUrl, actions: next.request.actions }); }
    catch (error) {
      const method = next.request.actions[0].params.methodName;
      return { cleared: false, blocked: [`SWEEP_FAILED:${method}:${blockedText(error)}`] };
    }
  }
  return { cleared: false, blocked: ['SWEEP_STEP_LIMIT'] };
}
