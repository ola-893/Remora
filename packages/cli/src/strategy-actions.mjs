import { assetId, rawAmount, spot } from './copy-activity.mjs';

export const nativeWalletActivities = new Set([
  'staking-moves', 'liquidity-ranges', 'portfolio-rebalance', 'yield-reallocation', 'limit-orders',
]);
export const strategyActivities = new Set([...nativeWalletActivities, 'prediction-markets']);
export const NEAR_ASSET = 'near:testnet';
export const DCL = 'dclv2.ref-dev.testnet';
export const LENDING = 'contract.1689937928.burrow.testnet';
export const RNEAR = 'lst.ref-dev.testnet';
export const EXCHANGE = 'ref-finance-101.testnet';
export const activityBlocker = 'PREDICTION_TESTNET_VENUE_UNAVAILABLE: an active NEAR testnet market with a verified order and settlement interface is required.';
export const ftAsset = token => 'nep141:' + token;
export const tokenId = value => typeof value === 'string' && /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(value) && (value.endsWith('.testnet') || /^[0-9a-f]{64}$/.test(value));
const map = value => value && typeof value === 'object' && !Array.isArray(value);
const amountOrZero = value => value === '0' || rawAmount(value);
const invalid = () => { throw new Error('INVALID_ACTIVITY_ACTION: see the activity examples in the CLI README.'); };
const operation = (value, options) => { if (!options.includes(value)) invalid(); return value; };
const tick = value => Number.isInteger(value) && Math.abs(value) <= 800000;

export function dclPoolTokens(pool) {
  const [x, y, fee, ...rest] = typeof pool === 'string' ? pool.split('|') : [];
  if (tokenId(x) && tokenId(y) && x < y && /^\d{1,6}$/.test(fee ?? '') && !rest.length) return [x, y];
}

export function strategyAction(activity, input) {
  if (!map(input)) invalid();
  const { operation: op, amount } = input;
  switch (activity) {
    case 'staking-moves':
      if (!tokenId(input.pool) || !input.pool.endsWith('.testnet') || !rawAmount(amount)) invalid();
      return { pool: input.pool, operation: operation(op, ['stake', 'unstake', 'withdraw']), amount };
    case 'liquidity-ranges': {
      if (!dclPoolTokens(input.pool)) invalid();
      if (op === 'remove') {
        if (!tick(input.left) || !tick(input.right) || input.left >= input.right || !rawAmount(amount) ||
            !amountOrZero(input.minX) || !amountOrZero(input.minY) || (input.minX === '0' && input.minY === '0')) invalid();
        return { pool: input.pool, operation: op, left: input.left, right: input.right, amount, minX: input.minX, minY: input.minY };
      }
      if (op !== undefined || !tick(input.left) || !tick(input.right) || input.left >= input.right ||
          !amountOrZero(input.amountX) || !amountOrZero(input.amountY) || (input.amountX === '0' && input.amountY === '0')) invalid();
      const result = { pool: input.pool, left: input.left, right: input.right, amountX: input.amountX, amountY: input.amountY };
      if (input.minX !== undefined || input.minY !== undefined) {
        if (!amountOrZero(input.minX) || !amountOrZero(input.minY) || BigInt(input.minX) > BigInt(input.amountX) || BigInt(input.minY) > BigInt(input.amountY)) invalid();
        Object.assign(result, { minX: input.minX, minY: input.minY });
      }
      return result;
    }
    case 'prediction-markets': throw new Error(activityBlocker);
    case 'portfolio-rebalance': {
      if (!Number.isSafeInteger(input.poolId) || input.poolId < 0 || !tokenId(input.base) || !rawAmount(amount) || !map(input.weights)) invalid();
      const weights = Object.entries(input.weights).sort(([a], [b]) => a.localeCompare(b));
      if (weights.length !== 2 || !Object.hasOwn(input.weights, input.base) ||
          !weights.every(([asset, weight]) => tokenId(asset) && validInteger(weight, 0, 10000)) ||
          weights.reduce((sum, [, weight]) => sum + weight, 0) !== 10000) invalid();
      return { poolId: input.poolId, base: input.base, amount, weights: Object.fromEntries(weights) };
    }
    case 'yield-reallocation':
      if (!tokenId(input.token) || !rawAmount(amount)) invalid();
      return { token: input.token, operation: operation(op, ['supply', 'withdraw']), amount };
    case 'limit-orders': {
      const { pool, sellToken, point, placement } = input;
      const tokens = dclPoolTokens(pool);
      if (!tokens) invalid();
      if (op === 'place') {
        if (!tokens.includes(sellToken) || !tick(point) || !rawAmount(amount)) invalid();
        return { pool, operation: op, sellToken, point, amount };
      }
      if (typeof placement !== 'string' || !/^[a-f0-9]{64}$/.test(placement)) invalid();
      return { pool, operation: operation(op, ['cancel', 'claim']), placement };
    }
    default: throw new Error('UNKNOWN_STRATEGY_ACTIVITY');
  }
}

export function strategyTarget(activity, action) {
  switch (activity) {
    case 'staking-moves': return action.pool;
    case 'liquidity-ranges': return action.pool;
    case 'limit-orders': return action.pool;
    case 'portfolio-rebalance': return String(action.poolId);
    case 'yield-reallocation': return action.token;
    default: throw new Error('UNKNOWN_STRATEGY_ACTIVITY');
  }
}

const validInteger = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
export function strategyPolicy(activity, flags, previous = {}) {
  const targets = flags.targets?.split(',') ?? previous.targets;
  const caps = flags['max-inputs'] === undefined ? previous.caps :
    Object.fromEntries(flags['max-inputs'].split(',').map(value => {
      const [asset, amount, ...extra] = value.split('=');
      if (extra.length || !assetId(asset) || !rawAmount(amount)) throw new Error('Use --max-inputs ASSET=RAW[,ASSET=RAW].');
      return [asset, amount];
    }));
  const maxAge = Number(flags['max-age'] ?? previous.maxAge ?? 120);
  const copyBps = Number(flags['copy-bps'] ?? previous.copyBps ?? 10000);
  const slippageBps = Number(flags['max-slippage-bps'] ?? previous.slippageBps ?? 100);
  const assets = flags.assets?.split(',') ?? previous.assets;
  if (!targets?.length || targets.length > 32 || !targets.every(target => target && target.length <= 200) ||
      !Object.keys(caps ?? {}).length || Object.keys(caps ?? {}).length > 32) throw new Error('Set --targets and --max-inputs.');
  if (!validInteger(maxAge, 1, 3600) || !validInteger(copyBps, 1, 10000) || !validInteger(slippageBps, 0, 500)) throw new Error('Invalid activity age, sizing or slippage limit.');
  if (activity === 'portfolio-rebalance' && (!assets?.length || assets.length > 5 || !assets.every(assetId))) throw new Error('Set --assets for portfolio rebalancing.');
  return { targets, caps: caps ?? {}, maxAge, copyBps, slippageBps, ...(assets ? { assets } : {}) };
}

export function sizedStrategyAction(activity, action, policy) {
  const scaled = { ...action };
  const keys = activity === 'liquidity-ranges' ? ['amount', 'amountX', 'amountY', 'minX', 'minY'] : ['amount'];
  for (const key of keys) if (scaled[key] !== undefined) {
    scaled[key] = (BigInt(scaled[key]) * BigInt(policy.copyBps) / 10000n).toString();
  }
  return strategyAction(activity, scaled);
}

export function enforceStrategyPolicy(activity, action, policy, inputs) {
  if (!policy) throw new Error('EXECUTION_POLICY_REQUIRED');
  if (!policy.targets.includes(strategyTarget(activity, action))) throw new Error('STRATEGY_TARGET_NOT_ALLOWED');
  if (activity === 'portfolio-rebalance' && Object.keys(action.weights).some(asset => !policy.assets?.includes(ftAsset(asset)))) throw new Error('ASSET_NOT_ALLOWED');
  for (const [asset, amount] of Object.entries(inputs)) {
    if (BigInt(amount) > BigInt(Object.hasOwn(policy.caps, asset) ? policy.caps[asset] : '0')) throw new Error('STRATEGY_INPUT_LIMIT: ' + asset);
  }
}

export function promptActivity(state) {
  const wallet = [...nativeWalletActivities].filter(activity => state?.tasks?.[activity]?.mode === 'wallet').sort();
  if (wallet.length > 1) throw new Error('Several NEAR activities are enabled. Pass --activity.');
  if (wallet.length === 1) return wallet[0];
  if (state?.tasks?.[spot]?.mode === 'paper') return spot;
  return null;
}

export const activityMode = (state, activity) => activity === spot
  ? state.tasks[spot]?.mode ?? (state.tasks[spot] ? 'agent-connect' : null)
  : nativeWalletActivities.has(activity) && state.tasks[activity]?.mode === 'wallet' ? 'wallet' : null;
