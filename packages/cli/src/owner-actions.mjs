import { dirname, resolve } from 'node:path';
import { settings, usdc } from './settings.mjs';
import { readKey } from '@ola-893/agentstreams-core/internal-config';
import { NearAgentStreamsClient, formatUSDC } from '@ola-893/agentstreams-core/near';
import { ownerTransaction } from './owner-wallet.mjs';
import { payout } from './vault-money.mjs';

export function withdrawalAmount(vault, amount) {
  const raw = amount === 'all' ? vault.available : usdc(amount);
  if (BigInt(raw) <= 0n) throw new Error('NO_AVAILABLE_FUNDS: there is no available vault USDC to withdraw.');
  if (BigInt(raw) > BigInt(vault.available)) throw new Error(`INSUFFICIENT_AVAILABLE: ${formatUSDC(vault.available)} USDC is available; ${formatUSDC(vault.reserved)} USDC is reserved. Close the stream to release its unused reserve.`);
  return raw;
}
export async function ownerVaultAction(agent, project, amount, ownerKeyFile, { topUp = false, noOpen = false, transact = ownerTransaction } = {}) {
  if (!amount) throw new Error(`Use ${topUp ? 'stream top-up AMOUNT' : 'withdraw AMOUNT|all'} --agent NAME.`);
  const { profile, config } = await settings(project);
  const reader = new NearAgentStreamsClient({ vaultId: config.vaultId, rpcUrl: config.rpcUrl });
  if ((await reader.provider.viewNodeStatus()).chain_id !== 'testnet') throw new Error('RPC_NETWORK_MISMATCH');
  const vault = await reader.getVault();
  if (vault.owner_id !== config.ownerId || vault.token_id !== config.tokenId) throw new Error('VAULT_IDENTITY_MISMATCH');
  if (topUp && !vault.active_session) throw new Error('NO_ACTIVE_STREAM');
  const raw = topUp ? usdc(amount) : withdrawalAmount(vault, amount);
  if (BigInt(raw) <= 0n) throw new Error('AMOUNT_MUST_BE_POSITIVE');
  if (topUp && BigInt(raw) > BigInt(vault.available)) throw new Error('INSUFFICIENT_AVAILABLE');
  const method = topUp ? 'top_up_stream' : 'withdraw_available';
  const args = { amount: raw, ...(topUp ? { session_id: vault.active_session } : {}) };
  if (ownerKeyFile) {
    const owner = await readKey(resolve(ownerKeyFile));
    if (owner.accountId !== config.ownerId) throw new Error('OWNER_CREDENTIAL_MISMATCH');
    const client = new NearAgentStreamsClient({ vaultId: config.vaultId, rpcUrl: config.rpcUrl, accountId: owner.accountId, privateKey: owner.privateKey });
    const journal = agent ?? { path: dirname(profile.file) };
    return { amountRawUSDC: raw, recipientId: config.ownerId, signing: 'explicit-local-key', ...await payout(journal, client, method, args) };
  }
  const receipt = await transact({ ownerId: config.ownerId, receiverId: config.vaultId, rpcUrl: config.rpcUrl,
    label: topUp ? `Add ${formatUSDC(raw)} USDC to your stream` : `Withdraw ${formatUSDC(raw)} USDC to ${config.ownerId}`,
    actions: [{ type: 'FunctionCall', params: { methodName: method, args, gas: '100000000000000', deposit: '0' } }],
    context: { kind: topUp ? 'top-up' : 'withdrawal', vaultId: config.vaultId, amount: raw, recipientId: config.ownerId } }, { noOpen });
  if (topUp ? receipt.value?.session_id !== vault.active_session : receipt.value !== true) throw new Error(`OWNER_VAULT_ACTION_FAILED: ${receipt.explorerUrl}`);
  return { amountRawUSDC: raw, amountUSDC: formatUSDC(raw), recipientId: config.ownerId, reservedRawUSDC: vault.reserved,
    transactionHash: receipt.hash, explorerUrl: receipt.explorerUrl, signing: 'browser-wallet', result: receipt.value };
}
