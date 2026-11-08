import "dotenv/config";
import { parseArgs } from "node:util";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { readConfig, readKey } from "./lib/config.mjs";
import { assessQuote, fetchPrices } from "./lib/policy.mjs";
import { NearAgentStreamsClient } from "./sdk/index.mjs";
import { startProvider } from "./provider.mjs";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    sandbox: { type: "boolean" },
    json: { type: "boolean" },
    anchor: { type: "boolean" },
    help: { type: "boolean" },
  },
  strict: true,
});
if (values.help)
  console.log(
    "Native spend review: node near/spend-review.mjs --sandbox | --config <deployment> [--anchor] [--json]\nReads vault policy and provider observations. --anchor records the durable review digest using the owner key. No payment transaction is simulated."
  );
else {
  let sandbox, service;
  try {
    let configPath = values.config || process.env.NEAR_CONFIG;
    if (values.sandbox && !values.config) {
      await mkdir(".local/near", { recursive: true });
      const directory = await mkdtemp(".local/near/review-");
      const { createSandbox } = await import("./scripts/sandbox.mjs");
      sandbox = await createSandbox({ directory });
      service = await startProvider(sandbox.config, { port: 0 });
      sandbox.config.serviceUrl = service.origin;
      configPath = `${directory}/deployment.json`;
      await writeFile(configPath, JSON.stringify(sandbox.config, null, 2));
    }
    const config = await readConfig(configPath),
      client = new NearAgentStreamsClient({
        vaultId: config.vaultId,
        rpcUrl: config.rpcUrl,
      });
    const vault = await client.getVault();
    const healthResponse = await fetch(`${config.serviceUrl}/health`, {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!healthResponse.ok) throw new Error("Provider health unavailable.");
    const health = await healthResponse.json();
    const prices =
      config.network === "sandbox"
        ? { decision: "ALLOW", reason: "SANDBOX_FIXTURE_NO_MARKET_PRICE" }
        : await fetchPrices();
    const decisions = [];
    for (const tier of ["basic", "premium"]) {
      const response = await fetch(`${config.serviceUrl}/quote?tier=${tier}`, {
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Provider quote unavailable.");
      const quote = await response.json();
      const assessment = assessQuote({
        vault: { ...vault, vault_id: config.vaultId },
        quote,
        health,
      });
      const decision =
        prices.decision === "ALLOW"
          ? assessment
          : { decision: "DENY", reason: prices.reason };
      decisions.push({ tier, quote, decision });
    }
    const payload = {
      network: config.network,
      recordedAt: new Date().toISOString(),
      vaultId: config.vaultId,
      vault,
      health,
      prices,
      decisions,
      signed: false,
      transactionSimulated: false,
      anchored: false,
    };
    const sha256 = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    const directory = `.local/near/reviews/${randomUUID()}`;
    await mkdir(directory, { recursive: true });
    await writeFile(
      `${directory}/review.json`,
      JSON.stringify({ sha256, payload }, null, 2)
    );
    let anchor = null;
    if (values.anchor) {
      const credential = await readKey(
        process.env.NEAR_OWNER_KEY_FILE || config.ownerKeyFile
      );
      if (credential.accountId !== config.ownerId)
        throw new Error("Owner credential mismatch.");
      const owner = new NearAgentStreamsClient({
        vaultId: config.vaultId,
        accountId: config.ownerId,
        privateKey: credential.privateKey,
        rpcUrl: config.rpcUrl,
      });
      // Persist content before anchoring its digest. An uncertain submission is never retried.
      await writeFile(
        `${directory}/anchor-intent.json`,
        JSON.stringify({ vaultId: config.vaultId, sha256 }, null, 2)
      );
      anchor = await owner.anchorDecision(sha256);
      const verified = await owner.getDecision(anchor.value.sequence);
      if (verified?.root !== sha256)
        throw new Error("Anchored digest does not match the durable review.");
      await writeFile(
        `${directory}/anchor-receipt.json`,
        JSON.stringify(anchor, null, 2)
      );
    }
    if (values.json)
      console.log(JSON.stringify({ sha256, ...payload, anchor }));
    else {
      for (const item of decisions)
        console.log(
          `${item.tier}: ${item.decision.decision} · ${item.decision.reason}`
        );
      console.log(
        `Unsigned review ${sha256}\nEvidence: ${directory}/review.json`
      );
      if (anchor)
        console.log(`Digest anchored on ${config.network} · ${anchor.hash}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await service?.close();
    await sandbox?.sandbox.tearDown();
  }
}
