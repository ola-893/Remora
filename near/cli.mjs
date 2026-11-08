import "dotenv/config";
import { parseArgs } from "node:util";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runDemo } from "./run.mjs";
import { startProvider } from "./provider.mjs";
import { readConfig, readKey } from "./lib/config.mjs";
import { NearAgentStreamsClient, formatUSDC } from "./sdk/index.mjs";

const { values } = parseArgs({
  options: {
    sandbox: { type: "boolean" },
    ai: { type: "boolean" },
    json: { type: "boolean" },
    capture: { type: "boolean" },
    config: { type: "string" },
    recover: { type: "string" },
    help: { type: "boolean" },
  },
  strict: true,
});
if (values.help) {
  console.log(
    "agentStreams on NEAR\n  npm run demo:agent -- --sandbox [--ai] [--json] [--capture]\n  npm run demo:agent -- --config .local/near/deployment.json [--ai]\n  npm run recover:near -- --config <file> --recover <session-id>\nSandbox executes real local NEAR transactions using valueless fixture tokens. --ai calls the configured Qwen/OpenAI model."
  );
} else {
  let sandbox, service;
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    let configPath =
      values.config || process.env.NEAR_CONFIG || ".local/near/deployment.json";
    if (values.sandbox) {
      if (values.recover)
        throw new Error("Recovery requires the existing deployment config.");
      await mkdir(".local/near", { recursive: true });
      const directory = await mkdtemp(".local/near/sandbox-");
      const { createSandbox } = await import("./scripts/sandbox.mjs");
      sandbox = await createSandbox({ directory });
      service = await startProvider(sandbox.config, { port: 0 });
      sandbox.config.serviceUrl = service.origin;
      configPath = resolve(directory, "deployment.json");
      await writeFile(configPath, JSON.stringify(sandbox.config, null, 2));
    }
    if (values.recover) {
      const config = await readConfig(configPath),
        owner = await readKey(
          process.env.NEAR_OWNER_KEY_FILE || config.ownerKeyFile
        );
      if (owner.accountId !== config.ownerId)
        throw new Error("Owner key does not match vault owner.");
      const client = new NearAgentStreamsClient({
        vaultId: config.vaultId,
        accountId: config.ownerId,
        privateKey: owner.privateKey,
        rpcUrl: config.rpcUrl,
      });
      const receipt = await client.recover(values.recover);
      console.log(JSON.stringify(receipt, null, 2));
    } else {
      const run = await runDemo({
        configPath,
        service,
        ai: values.ai,
        signal: abort.signal,
        onEvent: (event) => {
          if (!values.json) {
            if (event.type === "policy")
              console.log(`${event.decision} · ${event.reason}`);
            if (event.type === "transaction")
              console.log(`${event.action} confirmed · ${event.hash}`);
            if (event.type === "request")
              console.log(
                `API request ${event.count}/10 · same funded session`
              );
            if (event.type === "settled")
              console.log(
                `Earned ${formatUSDC(
                  event.stream.earned
                )} · refunded to vault ${formatUSDC(
                  event.stream.refunded
                )} USDC`
              );
            if (event.type === "recovery_required" || event.type === "error")
              console.error(event.message);
          }
        },
      });
      if (sandbox) {
        const claim = await sandbox.merchant.claim();
        if (claim.value !== true || claim.receiptFailures.length)
          throw new Error("Provider payout failed.");
        run.providerPayout = claim;
        run.providerBalance = await sandbox.agent.tokenBalance(
          sandbox.config.recipientId,
          sandbox.config.tokenId
        );
        run.finalVault = await sandbox.agent.getVault();
        await writeFile(
          `.local/near/runs/${run.runId}/run.json`,
          JSON.stringify(run, null, 2)
        );
        if (!values.json)
          console.log(
            `Provider claimed ${formatUSDC(run.providerBalance)} USDC · ${
              claim.hash
            }`
          );
      }
      if (values.capture) {
        await mkdir("vite-project/public/near", { recursive: true });
        await writeFile(
          `vite-project/public/near/${run.network === 'sandbox' ? 'sandbox' : 'testnet'}.json`,
          JSON.stringify(run, null, 2) + "\n"
        );
      }
      if (values.json) console.log(JSON.stringify(run));
      else
        console.log(
          `Completed on ${run.network}. Agent mode: ${run.agentMode}. Evidence: .local/near/runs/${run.runId}/run.json`
        );
    }
  } catch (error) {
    console.error(
      values.json
        ? JSON.stringify({ ok: false, error: error.message })
        : error.message
    );
    process.exitCode = abort.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await service?.close();
    await sandbox?.sandbox.tearDown();
  }
}
