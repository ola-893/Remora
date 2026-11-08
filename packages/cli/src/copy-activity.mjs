import { createHash } from 'node:crypto';
import { usdc } from './settings.mjs';

export const activities = Object.freeze({
  'spot-trading': 'Mirror an eligible spot swap.',
  'staking-moves': 'Follow validator or staking pool allocations.',
  'liquidity-ranges': 'Mirror concentrated-liquidity ranges.',
  'prediction-markets': 'Mirror outcome positions.',
  'portfolio-rebalance': 'Follow portfolio target weights.',
  'yield-reallocation': 'Follow lending or yield-vault allocations.',
  'limit-orders': 'Mirror Rhea limit-order placement, cancellation and claims.',
});

export const spot = 'spot-trading';
export const assetId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9:._-]{0,155}$/i.test(value);
export const rawAmount = value => typeof value === 'string' && /^[1-9][0-9]{0,37}$/.test(value);

export function spotOrder({ from, to, amount }) {
  if (!assetId(from) || !assetId(to) || from === to || !rawAmount(amount)) throw new Error('Specify distinct --from and --to asset IDs and --amount-raw in the input asset’s atomic units.');
  return { origin_asset: from, destination_asset: to, amount };
}

export function executionPolicy(flags, previous = {}) {
  const assets = flags.assets?.split(',') ?? previous.assets;
  const maxInput = flags['max-input-raw'] ?? previous.maxInput;
  const inputAsset = flags['input-asset'] ?? previous.inputAsset;
  const fixedInput = flags['copy-input-raw'] ?? previous.fixedInput;
  const maxAge = Number(flags['max-age'] ?? previous.maxAge ?? 60);
  const slippageBps = Number(flags['max-slippage-bps'] ?? previous.slippageBps ?? 50);
  if (!assets?.length || assets.length > 32 || !assets.every(assetId) || !assets.includes(inputAsset) || !rawAmount(maxInput) || !rawAmount(fixedInput) || BigInt(fixedInput) > BigInt(maxInput)) throw new Error('Set --assets, --input-asset, --max-input-raw and --copy-input-raw. Use one input asset so caps have a consistent unit.');
  if (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > 3600 || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 500) throw new Error('Use --max-age 1–3600 seconds and --max-slippage-bps 0–500.');
  return { assets: [...new Set(assets)], inputAsset, maxInput, fixedInput, maxAge, slippageBps,
    ...(flags['max-notional'] ? { maxNotionalRawUSDC: usdc(flags['max-notional']) } : previous.maxNotionalRawUSDC ? { maxNotionalRawUSDC: previous.maxNotionalRawUSDC } : {}) };
}

export function proposedOrder(action, policy, now = Date.now()) {
  if (!policy) return { reason: 'EXECUTION_POLICY_REQUIRED' };
  if (action.at > now + 5000 || now - action.at > policy.maxAge * 1000 || now >= action.expiresAt) return { reason: 'ACTION_EXPIRED' };
  if (action.from !== policy.inputAsset || !policy.assets.includes(action.to)) return { reason: 'ASSET_NOT_ALLOWED' };
  return { order: spotOrder({ from: action.from, to: action.to, amount: policy.fixedInput }) };
}

export function checkQuote(quote, order, action, policy) {
  if (!rawAmount(quote.amountOut) || !rawAmount(quote.amountIn) || quote.amountIn !== order.amount) return 'UNUSABLE_QUOTE';
  const expected = BigInt(action.amountOut) * BigInt(order.amount);
  const observed = BigInt(quote.amountOut) * BigInt(action.amountIn);
  if (observed * 10000n < expected * BigInt(10000 - policy.slippageBps)) return 'PRICE_MOVED';
  if (policy.maxNotionalRawUSDC) {
    let usd;
    const price = String(quote.amountInUsd);
    if (!/^[0-9]{1,25}(\.[0-9]{1,30})?$/.test(price)) return 'USD_PRICE_UNAVAILABLE';
    const [whole, fractional = ''] = price.split('.');
    usd = BigInt(whole) * 1000000n + BigInt(fractional.slice(0, 6).padEnd(6, '0'));
    if (/[1-9]/.test(fractional.slice(6))) usd++;
    if (usd > BigInt(policy.maxNotionalRawUSDC)) return 'NOTIONAL_LIMIT';
  }
  return null;
}

export const operationKey = (agentId, actionId) => createHash('sha256').update(`${agentId}:${actionId}`).digest('hex');
