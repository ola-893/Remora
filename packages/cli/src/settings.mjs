import { ownerTransaction, connectedOwner } from './owner-wallet.mjs';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { liveProfile } from './config.mjs';
import { atomicWrite, readOptional } from './files.mjs';
import { readConfig } from '@ola-893/agentstreams-core/internal-config';
import { runtimePolicy, serviceConfig } from '@ola-893/agentstreams-core/internal-runtime-policy';
import { inspectNearProfile, NearAgentStreamsClient } from '@ola-893/agentstreams-core/near';
import { inferenceConfig } from './inference.mjs';
import { withAgentState } from './agents.mjs';
export { inferenceConfig } from './inference.mjs';

export function usdc(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,24})(\.[0-9]{1,6})?$/.test(value)) throw new Error('Use a nonnegative USDC amount with at most six decimal places.');
  const [whole, fraction = ''] = value.split('.');
  return (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))).toString();
}
export function durationSeconds(value) {
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? '') || Number(value) > 4294967295) throw new Error('Use a duration in seconds, or 0 for no time limit.');
  return Number(value);
}
export async function settings(project) {
  const profile = await liveProfile(project);
  return { profile, config: await readConfig(profile.configPath) };
}
export async function showSettings(project) {
  const { profile, config } = await settings(project);
  const { client, summary } = await inspectNearProfile(profile.configPath, profile.stateRoot);
  return { network: config.network, vaultId: config.vaultId, agentId: config.agentId, recipientId: config.recipientId, paymentsEnabled: profile.paymentsEnabled,
    financialPolicy: (await client.getVault()).policy, financialUnits: 'raw USDC (1 USDC = 1000000)', runtimePolicy: config.runtimePolicy,
    service: { url: config.serviceUrl, ...config.service }, inference: profile.inference || null, ...summary };
}
export async function setRuntime(project, patch) {
  if (!Object.keys(patch).length) throw new Error('Specify at least one runtime guardrail. See --help.');
  const { profile, config } = await settings(project);
  config.runtimePolicy = runtimePolicy({ ...config.runtimePolicy, ...patch });
  await atomicWrite(profile.configPath, JSON.stringify(config, null, 2));
  return { runtimePolicy: config.runtimePolicy, enforcement: 'local payment worker; thresholds reload on the next checkpoint', restartRequired: 'Restart running agents/MCP servers after changing reuse, polling or exit behavior.' };
}
export async function setService(project, patch) {
  const { profile, config } = await settings(project);
  const { summary, client } = await inspectNearProfile(profile.configPath, profile.stateRoot);
  if (summary.activeSession || summary.pendingIntent || summary.executorBusyOrInterrupted) throw new Error('CLOSE_OR_RECONCILE_STREAM_BEFORE_SERVICE_CHANGE');
  const { url, recipient, ...paths } = patch;
  const next = { ...config, serviceUrl: url || config.serviceUrl, recipientId: recipient || config.recipientId, service: serviceConfig({ ...config.service, ...paths }) };
  const temp = profile.configPath + '.candidate.json';
  await atomicWrite(temp, JSON.stringify(next));
  let validated;
  try { validated = await readConfig(temp); } finally { await unlink(temp); }
  if (!(await client.getVault()).policy.recipients.includes(validated.recipientId)) throw new Error('RECIPIENT_NOT_IN_ONCHAIN_POLICY');
  await atomicWrite(profile.configPath, JSON.stringify(validated, null, 2));
  return { service: { url: validated.serviceUrl, recipient: validated.recipientId, ...validated.service }, restartRequired: 'Restart running agents/MCP servers after service changes.' };
}
export async function setInference(project, input, agent) {
  const inference = inferenceConfig(input);
  if (agent) await withAgentState(agent, state => { state.inference = inference; });
  else {
    const { file, configPath, stateRoot, ...saved } = await liveProfile(project);
    await atomicWrite(file, JSON.stringify({ ...saved, inference }, null, 2));
  }
  return { inference, credentialsStored: false,
    ...(inference.provider === 'near-ai' ? { attestationVerified: false, policySignerLocation: 'local host' } : {}),
    next: 'agentstreams agent run --prompt "Describe the task you want the agent to perform."' };
}
function validateFinancialPolicy(policy, vault, config) {
  const { budget, max_deposit: deposit, max_rate: rate, max_duration_seconds: duration, recipients } = policy;
  const validAmounts = BigInt(budget) >= BigInt(vault.spent) && BigInt(deposit) > 0n &&
    BigInt(deposit) <= BigInt(budget) && BigInt(rate) > 0n;
  const validDuration = Number.isInteger(duration) && duration >= 0 && duration <= 4294967295;
  const validRecipients = recipients.includes(config.recipientId) && recipients.length <= 32 &&
    recipients.every(id => /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(id));
  if (!validAmounts || !validDuration || !validRecipients) throw new Error('INVALID_FINANCIAL_POLICY');
}
export async function reconcileLimits(project) {
  const { profile } = await settings(project);
  const { client, stateDir } = await inspectNearProfile(profile.configPath, profile.stateRoot);
  const file = join(stateDir, 'policy-pending.json');
  const text = await readOptional(file);
  if (!text) return { resolved: true, reason: 'NO_PENDING_POLICY' };
  const pending = JSON.parse(text), vault = await client.getVault(), actual = vault.policy;
  if (JSON.stringify(actual) !== JSON.stringify(pending.policy) || pending.nonceBefore === undefined || BigInt(vault.next_nonce) <= BigInt(pending.nonceBefore)) return { resolved: false, reason: 'POLICY_OUTCOME_UNCONFIRMED' };
  await atomicWrite(file.replace('.json', '.reconciled.json'), JSON.stringify({ ...pending, verifiedAt: new Date().toISOString() }));
  await unlink(file);
  return { resolved: true, financialPolicy: actual, receiptRecovered: false };
}

export async function setLimits(project, patch) {
  if (!Object.keys(patch).length) throw new Error('Specify at least one financial limit.');
  const { profile, config } = await settings(project);
  await connectedOwner({ required: true, ownerId: config.ownerId });
  const { summary } = await inspectNearProfile(profile.configPath, profile.stateRoot);
  if (summary.policyUpdatePending) throw new Error('POLICY_RECONCILIATION_REQUIRED: run agentstream config reconcile.');
  if (summary.pendingIntent || summary.executorBusyOrInterrupted) throw new Error('RECONCILIATION_REQUIRED: run agentstream reconcile.');
  const client = new NearAgentStreamsClient({ vaultId: config.vaultId, rpcUrl: config.rpcUrl });
  const vault = await client.getVault();
  if (vault.owner_id !== config.ownerId || vault.token_id !== config.tokenId) throw new Error('VAULT_IDENTITY_MISMATCH');
  if (vault.active_session) throw new Error('CLOSE_STREAM_BEFORE_POLICY_CHANGE');
  const policy = { ...vault.policy, ...patch };
  validateFinancialPolicy(policy, vault, config);
  const receipt = await ownerTransaction({ ownerId: config.ownerId, receiverId: config.vaultId, rpcUrl: config.rpcUrl, label: 'Update your agent’s payment guardrails',
    actions: [{ type: 'FunctionCall', params: { methodName: 'configure', args: { policy }, gas: '100000000000000', deposit: '0' } }], context: { kind: 'configure', vaultId: config.vaultId, policy } });
  const actual = (await client.getVault()).policy;
  if (JSON.stringify(actual) !== JSON.stringify(policy)) throw new Error('POLICY_RECONCILIATION_REQUIRED');
  return { financialPolicy: actual, units: 'raw USDC', transactionHash: receipt.hash, explorerUrl: receipt.explorerUrl, signing: 'browser-wallet' };
}
