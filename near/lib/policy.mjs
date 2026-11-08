import { hashQuote, signPermit } from "./permit.mjs";
import { assessQuote, assessPrices } from "@ola-893/agentstreams-core";
export { assessQuote, assessPrices } from "@ola-893/agentstreams-core";

export async function fetchPrices() {
  const json = async (url) => {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!r.ok) throw new Error("Price source unavailable.");
    return r.json();
  };
  const [coinbase, kraken] = await Promise.all([
    json("https://api.coinbase.com/v2/prices/USDC-USD/spot"),
    json("https://api.kraken.com/0/public/Ticker?pair=USDCUSD"),
  ]);
  if (kraken.error?.length) throw new Error("Kraken price source unavailable.");
  const pair = Object.values(kraken.result ?? {})[0];
  const observedAt = Date.now();
  // Spot sources supply no signed market timestamp. This is retrieval freshness,
  // not an independent oracle attestation or proof of the age of a trade.
  return assessPrices(
    [
      { source: "coinbase", usd: Number(coinbase.data?.amount), observedAt },
      { source: "kraken", usd: Number(pair?.c?.[0]), observedAt },
    ],
    observedAt
  );
}

export function approve({
  config,
  vault,
  quote,
  sessionId,
  action,
  privateKey,
}) {
  const permit = {
    domain: "agentpay.near.v1",
    vault_id: config.vaultId,
    agent_id: config.agentId,
    action,
    session_id: sessionId,
    recipient_id: quote.recipient_id,
    rate: quote.rate,
    duration_seconds: quote.duration_seconds,
    quote_hash: hashQuote(quote),
    nonce: vault.next_nonce,
    expires_at: String(Number(vault.now) + 90),
  };
  return signPermit(permit, privateKey);
}
