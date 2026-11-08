import { parseArgs } from "node:util";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { JsonRpcProvider } from "near-api-js";
import { deploymentPlan, inspectTestnet } from "../lib/testnet-preflight.mjs";
import { connectedOwner } from "../../packages/cli/src/owner-wallet.mjs";

const { values } = parseArgs({
  options: {
    "owner-id": { type: "string" },
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
    "Connect with agentstream wallet connect --network testnet, then run npm run preflight:near -- --recipient provider.testnet. Optional --output PATH saves the read-only report."
  );
else
  try {
    const wallet = await connectedOwner({ ownerId: values["owner-id"] });
    const plan = deploymentPlan({
      ownerId: wallet?.accountId || values["owner-id"],
      recipientId: values.recipient,
      vaultLabel: values["vault-name"],
      agentLabel: values["agent-name"],
      rpcUrl: values.rpc,
      serviceUrl: values.service,
    });
    const report = await inspectTestnet(plan, {
      provider: new JsonRpcProvider({ url: plan.rpcUrl }),
      readWasm: () =>
        readFile(
          resolve(
            "near/contracts/target/wasm32-unknown-unknown/release/agentpay_vault.wasm"
          )
        ),
      ownerPublicKey: wallet?.publicKey,
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
