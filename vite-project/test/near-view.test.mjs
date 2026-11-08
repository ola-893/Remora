import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  decisionComparison,
  filterHistory,
  historyRows,
  outcome,
  summarize,
  timestamp,
  usdc,
} from "../src/lib/near-view.mjs";

const run = JSON.parse(
  await readFile(new URL("../public/near/sandbox.json", import.meta.url), "utf8")
);

test("recorded session accounting is separate from the provider's successful claim", () => {
  const view = summarize(run, run.finalVault);
  assert.equal(view.session, "Closed");
  assert.equal(view.payoutState, "Paid · claim confirmed");
  assert.equal(
    BigInt(view.stream.earned) + BigInt(view.stream.refunded),
    BigInt(view.stream.deposit)
  );
  assert.equal(view.reuse.successfulRequests, 10);
  assert.equal(view.reuse.extraPaymentTransactions, 0);
  assert.equal(view.serviceState, "Unavailable · fixture");
});

test("closure without a payout receipt does not imply provider payment", () => {
  const view = summarize({ ...run, providerPayout: undefined }, run.finalVault);
  assert.equal(view.session, "Closed");
  assert.equal(view.payoutState, "Claimable at settlement");
  const failed = {
    ...run,
    providerPayout: { ...run.providerPayout, value: false },
  };
  assert.equal(
    summarize(failed, run.finalVault).payoutState,
    "Payout failed · inspect receipt"
  );
  assert.equal(outcome(historyRows(failed).at(-1)).tone, "error");
});

test("closure approval without a final receipt remains pending", () => {
  const partial = { events: run.events.filter((e) => e.sequence <= 19) };
  const view = summarize(partial, { active_session: null });
  assert.equal(view.session, "Closure requested");
  assert.equal(view.payoutState, "Not observed");
  assert.equal(view.settled, undefined);
});

test("attached payout appears once and creates no payment per API request", () => {
  const rows = historyRows(run);
  const transactions = filterHistory(rows, "transactions", "");
  assert.equal(transactions.length, 3);
  assert.deepEqual(
    transactions.map((e) => e.action),
    ["OPEN", "CLOSE", "PROVIDER_CLAIM"]
  );
  assert.equal(filterHistory(rows, "all", "paid api request").length, 10);
  assert.equal(filterHistory(rows, "transactions", "premium").length, 0);
  const payoutEvent = rows.at(-1);
  assert.equal(payoutEvent.at, undefined);
  assert.equal(
    historyRows({ ...run, events: [...run.events, payoutEvent] }).length,
    rows.length
  );
});

test("denial preserves offered rate and snapshot limit, without creating a receipt", () => {
  const rows = historyRows(run);
  const denial = filterHistory(rows, "decisions", "RATE_LIMIT");
  assert.equal(denial.length, 1);
  assert.equal(outcome(denial[0]).tone, "warn");
  assert.equal(denial[0].hash, undefined);
  assert.equal(denial[0].approval, undefined);
  assert.deepEqual(decisionComparison(denial[0], run.finalVault.policy)[0], {
    label: "Rate",
    observed: "0.000200 USDC / s",
    bound: "0.000100 USDC / s",
    failed: true,
  });
  assert.equal(filterHistory(rows, "all", "no-matching-session").length, 0);
});

test("missing values remain unavailable and integer amounts retain six decimals", () => {
  assert.equal(usdc(undefined), "—");
  assert.equal(usdc("bad"), "—");
  assert.equal(usdc("0"), "0.000000");
  assert.equal(usdc("10000000000000000001"), "10000000000000.000001");
  assert.equal(timestamp(undefined), "Time unavailable");
  const view = summarize(null, null);
  assert.equal(view.session, "No session observed");
  assert.equal(view.stream, undefined);
  assert.equal(view.reuse, undefined);
});
