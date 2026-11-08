import { NearAgentStreamsClient, formatUSDC, type Approval } from "@agentstreams/near";

// Read-only usage. Keep private keys and mutation authority on a trusted host.
const client = new NearAgentStreamsClient({
  vaultId: "agentpay.example.testnet",
  rpcUrl: "https://test.rpc.fastnear.com",
});
export async function balances() {
  const vault = await client.getVault();
  return {
    available: formatUSDC(vault.available),
    budget: formatUSDC(vault.policy.budget),
  };
}
export async function openApprovedSession(
  agent: NearAgentStreamsClient,
  approval: Approval
) {
  await agent.assertRestrictedAgent();
  const receipt = await agent.open(approval);
  return { transaction: receipt.hash, session: receipt.value.session_id };
}
