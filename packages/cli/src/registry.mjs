import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, baseEncode, keyToImplicitAddress } from 'near-api-js';
import { decodeOutcome } from '@ola-893/agentstreams-core/near';
import { configHome } from './config.mjs';
import { atomicWrite, readOptional } from './files.mjs';
import { feedKey, readAgentState, withAgentState } from './agents.mjs';
import { connectedOwner, ownerTransaction } from './owner-wallet.mjs';
import network from './registry-network.json' with { type: 'json' };

const methods = ['heartbeat', 'stop'];
const gas = 30_000_000_000_000n;
const allowance = 50_000_000_000_000_000_000_000n;
const wasmFile = new URL('../artifacts/remora_registry.wasm', import.meta.url);

export async function registryConfig(agent, contractId) {
  const saved = JSON.parse(await readOptional(join(configHome(), 'registry.json')) ?? 'null');
  const registration = agent && (await readAgentState(agent)).registry;
  const config = { ...network, ...saved, ...(registration ? { contractId: registration.contractId, rpcUrl: registration.rpcUrl } : {}), ...(contractId ? { contractId } : {}) };
  if (!config.contractId) throw new Error('REGISTRY_NOT_CONFIGURED: run registry deploy or registry set --registry CONTRACT_ID.');
  if (!/^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(config.contractId)) throw new Error('INVALID_REGISTRY_ACCOUNT');
  return config;
}

export async function setRegistry(contractId, rpcUrl = network.rpcUrl) {
  const config = await registryConfig(null, contractId);
  const provider = new JsonRpcProvider({ url: rpcUrl });
  if ((await provider.viewNodeStatus()).chain_id !== 'testnet') throw new Error('REGISTRY_NETWORK_MISMATCH');
  const page = await provider.callFunction({ contractId, method: 'list_publishers', args: { limit: 1 }, blockQuery: { finality: 'final' } });
  if (!Array.isArray(page.publishers) || page.heartbeat_ttl_seconds !== 120) throw new Error('INVALID_REGISTRY_CONTRACT');
  await atomicWrite(join(configHome(), 'registry.json'), JSON.stringify({ ...config, rpcUrl }));
  return { ...config, rpcUrl };
}

export async function deployRegistry() {
  const wallet = await connectedOwner({ required: true });
  const rpcUrl = wallet.rpcUrl ?? network.rpcUrl;
  const provider = new JsonRpcProvider({ url: rpcUrl });
  if ((await provider.viewNodeStatus()).chain_id !== 'testnet') throw new Error('REGISTRY_NETWORK_MISMATCH');
  const file = join(configHome(), 'registry-deployment.json');
  let pending = JSON.parse(await readOptional(file) ?? 'null');
  if (pending?.status === 'deployed') {
    const deployed = await provider.viewAccount({ accountId: pending.contractId, blockQuery: { finality: 'final' } });
    if (deployed.code_hash !== pending.codeHash) throw new Error('REGISTRY_DEPLOYMENT_CODE_MISMATCH');
    return { ...await setRegistry(pending.contractId, rpcUrl), transactionHash: pending.transactionHash, immutable: true, ownerPrivateKeyStored: false };
  }
  const wasm = await readFile(wasmFile);
  const codeHash = baseEncode(createHash('sha256').update(wasm).digest());
  if (!pending) {
    const key = KeyPair.fromRandom('ed25519');
    pending = { ownerId: wallet.accountId, contractId: keyToImplicitAddress(key.getPublicKey()), privateKey: key.toString(), codeHash, rpcUrl };
    await atomicWrite(file, JSON.stringify(pending));
  }
  if (pending.ownerId !== wallet.accountId || pending.codeHash !== codeHash) throw new Error('REGISTRY_DEPLOYMENT_RECONCILIATION_REQUIRED');
  let chainAccount;
  try { chainAccount = await provider.viewAccount({ accountId: pending.contractId, blockQuery: { finality: 'final' } }); }
  catch (error) { if (!/UNKNOWN_ACCOUNT|does not exist|doesn't exist/.test(error.message)) throw error; }
  if (!chainAccount) {
    const funding = await ownerTransaction({ ownerId: wallet.accountId, receiverId: pending.contractId, rpcUrl,
      label: 'Fund the shared Remora registry with 3 test NEAR',
      actions: [{ type: 'Transfer', params: { deposit: '3000000000000000000000000' } }],
      context: { kind: 'registry-deployment', contractId: pending.contractId } });
    pending.fundingHash = funding.hash;
    await atomicWrite(file, JSON.stringify(pending));
    chainAccount = await provider.viewAccount({ accountId: pending.contractId, blockQuery: { finality: 'final' } });
  }
  if (chainAccount.code_hash !== codeHash) {
    if (chainAccount.code_hash !== '11111111111111111111111111111111') throw new Error('REGISTRY_DEPLOYMENT_CODE_MISMATCH');
    const key = KeyPair.fromString(pending.privateKey);
    const account = new Account(pending.contractId, provider, new KeyPairSigner(key));
    const transaction = await account.createTransaction({ receiverId: pending.contractId, publicKey: key.getPublicKey(), actions: [
      actions.deployContract(wasm), actions.functionCall('new', {}, gas, 0n), actions.deleteKey(key.getPublicKey()),
    ] });
    const { txHash, signedTransaction } = await new KeyPairSigner(key).signTransaction(transaction);
    pending.transactionHash = baseEncode(txHash);
    await atomicWrite(file, JSON.stringify(pending));
    const result = decodeOutcome(await provider.sendTransactionUntil(signedTransaction, 'FINAL'));
    if (result.receiptFailures.length) throw new Error('REGISTRY_DEPLOYMENT_RECONCILIATION_REQUIRED');
  }
  const config = await setRegistry(pending.contractId, rpcUrl);
  delete pending.privateKey;
  await atomicWrite(file, JSON.stringify({ ...pending, status: 'deployed', immutable: true }));
  return { ...config, transactionHash: pending.transactionHash, immutable: true, ownerPrivateKeyStored: false };
}

export async function registerPublisher(agent, contractId) {
  const { publish } = await readAgentState(agent);
  if (!publish || !publish.origin.startsWith('https://')) throw new Error('REGISTRY_HTTPS_FEED_REQUIRED: configure a publicly reachable HTTPS feed origin.');
  const config = await registryConfig(agent, contractId);
  const wallet = await connectedOwner({ required: true });
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  if ((await provider.viewNodeStatus()).chain_id !== 'testnet') throw new Error('REGISTRY_NETWORK_MISMATCH');
  const key = await feedKey(agent);
  const current = await provider.callFunction({ contractId: config.contractId, method: 'get_publisher', args: { id: agent.id }, blockQuery: { finality: 'final' } });
  if (!current || current.origin !== publish.origin || current.owner_id !== wallet.accountId) {
    const expires_at = String(Math.floor(Date.now() / 1000) + 300);
    const message = ['remora.registry.register.v1', config.contractId, wallet.accountId, agent.id, publish.origin, expires_at].join('\n');
    await ownerTransaction({ ownerId: wallet.accountId, receiverId: config.contractId, rpcUrl: config.rpcUrl,
      label: `Register ${agent.name} in the NEAR publisher directory`,
      actions: [{ type: 'FunctionCall', params: { methodName: 'register', gas: gas.toString(), deposit: '10000000000000000000000', args: {
        id: agent.id, origin: publish.origin, public_key: agent.publicKey, expires_at,
        signature: Buffer.from(key.sign(Buffer.from(message)).signature).toString('base64'),
      } } }], context: { kind: 'publisher-registration', publisherId: agent.id, contractId: config.contractId } });
  }
  let access;
  try { access = await provider.viewAccessKey({ accountId: wallet.accountId, publicKey: agent.publicKey, blockQuery: { finality: 'final' } }); }
  catch (error) { if (!/UNKNOWN_ACCESS_KEY|does not exist|doesn't exist/.test(error.message)) throw error; }
  if (access) {
    const permission = access.permission?.FunctionCall;
    if (!permission || permission.receiver_id !== config.contractId || permission.method_names.length !== methods.length || !methods.every(name => permission.method_names.includes(name))) {
      throw new Error('REGISTRY_KEY_SCOPE_MISMATCH');
    }
  } else {
    await ownerTransaction({ ownerId: wallet.accountId, receiverId: wallet.accountId, rpcUrl: config.rpcUrl,
      label: `Allow ${agent.name} to send registry heartbeats, with a 0.05 test NEAR fee allowance`,
      actions: [{ type: 'AddKey', params: { publicKey: agent.publicKey, accessKey: { nonce: 0,
        permission: { receiverId: config.contractId, methodNames: methods, allowance: allowance.toString() } } } }],
      context: { kind: 'registry-heartbeat-key', publisherId: agent.id, contractId: config.contractId } });
  }
  const registration = { ...config, ownerId: wallet.accountId, registeredOrigin: publish.origin };
  await withAgentState(agent, state => { state.registry = registration; });
  return { ...registration, publisherId: agent.id, registered: true, heartbeatMethods: methods, ownerPrivateKeyStored: false };
}

export async function registryHeartbeat(agent, stop = false) {
  const state = await readAgentState(agent);
  if (!state.registry) return null;
  if (!stop && (!state.publish?.enabled || state.publish.origin !== state.registry.registeredOrigin)) throw new Error('REGISTRY_PUBLICATION_CHANGED: register the current feed before advertising it.');
  const config = state.registry;
  const key = await feedKey(agent);
  const account = new Account(config.ownerId, new JsonRpcProvider({ url: config.rpcUrl }), new KeyPairSigner(key));
  const receipt = decodeOutcome(await account.signAndSendTransaction({ receiverId: config.contractId, waitUntil: 'FINAL',
    actions: [actions.functionCall(stop ? 'stop' : 'heartbeat', { id: agent.id }, gas, 0n)] }));
  return { publisherId: agent.id, method: stop ? 'stop' : 'heartbeat', transactionHash: receipt.hash };
}

export async function registryPublishers(agent, id) {
  const config = await registryConfig(agent);
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  if ((await provider.viewNodeStatus()).chain_id !== 'testnet') throw new Error('REGISTRY_NETWORK_MISMATCH');
  if (id) {
    const item = await provider.callFunction({ contractId: config.contractId, method: 'get_publisher', args: { id }, blockQuery: { finality: 'final' } });
    return item ? [{ id: item.id, origin: item.origin }] : [];
  }
  const entries = [];
  let from_index = '0';
  do {
    const page = await provider.callFunction({ contractId: config.contractId, method: 'list_publishers', args: { from_index, limit: 100 }, blockQuery: { finality: 'final' } });
    entries.push(...page.publishers.map(item => ({ id: item.id, origin: item.origin })));
    from_index = page.next_index;
  } while (from_index !== null && entries.length < 1000);
  return entries;
}
