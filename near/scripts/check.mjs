import "dotenv/config";
import { readConfig, readKey } from "../lib/config.mjs";
import { NearAgentStreamsClient, formatUSDC } from "../sdk/index.mjs";
try {
  const config = await readConfig();
  const credential = await readKey(
    process.env.NEAR_AGENT_KEY_FILE || config.agentKeyFile
  );
  const client = new NearAgentStreamsClient({
    vaultId: config.vaultId,
    accountId: config.agentId,
    privateKey: credential.privateKey,
    rpcUrl: config.rpcUrl,
  });
  const vault = await client.assertRestrictedAgent();
  const status = await client.provider.viewNodeStatus();
  if (config.network === "testnet" && status.chain_id !== "testnet")
    throw new Error("RPC network mismatch.");
  if (vault.token_id !== config.tokenId || vault.owner_id !== config.ownerId)
    throw new Error("Vault configuration mismatch.");
  console.log(
    `${config.network}: ${
      config.vaultId
    }\nRestricted agent key verified.\nAvailable ${formatUSDC(
      vault.available
    )} USDC · total budget ${formatUSDC(
      vault.policy.budget
    )} USDC\nActive session: ${vault.active_session || "none"}`
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
