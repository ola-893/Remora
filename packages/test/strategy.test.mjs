import test from 'node:test';
import assert from 'node:assert/strict';
import { DCL, EXCHANGE, LENDING, NEAR_ASSET, RNEAR, ftAsset, sizedStrategyAction, strategyAction, strategyPolicy } from '../cli/src/strategy-actions.mjs';
import { prepareRangeDeposit, runWalletStrategy } from '../cli/src/strategy-wallet.mjs';

const accountId = 'owner.testnet';
const wrap = 'wrap.testnet', rft = 'rft.tokenfactory.testnet';
const token = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const mock = view => ({
  connect: async () => ({ accountId, rpcUrl: 'https://test.invalid' }),
  views: async () => ({ view, blockHeight: 20, observedAt: new Date().toISOString() }),
});
const caps = (...entries) => entries.map(([asset, value]) => asset + '=' + value).join(',');
const plan = (activity, input, guards, views, options) =>
  runWalletStrategy(activity, strategyAction(activity, input), strategyPolicy(activity, guards), { ...mock(views), ...options });

test('Rhea Lending supply is signed for the NEP-141 token and withdrawals use lending precision', async () => {
  const guards = { targets: token, 'max-inputs': caps([ftAsset(token), 1000000]) };
  const view = async (_contract, method) => ({
    get_asset: { token_id: token, config: { extra_decimals: 12, can_deposit: true, can_withdraw: true }, supplied: { shares: '12', balance: '14' } },
    ft_metadata: { decimals: 6 }, storage_balance_of: {}, ft_balance_of: '1000000',
    get_account: { supplied: [{ token_id: token, balance: '1000000000000000000' }] },
  })[method];
  const supply = await plan('yield-reallocation', { token, operation: 'supply', amount: '1000000' }, guards, view);
  assert.equal(supply.receiverId, token);
  assert.equal(supply.actions[0].params.deposit, '1');
  assert.deepEqual(supply.actions[0].params.args, { receiver_id: LENDING, amount: '1000000', msg: '' });
  const withdraw = await plan('yield-reallocation', { token, operation: 'withdraw', amount: '250000' }, guards, view);
  assert.equal(withdraw.actions[0].params.deposit, '1');
  assert.equal(withdraw.receiverId, LENDING);
  assert.deepEqual(withdraw.actions[0].params.args.actions, [{ Withdraw: { token_id: token, max_amount: '250000000000000000' } }]);
});

test('range exits address the follower position with explicit token minimums', async () => {
  const pool = 'usdc.fakes.testnet|wrap.testnet|2000';
  const action = { pool, left: 40, right: 80, operation: 'remove', amount: '200', minX: '0', minY: '10' };
  const policy = strategyPolicy('liquidity-ranges', { targets: pool, 'max-inputs': 'dcl:liquidity=100', 'copy-bps': '5000' });
  const scaled = sizedStrategyAction('liquidity-ranges', action, policy);
  const checked = await runWalletStrategy('liquidity-ranges', scaled, policy, mock(async (_c, method) => ({
    get_pool: { pool_id: pool, token_x: 'usdc.fakes.testnet', token_y: wrap, state: 'Running', point_delta: 40, current_point: 120, liquidity: '1', whitelist: null },
    list_liquidities: [{ lpt_id: pool + '#8', pool_id: pool, left_point: 40, right_point: 80, amount: '1000', mft_id: '' }],
  })[method]));
  assert.equal(checked.receiverId, DCL);
  assert.deepEqual(checked.actions[0].params.args, { lpt_id: pool + '#8', amount: '100', min_amount_x: '0', min_amount_y: '5' });
});

test('range deposits use a guarded wallet transfer and confirm the credited venue balance', async () => {
  const x = 'usdc.fakes.testnet', pool = x + '|' + wrap + '|2000';
  const policy = strategyPolicy('liquidity-ranges', { targets: pool, 'max-inputs': caps([ftAsset(wrap), 25]) });
  const input = { pool, token: wrap, amount: '20' };
  let deposited = '7';
  const view = async (_c, method) => ({
    get_pool: { pool_id: pool, token_x: x, token_y: wrap, state: 'Running', whitelist: null },
    get_user_storage_detail: { max_slots: 20 },
    list_user_assets: { [wrap]: deposited },
    storage_balance_of: { total: '10' },
    ft_balance_of: '100',
  })[method];
  await assert.rejects(prepareRangeDeposit({ ...input, amount: '26' }, policy, mock(view)), /STRATEGY_INPUT_LIMIT/);
  await assert.rejects(prepareRangeDeposit({ ...input, token: rft }, policy, mock(view)), /INVALID_DCL_DEPOSIT/);
  const preview = await prepareRangeDeposit(input, policy, mock(view));
  assert.equal(preview.signedTransactions, 0);
  assert.deepEqual(preview.actions[0].params, { methodName: 'ft_transfer_call',
    args: { receiver_id: DCL, amount: '20', msg: '"Deposit"' }, gas: '1000000000000000', deposit: '1' });
  let authorized = false;
  const receipt = { value: '20', explorerUrl: 'https://testnet.nearblocks.io/txns/test-receipt' };
  const options = { ...mock(view), execute: true, authorize: async inputs => {
    assert.deepEqual(inputs, { [ftAsset(wrap)]: '20' });
    authorized = true;
  } };
  await assert.rejects(prepareRangeDeposit(input, policy, { ...options, transact: async (_plan, { beforeSubmit }) => {
    await beforeSubmit();
    return receipt;
  } }), /DCL_DEPOSIT_UNCONFIRMED/);
  const result = await prepareRangeDeposit(input, policy, { ...options, transact: async (tx, { beforeSubmit }) => {
    assert.equal(tx.receiverId, wrap);
    await beforeSubmit();
    deposited = '27';
    return receipt;
  } });
  assert.equal(authorized, true);
  assert.equal(result.status, 'wallet-confirmed');
});

test('a full range exit confirms when its position disappears from the owner list', async () => {
  const pool = 'usdc.fakes.testnet|wrap.testnet|2000';
  const action = { pool, left: 40, right: 80, operation: 'remove', amount: '200', minX: '0', minY: '10' };
  let positions = [{ lpt_id: pool + '#8', pool_id: pool, left_point: 40, right_point: 80, amount: '200' }];
  const view = async (_c, method) => ({
    get_pool: { pool_id: pool, token_x: 'usdc.fakes.testnet', token_y: wrap, state: 'Running', point_delta: 40, current_point: 120, liquidity: '1', whitelist: null },
    list_liquidities: positions,
  })[method];
  const result = await plan('liquidity-ranges', action, { targets: pool, 'max-inputs': 'dcl:liquidity=200' }, view, {
    execute: true,
    transact: async () => { positions = []; return { value: null }; },
  });
  assert.equal(result.status, 'wallet-confirmed');
});

test('a range entry confirms the receipt position and rejects an unrelated range', async () => {
  const tokenX = 'usdc.fakes.testnet', pool = tokenX + '|' + wrap + '|2000';
  const action = { pool, left: 40, right: 80, amountX: '0', amountY: '100', minX: '0', minY: '90' };
  const guard = { targets: pool, 'max-inputs': caps([ftAsset(wrap), 100]) };
  const lpt_id = pool + '#3';
  let positions = [];
  const view = async (_c, method) => ({
    get_pool: { pool_id: pool, token_x: tokenX, token_y: wrap, state: 'Running', point_delta: 40, current_point: 120, liquidity: '1', whitelist: null },
    list_liquidities: positions,
    get_user_storage_detail: { cur_order_slots: 0, cur_liquidity_slots: 0, max_slots: 20 },
    list_user_assets: { [wrap]: '100' },
  })[method];
  const execute = right_point => plan('liquidity-ranges', action, guard, view, {
    execute: true,
    transact: async (tx, { beforeSubmit }) => {
      assert.equal(tx.actions[0].params.methodName, 'add_liquidity');
      assert.equal(tx.actions[0].params.deposit, '0');
      await beforeSubmit();
      positions = [{ lpt_id, pool_id: pool, left_point: 40, right_point }];
      return { value: lpt_id, explorerUrl: 'https://testnet.nearblocks.io/txns/test-receipt' };
    },
  });
  await assert.rejects(execute(120), /STRATEGY_OUTCOME_UNCONFIRMED/);
  positions = [];
  assert.equal((await execute(80)).status, 'wallet-confirmed');
});

test('rebalance uses deposited balances, pool reserves, and a fresh Rhea minimum output', async () => {
  const view = async (_c, method, args) => {
    if (method === 'get_pool') return { pool_kind: 'SIMPLE_POOL', token_account_ids: [wrap, rft], amounts: ['10000000', '20000000'] };
    if (method === 'get_deposits') return { [wrap]: '1000', [rft]: '100' };
    assert.deepEqual(args, { pool_id: 0, token_in: wrap, token_out: rft, amount_in: '475' });
    return '948';
  };
  const input = { poolId: 0, base: wrap, amount: '500', weights: { [wrap]: 5000, [rft]: 5000 } };
  const guard = { targets: '0', assets: [wrap, rft].map(ftAsset).join(','), 'max-inputs': caps([ftAsset(wrap), 475]) };
  const checked = await plan('portfolio-rebalance', input, guard, view);
  assert.equal(checked.receiverId, EXCHANGE);
  assert.equal(checked.actions[0].params.deposit, '1');
  assert.equal(checked.actions[0].params.args.actions[0].min_amount_out, '938');
  await assert.rejects(plan('portfolio-rebalance', input, { ...guard, 'max-inputs': caps([ftAsset(wrap), 474]) }, view), /STRATEGY_INPUT_LIMIT/);
});

test('limit-order placement checks guards and the latest pool tick before opening an order', async () => {
  const buyToken = 'usdc.fakes.testnet', pool = buyToken + '|' + wrap + '|2000';
  const orderClientId = 'a'.repeat(32);
  const order = { client_id: orderClientId, owner_id: accountId, pool_id: pool, order_id: pool + '#19',
    point: 80, sell_token: wrap, buy_token: buyToken, original_deposit_amount: '100',
    original_amount: '100', remain_amount: '100', swap_earn_amount: '0' };
  const input = { pool, operation: 'place', sellToken: wrap, point: 80, amount: '100' };
  const guard = { targets: pool, 'max-inputs': caps([ftAsset(wrap), 100]) };
  let tick = 120, open = [];
  const view = async (_c, method) => ({
    get_pool: { pool_id: pool, token_x: buyToken, token_y: wrap, state: 'Running', point_delta: 40, current_point: tick, whitelist: null },
    get_user_storage_detail: { max_slots: 20, cur_order_slots: 0, cur_liquidity_slots: 0 },
    storage_balance_of: {}, ft_balance_of: '1000', list_active_orders: open, list_history_orders: [],
  })[method];
  await assert.rejects(plan('limit-orders', { ...input, point: 81 }, guard, view, { orderClientId }), /POINT_NOT_ALIGNED/);
  await assert.rejects(plan('limit-orders', { ...input, amount: '101' }, guard, view, { orderClientId }), /STRATEGY_INPUT_LIMIT/);
  await assert.rejects(plan('limit-orders', input, guard, view, { orderClientId, execute: true, transact: async (_tx, { beforeSubmit }) => {
    tick = 80;
    await beforeSubmit();
    assert.fail('a crossed order must not reach signing');
  } }), /ORDER_WOULD_CROSS_MARKET/);
  tick = 120;
  const confirmed = await plan('limit-orders', input, guard, view, { orderClientId, execute: true, transact: async (tx, { beforeSubmit }) => {
    const { args } = tx.actions[0].params;
    assert.deepEqual(JSON.parse(args.msg), { LimitOrderWithSwap: { pool_id: pool, buy_token: buyToken, point: 80, client_id: orderClientId } });
    await beforeSubmit();
    open = [order];
    return { value: '100' };
  } });
  assert.equal(confirmed.order.order_id, order.order_id);
  await assert.rejects(plan('limit-orders', input, guard, view, { orderClientId }), /ORDER_ALREADY_PLACED/);
});

test('limit-order cancellation and claim are tied to the wallet and copy placement reference', async () => {
  const buyToken = 'usdc.fakes.testnet', pool = buyToken + '|' + wrap + '|2000';
  const orderClientId = 'a'.repeat(32), placement = 'b'.repeat(64);
  const follower = { client_id: orderClientId, owner_id: accountId, pool_id: pool, order_id: pool + '#23',
    sell_token: wrap, buy_token: buyToken, remain_amount: '70', unclaimed_amount: '30' };
  const leader = { ...follower, client_id: 'c'.repeat(32), order_id: pool + '#22' };
  const otherWallet = { ...follower, owner_id: 'other.testnet', order_id: pool + '#24' };
  const guards = { targets: pool, 'max-inputs': caps([ftAsset(wrap), 100]) };
  let open = [leader, follower, otherWallet], closed = [], balance = 100;
  const view = async (_c, method) => ({
    list_active_orders: open, list_history_orders: closed, ft_balance_of: String(balance),
  })[method];
  const cancel = { pool, operation: 'cancel', placement };
  const claim = { ...cancel, operation: 'claim' };
  assert.deepEqual(sizedStrategyAction('limit-orders', cancel, { copyBps: 5000 }), cancel);
  const claimPreview = await plan('limit-orders', claim, guards, view, { orderClientId });
  assert.deepEqual(claimPreview.actions[0].params.args, { order_id: follower.order_id, amount: '0' });
  const claimed = await plan('limit-orders', claim, guards, view, { orderClientId, execute: true, transact: async (_tx, { beforeSubmit }) => {
    await beforeSubmit();
    open = [leader, { ...follower, unclaimed_amount: '0' }, otherWallet];
    balance += 30;
    return { value: ['0', '30'] };
  } });
  assert.equal(claimed.order.remain_amount, '70');
  await assert.rejects(plan('limit-orders', claim, guards, view, { orderClientId }), /DCL_NO_ORDER_PROCEEDS/);
  await assert.rejects(plan('limit-orders', cancel, guards, view, { orderClientId: 'd'.repeat(32) }), /DCL_LOCAL_ORDER_NOT_FOUND/);
  const result = await plan('limit-orders', cancel, guards, view, { orderClientId, execute: true, transact: async (tx, { beforeSubmit }) => {
    assert.equal(tx.actions[0].params.deposit, '0');
    assert.deepEqual(tx.actions[0].params.args, { order_id: follower.order_id, amount: '70' });
    await beforeSubmit();
    open = [leader, otherWallet];
    closed = [{ ...follower, remain_amount: '0', cancel_amount: '70' }];
    return { value: ['70', '0'], logs: [`Withdraw 70 yoctoNEAR from ${DCL}`] };
  } });
  assert.equal(result.order.order_id, follower.order_id);
  await assert.rejects(plan('limit-orders', cancel, guards, view, { orderClientId }), /DCL_LOCAL_ORDER_NOT_FOUND/);
});

test('wallet submission checks authority again and an expired authorization prevents broadcast', async () => {
  const view = async (_c, method) => method === 'get_summary'
    ? { ft_price: '1000000000000000000000000' }
    : { staked_balance: '100', unstaked_balance: '0' };
  const guard = { targets: RNEAR, 'max-inputs': caps([NEAR_ASSET, 100]) };
  let broadcast = false;
  const unstake = await plan('staking-moves', { pool: RNEAR, operation: 'unstake', amount: '50' }, guard, view);
  assert.equal(unstake.actions.at(-1).params.methodName, 'unstake');
  assert.equal(unstake.actions.at(-1).params.deposit, '0');
  await assert.rejects(plan('staking-moves', { pool: RNEAR, operation: 'unstake', amount: '50' }, guard, view, {
    execute: true,
    authorize: async inputs => { assert.deepEqual(inputs, { [NEAR_ASSET]: '50' }); throw new Error('COPY_AUTHORITY_EXPIRED'); },
    transact: async (_plan, { beforeSubmit }) => { await beforeSubmit(); broadcast = true; },
  }), /COPY_AUTHORITY_EXPIRED/);
  assert.equal(broadcast, false);
});

test('a veto-mode strategy without a matching grant never prepares or opens a wallet transaction', async () => {
  const guard = { targets: RNEAR, 'max-inputs': caps([NEAR_ASSET, 100]) };
  await assert.rejects(plan('staking-moves', { pool: RNEAR, operation: 'unstake', amount: '50' }, guard, async () => {
    assert.fail('Veto execution tried to read the venue without a grant');
  }, { execute: true, requireGrant: true, transact: async () => assert.fail('Veto execution opened a wallet transaction') }), /COPY_VETO_GRANT_REQUIRED/);
});
