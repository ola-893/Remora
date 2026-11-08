import { connectedOwner, ownerTransaction } from './owner-wallet.mjs';
import { activityBlocker, DCL, EXCHANGE, LENDING, NEAR_ASSET, RNEAR, dclPoolTokens, enforceStrategyPolicy, ftAsset } from './strategy-actions.mjs';
import { rawAmount } from './copy-activity.mjs';
import { integerAmount, lendingMarket, liquidityMarket, stakingMarket, testnetViews } from './strategy-markets.mjs';

const call = (methodName, args, gas, deposit = '0') => ({ type: 'FunctionCall', params: { methodName, args, gas, deposit } });
const tokenBalance = (view, token, account_id) => view(token, 'ft_balance_of', { account_id }).then(integerAmount);

async function stakingPlan(action, account_id, rpc) {
  const evidence = await stakingMarket(action.pool, rpc);
  const n = BigInt(action.amount);
  const args = { account_id };
  const actions = [];
  if (action.operation === 'stake') {
    if (action.pool === RNEAR && !await rpc.view(RNEAR, 'storage_balance_of', args)) {
      const storage = await rpc.view(RNEAR, 'storage_balance_bounds');
      integerAmount(storage.min);
      actions.push(call('storage_deposit', { ...args, registration_only: true }, '30000000000000', storage.min));
    }
    const account = await rpc.provider.viewAccount({ accountId: account_id, blockQuery: { blockId: rpc.blockHash } });
    const required = n + actions.reduce((sum, a) => sum + BigInt(a.params.deposit), 0n) + 10n ** 22n;
    if (BigInt(account.amount) - BigInt(account.storage_usage) * 10n ** 19n < required) throw new Error('INSUFFICIENT_TEST_NEAR_FOR_STAKE_AND_GAS');
    actions.push(call('deposit_and_stake', {}, '200000000000000', action.amount));
  } else {
    const position = await rpc.view(action.pool, 'get_account', args);
    const available = action.operation === 'unstake' ? position?.staked_balance : position?.unstaked_balance;
    if (n > integerAmount(available)) throw new Error('INSUFFICIENT_STAKING_POSITION');
    if (action.operation === 'withdraw' && position.can_withdraw !== true) throw new Error('STAKING_UNBONDING_NOT_READY');
    actions.push(call(action.operation, { amount: action.amount }, '200000000000000'));
  }
  const readPosition = async read => {
    const position = await read(action.pool, 'get_account', args);
    return { staked: integerAmount(position.staked_balance), unstaked: integerAmount(position.unstaked_balance) };
  };
  const before = await readPosition(rpc.view);
  const confirms = async (_receipt, read) => {
    const after = await readPosition(read);
    if (action.operation === 'stake') return after.staked > before.staked;
    if (action.operation === 'unstake') return after.unstaked > before.unstaked;
    return after.unstaked < before.unstaked;
  };
  return { receiverId: action.pool, actions, evidence, inputs: { [NEAR_ASSET]: action.amount }, confirms };
}

async function liquidityPlan(action, account_id, rpc) {
  const evidence = await liquidityMarket(action, rpc);
  const positions = await rpc.view(DCL, 'list_liquidities', { account_id });
  if (!Array.isArray(positions)) throw new Error('DCL_POSITIONS_UNAVAILABLE');
  if (action.operation === 'remove') {
    const matches = positions.filter(position => position.pool_id === action.pool &&
      position.left_point === action.left && position.right_point === action.right);
    if (matches.length !== 1 || matches[0].mft_id || BigInt(action.amount) > integerAmount(matches[0].amount)) {
      throw new Error('DCL_REMOVE_REQUIRES_ONE_UNFARMED_POSITION_WITH_SUFFICIENT_LIQUIDITY');
    }
    const { lpt_id, amount } = matches[0];
    const args = { lpt_id, amount: action.amount, min_amount_x: action.minX, min_amount_y: action.minY };
    return { receiverId: DCL, actions: [call('remove_liquidity', args, '150000000000000')], evidence,
      inputs: { 'dcl:liquidity': action.amount }, confirms: async (_receipt, read) => {
        const current = await read(DCL, 'list_liquidities', { account_id });
        if (!Array.isArray(current)) return false;
        const after = current.find(position => position.lpt_id === lpt_id);
        return integerAmount(after?.amount ?? '0') === BigInt(amount) - BigInt(action.amount);
      } };
  }
  if (action.minX === undefined || (action.minX === '0' && action.minY === '0')) throw new Error('DCL_LIVE_MINIMUMS_REQUIRED: set minX and minY in raw token units.');
  const [storage, deposits] = await Promise.all([
    rpc.view(DCL, 'get_user_storage_detail', { user_id: account_id }),
    rpc.view(DCL, 'list_user_assets', { account_id }),
  ]);
  if (!storage || storage.cur_order_slots + storage.cur_liquidity_slots >= storage.max_slots) throw new Error('DCL_STORAGE_REQUIRED: register or add storage in Rhea first.');
  const { tokenX, tokenY } = evidence;
  if (integerAmount(deposits[tokenX] ?? '0') < BigInt(action.amountX) || integerAmount(deposits[tokenY] ?? '0') < BigInt(action.amountY)) {
    throw new Error('DCL_DEPOSITS_REQUIRED: use agentstream task deposit-range to fund the missing token balance.');
  }
  const ids = new Set(positions.map(p => p.lpt_id));
  const args = { pool_id: action.pool, left_point: action.left, right_point: action.right,
    amount_x: action.amountX, amount_y: action.amountY, min_amount_x: action.minX, min_amount_y: action.minY };
  const confirms = async (receipt, read) => {
    const positions = await read(DCL, 'list_liquidities', { account_id });
    return positions.some(p => !ids.has(p.lpt_id) && p.pool_id === action.pool &&
      p.left_point === action.left && p.right_point === action.right &&
      (typeof receipt.value !== 'string' || p.lpt_id === receipt.value));
  };
  return { receiverId: DCL, actions: [call('add_liquidity', args, '150000000000000')], evidence,
    inputs: { [ftAsset(tokenX)]: action.amountX, [ftAsset(tokenY)]: action.amountY }, confirms };
}

async function lendingPlan(action, account_id, rpc) {
  const evidence = await lendingMarket(action, rpc);
  if (!await rpc.view(LENDING, 'storage_balance_of', { account_id })) throw new Error('LENDING_STORAGE_REQUIRED: register your account with Rhea Lending first.');
  const input = BigInt(action.amount);
  const inputs = { [ftAsset(action.token)]: action.amount };
  const before = await tokenBalance(rpc.view, action.token, account_id);
  if (action.operation === 'supply') {
    if (before < input) throw new Error('INSUFFICIENT_WALLET_TOKEN_BALANCE');
    const args = { receiver_id: LENDING, amount: action.amount, msg: '' };
    return { receiverId: action.token, actions: [call('ft_transfer_call', args, '150000000000000', '1')],
      evidence, inputs, confirms: async receipt => receipt.value === action.amount };
  }
  const account = await rpc.view(LENDING, 'get_account', { account_id });
  const position = account?.supplied?.find(item => item.token_id === action.token);
  const internal = input * 10n ** BigInt(evidence.extraDecimals);
  if (integerAmount(position?.balance ?? '0') < internal) throw new Error('INSUFFICIENT_UNENCUMBERED_SUPPLY');
  const args = { actions: [{ Withdraw: { token_id: action.token, max_amount: internal.toString() } }] };
  return { receiverId: LENDING, actions: [call('execute', args, '200000000000000', '1')], evidence, inputs,
    confirms: async (_receipt, read) => await tokenBalance(read, action.token, account_id) >= before + input };
}

async function portfolioPlan(action, account_id, rpc, policy) {
  const { poolId, base, weights } = action;
  const other = Object.keys(weights).find(token => token !== base);
  const [pool, deposits] = await Promise.all([
    rpc.view(EXCHANGE, 'get_pool', { pool_id: poolId }), rpc.view(EXCHANGE, 'get_deposits', { account_id }),
  ]);
  const tokens = pool?.token_account_ids;
  if (pool?.pool_kind !== 'SIMPLE_POOL' || tokens?.length !== 2 || !tokens.includes(base) || !tokens.includes(other)) {
    throw new Error('REBALANCE_REQUIRES_MATCHING_RHEA_SIMPLE_POOL');
  }
  const reserve = token => integerAmount(pool.amounts[tokens.indexOf(token)]);
  const baseReserve = reserve(base), otherReserve = reserve(other);
  if (baseReserve === 0n || otherReserve === 0n) throw new Error('REBALANCE_POOL_EMPTY');
  const held = token => integerAmount(deposits?.[token] ?? '0');
  const baseHeld = held(base), otherHeld = held(other);
  const signedExcess = (baseBalance, otherBalance) =>
    baseBalance * otherReserve * BigInt(weights[other]) - otherBalance * baseReserve * BigInt(weights[base]);
  const excess = signedExcess(baseHeld, otherHeld);
  const abs = n => n < 0n ? -n : n;
  const [from, to] = excess > 0n ? [base, other] : [other, base];
  const denomination = from === base ? otherReserve : baseReserve;
  const ideal = abs(excess) / (10000n * denomination);
  const budget = BigInt(action.amount) * otherReserve / denomination;
  const amountIn = ideal < budget ? ideal : budget;
  if (!amountIn) throw new Error('REBALANCE_ALREADY_AT_TARGET_OR_AMOUNT_TOO_SMALL');
  const args = { pool_id: poolId, token_in: from, token_out: to, amount_in: amountIn.toString() };
  const quote = integerAmount(await rpc.view(EXCHANGE, 'get_return', args));
  const priceFloor = (amountIn * reserve(to) * BigInt(10000 - policy.slippageBps)) / (reserve(from) * 10000n);
  if (quote < priceFloor) throw new Error('REBALANCE_PRICE_IMPACT_LIMIT');
  const min = quote * BigInt(10000 - policy.slippageBps) / 10000n;
  const improvement = output => from === base
    ? abs(signedExcess(baseHeld - amountIn, otherHeld + output))
    : abs(signedExcess(baseHeld + output, otherHeld - amountIn));
  if (!min || improvement(min) >= abs(excess) || improvement(quote) >= abs(excess)) throw new Error('REBALANCE_DOES_NOT_IMPROVE_TARGET');
  const evidence = { source: 'rhea-exchange', contract: EXCHANGE, poolId, before: deposits, from, to, amountIn: amountIn.toString(),
    quotedAmountOut: quote.toString(), minimumAmountOut: min.toString(), blockHeight: rpc.blockHeight, observedAt: rpc.observedAt };
  return { receiverId: EXCHANGE, actions: [call('swap', { actions: [{ ...args, min_amount_out: min.toString() }] }, '100000000000000', '1')],
    evidence, inputs: { [ftAsset(from)]: amountIn.toString() },
    confirms: async receipt => integerAmount(receipt.value) >= min };
}

async function limitOrderPlan(action, account_id, rpc, _policy, clientId) {
  if (typeof clientId !== 'string' || !/^[a-f0-9]{32}$/.test(clientId)) throw new Error('DCL_ORDER_REFERENCE_REQUIRED');
  const { pool, operation, sellToken, point, amount } = action;
  const [x, y] = dclPoolTokens(pool);
  const orders = async (read, method) => {
    const result = await read(DCL, method, { account_id });
    if (!Array.isArray(result)) throw new Error('DCL_ORDERS_UNAVAILABLE');
    return result.filter(order => order.owner_id === account_id && order.pool_id === pool && order.client_id === clientId);
  };
  const active = read => orders(read, 'list_active_orders');
  const history = read => orders(read, 'list_history_orders');
  const evidence = { source: 'rhea-dcl-orders', contract: DCL, pool, blockHeight: rpc.blockHeight, observedAt: rpc.observedAt };
  if (operation === 'place') {
    const buyToken = sellToken === x ? y : x;
    const [market, storage, registered, balance, existing, closed] = await Promise.all([
      rpc.view(DCL, 'get_pool', { pool_id: pool }),
      rpc.view(DCL, 'get_user_storage_detail', { user_id: account_id }),
      rpc.view(buyToken, 'storage_balance_of', { account_id }),
      tokenBalance(rpc.view, sellToken, account_id),
      active(rpc.view), history(rpc.view),
    ]);
    if (market?.pool_id !== pool || market.token_x !== x || market.token_y !== y || market.state !== 'Running' ||
        market.whitelist !== null || !Number.isInteger(market.point_delta) || market.point_delta <= 0 ||
        !Number.isInteger(market.current_point)) throw new Error('DCL_POOL_NOT_AVAILABLE');
    if (point % market.point_delta) throw new Error('DCL_ORDER_POINT_NOT_ALIGNED');
    if (sellToken === x ? point <= market.current_point : point >= market.current_point) throw new Error('DCL_ORDER_WOULD_CROSS_MARKET');
    if (!storage || storage.cur_order_slots + storage.cur_liquidity_slots >= storage.max_slots) throw new Error('DCL_STORAGE_REQUIRED');
    if (!registered) throw new Error('DCL_ORDER_BUY_TOKEN_STORAGE_REQUIRED: register the receiving wallet on ' + buyToken);
    if (balance < BigInt(amount)) throw new Error('INSUFFICIENT_WALLET_TOKEN_BALANCE');
    if (existing.length || closed.length) throw new Error('DCL_ORDER_ALREADY_PLACED');
    const msg = JSON.stringify({ LimitOrderWithSwap: { pool_id: pool, buy_token: buyToken, point, client_id: clientId } });
    const args = { receiver_id: DCL, amount, msg };
    return { receiverId: sellToken, actions: [call('ft_transfer_call', args, '1000000000000000', '1')],
      evidence: { ...evidence, currentPoint: market.current_point, pointDelta: market.point_delta, buyToken },
      inputs: { [ftAsset(sellToken)]: amount }, confirms: async (receipt, read) => {
        const [open, closed] = await Promise.all([active(read), history(read)]);
        const matches = [...open, ...closed].filter(order => order.point === point && order.sell_token === sellToken &&
          order.buy_token === buyToken && order.original_deposit_amount === amount && order.original_amount === amount &&
          order.swap_earn_amount === '0');
        return receipt.value === amount && matches.length === 1 ? matches[0] : false;
      } };
  }
  const matches = await active(rpc.view);
  if (matches.length !== 1) throw new Error('DCL_LOCAL_ORDER_NOT_FOUND');
  const order = matches[0];
  const cancel = operation === 'cancel';
  const expected = integerAmount(cancel ? order.remain_amount : order.unclaimed_amount);
  if (expected === 0n) throw new Error(cancel ? 'DCL_NO_UNFILLED_ORDER_AMOUNT' : 'DCL_NO_ORDER_PROCEEDS');
  const token = cancel ? order.sell_token : order.buy_token;
  const unwrap = token === 'wrap.testnet';
  const before = unwrap ? null : await tokenBalance(rpc.view, token, account_id);
  const args = { order_id: order.order_id, amount: cancel ? expected.toString() : '0' };
  return { receiverId: DCL, actions: [call('cancel_order', args, '1000000000000000')],
    evidence: { ...evidence, orderId: order.order_id, returnAsset: unwrap ? NEAR_ASSET : ftAsset(token), expectedReturn: expected.toString() }, inputs: {},
    confirms: async (receipt, read) => {
      const returned = Array.isArray(receipt.value) && receipt.value[cancel ? 0 : 1];
      if (returned !== expected.toString()) return false;
      // Rhea unwraps wNEAR when sending order proceeds. The wallet verifier already checks all child receipts.
      const paid = unwrap ? receipt.logs?.includes(`Withdraw ${returned} yoctoNEAR from ${DCL}`)
        : await tokenBalance(read, token, account_id) >= before + expected;
      if (!paid) return false;
      const [open, closed] = await Promise.all([active(read), history(read)]);
      const result = (cancel ? closed : [...open, ...closed]).find(item => item.order_id === order.order_id);
      if (!result) return false;
      if (cancel && (result.remain_amount !== '0' || integerAmount(result.cancel_amount) < expected)) return false;
      return result;
    } };
}

const builders = {
  'staking-moves': stakingPlan,
  'liquidity-ranges': liquidityPlan,
  'yield-reallocation': lendingPlan,
  'portfolio-rebalance': portfolioPlan,
  'limit-orders': limitOrderPlan,
};

export async function prepareRangeDeposit(input, policy, {
  execute, ownerId, authorize, connect = connectedOwner, views = testnetViews, transact = ownerTransaction,
} = {}) {
  const { pool, token, amount } = input ?? {};
  const tokens = dclPoolTokens(pool);
  if (Object.keys(input ?? {}).length !== 3 || !tokens?.includes(token) || !rawAmount(amount)) {
    throw new Error('INVALID_DCL_DEPOSIT: provide pool, token and a positive atomic amount.');
  }
  const [x, y] = tokens;
  const activity = 'liquidity-ranges';
  const inputs = { [ftAsset(token)]: amount };
  enforceStrategyPolicy(activity, { pool }, policy, inputs);
  const wallet = await connect({ required: true, ownerId });
  const { accountId, rpcUrl } = wallet;
  async function depositBalance() {
    const { view } = await views(rpcUrl);
    const [market, storage, deposits, balance, receiverStorage] = await Promise.all([
      view(DCL, 'get_pool', { pool_id: pool }),
      view(DCL, 'get_user_storage_detail', { user_id: accountId }),
      view(DCL, 'list_user_assets', { account_id: accountId }),
      tokenBalance(view, token, accountId),
      view(token, 'storage_balance_of', { account_id: DCL }),
    ]);
    if (market?.pool_id !== pool || market.token_x !== x || market.token_y !== y || market.state !== 'Running' ||
        market.whitelist !== null) throw new Error('DCL_POOL_NOT_AVAILABLE');
    if (!storage?.max_slots) throw new Error('DCL_STORAGE_REQUIRED: register your account with Rhea DCL first.');
    if (!receiverStorage) throw new Error('DCL_TOKEN_NOT_REGISTERED_FOR_DEPOSITS');
    if (balance < BigInt(amount)) throw new Error('INSUFFICIENT_WALLET_TOKEN_BALANCE');
    return integerAmount(deposits?.[token] ?? '0');
  }
  let before = await depositBalance();
  // The testnet DCL receiver used about 920 Tgas in the confirmed deposit receipt.
  const actions = [call('ft_transfer_call', { receiver_id: DCL, amount, msg: '"Deposit"' }, '1000000000000000', '1')];
  const plan = { activity, operation: 'deposit', pool, token, amount, receiverId: token, venue: DCL, actions, inputs };
  if (!execute) return { ...plan, status: 'preview', signedTransactions: 0 };
  const receipt = await transact({ ownerId: accountId, receiverId: token, actions, rpcUrl,
    label: `Deposit ${token} into your Rhea liquidity balance on NEAR testnet`,
    context: { kind: 'activity-preparation', activity, pool, token, amount },
  }, {
    beforeSubmit: async () => {
      before = await depositBalance();
      await authorize?.(inputs);
    },
  });
  const after = await (await views(rpcUrl)).view(DCL, 'list_user_assets', { account_id: accountId });
  if (receipt.value !== amount || integerAmount(after?.[token] ?? '0') < before + BigInt(amount)) {
    throw new Error(`DCL_DEPOSIT_UNCONFIRMED: inspect ${receipt.explorerUrl} before retrying.`);
  }
  return { ...plan, status: 'wallet-confirmed', receipt, signedTransactions: 1 };
}

export async function runWalletStrategy(activity, action, policy, {
  execute, operationId, orderClientId, authorize, ownerId, connect = connectedOwner, views = testnetViews, transact = ownerTransaction,
} = {}) {
  const build = builders[activity];
  if (!build) throw new Error(activityBlocker);
  enforceStrategyPolicy(activity, action, policy, {});
  const wallet = await connect({ required: true, ownerId });
  const rpc = await views(wallet.rpcUrl);
  let { confirms, ...plan } = await build(action, wallet.accountId, rpc, policy, orderClientId);
  enforceStrategyPolicy(activity, action, policy, plan.inputs);
  if (!execute) return { status: 'preview', mode: 'wallet', activity, action, network: 'testnet', ownerId: wallet.accountId, ...plan, signedTransactions: 0 };
  const method = plan.actions.at(-1).params.methodName;
  const receipt = await transact({ ownerId: wallet.accountId, receiverId: plan.receiverId, actions: plan.actions,
    label: `${activity} on NEAR testnet · ${method}`, rpcUrl: wallet.rpcUrl, context: { kind: 'activity', activity, action, operationId } }, {
    beforeSubmit: async () => {
      if (activity === 'limit-orders') {
        const fresh = await build(action, wallet.accountId, await views(wallet.rpcUrl), policy, orderClientId);
        if (JSON.stringify(fresh.actions) !== JSON.stringify(plan.actions)) throw new Error('DCL_ORDER_CHANGED: start a new wallet approval.');
        confirms = fresh.confirms;
      } else if (Date.now() - Date.parse(plan.evidence.observedAt) > 60000) {
        throw new Error('STRATEGY_PREVIEW_STALE: start a new wallet approval.');
      }
      await authorize?.(plan.inputs);
    },
  });
  const updated = await views(wallet.rpcUrl);
  const confirmation = await confirms(receipt, updated.view);
  if (!confirmation) throw new Error(`STRATEGY_OUTCOME_UNCONFIRMED: inspect ${receipt.explorerUrl} before another execution. Action ID ${operationId}.`);
  return { status: 'wallet-confirmed', mode: 'wallet', activity, action, network: 'testnet',
    ownerId: wallet.accountId, inputs: plan.inputs, receipt, evidence: plan.evidence, signedTransactions: 1,
    ...(activity === 'limit-orders' ? { order: confirmation } : {}) };
}
