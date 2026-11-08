import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { mkdir, readFile, stat, open, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider } from 'near-api-js';
import { configHome, projectConfig, initProject, liveProfile } from './config.mjs';
import { atomicWrite, readOptional, safeTarget } from './files.mjs';
import { readKey, readConfig } from '@ola-893/agentstreams-core/internal-config';
import { NearAgentStreamsClient, formatUSDC } from '@ola-893/agentstreams-core/near';
import { connectedOwner, ownerTransaction } from './owner-wallet.mjs';
import { setupWithBrowser } from './browser-setup.mjs';
import { deployTestnet } from '@ola-893/agentstreams-core/internal-deployment';

const setupId = project => createHash('sha256').update(project).digest('hex');
export const bundledWasm = fileURLToPath(new URL('../artifacts/agentpay_vault.wasm', import.meta.url));
export const historicalVaultWasm = ['2.0.0', '2.1.0'].map(version => fileURLToPath(new URL(`../artifacts/vault-v${version}.wasm`, import.meta.url)));
export const publicRecording = fileURLToPath(new URL('../ui/near/testnet.json', import.meta.url));

export async function setupTestnet(project, options) {
  if (!options.ownerKeyFile && await connectedOwner()) return setupWithBrowser(project, options, { wasmFile: bundledWasm });
  if (!options.ownerId || !options.ownerKeyFile) return {
    status: 'OWNER_SETUP_REQUIRED', network: 'testnet', signedTransactions: 0,
    next: 'agentstream wallet connect --network testnet',
    localKeyAlternative: (options.setupCommand ?? 'agentstreams init') + ' --network testnet --owner-id YOUR.testnet --owner-key /absolute/path/owner.json',
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
  const { deploymentPlan, inspectTestnet } = await import('@ola-893/agentstreams-core/internal-preflight');
  const key = await readKey(resolve(options.ownerKeyFile));
  if (key.accountId !== options.ownerId) throw new Error('OWNER_CREDENTIAL_MISMATCH');
  const plan = deploymentPlan({ ownerId: options.ownerId, recipientId: options.recipientId || options.ownerId, vaultLabel: options.vaultLabel, agentLabel: options.agentLabel, rpcUrl: options.rpcUrl, serviceUrl: options.serviceUrl });
  const provider = new JsonRpcProvider({ url: plan.rpcUrl });
  const preflight = await inspectTestnet(plan, { provider, readWasm: () => readFile(bundledWasm), ownerPublicKey: key.publicKey });
  if (!options.deploy) return { ...preflight, next: preflight.readyToDeploy ? 'Repeat this init command with --deploy. Setup uses up to 6 test NEAR, installs owner-controlled vault/admin keys, and does not fund USDC or enable payments.' : 'Resolve the reported checks, then repeat init. No transaction was signed.' };
  if (!preflight.readyToDeploy) throw new Error('TESTNET_PREFLIGHT_FAILED: ' + preflight.checks.filter(c => c.status !== 'pass').map(c => `${c.id}: ${c.detail}`).join('; '));
  const home = configHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (((await stat(home)).mode & 0o077) !== 0) throw new Error('AGENTSTREAMS_HOME must have permissions 0700.');
  const directory = await safeTarget(home, join('setups', setupId(project)));
  const configPath = join(directory, 'deployment.json');
  if (await projectConfig(project) !== null) throw new Error('PROJECT_ALREADY_INITIALIZED');
  const result = await deployTestnet({ ...plan, ownerKeyFile: resolve(options.ownerKeyFile), vaultLabel: options.vaultLabel, agentLabel: options.agentLabel, directory, wasmFile: bundledWasm, onProgress: event => process.stderr.write(`NEAR setup ${event.step}: ${event.transactionHash}\n`) });
  await initProject(project, { deployment: configPath });
  return {
    status: 'DEPLOYED', network: 'testnet', ownerId: result.config.ownerId, vaultId: result.config.vaultId, agentId: result.config.agentId, recipientId: result.config.recipientId,
    paymentsEnabled: false, ownerUSDCFundingAddress: result.config.ownerId, usdcFaucet: 'https://faucet.circle.com/',
    transactions: result.record.steps.map(s => ({ step: s.name, hash: s.hash, explorerUrl: `https://testnet.nearblocks.io/txns/${s.hash}` })),
    privateSetupDirectory: directory, next: 'Get Circle test USDC for the owner (Near Testnet). Then agentstreams fund --amount 100000 --owner-key /absolute/path/owner.json. Owner/admin setup credentials are kept separately from the runtime profile.',
  };
}

export async function fundProject(project, { ownerKeyFile, amount, decimal = false, noOpen = false }) {
  if (!/^[1-9][0-9]{0,20}$/.test(amount ?? '') || (!decimal && BigInt(amount) > 100000n)) throw new Error(decimal ? 'Provide a positive test USDC amount.' : 'Provide --amount in raw six-decimal USDC units, at most 100000 (0.1 test USDC) per funding call.');
  if (!ownerKeyFile) return fundWithBrowser(project, amount, noOpen);
  const profile = await liveProfile(project);
  const config = await readConfig(profile.configPath);
  const owner = await readKey(resolve(ownerKeyFile));
  if (owner.accountId !== config.ownerId) throw new Error('OWNER_CREDENTIAL_MISMATCH');
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  if ((await provider.viewNodeStatus()).chain_id !== 'testnet') throw new Error('RPC_NETWORK_MISMATCH');
  const accessKey = await provider.viewAccessKey({ accountId: config.ownerId, publicKey: owner.publicKey, blockQuery: { finality: 'final' } });
  if (accessKey.permission !== 'FullAccess') throw new Error('OWNER_FULL_ACCESS_REQUIRED');
  const client = new NearAgentStreamsClient({ vaultId: config.vaultId, accountId: owner.accountId, privateKey: owner.privateKey, provider });
  const vault = await client.getVault();
  if (vault.owner_id !== owner.accountId || vault.token_id !== config.tokenId) throw new Error('VAULT_IDENTITY_MISMATCH');
  if (BigInt(await client.tokenBalance(owner.accountId, config.tokenId)) < BigInt(amount)) throw new Error(`OWNER_USDC_INSUFFICIENT: request Near Testnet USDC at https://faucet.circle.com/ for ${owner.accountId}`);
  const pending = join(configHome(), 'funding', createHash('sha256').update(config.vaultId).digest('hex') + '.json');
  await mkdir(join(configHome(), 'funding'), { recursive: true, mode: 0o700 });
  let journal;
  try { journal = await open(pending, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') throw new Error(`FUNDING_RECONCILIATION_REQUIRED: inspect ${pending}. No transaction was resubmitted.`); throw e; }
  try { await journal.writeFile(JSON.stringify({ network: config.network, vaultId: config.vaultId, ownerId: owner.accountId, amount, createdAt: new Date().toISOString() })); await journal.sync(); } finally { await journal.close(); }
  const receipt = await client.fund(amount);
  await atomicWrite(pending.replace('.json', `-${receipt.hash}.receipt.json`), JSON.stringify(receipt));
  if (receipt.receiptFailures.length || receipt.value !== amount) throw new Error(`FUNDING_NOT_CONFIRMED: ${receipt.hash}; inspect ${pending}.`);
  await unlink(pending);
  return { network: 'testnet', amountRawUSDC: amount, transactionHash: receipt.hash, explorerUrl: `https://testnet.nearblocks.io/txns/${receipt.hash}`, next: 'agentstreams config show; configure service/inference and guardrails, then agentstreams payments --enable and agentstreams agent run --prompt "..."' };
}

async function fundWithBrowser(project, amount, noOpen) {
  const profile = await liveProfile(project), config = await readConfig(profile.configPath);
  await connectedOwner({ required: true, ownerId: config.ownerId });
  const client = new NearAgentStreamsClient({ vaultId: config.vaultId, rpcUrl: config.rpcUrl });
  const vault = await client.getVault();
  if (vault.owner_id !== config.ownerId || vault.token_id !== config.tokenId) throw new Error('VAULT_IDENTITY_MISMATCH');
  if (BigInt(await client.tokenBalance(config.ownerId, config.tokenId)) < BigInt(amount)) throw new Error(`OWNER_USDC_INSUFFICIENT: fund ${config.ownerId} at https://faucet.circle.com/ (Near Testnet).`);
  const receipt = await ownerTransaction({ ownerId: config.ownerId, receiverId: config.tokenId, rpcUrl: config.rpcUrl, label: `Fund your agentStreams vault with ${formatUSDC(amount)} test USDC`,
    actions: [{ type: 'FunctionCall', params: { methodName: 'ft_transfer_call', args: { receiver_id: config.vaultId, amount, msg: 'fund' }, gas: '100000000000000', deposit: '1' } }], context: { kind: 'funding', vaultId: config.vaultId, amount } }, { noOpen });
  if (receipt.value !== amount) throw new Error(`FUNDING_NOT_CONFIRMED: ${receipt.explorerUrl}`);
  return { network: 'testnet', amountRawUSDC: amount, transactionHash: receipt.hash, explorerUrl: receipt.explorerUrl, signing: 'browser-wallet' };
}
