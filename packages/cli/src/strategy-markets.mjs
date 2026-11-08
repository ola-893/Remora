import { JsonRpcProvider } from 'near-api-js';
import { rawAmount } from './copy-activity.mjs';
import { DCL, LENDING, RNEAR } from './strategy-actions.mjs';

export const strategyRpc = 'https://near-testnet.drpc.org';
const amount = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value);
export const integerAmount = value => {
  if (!amount(value)) throw new Error('VENUE_AMOUNT_INVALID');
  return BigInt(value);
};
export async function testnetViews(rpcUrl = strategyRpc) {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  if ((await provider.viewNodeStatus()).chain_id !== 'testnet') throw new Error('STRATEGY_RPC_NETWORK_MISMATCH');
  const block = await provider.viewBlock({ finality: 'final' });
  const at = Number(BigInt(block.header.timestamp_nanosec) / 1000000n);
  if (!Number.isSafeInteger(at) || Math.abs(Date.now() - at) > 60000) throw new Error('STRATEGY_RPC_BLOCK_STALE');
  const view = (contractId, method, args = {}) => provider.callFunction({
    contractId, method, args, blockQuery: { blockId: block.header.hash },
  });
  return { provider, view, observedAt: new Date(at).toISOString(), blockHeight: block.header.height, blockHash: block.header.hash };
}

export async function stakingMarket(pool, views) {
  if (pool === RNEAR) {
    const summary = await views.view(pool, 'get_summary');
    if (!rawAmount(summary?.ft_price)) throw new Error('STAKING_SHARE_PRICE_UNAVAILABLE');
    return { source: 'rhea-rnear', pool, sharePrice: summary.ft_price, blockHeight: views.blockHeight, observedAt: views.observedAt };
  }
  const [total, fee] = await Promise.all([
    views.view(pool, 'get_total_staked_balance'), views.view(pool, 'get_reward_fee_fraction'),
  ]);
  if (!rawAmount(total) || !Number.isInteger(fee?.numerator) || !Number.isInteger(fee?.denominator) ||
      fee.denominator <= 0 || fee.numerator < 0 || fee.numerator > fee.denominator) throw new Error('STAKING_POOL_INVALID');
  return { source: 'near-staking-pool', pool, totalStaked: total, rewardFee: fee, blockHeight: views.blockHeight, observedAt: views.observedAt };
}

export async function liquidityMarket(action, views) {
  const pool = await views.view(DCL, 'get_pool', { pool_id: action.pool });
  const [x, y] = action.pool.split('|');
  if (pool?.pool_id !== action.pool || pool.token_x !== x || pool.token_y !== y || pool.state !== 'Running' ||
      !Number.isInteger(pool.point_delta) || pool.point_delta <= 0 || !Number.isInteger(pool.current_point) ||
      !rawAmount(pool.liquidity) || pool.whitelist !== null) throw new Error('DCL_POOL_NOT_AVAILABLE');
  if (action.left % pool.point_delta || action.right % pool.point_delta) throw new Error('DCL_RANGE_NOT_ALIGNED');
  // Rhea uses X above the current point and Y below it.
  if (action.operation !== 'remove' && ((pool.current_point < action.left && action.amountY !== '0') ||
      (pool.current_point >= action.right && action.amountX !== '0') ||
      (pool.current_point > action.left && pool.current_point < action.right - 1 && (action.amountX === '0' || action.amountY === '0')))) {
    throw new Error('DCL_RANGE_TOKEN_SIDE_MISMATCH');
  }
  return { source: 'rhea-dcl', contract: DCL, pool: pool.pool_id, tokenX: x, tokenY: y, currentPoint: pool.current_point,
    pointDelta: pool.point_delta, fee: pool.fee, inRange: pool.current_point >= action.left && pool.current_point < action.right,
    blockHeight: views.blockHeight, observedAt: views.observedAt };
}

export async function lendingMarket(action, views) {
  const [asset, metadata] = await Promise.all([
    views.view(LENDING, 'get_asset', { token_id: action.token }), views.view(action.token, 'ft_metadata'),
  ]);
  const extraDecimals = asset?.config?.extra_decimals;
  const enabled = action.operation === 'supply' ? asset?.config?.can_deposit : asset?.config?.can_withdraw;
  if (asset?.token_id !== action.token || enabled !== true || !Number.isInteger(extraDecimals) || extraDecimals < 0 ||
      extraDecimals > 24 || !Number.isInteger(metadata?.decimals) || metadata.decimals < 0 || metadata.decimals > 24 ||
      !amount(asset.supplied?.shares) || !amount(asset.supplied?.balance)) throw new Error('LENDING_MARKET_NOT_AVAILABLE');
  return { source: 'rhea-lending', contract: LENDING, token: action.token, decimals: metadata.decimals, extraDecimals,
    totalSupplyShares: asset.supplied.shares, totalSupplyBalance: asset.supplied.balance, supplyAprPercent: asset.supply_apr,
    blockHeight: views.blockHeight, observedAt: views.observedAt };
}

