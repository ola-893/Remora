import "dotenv/config";
import { parseArgs } from "node:util";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { JsonRpcProvider } from "near-api-js";
import { readKey } from "../lib/config.mjs";
import { deploymentPlan, inspectTestnet } from "../lib/testnet-preflight.mjs";

const { values } = parseArgs({
  options: {
    "owner-id": { type: "string" },
    "owner-key": { type: "string" },
    recipient: { type: "string" },
    "vault-name": { type: "string", default: "agentstreams" },
    "agent-name": { type: "string", default: "research-agent" },
    service: { type: "string", default: "http://127.0.0.1:5321" },
    rpc: { type: "string", default: "https://test.rpc.fastnear.com" },
    output: { type: "string" },
    help: { type: "boolean" },
  },
  strict: true,
});

if (values.help)
  console.log(
    "Read-only NEAR testnet deployment preflight:\n  npm run preflight:near -- --owner-id owner.testnet --recipient provider.testnet --owner-key /absolute/path/owner.json\nOptional --output .local/near/preflight.json saves a sanitized report. Without account IDs it checks the RPC, Circle token and local WASM, reporting account checks as pending. Never signs, creates accounts or spends tokens; exit 0 only when all required checks pass."
  );
else
  try {
    const plan = deploymentPlan({
      ownerId: values["owner-id"] || process.env.NEAR_OWNER_ID,
      recipientId: values.recipient,
      vaultLabel: values["vault-name"],
      agentLabel: values["agent-name"],
      rpcUrl: values.rpc,
      serviceUrl: values.service,
    });
    const path = values["owner-key"] || process.env.NEAR_OWNER_KEY_FILE;
    let ownerPublicKey,
      credentialError = false;
    if (path) {
      try {
        const key = await readKey(path);
        if (key.accountId !== plan.ownerId) throw new Error("Owner mismatch.");
        ownerPublicKey = key.publicKey;
      } catch {
        credentialError = true;
      }
    }
    const report = await inspectTestnet(plan, {
      provider: new JsonRpcProvider({ url: plan.rpcUrl }),
      readWasm: () =>
        readFile(
          resolve(
            "near/contracts/target/wasm32-unknown-unknown/release/agentpay_vault.wasm"
          )
        ),
      ownerPublicKey,
      credentialError,
    });
    const json = JSON.stringify(report, null, 2) + "\n";
    if (values.output) {
      const output = resolve(values.output);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, json, { flag: "wx" });
    }
    console.log(json);
    if (!report.readyToDeploy) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
