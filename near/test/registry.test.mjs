import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Sandbox, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from 'near-api-js';
import { decodeOutcome } from '../sdk/index.mjs';

test('NEAR registry binds publisher identity, restricts heartbeats and paginates public metadata', { timeout: 180000 }, async t => {
  const sandbox = await Sandbox.start({ version: '2.13.1' });
  t.after(() => sandbox.stop());
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const root = new Account('sandbox', provider, KeyPairSigner.fromSecretKey(DEFAULT_PRIVATE_KEY));
  const ownerKey = KeyPair.fromRandom('ed25519');
  const feedKey = KeyPair.fromRandom('ed25519');
  const registryKey = KeyPair.fromRandom('ed25519');
  for (const [accountId, key] of [['owner.sandbox', ownerKey], ['registry.sandbox', registryKey]]) {
    decodeOutcome(await root.signAndSendTransaction({ receiverId: accountId, waitUntil: 'FINAL', actions: [
      actions.createAccount(), actions.transfer(5n * 10n ** 24n), actions.addFullAccessKey(key.getPublicKey()),
    ] }));
  }
  const owner = new Account('owner.sandbox', provider, new KeyPairSigner(ownerKey));
  const registry = new Account('registry.sandbox', provider, new KeyPairSigner(registryKey));
  decodeOutcome(await registry.signAndSendTransaction({ receiverId: registry.accountId, waitUntil: 'FINAL', actions: [
    actions.deployContract(await readFile('near/contracts/target/wasm32-unknown-unknown/release/remora_registry.wasm')),
    actions.functionCall('new', {}, 30_000_000_000_000n, 0n),
  ] }));
  const public_key = feedKey.getPublicKey().toString();
  const id = 'ap_' + createHash('sha256').update(public_key).digest('hex');
  const block = await provider.viewBlock({ finality: 'final' });
  const expires_at = String(Math.floor(Number(block.header.timestamp_nanosec) / 1e9) + 300);
  const origin = 'https://publisher.example';
  const message = ['remora.registry.register.v1', registry.accountId, owner.accountId, id, origin, expires_at].join('\n');
  const registration = { id, public_key, origin, expires_at, signature: Buffer.from(feedKey.sign(Buffer.from(message)).signature).toString('base64') };
  const call = (account, method, args, deposit = 0n) => account.signAndSendTransaction({ receiverId: registry.accountId, waitUntil: 'FINAL',
    actions: [actions.functionCall(method, args, 30_000_000_000_000n, deposit)] }).then(decodeOutcome);
  const view = (method, args = {}) => provider.callFunction({ contractId: registry.accountId, method, args });
  await assert.rejects(call(owner, 'register', { ...registration, origin: 'https://attacker.example' }, 10n ** 22n), /INVALID_FEED_SIGNATURE/);
  await assert.rejects(call(owner, 'register', registration), /REGISTRY_STORAGE_DEPOSIT_REQUIRED/);
  await call(owner, 'register', registration, 10n ** 22n);
  assert.equal((await view('get_publisher', { id })).active, false);
  await assert.rejects(call(owner, 'heartbeat', { id }), /PUBLISHER_KEY_REQUIRED/);
  decodeOutcome(await owner.signAndSendTransaction({ receiverId: owner.accountId, waitUntil: 'FINAL', actions: [
    actions.addFunctionCallAccessKey(feedKey.getPublicKey(), registry.accountId, ['heartbeat', 'stop'], 5n * 10n ** 22n),
  ] }));
  const heartbeats = new Account(owner.accountId, provider, new KeyPairSigner(feedKey));
  await call(heartbeats, 'heartbeat', { id });
  const page = await view('list_publishers', { limit: 1 });
  assert.equal(page.publishers[0].active, true);
  assert.equal(page.publishers[0].origin, origin);
  assert.equal(page.next_index, null);
  assert.equal(page.heartbeat_ttl_seconds, 120);
  assert.deepEqual(Object.keys(page.publishers[0]).sort(), ['active', 'id', 'last_seen', 'origin', 'owner_id', 'public_key']);
  await assert.rejects(call(heartbeats, 'register', registration, 10n ** 22n), /access|permission|method|deposit/i);
  await assert.rejects(heartbeats.signAndSendTransaction({ receiverId: root.accountId, waitUntil: 'FINAL', actions: [actions.transfer(1n)] }), /access|permission|receiver|action/i);
  await call(heartbeats, 'stop', { id });
  assert.equal((await view('get_publisher', { id })).active, false);
  assert.deepEqual((await view('list_publishers', { from_index: '100' })).publishers, []);
});
