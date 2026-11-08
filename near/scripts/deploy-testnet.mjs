import "dotenv/config";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { deployTestnet } from "../lib/deployment.mjs";
const { values } = parseArgs({
  options: {
    "owner-id": { type: "string" },
    "owner-key": { type: "string" },
    recipient: { type: "string" },
    "vault-name": { type: "string", default: "agentstreams" },
    "agent-name": { type: "string", default: "research-agent" },
    service: { type: "string", default: "http://127.0.0.1:5321" },
    rpc: { type: "string", default: "https://test.rpc.fastnear.com" },
    help: { type: "boolean" },
  },
  strict: true,
});

if (values.help) {
  console.log("Deploy agentStreams to NEAR testnet: npm run deploy:near -- --owner-id owner.testnet --owner-key /absolute/path/owner.json --recipient provider.testnet. Requires 6 test NEAR; USDC funding is separate.");
} else try {
  const result = await deployTestnet({ ownerId: values["owner-id"] || process.env.NEAR_OWNER_ID, ownerKeyFile: values["owner-key"] || process.env.NEAR_OWNER_KEY_FILE, recipientId: values.recipient, vaultLabel: values["vault-name"], agentLabel: values["agent-name"], rpcUrl: values.rpc, serviceUrl: values.service, directory: resolve(`.local/near/testnet-${Date.now()}`), wasmFile: resolve("near/contracts/target/wasm32-unknown-unknown/release/agentpay_vault.wasm"), onProgress: step => console.log(`${step.step} · ${step.transactionHash}`) });
  console.log(`Ready. Set NEAR_CONFIG=${result.configPath}. Get Circle testnet USDC for ${result.config.ownerId}, then npm run fund:near -- --amount 100000. Keep the deployment keys private.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
