import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { KeyPair, actions } from "near-api-js";
import { createSandbox } from "../scripts/sandbox.mjs";
import { signPermit } from "../lib/permit.mjs";
import { makeSession, verifySession } from "../lib/session.mjs";
import { startProvider } from "../provider.mjs";
import { startPolicyWorker } from "../lib/worker-client.mjs";

test(
  "native NEAR vault: authority, policy, real API reuse, settlement and payout recovery",
  { timeout: 400000 },
  async (t) => {
    await mkdir(".local/near-tests", { recursive: true });
    const directory = await mkdtemp(".local/near-tests/run-");
    const env = await createSandbox({ directory });
    let service, worker;
    const receipts = [];
    const { config, agent, owner, merchant, keys, accounts, provider } = env;
    const approval = async (overrides = {}, signingKey = keys.policy) => {
      const vault = await agent.getVault();
      return signPermit(
        {
          domain: "agentpay.near.v1",
          vault_id: config.vaultId,
          agent_id: config.agentId,
          action: "OPEN",
          session_id: "direct-test",
          recipient_id: config.recipientId,
          rate: "100",
          duration_seconds: 100,
          quote_hash: "a".repeat(64),
          nonce: vault.next_nonce,
          expires_at: String(Number(vault.now) + 90),
          ...overrides,
        },
        signingKey.toString()
      );
    };
    const record = async (promise) => {
      const receipt = await promise;
      receipts.push(receipt);
      return receipt;
    };
    try {
      await t.test(
        "restricted key is verified and cannot transfer funds or alter policy",
        async () => {
          const vault = await agent.assertRestrictedAgent();
          assert.equal(vault.available, "1000000");
          await assert.rejects(
            () =>
              agent.account.signAndSendTransaction({
                receiverId: config.ownerId,
                actions: [actions.transfer(1n)],
                waitUntil: "FINAL",
              }),
            /access|permission|receiver|function|action/i
          );
          await assert.rejects(
            () => agent.execute("configure", { policy: env.policy }),
            /access|permission|method/i
          );
        }
      );
      await t.test(
        "full-access agent key cannot impersonate the restricted agent authority",
        async () => {
          const signed = await approval();
          await assert.rejects(
            () => env.client("agent").open(signed),
            /AGENT_ONLY/
          );
        }
      );
      await t.test(
        "forged, altered, expired and cross-vault approvals fail onchain",
        async () => {
          const forged = await approval({}, KeyPair.fromRandom("ed25519"));
          await assert.rejects(
            () => agent.open(forged),
            /INVALID_POLICY_SIGNATURE/
          );
          const altered = await approval();
          altered.permit.rate = "99";
          await assert.rejects(
            () => agent.open(altered),
            /INVALID_POLICY_SIGNATURE/
          );
          const vault = await agent.getVault();
          const expired = await approval({
            expires_at: String(Number(vault.now) - 1),
          });
          await assert.rejects(() => agent.open(expired), /PERMIT_EXPIRED/);
          const cross = await approval({ vault_id: config.ownerId });
          await assert.rejects(() => agent.open(cross), /PERMIT_DOMAIN/);
        }
      );
      await t.test(
        "hard limits reject even correctly signed disallowed requests",
        async () => {
          for (const [changes, reason] of [
            [{ duration_seconds: 101 }, "DEPOSIT_LIMIT"],
            [{ rate: "101" }, "RATE_LIMIT"],
            [{ duration_seconds: 1001 }, "DURATION_LIMIT"],
            [{ recipient_id: "unapproved.sandbox" }, "RECIPIENT_DENIED"],
          ]) {
            const signed = await approval(changes);
            await assert.rejects(() => agent.open(signed), new RegExp(reason));
          }
          await assert.rejects(
            () =>
              env.client("outsider").execute("ft_on_transfer", {
                sender_id: config.ownerId,
                amount: "999999",
                msg: "fund",
              }),
            /TOKEN_ONLY/
          );
          assert.equal((await agent.getVault()).available, "1000000");
        }
      );
      service = await startProvider(config, { port: 0 });
      config.serviceUrl = service.origin;
      // Keep this recovery regression independent of the production failure cooldown.
      config.runtimePolicy = { failureCooldownSeconds: 1 };
      const configPath = `${directory}/deployment.json`;
      await writeFile(configPath, JSON.stringify(config, null, 2));
      worker = startPolicyWorker(configPath);
      let sessionId = "worker-session",
        opened,
        closed,
        requestCount = 0;
      await t.test(
        "worker denies expensive tier and approves a real funded session",
        async () => {
          const premium = await worker.request({
            action: "OPEN",
            tier: "premium",
            sessionId: "premium",
          });
          assert.equal(premium.decision, "DENY");
          const result = await worker.request({
            action: "OPEN",
            tier: "basic",
            sessionId,
          });
          assert.equal(result.decision, "OPEN");
          assert.equal(result.prices.reason, "SANDBOX_FIXTURE_NO_MARKET_PRICE");
          const receipt = await record(agent.open(result.approval));
          opened = receipt.value;
          assert.equal(opened.deposit, "10000");
          await assert.rejects(
            () => agent.open(result.approval),
            /PERMIT_NONCE/
          );
          const another = await approval({ session_id: "second-session" });
          await assert.rejects(() => agent.open(another), /ACTIVE_STREAM/);
        }
      );
      await t.test(
        "ten authenticated HTTP requests reuse one stream with no further agent transaction",
        async () => {
          const nonce = async () =>
            (
              await provider.viewAccessKey({
                accountId: config.agentId,
                publicKey: keys.agentRestricted.getPublicKey().toString(),
              })
            ).nonce;
          const before = await nonce();
          assert.equal((await fetch(`${service.origin}/research`)).status, 402);
          const session = makeSession({
            config,
            stream: opened,
            key: keys.agentRestricted,
          });
          const forged = makeSession({
            config,
            stream: opened,
            key: keys.agent,
          });
          assert.equal(
            (
              await fetch(`${service.origin}/research`, {
                headers: { "x-agentpay-session": forged },
              })
            ).status,
            403
          );
          for (let i = 0; i < 10; i++) {
            const response = await fetch(`${service.origin}/research`, {
              headers: { "x-agentpay-session": session },
            });
            assert.equal(response.status, 200);
            requestCount = (await response.json()).request;
          }
          assert.equal(requestCount, 10);
          assert.equal(await nonce(), before);
          const checkpoint = await worker.request({
            action: "CHECK",
            sessionId,
          });
          assert.equal(checkpoint.decision, "CONTINUE");
        }
      );
      await t.test(
        "observed outage closes onchain and conserves earned plus refunded funds",
        async () => {
          service.setUnavailable(true);
          const checkpoint = await worker.request({
            action: "CHECK",
            sessionId,
          });
          assert.equal(checkpoint.decision, "CLOSE");
          closed = (await record(agent.close(checkpoint.approval))).value;
          assert.equal(BigInt(closed.earned) + BigInt(closed.refunded), 10000n);
          assert.ok(BigInt(closed.earned) > 0n);
          assert.ok(BigInt(closed.refunded) > 0n);
          assert.equal(await agent.getClaim(config.recipientId), closed.earned);
          assert.equal(
            (await agent.getVault()).available,
            (1000000n - BigInt(closed.earned)).toString()
          );
          await assert.rejects(
            () => agent.close(checkpoint.approval),
            /PERMIT_NONCE/
          );
          service.setUnavailable(false);
          const session = makeSession({
            config,
            stream: opened,
            key: keys.agentRestricted,
          });
          assert.equal(
            (
              await fetch(`${service.origin}/research`, {
                headers: { "x-agentpay-session": session },
              })
            ).status,
            403
          );
          const replay = await approval({ session_id: sessionId });
          await assert.rejects(() => agent.open(replay), /SESSION_REPLAY/);
        }
      );
      await t.test(
        "provider claim and owner refund reach actual token balances",
        async () => {
          const paid = await record(merchant.claim());
          assert.equal(paid.value, true);
          assert.equal(paid.receiptFailures.length, 0);
          assert.equal(
            await agent.tokenBalance(config.recipientId, config.tokenId),
            closed.earned
          );
          const before = BigInt(
            await agent.tokenBalance(config.ownerId, config.tokenId)
          );
          const refunded = await record(owner.withdraw(closed.refunded));
          assert.equal(refunded.value, true);
          assert.equal(
            BigInt(await agent.tokenBalance(config.ownerId, config.tokenId)),
            before + BigInt(closed.refunded)
          );
          await assert.rejects(() => merchant.claim(), /NOTHING_TO_CLAIM/);
        }
      );
      await t.test(
        "owner recovery works while paused without the policy worker",
        async () => {
          const result = await worker.request({
            action: "OPEN",
            tier: "basic",
            sessionId: "recover-session",
          });
          await record(agent.open(result.approval));
          await record(owner.execute("set_paused", { paused: true }));
          const recovered = await record(owner.recover("recover-session"));
          assert.ok(recovered.value.closed_at);
          worker.stop();
          worker = null;
          const signed = await approval({ session_id: "paused" });
          await assert.rejects(() => agent.open(signed), /PAUSED/);
          await record(owner.execute("set_paused", { paused: false }));
        }
      );
      await t.test(
        "provider can withdraw accrued earnings before closure without double credit",
        async () => {
          const initial = await agent.getVault();
          const signed = await approval({ session_id: "partial-withdrawal" });
          await record(agent.open(signed));
          await provider.sendJsonRpc("sandbox_fast_forward", {
            delta_height: 100,
          });
          const paid = await record(
            merchant.withdrawEarned("partial-withdrawal")
          );
          assert.equal(paid.value, true);
          const partial = await agent.getStream("partial-withdrawal");
          assert.ok(BigInt(partial.earned) > 0n);
          const recovered = await record(owner.recover("partial-withdrawal"));
          const vault = await agent.getVault();
          assert.equal(
            BigInt(vault.spent) - BigInt(initial.spent),
            BigInt(recovered.value.earned)
          );
          assert.equal(
            BigInt(recovered.value.earned) + BigInt(recovered.value.refunded),
            BigInt(recovered.value.deposit)
          );
        }
      );
      await t.test(
        "failed asynchronous token payout restores the claim and a retry succeeds",
        async () => {
          const signed = await approval({
            session_id: "unregistered-recipient",
            recipient_id: accounts.outsider.accountId,
            rate: "10",
            duration_seconds: 1,
          });
          await record(agent.open(signed));
          // Advancing block timestamps exercises capped expiry without waiting a lease duration.
          await provider.sendJsonRpc("sandbox_fast_forward", {
            delta_height: 10,
          });
          await record(
            env.client("outsider").settleExpired("unregistered-recipient")
          );
          const outsider = env.client("outsider");
          assert.equal(
            await outsider.getClaim(accounts.outsider.accountId),
            "10"
          );
          const failed = await record(outsider.claim());
          assert.equal(failed.value, false);
          assert.ok(failed.receiptFailures.length > 0);
          assert.equal(
            await outsider.getClaim(accounts.outsider.accountId),
            "10"
          );
          assert.equal((await outsider.getVault()).pending_total, "0");
          await accounts.owner.callFunction({
            contractId: config.tokenId,
            methodName: "storage_deposit",
            args: {
              account_id: accounts.outsider.accountId,
              registration_only: true,
            },
            deposit: 10000000000000000000000n,
          });
          const retried = await record(outsider.claim());
          assert.equal(retried.value, true);
          assert.equal(
            await outsider.tokenBalance(
              accounts.outsider.accountId,
              config.tokenId
            ),
            "10"
          );
          await assert.rejects(
            () => outsider.execute("on_payout", { payout_id: "0" }),
            /private|callback/i
          );
        }
      );
      await t.test(
        "cumulative budget is enforced across sessions and policy updates invalidate old permits",
        async () => {
          const before = await agent.getVault();
          const old = await approval({ session_id: "old-policy" });
          await record(
            owner.execute("configure", {
              policy: {
                ...env.policy,
                budget: String(BigInt(before.spent) + 10000n),
              },
            })
          );
          await assert.rejects(() => agent.open(old), /PERMIT_NONCE/);
          const first = await approval({
            session_id: "budget-one",
            rate: "100",
            duration_seconds: 100,
          });
          await record(agent.open(first));
          await provider.sendJsonRpc("sandbox_fast_forward", {
            delta_height: 2000,
          });
          await record(owner.settleExpired("budget-one"));
          const second = await approval({ session_id: "budget-two" });
          await assert.rejects(() => agent.open(second), /BUDGET_LIMIT/);
        }
      );
      await t.test(
        "open-ended subscriptions survive an hour, top up without reconnecting, and revoke on exhaustion or closure",
        async () => {
          const before = await agent.getVault();
          const policy = { ...env.policy, budget: String(BigInt(before.spent) + 100000n), max_deposit: "5000", max_duration_seconds: 3153600000 };
          await record(owner.execute("configure", { policy }));
          const ongoing = await approval({ session_id: "ongoing", duration_seconds: 0, rate: "1" });
          await assert.rejects(() => agent.open(ongoing), /DURATION_LIMIT/);
          await record(owner.execute("configure", { policy: { ...policy, max_duration_seconds: 0 } }));
          const opened = (await record(agent.open(await approval({ session_id: "ongoing", duration_seconds: 0, rate: "1" })))).value;
          assert.equal(opened.deposit, "5000");
          const encoded = makeSession({ config, stream: opened, key: keys.agentRestricted });
          assert.equal(JSON.parse(Buffer.from(encoded, "base64url")).expires_at, null);
          await provider.sendJsonRpc("sandbox_fast_forward", { delta_height: 13000 });
          let vault = await agent.getVault();
          assert.ok(Number(vault.now) - Number(opened.started_at) > 3600);
          assert.equal(verifySession(encoded, { config, stream: await agent.getStream("ongoing"), vault, now: Number(vault.now) }).expires_at, null);
          await assert.rejects(() => env.client("outsider").topUpStream("ongoing", "1"), /OWNER_ONLY/);
          await assert.rejects(() => owner.topUpStream("ongoing", "5000"), /DEPOSIT_LIMIT/);
          const topped = (await record(owner.topUpStream("ongoing", "1000"))).value;
          assert.equal(topped.deposit, "6000");
          vault = await agent.getVault();
          verifySession(encoded, { config, stream: topped, vault, now: Number(vault.now) });
          await assert.rejects(() => owner.settleExpired("ongoing"), /NOT_EXPIRED/);
          await provider.sendJsonRpc("sandbox_fast_forward", { delta_height: 9000 });
          vault = await agent.getVault();
          assert.throws(() => verifySession(encoded, { config, stream: topped, vault, now: Number(vault.now) }), /SESSION_INACTIVE/);
          await assert.rejects(() => owner.topUpStream("ongoing", "1"), /STREAM_FUNDS_EXHAUSTED/);
          const settled = (await record(owner.settleExpired("ongoing"))).value;
          assert.equal(settled.earned, "6000");
          assert.equal(settled.refunded, "0");
          const next = (await record(agent.open(await approval({ session_id: "ongoing-close", duration_seconds: 0, rate: "1" })))).value;
          const token = makeSession({ config, stream: next, key: keys.agentRestricted });
          const closed = (await record(owner.recover("ongoing-close"))).value;
          assert.ok(BigInt(closed.refunded) > 0n);
          assert.throws(() => verifySession(token, { config, stream: closed, vault: { ...vault, active_session: null }, now: Number(vault.now) }), /SESSION_INACTIVE/);
        }
      );
      await t.test(
        "native audit root is owner-only, unique, and cannot authorize a payment",
        async () => {
          const before = await agent.getVault();
          const root = "b".repeat(64);
          const receipt = await record(owner.anchorDecision(root));
          assert.equal(receipt.value.sequence, "1");
          assert.equal((await agent.getDecision("1")).root, root);
          await assert.rejects(
            () => owner.anchorDecision(root),
            /DUPLICATE_ROOT/
          );
          await assert.rejects(
            () => env.client("outsider").anchorDecision("c".repeat(64)),
            /OWNER_ONLY/
          );
          const after = await agent.getVault();
          assert.equal(after.available, before.available);
          assert.equal(after.next_nonce, before.next_nonce);
        }
      );
      await t.test(
        "vault token balance equals every outstanding liability",
        async () => {
          const vault = await agent.getVault();
          const held = BigInt(
            await agent.tokenBalance(config.vaultId, config.tokenId)
          );
          assert.equal(
            held,
            BigInt(vault.available) +
              BigInt(vault.reserved) +
              BigInt(vault.claimable_total) +
              BigInt(vault.pending_total)
          );
          await writeFile(
            `${directory}/verification.json`,
            JSON.stringify(
              {
                network: "sandbox",
                recordedAt: new Date().toISOString(),
                deployments: env.deployments,
                requestsReused: requestCount,
                stream: closed,
                finalVault: vault,
                receipts: receipts.map(
                  ({
                    hash,
                    receiverId,
                    receiptIds,
                    receiptFailures,
                    value,
                  }) => ({
                    hash,
                    receiverId,
                    receiptIds,
                    receiptFailures,
                    value,
                  })
                ),
              },
              null,
              2
            )
          );
        }
      );
    } finally {
      worker?.stop();
      await service?.close();
      // Large fast-forwards can stall the sandbox binary's graceful shutdown.
      const stopTimer = setTimeout(() => env.sandbox.childProcess?.kill("SIGKILL"), 5000);
      stopTimer.unref();
      try { await env.sandbox.tearDown(); } finally { clearTimeout(stopTimer); }
    }
  }
);
