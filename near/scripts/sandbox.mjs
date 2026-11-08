import { Sandbox, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
} from "near-api-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  NearAgentStreamsClient,
  decodeOutcome,
  AGENT_METHODS,
} from "../sdk/index.mjs";

export const DEFAULT_POLICY = {
  budget: "100000",
  max_deposit: "10000",
  max_rate: "100",
  max_duration_seconds: 1000,
  recipients: [],
};
export const wasmPath = (name) =>
  resolve(`near/contracts/target/wasm32-unknown-unknown/release/${name}.wasm`);

export async function deploy(account, name, args) {
  return decodeOutcome(
    await account.signAndSendTransaction({
      receiverId: account.accountId,
      waitUntil: "FINAL",
      actions: [
        actions.deployContract(await readFile(wasmPath(name))),
        actions.functionCall("new", args, 100000000000000n, 0n),
      ],
    })
  );
}

export async function writeKey(directory, name, accountId, key) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, `${name}.json`);
  await writeFile(
    path,
    JSON.stringify(
      {
        account_id: accountId,
        public_key: key.getPublicKey().toString(),
        private_key: key.toString(),
      },
      null,
      2
    ) + "\n",
    { mode: 0o600, flag: "wx" }
  );
  return path;
}

export async function createSandbox({
  directory,
  serviceUrl = "http://127.0.0.1:5321",
} = {}) {
  const sandbox = await Sandbox.start({ version: "2.13.1" });
  try {
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    const root = new Account(
      "sandbox",
      provider,
      KeyPairSigner.fromSecretKey(DEFAULT_PRIVATE_KEY)
    );
    const accounts = {},
      keys = {};
    for (const name of [
      "owner",
      "vault",
      "agent",
      "provider",
      "token",
      "outsider",
    ]) {
      const key = KeyPair.fromRandom("ed25519");
      keys[name] = key;
      const id = `${name}.sandbox`;
      decodeOutcome(
        await root.signAndSendTransaction({
          receiverId: id,
          waitUntil: "FINAL",
          actions: [
            actions.createAccount(),
            actions.transfer(10000000000000000000000000n),
            actions.addFullAccessKey(key.getPublicKey()),
          ],
        })
      );
      accounts[name] = new Account(id, provider, new KeyPairSigner(key));
    }
    keys.policy = KeyPair.fromRandom("ed25519");
    keys.agentRestricted = KeyPair.fromRandom("ed25519");
    const config = {
      version: 1,
      network: "sandbox",
      rpcUrl: sandbox.rpcUrl,
      ownerId: accounts.owner.accountId,
      vaultId: accounts.vault.accountId,
      agentId: accounts.agent.accountId,
      recipientId: accounts.provider.accountId,
      tokenId: accounts.token.accountId,
      serviceUrl,
    };
    const policy = {
      ...DEFAULT_POLICY,
      recipients: [config.recipientId, accounts.outsider.accountId],
    };
    const tokenDeployment = await deploy(
      accounts.token,
      "agentpay_test_token",
      { owner_id: config.ownerId, total_supply: "1000000000" }
    );
    const vaultDeployment = await deploy(accounts.vault, "agentpay_vault", {
      owner_id: config.ownerId,
      token_id: config.tokenId,
      agent_id: config.agentId,
      agent_key: keys.agentRestricted.getPublicKey().toString(),
      policy_key: keys.policy.getPublicKey().toString(),
      policy,
    });
    decodeOutcome(
      await accounts.agent.signAndSendTransaction({
        receiverId: config.agentId,
        waitUntil: "FINAL",
        actions: [
          actions.addFunctionCallAccessKey(
            keys.agentRestricted.getPublicKey(),
            config.vaultId,
            [...AGENT_METHODS],
            1000000000000000000000000n
          ),
        ],
      })
    );
    for (const account_id of [config.vaultId, config.recipientId]) {
      decodeOutcome(
        await accounts.owner.callFunctionRaw({
          contractId: config.tokenId,
          methodName: "storage_deposit",
          args: { account_id, registration_only: true },
          deposit: 10000000000000000000000n,
          gas: 30000000000000n,
          waitUntil: "FINAL",
        })
      );
    }
    const client = (name, keyName = name) =>
      new NearAgentStreamsClient({
        vaultId: config.vaultId,
        accountId: accounts[name].accountId,
        privateKey: keys[keyName].toString(),
        provider,
      });
    const owner = client("owner");
    const funding = await owner.fund("1000000");
    if (funding.receiptFailures.length || funding.value !== "1000000")
      throw new Error("Sandbox vault funding failed.");
    if (directory) {
      const keyDir = resolve(directory, "keys");
      for (const name of ["owner", "provider", "policy"])
        config[`${name}KeyFile`] = await writeKey(
          keyDir,
          name,
          name === "policy" ? null : accounts[name].accountId,
          keys[name]
        );
      config.agentKeyFile = await writeKey(
        keyDir,
        "agent",
        config.agentId,
        keys.agentRestricted
      );
      config.agentAdminKeyFile = await writeKey(
        keyDir,
        "agent-admin",
        config.agentId,
        keys.agent
      );
      await writeFile(
        resolve(directory, "deployment.json"),
        JSON.stringify(config, null, 2) + "\n",
        { flag: "wx" }
      );
    }
    return {
      sandbox,
      provider,
      root,
      config,
      accounts,
      keys,
      policy,
      client,
      agent: client("agent", "agentRestricted"),
      owner,
      merchant: client("provider"),
      deployments: {
        token: tokenDeployment.hash,
        vault: vaultDeployment.hash,
        funding: funding.hash,
      },
    };
  } catch (error) {
    await sandbox.tearDown();
    throw error;
  }
}
