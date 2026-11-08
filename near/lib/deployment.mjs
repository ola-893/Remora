import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from "near-api-js";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { readKey } from "./config.mjs";
import { USDC, AGENT_METHODS, NearAgentStreamsClient, decodeOutcome } from "../sdk/index.mjs";
import { deploymentPlan, inspectTestnet } from "./testnet-preflight.mjs";

export const DEFAULT_POLICY = Object.freeze({ budget: "100000", max_deposit: "10000", max_rate: "100", max_duration_seconds: 0, recipients: [] });
export async function writeKey(directory, name, accountId, key) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, `${name}.json`);
  await writeFile(path, JSON.stringify({ account_id: accountId, public_key: key.getPublicKey().toString(), private_key: key.toString() }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return path;
}

// Shared by source deployment and the packaged CLI; no dotenv, sandbox or model runtime.
export async function deployTestnet({ ownerId, ownerKeyFile, recipientId = ownerId, vaultLabel = "agentstreams", agentLabel = "research-agent", rpcUrl = "https://test.rpc.fastnear.com", serviceUrl = "http://127.0.0.1:5321", directory, wasmFile, onProgress = () => {} }) {
  let record;
  try {
    const plan = deploymentPlan({
      ownerId,
      recipientId: recipientId,
      vaultLabel: vaultLabel,
      agentLabel: agentLabel,
      rpcUrl: rpcUrl,
      serviceUrl: serviceUrl,
    });
    if (
      !ownerId?.endsWith(".testnet") ||
      !recipientId?.endsWith(".testnet")
    )
      throw new Error(
        "Owner and recipient must be existing named .testnet accounts."
      );
    const credential = await readKey(
      ownerKeyFile
    );
    if (credential.accountId !== ownerId)
      throw new Error("Owner credential account mismatch.");
    const { vaultId, agentId } = plan;
    const provider = new JsonRpcProvider({ url: plan.rpcUrl });
    const preflight = await inspectTestnet(plan, {
      provider,
      readWasm: () => readFile(wasmFile),
      ownerPublicKey: credential.publicKey,
    });
    if (!preflight.readyToDeploy)
      throw new Error(
        "Deployment preflight failed:\n" +
          preflight.checks
            .filter((check) => check.status !== "pass")
            .map((check) => `${check.id}: ${check.detail}`)
            .join("\n")
      );
    const owner = new Account(
      ownerId,
      provider,
      KeyPairSigner.fromSecretKey(credential.privateKey)
    );
    const client = new NearAgentStreamsClient({
      vaultId,
      accountId: ownerId,
      privateKey: credential.privateKey,
      provider,
    });
    directory = resolve(directory);
    try { await access(`${directory}/record.json`); throw new Error("Deployment record exists; inspect it before another deployment. No step is automatically repeated."); } catch (e) { if (e.code !== "ENOENT") throw e; }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const keys = Object.fromEntries(
      ["vault", "agent-admin", "agent", "policy"].map((name) => [
        name,
        KeyPair.fromRandom("ed25519"),
      ])
    );
    const files = {};
    for (const [name, key] of Object.entries(keys))
      files[name] = await writeKey(
        resolve(directory, "keys"),
        name,
        name === "policy" ? null : name === "vault" ? vaultId : agentId,
        key
      );
    const config = {
      version: 1,
      network: "testnet",
      rpcUrl: plan.rpcUrl,
      ownerId,
      vaultId,
      agentId,
      recipientId: recipientId,
      tokenId: USDC.testnet,
      serviceUrl: plan.serviceUrl,
      ownerKeyFile: resolve(
        ownerKeyFile
      ),
      agentKeyFile: files.agent,
      agentAdminKeyFile: files["agent-admin"],
      policyKeyFile: files.policy,
    };
    record = {
      createdAt: new Date().toISOString(),
      config,
      preflight,
      status: "deploying",
      steps: [],
    };
    const step = async (name, submit) => {
      record.pendingStep = name;
      await writeFile(
        `${directory}/record.json`,
        JSON.stringify(record, null, 2), { mode: 0o600 }
      );
      const receipt = decodeOutcome(await submit());
      record.steps.push({ name, ...receipt });
      delete record.pendingStep;
      await writeFile(
        `${directory}/record.json`,
        JSON.stringify(record, null, 2), { mode: 0o600 }
      );
      onProgress({ step: name, transactionHash: receipt.hash });
      return receipt;
    };
    await step("create-vault", () =>
      owner.signAndSendTransaction({
        receiverId: vaultId,
        waitUntil: "FINAL",
        actions: [
          actions.createAccount(),
          actions.transfer(5000000000000000000000000n),
          actions.addFullAccessKey(keys.vault.getPublicKey()),
        ],
      })
    );
    await step("create-agent", () =>
      owner.signAndSendTransaction({
        receiverId: agentId,
        waitUntil: "FINAL",
        actions: [
          actions.createAccount(),
          actions.transfer(500000000000000000000000n),
          actions.addFullAccessKey(keys["agent-admin"].getPublicKey()),
          actions.addFunctionCallAccessKey(
            keys.agent.getPublicKey(),
            vaultId,
            [...AGENT_METHODS],
            250000000000000000000000n
          ),
        ],
      })
    );
    const vault = new Account(vaultId, provider, new KeyPairSigner(keys.vault));
    await step("deploy-and-initialize", async () =>
      vault.signAndSendTransaction({
        receiverId: vaultId,
        waitUntil: "FINAL",
        actions: [
          actions.deployContract(await readFile(wasmFile)),
          actions.functionCall(
            "new",
            {
              owner_id: ownerId,
              token_id: USDC.testnet,
              agent_id: agentId,
              agent_key: keys.agent.getPublicKey().toString(),
              policy_key: keys.policy.getPublicKey().toString(),
              policy: { ...DEFAULT_POLICY, recipients: [recipientId] },
            },
            100000000000000n,
            0n
          ),
        ],
      })
    );
    for (const account_id of [vaultId, ownerId, recipientId]) {
      if (await client.view("storage_balance_of", { account_id }, USDC.testnet))
        continue;
      const bounds = await client.view(
        "storage_balance_bounds",
        {},
        USDC.testnet
      );
      await step(`register-usdc-${account_id}`, () =>
        owner.callFunctionRaw({
          contractId: USDC.testnet,
          methodName: "storage_deposit",
          args: { account_id, registration_only: true },
          deposit: BigInt(bounds.min),
          gas: 30000000000000n,
          waitUntil: "FINAL",
        })
      );
    }
    const agent = new NearAgentStreamsClient({
      vaultId,
      accountId: agentId,
      privateKey: keys.agent.toString(),
      provider,
    });
    await agent.assertRestrictedAgent();
    record.status = "deployed";
    await writeFile(
      `${directory}/record.json`,
      JSON.stringify(record, null, 2), { mode: 0o600 }
    );
    await writeFile(
      `${directory}/deployment.json`,
      JSON.stringify(config, null, 2), { mode: 0o600 }
    );
    return { configPath: `${directory}/deployment.json`, config, record };
  } catch (error) {
    if (record) {
      record.status = "needs-reconciliation";
      await writeFile(`${directory}/record.json`, JSON.stringify(record, null, 2), { mode: 0o600 });
      error.message += ` Inspect ${directory}/record.json and onchain accounts before another deployment. No action is automatically resubmitted.`;
    }
    throw error;
  }
}
