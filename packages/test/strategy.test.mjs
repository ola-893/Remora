import test from 'node:test';
import assert from 'node:assert/strict';
import { DCL, EXCHANGE, LENDING, NEAR_ASSET, RNEAR, ftAsset, sizedStrategyAction, strategyAction, strategyPolicy } from '../cli/src/strategy-actions.mjs';
import { runWalletStrategy } from '../cli/src/strategy-wallet.mjs';

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
  assert.deepEqual(supply.actions[0].params.args, { receiver_id: LENDING, amount: '1000000', msg: '' });
  const withdraw = await plan('yield-reallocation', { token, operation: 'withdraw', amount: '250000' }, guards, view);
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
  assert.equal(checked.actions[0].params.args.actions[0].min_amount_out, '938');
  await assert.rejects(plan('portfolio-rebalance', input, { ...guard, 'max-inputs': caps([ftAsset(wrap), 474]) }, view), /STRATEGY_INPUT_LIMIT/);
});

test('reward compounding claims the connected owner’s lending rewards without spending a token balance', async () => {
  const rewards = [{ rewards: [{ reward_token_id: wrap, unclaimed_amount: '500' }] }];
  const guard = { targets: LENDING };
  const checked = await plan('reward-reinvestment', { operation: 'compound' }, guard, async () => ({ farms: rewards }));
  assert.deepEqual(checked.evidence.unclaimedInternalUnits, { [wrap]: '500' });
  assert.deepEqual(checked.inputs, {});
  assert.deepEqual(checked.actions[0].params, { methodName: 'account_farm_claim_all', args: {}, gas: '200000000000000', deposit: '0' });
  await assert.rejects(plan('reward-reinvestment', { operation: 'compound' }, guard, async () => ({ farms: [] })), /NO_CLAIMABLE_LENDING_REWARDS/);
});

test('wallet submission checks authority again and an expired authorization prevents broadcast', async () => {
  const view = async (_c, method) => method === 'get_summary'
    ? { ft_price: '1000000000000000000000000' }
    : { staked_balance: '100', unstaked_balance: '0' };
  const guard = { targets: RNEAR, 'max-inputs': caps([NEAR_ASSET, 100]) };
  let broadcast = false;
  await assert.rejects(plan('staking-moves', { pool: RNEAR, operation: 'unstake', amount: '50' }, guard, view, {
    execute: true,
    authorize: async inputs => { assert.deepEqual(inputs, { [NEAR_ASSET]: '50' }); throw new Error('COPY_AUTHORITY_EXPIRED'); },
    transact: async (_plan, { beforeSubmit }) => { await beforeSubmit(); broadcast = true; },
  }), /COPY_AUTHORITY_EXPIRED/);
  assert.equal(broadcast, false);
});
