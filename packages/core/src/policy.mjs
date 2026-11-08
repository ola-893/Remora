export function assessQuote({
  vault,
  quote,
  health,
  now = Math.floor(Date.now() / 1000),
}) {
  const deny = (reason) => ({ decision: "DENY", reason });
  if (
    !health ||
    health.ok !== true ||
    !Number.isSafeInteger(health.observed_at) ||
    Math.abs(now - health.observed_at) > 30
  )
    return deny("SERVICE_UNAVAILABLE");
  if (
    !quote ||
    quote.version !== 1 ||
    quote.vault_id !== vault.vault_id ||
    quote.token_id !== vault.token_id ||
    !vault.policy.recipients.includes(quote.recipient_id)
  )
    return deny("QUOTE_IDENTITY");
  if (
    typeof quote.rate !== "string" ||
    !/^[1-9][0-9]{0,37}$/.test(quote.rate) ||
    !Number.isSafeInteger(quote.duration_seconds) ||
    quote.duration_seconds < 0 ||
    quote.duration_seconds > 4294967295
  )
    return deny("QUOTE_AMOUNT");
  if (
    !Number.isSafeInteger(quote.expires_at) ||
    quote.expires_at <= now ||
    quote.expires_at > now + 300
  )
    return deny("QUOTE_EXPIRED");
  const rate = BigInt(quote.rate),
    deposit = quote.duration_seconds === 0 ? BigInt(vault.policy.max_deposit) : rate * BigInt(quote.duration_seconds);
  if (vault.paused) return deny("PAUSED");
  if (vault.active_session) return deny("ACTIVE_STREAM");
  if (rate > BigInt(vault.policy.max_rate)) return deny("RATE_LIMIT");
  if (vault.policy.max_duration_seconds !== 0 && (quote.duration_seconds === 0 || quote.duration_seconds > vault.policy.max_duration_seconds))
    return deny("DURATION_LIMIT");
  if (deposit > BigInt(vault.policy.max_deposit)) return deny("DEPOSIT_LIMIT");
  if (BigInt(vault.spent) + deposit > BigInt(vault.policy.budget))
    return deny("BUDGET_LIMIT");
  if (deposit > BigInt(vault.available)) return deny("INSUFFICIENT_FUNDS");
  return {
    decision: "OPEN",
    reason: "WITHIN_POLICY",
    deposit: deposit.toString(),
  };
}

export function assessPrices(samples, now = Date.now()) {
  if (!Array.isArray(samples) || samples.length !== 2)
    return { decision: "DENY", reason: "PRICE_UNAVAILABLE" };
  if (
    samples.some(
      (s) =>
        !Number.isFinite(s.usd) ||
        s.usd <= 0 ||
        !Number.isSafeInteger(s.observedAt) ||
        Math.abs(now - s.observedAt) > 30000
    )
  )
    return { decision: "DENY", reason: "PRICE_STALE" };
  if (samples.some((s) => Math.abs(s.usd - 1) > 0.02))
    return { decision: "DENY", reason: "USDC_DEPEG" };
  if (Math.abs(samples[0].usd - samples[1].usd) > 0.01)
    return { decision: "DENY", reason: "PRICE_DISAGREEMENT" };
  return { decision: "ALLOW", reason: "PRICE_CHECKED", samples };
}
