import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configHome, liveProfile } from './config.mjs';
import { readOptional } from './files.mjs';
import { readConfig } from '@ola-893/agentstreams-core/internal-config';
import { NearAgentStreamsClient, formatUSDC } from '@ola-893/agentstreams-core/near';
import { connectedOwner, ownerTransaction } from './owner-wallet.mjs';
import { setupWithBrowser } from './browser-setup.mjs';

export const bundledWasm = fileURLToPath(new URL('../artifacts/agentpay_vault.wasm', import.meta.url));
export const historicalVaultWasm = ['2.0.0', '2.1.0'].map(version => fileURLToPath(new URL(`../artifacts/vault-v${version}.wasm`, import.meta.url)));
export const publicRecording = fileURLToPath(new URL('../ui/near/testnet.json', import.meta.url));

export async function setupTestnet(project, options) {
  if (await connectedOwner()) return setupWithBrowser(project, options, { wasmFile: bundledWasm });
  return {
    status: 'OWNER_SETUP_REQUIRED', network: 'testnet', signedTransactions: 0,
    next: 'agentstream wallet connect --network testnet',
    ownerSigning: 'browser-wallet',
    steps: [
      'Connect a funded named NEAR testnet account in your browser wallet.',
      'Run setup again to check deployment readiness. Keep at least 6 test NEAR available after storage reserve.',
      'Repeat setup with --deploy and approve each transaction in the browser.',
      'Fund the owner wallet with Circle test USDC, then run agentstream fund AMOUNT and approve the transfer.',
    ],
    nearAccounts: 'https://docs.near.org/tools/cli', usdcFaucet: 'https://faucet.circle.com/',
    noSponsor: true,
  };
}

export async function fundProject(project, { amount, decimal = false }) {
  if (!/^[1-9][0-9]{0,20}$/.test(amount ?? '') || (!decimal && BigInt(amount) > 100000n)) throw new Error(decimal ? 'Provide a positive test USDC amount.' : 'Provide --amount in raw six-decimal USDC units, at most 100000 (0.1 test USDC) per funding call.');
  const profile = await liveProfile(project), config = await readConfig(profile.configPath);
  await connectedOwner({ required: true, ownerId: config.ownerId });
  const pending = join(configHome(), 'funding', createHash('sha256').update(config.vaultId).digest('hex') + '.json');
  if (await readOptional(pending) !== null) throw new Error(`FUNDING_RECONCILIATION_REQUIRED: inspect ${pending} before funding again.`);
  const client = new NearAgentStreamsClient({ vaultId: config.vaultId, rpcUrl: config.rpcUrl });
  const vault = await client.getVault();
  if (vault.owner_id !== config.ownerId || vault.token_id !== config.tokenId) throw new Error('VAULT_IDENTITY_MISMATCH');
  if (BigInt(await client.tokenBalance(config.ownerId, config.tokenId)) < BigInt(amount)) throw new Error(`OWNER_USDC_INSUFFICIENT: fund ${config.ownerId} at https://faucet.circle.com/ (Near Testnet).`);
  const receipt = await ownerTransaction({ ownerId: config.ownerId, receiverId: config.tokenId, rpcUrl: config.rpcUrl, label: `Fund your agentStreams vault with ${formatUSDC(amount)} test USDC`,
    actions: [{ type: 'FunctionCall', params: { methodName: 'ft_transfer_call', args: { receiver_id: config.vaultId, amount, msg: 'fund' }, gas: '100000000000000', deposit: '1' } }], context: { kind: 'funding', vaultId: config.vaultId, amount } });
  if (receipt.value !== amount) throw new Error(`FUNDING_NOT_CONFIRMED: ${receipt.explorerUrl}`);
  return { network: 'testnet', amountRawUSDC: amount, transactionHash: receipt.hash, explorerUrl: receipt.explorerUrl, signing: 'browser-wallet' };
}
