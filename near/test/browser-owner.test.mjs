import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { Account, KeyPair, KeyPairSigner, PublicKey, actions, keyToImplicitAddress } from 'near-api-js';
import { createSandbox, wasmPath } from '../scripts/sandbox.mjs';
import { NearAgentStreamsClient } from '../sdk/index.mjs';
import { signPermit } from '../lib/permit.mjs';
import { bootstrapActions, browserDeploymentSteps } from '../../packages/cli/src/browser-setup.mjs';
import { verifyOwnerTransaction } from '../../packages/cli/src/owner-wallet.mjs';

function nativeAction(a) {
  if (a.type === 'CreateAccount') return actions.createAccount();
  if (a.type === 'Transfer') return actions.transfer(BigInt(a.params.deposit));
  if (a.type === 'DeployContract') return actions.deployContract(Buffer.from(a.params.codeBase64, 'base64'));
  if (a.type === 'FunctionCall') return actions.functionCall(a.params.methodName, a.params.args, BigInt(a.params.gas), BigInt(a.params.deposit));
  const p = a.params.accessKey.permission;
  return p === 'FullAccess' ? actions.addFullAccessKey(PublicKey.fromString(a.params.publicKey)) : actions.addFunctionCallAccessKey(PublicKey.fromString(a.params.publicKey), p.receiverId, p.methodNames, BigInt(p.allowance));
}

test('browser-owner deployment transaction plans and owner withdrawals execute on the native NEAR sandbox', { timeout: 120000 }, async t => {
  await mkdir('.local/near-tests', { recursive: true });
  const directory = await mkdtemp('.local/near-tests/browser-owner-');
  const env = await createSandbox({ directory });
  t.after(async () => { const stop = setTimeout(() => env.sandbox.childProcess?.kill('SIGKILL'), 5000); stop.unref(); try { await env.sandbox.tearDown(); } finally { clearTimeout(stop); } });
  const ownerId = env.config.ownerId, vaultId = 'browser-vault.' + ownerId, agentId = 'browser-agent.' + ownerId;
  const agentKey = KeyPair.fromRandom('ed25519'), policyKey = KeyPair.fromRandom('ed25519');
  const wasm = await readFile(wasmPath('agentpay_vault'));
  const vaultBootstrap = KeyPair.fromRandom('ed25519'), agentBootstrap = KeyPair.fromRandom('ed25519');
  const implicitVault = keyToImplicitAddress(vaultBootstrap.getPublicKey()), implicitAgent = keyToImplicitAddress(agentBootstrap.getPublicKey());
  const implicit = { plan: { ownerId, vaultId: implicitVault, agentId: implicitAgent, recipientId: ownerId, tokenId: env.config.tokenId }, ownerPublicKey: env.keys.owner.getPublicKey().toString(), agentPublicKey: agentKey.getPublicKey().toString(), policyPublicKey: policyKey.getPublicKey().toString() };
  for (const [role, accountId, key, amount] of [['vault', implicitVault, vaultBootstrap, 5000000000000000000000000n], ['agent', implicitAgent, agentBootstrap, 500000000000000000000000n]]) {
    await env.accounts.outsider.signAndSendTransaction({ receiverId: accountId, actions: [actions.transfer(amount)], waitUntil: 'FINAL' });
    const account = new Account(accountId, env.provider, KeyPairSigner.fromSecretKey(key.toString()));
    const result = await account.signAndSendTransaction({ receiverId: accountId, actions: bootstrapActions(role, implicit, wasm, key.getPublicKey()), waitUntil: 'FINAL' });
    assert.ok('SuccessValue' in result.status);
    const { keys } = await env.provider.viewAccessKeyList({ accountId, blockQuery: { finality: 'final' } });
    assert.deepEqual(keys.filter(k => k.access_key.permission === 'FullAccess').map(k => k.public_key), [implicit.ownerPublicKey]);
    assert.ok(!keys.some(k => k.public_key === key.getPublicKey().toString()));
  }
  const implicitClient = new NearAgentStreamsClient({ vaultId: implicitVault, provider: env.provider, accountId: implicitAgent, privateKey: agentKey.toString() });
  assert.equal((await implicitClient.assertRestrictedAgent()).owner_id, ownerId);
  const steps = browserDeploymentSteps({ plan: { ownerId, vaultId, agentId, recipientId: ownerId }, ownerPublicKey: env.keys.owner.getPublicKey().toString(), agentPublicKey: agentKey.getPublicKey().toString(), policyPublicKey: policyKey.getPublicKey().toString(), wasm: await readFile(wasmPath('agentpay_vault')) });
  // The sandbox uses its local test token; production plans pin Circle testnet USDC.
  steps[0].actions.at(-1).params.args.token_id = env.config.tokenId;
  for (const step of steps) {
    const outcome = await env.accounts.owner.signAndSendTransaction({ receiverId: step.receiverId, actions: step.actions.map(nativeAction), waitUntil: 'FINAL' });
    const verified = verifyOwnerTransaction(outcome, { ...step, ownerId });
    assert.equal(verified.receiptFailures.length, 0);
  }
  const owner = new NearAgentStreamsClient({ vaultId, provider: env.provider, accountId: ownerId, privateKey: env.keys.owner.toString() });
  const agent = new NearAgentStreamsClient({ vaultId, provider: env.provider, accountId: agentId, privateKey: agentKey.toString() });
  assert.equal((await owner.getVault()).owner_id, ownerId);
  assert.equal((await owner.getVault()).version, '2.2.0');
  await agent.assertRestrictedAgent();
  await env.accounts.owner.callFunction({ contractId: env.config.tokenId, methodName: 'storage_deposit', args: { account_id: vaultId, registration_only: true }, deposit: 10000000000000000000000n });
  await owner.fund('20000');
  const vault = await owner.getVault();
  await agent.open(signPermit({ domain: 'agentpay.near.v1', vault_id: vaultId, agent_id: agentId, action: 'OPEN', session_id: 'browser-owner-withdrawal', recipient_id: ownerId, rate: '1', duration_seconds: 0, quote_hash: 'a'.repeat(64), nonce: vault.next_nonce, expires_at: String(Number(vault.now) + 90) }, policyKey.toString()));
  const active = await owner.getVault(); assert.equal(active.available, '10000'); assert.equal(active.reserved, '10000');
  const outside = new NearAgentStreamsClient({ vaultId, provider: env.provider, accountId: env.accounts.outsider.accountId, privateKey: env.keys.outsider.toString() });
  await assert.rejects(outside.withdraw('1'), /OWNER_ONLY/);
  await assert.rejects(agent.withdraw('1'), /access|permission|method/i);
  await assert.rejects(owner.withdraw('10001'), /INSUFFICIENT_AVAILABLE/);
  const balance = BigInt(await owner.tokenBalance(ownerId, env.config.tokenId));
  const paid = await owner.withdraw('1000'); assert.equal(paid.value, true);
  const after = await owner.getVault(); assert.equal(after.available, '9000'); assert.equal(after.reserved, '10000'); assert.equal(after.active_session, active.active_session);
  assert.equal(BigInt(await owner.tokenBalance(ownerId, env.config.tokenId)), balance + 1000n);
  assert.equal(await owner.tokenBalance(vaultId, env.config.tokenId), '19000');
  await owner.recover(active.active_session);
  const ended = await owner.getVault(); await owner.withdraw(ended.available);
  if (BigInt(await owner.getClaim(ownerId)) > 0n) await owner.claim();
  assert.equal(await owner.tokenBalance(vaultId, env.config.tokenId), '0');
});
