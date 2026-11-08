import { OneClickService, verifyQuoteSignature } from '@defuse-protocol/one-click-sdk-typescript';
import { USDC } from '@ola-893/agentstreams-core/near';
import { assetId, operationKey, rawAmount } from './copy-activity.mjs';

const quoteContext = 'intents.near';
const maxQuoteAge = 30000;
const assetLabels = new Map([[`nep141:${USDC.mainnet}`, 'USDC'], ['nep141:wrap.near', 'wNEAR']]);
const displayAmount = value => typeof value === 'string' && /^\d{1,38}(?:\.\d{1,38})?$/.test(value) ? value : undefined;

export function paperSeed(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Use --paper-balances ASSET=RAW[,ASSET=RAW] to seed a virtual portfolio.');
  const entries = value.split(',').map(item => item.split('='));
  if (entries.length > 32 || entries.some(entry => entry.length !== 2 || !assetId(entry[0]) || !rawAmount(entry[1])) ||
      new Set(entries.map(entry => entry[0])).size !== entries.length) throw new Error('Paper balances require unique asset IDs and positive integer amounts.');
  return Object.fromEntries(entries);
}

export async function paperQuote(order, slippageBps) {
  const request = {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: slippageBps,
    originAsset: order.origin_asset,
    destinationAsset: order.destination_asset,
    amount: order.amount,
    depositType: 'INTENTS',
    refundTo: quoteContext,
    refundType: 'INTENTS',
    recipient: quoteContext,
    recipientType: 'INTENTS',
    deadline: new Date(Date.now() + 600000).toISOString(),
  };
  const pending = OneClickService.getQuote(request);
  const timeout = setTimeout(() => pending.cancel(), 15000);
  let response;
  try { response = await pending; }
  catch (error) { throw new Error(error.status ? `ONE_CLICK_QUOTE_HTTP_${error.status}` : 'ONE_CLICK_QUOTE_UNAVAILABLE'); }
  finally { clearTimeout(timeout); }

  const { quoteRequest, quote } = response ?? {};
  if (!quote || !quoteRequest || !Object.entries(request).every(([key, value]) => quoteRequest[key] === value) ||
      quote.depositAddress || quote.depositMemo || quote.amountIn !== order.amount || !rawAmount(quote.amountOut) ||
      !rawAmount(quote.minAmountOut) || BigInt(quote.minAmountOut) > BigInt(quote.amountOut)) throw new Error('ONE_CLICK_QUOTE_MISMATCH');
  const observedAt = Date.parse(response.timestamp);
  if (!Number.isFinite(observedAt) || observedAt > Date.now() + 5000 || Date.now() - observedAt > maxQuoteAge) throw new Error('ONE_CLICK_QUOTE_STALE');
  if (!verifyQuoteSignature(response)) throw new Error('ONE_CLICK_QUOTE_SIGNATURE_INVALID');
  return {
    source: 'near-intents-1click', dry: true, signatureVerified: true, observedAt: response.timestamp,
    amountIn: quote.amountIn, amountOut: quote.amountOut, minAmountOut: quote.minAmountOut,
    amountInFormatted: displayAmount(quote.amountInFormatted), amountOutFormatted: displayAmount(quote.amountOutFormatted),
    amountInUsd: quote.amountInUsd ?? null, warnings: [], signedResponse: response,
  };
}

export function paperBalances(portfolio, order, quote) {
  if (Date.now() - Date.parse(quote.observedAt) > maxQuoteAge) throw new Error('ONE_CLICK_QUOTE_STALE');
  const { origin_asset: from, destination_asset: to, amount } = order;
  const balances = portfolio.balances;
  const remaining = BigInt(Object.hasOwn(balances, from) ? balances[from] : '0') - BigInt(amount);
  if (remaining < 0n) throw new Error('INSUFFICIENT_PAPER_BALANCE');
  return { ...balances, [from]: remaining.toString(), [to]: (BigInt(Object.hasOwn(balances, to) ? balances[to] : '0') + BigInt(quote.amountOut)).toString() };
}

export function paperFill(order, quote, id, copiedFrom) {
  const at = Date.now();
  return { id, at, expiresAt: at + 120000, from: order.origin_asset, to: order.destination_asset, amountIn: order.amount, amountOut: quote.amountOut,
    ...(quote.amountInFormatted !== undefined ? { amountInFormatted: quote.amountInFormatted } : {}),
    ...(quote.amountOutFormatted !== undefined ? { amountOutFormatted: quote.amountOutFormatted } : {}),
    execution: 'paper', settlementRef: `1click-dry:${operationKey('quote', JSON.stringify(quote.signedResponse))}`,
    quoteObservedAt: quote.observedAt, ...(copiedFrom ? { copiedFrom } : {}) };
}

export function describePaperFill(fill) {
  const amount = (asset, formatted, raw) => {
    const label = assetLabels.get(asset) ?? asset;
    return displayAmount(formatted) ? `${formatted} ${label}` : `${raw} atomic units of ${label}`;
  };
  return `Paper trade filled. Spent ${amount(fill.from, fill.amountInFormatted, fill.amountIn)} and received ${amount(fill.to, fill.amountOutFormatted, fill.amountOut)}.`;
}
