import { test } from "node:test";
import assert from "node:assert/strict";
import { assessQuote, assessPrices } from "../lib/policy.mjs";
import { formatUSDC, decodeOutcome } from "../sdk/index.mjs";
import { auditHash, verifyRun } from "../lib/audit.mjs";

const now = 100000;
const vault = {
  vault_id: "vault.testnet",
  token_id: "usdc.testnet",
  policy: {
    recipients: ["provider.testnet"],
    max_rate: "100",
    max_deposit: "10000",
    max_duration_seconds: 1000,
    budget: "20000",
  },
  spent: "0",
  available: "100000",
  active_session: null,
  paused: false,
};
const quote = {
  version: 1,
  vault_id: vault.vault_id,
  token_id: vault.token_id,
  recipient_id: "provider.testnet",
  rate: "10",
  duration_seconds: 1000,
  expires_at: now + 60,
};
const assess = (q = {}, v = {}, health = { ok: true, observed_at: now }) =>
  assessQuote({
    vault: { ...vault, ...v },
    quote: { ...quote, ...q },
    health,
    now,
  });
test("admission fails closed for unhealthy, stale, redirected, malformed or oversized quotes", () => {
  assert.equal(assess().decision, "OPEN");
  assert.equal(
    assess({}, {}, { ok: true, observed_at: now - 31 }).reason,
    "SERVICE_UNAVAILABLE"
  );
  assert.equal(
    assess({ recipient_id: "attacker.testnet" }).reason,
    "QUOTE_IDENTITY"
  );
  assert.equal(assess({ rate: "1e3" }).reason, "QUOTE_AMOUNT");
  assert.equal(assess({ expires_at: now }).reason, "QUOTE_EXPIRED");
  assert.equal(assess({ rate: "100" }).reason, "DEPOSIT_LIMIT");
  assert.equal(assess({}, { spent: "10001" }).reason, "BUDGET_LIMIT");
  assert.equal(assess({}, { available: "9999" }).reason, "INSUFFICIENT_FUNDS");
});
test("open-ended admission reserves the owner-selected deposit without a time ceiling", () => {
  const policy = { ...vault.policy, max_duration_seconds: 0 };
  assert.equal(assess({ duration_seconds: 0 }).reason, "DURATION_LIMIT");
  assert.deepEqual(assess({ duration_seconds: 0 }, { policy }), { decision: "OPEN", reason: "WITHIN_POLICY", deposit: "10000" });
  assert.equal(assess({ duration_seconds: 0 }, { policy, available: "9999" }).reason, "INSUFFICIENT_FUNDS");
  assert.equal(assess({ duration_seconds: 0 }, { policy, spent: "10001" }).reason, "BUDGET_LIMIT");
  assert.equal(assess({ rate: "1", duration_seconds: 3153600000 }, { policy: { ...policy, max_deposit: "3153600000", budget: "3153600000" }, available: "3153600000" }).decision, "OPEN");
});
test("price checks reject depeg even when sources agree, stale data and disagreement", () => {
  const samples = (a, b, at = now) => [
    { usd: a, observedAt: at },
    { usd: b, observedAt: at },
  ];
  assert.equal(assessPrices(samples(1, 1), now).decision, "ALLOW");
  assert.equal(assessPrices(samples(0.95, 0.95), now).reason, "USDC_DEPEG");
  assert.equal(
    assessPrices(samples(1.009, 0.991), now).reason,
    "PRICE_DISAGREEMENT"
  );
  assert.equal(
    assessPrices(samples(1, 1, now - 30001), now).reason,
    "PRICE_STALE"
  );
  assert.equal(assessPrices(samples(NaN, 1), now).decision, "DENY");
});
test("six-decimal units preserve precision and unfinished transactions cannot be called receipts", () => {
  assert.equal(formatUSDC("10000"), "0.010000");
  assert.equal(
    formatUSDC("123456789012345678901234"),
    "123456789012345678.901234"
  );
  assert.throws(
    () => decodeOutcome({ final_execution_status: "EXECUTED_OPTIMISTIC" }),
    /not final/
  );
  assert.throws(
    () =>
      decodeOutcome({
        final_execution_status: "FINAL",
        status: { Failure: "rejected" },
      }),
    /failed/
  );
});
test("audit chain detects altered decisions and reordered events", () => {
  const first = {
    runId: "test",
    sequence: 1,
    type: "policy",
    decision: "DENY",
    previousHash: "0".repeat(64),
  };
  const firstEvent = { ...first, eventHash: auditHash(first) };
  const second = {
    runId: "test",
    sequence: 2,
    type: "finished",
    previousHash: firstEvent.eventHash,
  };
  const run = {
    schemaVersion: 1,
    network: "sandbox",
    runId: "test",
    events: [firstEvent, { ...second, eventHash: auditHash(second) }],
    receipts: [],
  };
  assert.equal(verifyRun(run).events, 2);
  const altered = structuredClone(run);
  altered.events[0].decision = "OPEN";
  assert.throws(() => verifyRun(altered), /invalid/);
  assert.throws(
    () => verifyRun({ ...run, events: [...run.events].reverse() }),
    /invalid/
  );
});
