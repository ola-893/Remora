import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { KeyPair } from 'near-api-js';
import { NearAgentStreamsClient } from '../runtime/near/sdk/index.mjs';
import { readConfig, readKey } from '../runtime/near/lib/config.mjs';
import { startPolicyWorker } from '../runtime/near/lib/worker-client.mjs';
import { streamAccessReason } from '../runtime/near/lib/stream.mjs';
import { makeSession } from '../runtime/near/lib/session.mjs';
import { PaymentExecutor } from './executor.mjs';

export { NearAgentStreamsClient, NearAgentPayClient, USDC, formatUSDC, AGENT_METHODS, decodeOutcome } from '../runtime/near/sdk/index.mjs';

export async function inspectNearProfile(configPath, stateRoot) {
  const config = await readConfig(configPath);
  const agent = await readKey(config.agentKeyFile);
  const policy = await readKey(config.policyKeyFile);
  if (agent.accountId !== config.agentId || agent.publicKey === policy.publicKey) throw new Error('CREDENTIAL_IDENTITY_MISMATCH');
  const client = new NearAgentStreamsClient({ vaultId: config.vaultId, accountId: config.agentId, privateKey: agent.privateKey, rpcUrl: config.rpcUrl });
  const status = await client.provider.viewNodeStatus();
  if (config.network === 'testnet' && status.chain_id !== 'testnet') throw new Error('RPC_NETWORK_MISMATCH');
  const vault = await client.assertRestrictedAgent();
  if (vault.policy_key !== policy.publicKey || vault.token_id !== config.tokenId || vault.owner_id !== config.ownerId || !vault.policy.recipients.includes(config.recipientId)) throw new Error('VAULT_IDENTITY_MISMATCH');
  const stateDir = join(stateRoot, createHash('sha256').update(`${config.rpcUrl}|${config.vaultId}|${config.agentId}`).digest('hex'));
  let pending = false;
  try { await access(join(stateDir, 'pending.json')); pending = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let locked = false;
  try { await access(join(stateDir, 'operation.lock')); locked = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let policyPending = false;
  try { await access(join(stateDir, 'policy-pending.json')); policyPending = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { config, client, agent, stateDir, summary: {
    network: config.network, vaultId: config.vaultId, agentId: config.agentId, policySignerMatches: true, restrictedKey: true,
    availableUSDC: vault.available, reservedUSDC: vault.reserved, spentUSDC: vault.spent, activeSession: vault.active_session, pendingIntent: pending, executorBusyOrInterrupted: locked, policyUpdatePending: policyPending,
    agentNEAR: String((await client.provider.viewAccount({ accountId: config.agentId, blockQuery: { finality: 'final' } })).amount),
    vaultTokenBalance: await client.tokenBalance(config.vaultId, config.tokenId),
  } };
}

export async function createNearGateway({ configPath, stateRoot, paymentsEnabled = false }) {
  const { config, client, agent, stateDir } = await inspectNearProfile(configPath, stateRoot);
  let worker;
  const proxy = { request: (request) => {
    // Explicit allowlist: no model API keys, owner credentials, NODE_OPTIONS or NEAR_* overrides.
    worker ??= startPolicyWorker(configPath, { env: { ...Object.fromEntries(['PATH', 'LANG', 'TZ', 'SYSTEMROOT', 'TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]])), AGENTPAY_STATE_DIR: join(stateDir, 'service-state') } });
    return worker.request(request);
  } };
  const executor = new PaymentExecutor({ client, worker: proxy, stateDir, paymentsEnabled, tiers: config.service.tiers, serviceId: JSON.stringify({ origin: config.serviceUrl, recipient: config.recipientId, service: config.service }) });
  const key = KeyPair.fromString(agent.privateKey);
  return Object.freeze({
    mode: config.network, serviceUrl: config.serviceUrl, service: config.service, runtimePolicy: config.runtimePolicy,
    check: (args) => executor.check(args),
    open: args => executor.open(args),
    close: args => executor.close(args),
    observeResult: args => executor.observe(args),
    status: () => executor.context(),
    reconcile: () => executor.reconcile(),
    async sessionHeaders() {
      const { stream, reusable } = await executor.context();
      if (!reusable || !stream || streamAccessReason(stream) !== null) return {};
      return { 'x-agentpay-session': makeSession({ config, stream, key }) };
    },
    async dispose() { worker?.stop(); },
  });
}
