import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { ownerMessageBytes, verifyOwnerMessage, verifyOwnerTransaction, startOwnerSession, ownerTransaction, reconcileOwnerWallet } from '../cli/src/owner-wallet.mjs';
import { withdrawalAmount } from '../cli/src/owner-actions.mjs';
import { browserDeploymentSteps } from '../cli/src/browser-setup.mjs';

const key = KeyPair.fromRandom('ed25519');
const challenge = () => ({ message: 'Connect owner to agentStreams testnet', nonce: randomBytes(32).toString('base64'), recipient: 'agentstreams.local' });
const signed = (c, accountId = 'owner.testnet') => ({ accountId, publicKey: key.getPublicKey().toString(), signature: Buffer.from(key.sign(ownerMessageBytes(c)).signature).toString('base64') });
const provider = { viewNodeStatus: async () => ({ chain_id: 'testnet' }), viewBlock: async ({ blockId }) => ({ header: { height: blockId ? 11 : 10 } }), viewAccessKey: async () => ({ permission: 'FullAccess' }) };
const plan = { ownerId: 'owner.testnet', receiverId: 'vault.owner.testnet', label: 'Withdraw 1 USDC', actions: [{ type: 'FunctionCall', params: { methodName: 'withdraw_available', args: { amount: '1000000' }, gas: '100000000000000', deposit: '0' } }] };
const hash = 'A'.repeat(44);
function outcome(p = plan) { return { final_execution_status: 'FINAL', transaction: { hash, signer_id: p.ownerId, receiver_id: p.receiverId, actions: p.actions.map(a => ({ FunctionCall: { method_name: a.params.methodName, args: Buffer.from(JSON.stringify(a.params.args)).toString('base64'), gas: a.params.gas, deposit: a.params.deposit } })) }, transaction_outcome: { block_hash: 'block-after-approval' }, status: { SuccessValue: Buffer.from('true').toString('base64') }, receipts_outcome: [] }; }

test('browser owner connection proves a fresh NEP-413 signature and registered full-access ownership', async () => {
  const c = challenge(), signature = signed(c);
  assert.equal((await verifyOwnerMessage(signature, c, provider)).accountId, 'owner.testnet');
  await assert.rejects(verifyOwnerMessage(signature, challenge(), provider), /SIGNATURE_INVALID/);
  await assert.rejects(verifyOwnerMessage(signature, { ...c, accountId: 'another.testnet' }, provider), /ACCOUNT_MISMATCH/);
  await assert.rejects(verifyOwnerMessage(signature, c, { ...provider, viewAccessKey: async () => ({ permission: { FunctionCall: {} } }) }), /FULL_ACCESS_REQUIRED/);
  await assert.rejects(verifyOwnerMessage(signature, c, { ...provider, viewNodeStatus: async () => ({ chain_id: 'mainnet' }) }), /NETWORK_MISMATCH/);
});

test('wallet session rejects foreign origins and forged callbacks, then accepts the bound owner signature once', async () => {
  const session = await startOwnerSession({ kind: 'connect', port: 0, provider });
  try {
    const url = new URL(session.url), token = url.hash.slice(1), origin = url.origin;
    const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
    assert.equal((await fetch(origin + '/api/session')).status, 403);
    assert.equal((await fetch(origin + '/api/connect', { method: 'POST', headers: { ...headers, origin: 'https://attacker.example' }, body: '{}' })).status, 403);
    const info = await (await fetch(origin + '/api/session', { headers })).json();
    const forged = { ...signed(info.challenge), accountId: 'owner.testnet', signature: Buffer.alloc(64).toString('base64') };
    assert.equal((await fetch(origin + '/api/connect', { method: 'POST', headers, body: JSON.stringify(forged) })).status, 400);
    const accepted = await fetch(origin + '/api/connect', { method: 'POST', headers, body: JSON.stringify(signed(info.challenge)) });
    assert.equal(accepted.status, 200); assert.equal((await session.done).accountId, 'owner.testnet');
    assert.equal((await fetch(origin + '/api/connect', { method: 'POST', headers, body: JSON.stringify(signed(info.challenge)) })).status, 409);
  } finally { await session.close(); }
});

test('owner transaction verification binds signer, destination, exact actions, amount, hash and finality', () => {
  assert.equal(verifyOwnerTransaction(outcome(), plan, hash).value, true);
  for (const mutate of [x => x.transaction.signer_id = 'attacker.testnet', x => x.transaction.receiver_id = 'other.testnet', x => x.transaction.actions[0].FunctionCall.args = Buffer.from('{"amount":"1000001"}').toString('base64'), x => x.transaction.hash = 'B'.repeat(44), x => x.final_execution_status = 'EXECUTED_OPTIMISTIC']) {
    const raw = outcome(); mutate(raw); assert.throws(() => verifyOwnerTransaction(raw, plan, hash), /PLAN_MISMATCH|NOT_FINAL/);
  }
  const failed = outcome(); failed.status = { Failure: { error_message: 'OWNER_ONLY' } };
  assert.throws(() => verifyOwnerTransaction(failed, plan, hash), error => error.confirmedFailure === true);
});

test('wallet callback is checked against RPC and cannot substitute an approval or forge a payout value', async () => {
  let submitted = 0, storedHash;
  const session = await startOwnerSession({ kind: 'transaction', plan, port: 0, provider: { ...provider, viewTransactionStatus: async () => outcome() }, onSubmitting: async () => { submitted++; }, onHash: async h => { storedHash = h; } });
  try {
    const url = new URL(session.url), headers = { authorization: 'Bearer ' + url.hash.slice(1), 'content-type': 'application/json' }, post = (path, value) => fetch(url.origin + path, { method: 'POST', headers, body: JSON.stringify(value) });
    assert.equal((await post('/api/transaction', { hash })).status, 404);
    assert.equal((await post('/api/submitting', {})).status, 200);
    assert.equal((await post('/api/submitting', {})).status, 409);
    assert.equal((await post('/api/transaction', { hash: 'B'.repeat(44), value: true })).status, 400);
    assert.equal((await post('/api/transaction', { hash, value: false })).status, 200);
    const receipt = await session.done; assert.equal(receipt.value, true); assert.equal(receipt.hash, hash); assert.equal(storedHash, hash); assert.equal(submitted, 1);
  } finally { await session.close(); }
});

test('uncertain browser approval is journalled and reconciled without another signature or submission', async t => {
  const home = await mkdtemp(join(tmpdir(), 'agentstreams-owner-')); const old = process.env.AGENTSTREAMS_HOME; process.env.AGENTSTREAMS_HOME = home;
  t.after(async () => { if (old === undefined) delete process.env.AGENTSTREAMS_HOME; else process.env.AGENTSTREAMS_HOME = old; await rm(home, { recursive: true, force: true }); });
  await writeFile(join(home, 'owner-wallet.json'), JSON.stringify({ network: 'testnet', signer: 'browser-wallet', accountId: plan.ownerId, publicKey: key.getPublicKey().toString(), port: 5389 }));
  let approvals = 0;
  const sign = async options => { approvals++; await options.onSubmitting(); await options.onHash(hash); throw new Error('Connection lost after approval'); };
  await assert.rejects(ownerTransaction({ ...plan, rpcUrl: 'https://test.rpc.example' }, { sign, provider }), /Connection lost/);
  await assert.rejects(ownerTransaction({ ...plan, rpcUrl: 'https://test.rpc.example' }, { sign, provider }), /RECONCILIATION_REQUIRED/);
  const result = await reconcileOwnerWallet(undefined, { provider: { ...provider, viewTransactionStatus: async () => outcome() } });
  assert.equal(result.resolved, true); assert.equal(result.receipt.value, true); assert.equal(approvals, 1);
  await assert.rejects(access(join(home, 'owner-operations/pending.json')), { code: 'ENOENT' });
});

test('withdraw all selects only available funds; reserved funds and zero balances cannot be withdrawn', () => {
  const vault = { available: '1000001', reserved: '5000000' };
  assert.equal(withdrawalAmount(vault, 'all'), '1000001');
  assert.equal(withdrawalAmount(vault, '1.000001'), '1000001');
  assert.throws(() => withdrawalAmount(vault, '1.000002'), /INSUFFICIENT_AVAILABLE/);
  assert.throws(() => withdrawalAmount({ available: '0', reserved: '100' }, 'all'), /NO_AVAILABLE_FUNDS/);
});

test('browser deployment installs the wallet public recovery key and only a restricted agent key', () => {
  const steps = browserDeploymentSteps({ plan: { ownerId: 'owner.testnet', vaultId: 'v.owner.testnet', agentId: 'a.owner.testnet', recipientId: 'seller.testnet' }, ownerPublicKey: key.getPublicKey().toString(), agentPublicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString(), policyPublicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString(), wasm: Buffer.from([0,97,115,109]) });
  assert.equal(steps.length, 2); assert.equal(steps[0].actions[2].params.publicKey, key.getPublicKey().toString());
  const restricted = steps[1].actions.at(-1).params.accessKey.permission;
  assert.equal(restricted.receiverId, 'v.owner.testnet'); assert.deepEqual(restricted.methodNames, ['open_stream','close_stream']);
  assert.doesNotMatch(JSON.stringify(steps), /private_key|privateKey/);
});
