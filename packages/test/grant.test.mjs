import test from 'node:test';
import assert from 'node:assert/strict';
import { DCL, EXCHANGE, LENDING } from '../cli/src/strategy-actions.mjs';
import { activeKey, grantScopes, publicGrant, signGrantedTransaction, yoctoPerTransaction } from '../cli/src/agent-grant.mjs';
import { chainAction } from '../cli/src/owner-wallet.mjs';

const pool = 'lst.ref-dev.testnet';
const token = 'wrap.testnet';

test('one grant adds a separate function-call key per contract and a finite gas allowance', () => {
  const scopes = grantScopes({
    activities: ['staking-moves', 'portfolio-rebalance', 'limit-orders', 'limit-orders'],
    stakingPool: pool, tokens: [token],
  });
  assert.deepEqual(scopes.map(scope => scope.receiverId), [DCL, pool, EXCHANGE, token].sort());
  const exchange = scopes.find(scope => scope.receiverId === EXCHANGE);
  assert.deepEqual(exchange.methodNames, ['swap']);
  const order = scopes.find(scope => scope.receiverId === DCL);
  assert.deepEqual(order.methodNames, ['cancel_order']);
  const staking = scopes.find(scope => scope.receiverId === pool);
  assert.ok(staking.methodNames.includes('deposit_and_stake') && !staking.methodNames.includes('ft_transfer_call'));
  assert.equal((yoctoPerTransaction * 10n).toString(), '1000000000000000000000000');
});

test('token movement is opt-in and staking requires its pool', () => {
  assert.throws(() => grantScopes({ activities: ['liquidity-ranges'], tokens: [] }), /--tokens/);
  assert.throws(() => grantScopes({ activities: ['portfolio-rebalance'], stakingPool: pool }), /staking-pool/);
  assert.throws(() => grantScopes({ activities: ['prediction-markets'] }), /Choose activities/);
  const lending = grantScopes({ activities: ['yield-reallocation'], tokens: [token] });
  assert.deepEqual(lending.find(scope => scope.receiverId === LENDING).methodNames, ['execute', 'storage_deposit']);
});

test('the agent key is used only inside the receiver, method list, count and time window', () => {
  const now = 1_000_000;
  const grant = { expiresAt: now + 1000, remaining: 2, keys: [
    { receiverId: EXCHANGE, methodNames: ['swap'], privateKey: 'secret' },
  ] };
  assert.equal(activeKey(grant, EXCHANGE, ['swap'], now)?.receiverId, EXCHANGE);
  assert.equal(activeKey(grant, EXCHANGE, ['swap', 'add_liquidity'], now), null);
  assert.equal(activeKey(grant, DCL, ['swap'], now), null);
  assert.equal(activeKey({ ...grant, remaining: 0 }, EXCHANGE, ['swap'], now), null);
  assert.equal(activeKey(grant, EXCHANGE, ['swap'], grant.expiresAt), null);
  const shown = publicGrant(grant);
  assert.equal(JSON.stringify(shown).includes('secret'), false);
  assert.equal(shown.protocolExpiry, false);
});

test('a covered strategy signs with the function-call key and spends one granted transaction', async () => {
  const grant = { ownerId: 'owner.testnet', expiresAt: Date.now() + 60_000, remaining: 2, keys: [
    { receiverId: EXCHANGE, methodNames: ['swap'], privateKey: 'ed25519:secret' },
  ] };
  let saved, usedKey;
  const receipt = await signGrantedTransaction({
    ownerId: 'owner.testnet', receiverId: EXCHANGE, rpcUrl: 'https://test.invalid',
    actions: [{ type: 'FunctionCall', params: { methodName: 'swap', args: { pool_id: 0 }, gas: '1', deposit: '1' } }],
  }, { beforeSubmit: async () => {} }, {
    load: async () => grant,
    save: async value => { saved = value.remaining; },
    send: async (_request, privateKey) => { usedKey = privateKey; return { hash: 'abc' }; },
    lock: async () => () => {},
  });
  assert.equal(receipt.signing, 'function-call-key');
  assert.equal(receipt.grantRemaining, 1);
  assert.equal(saved, 1);
  assert.equal(usedKey, 'ed25519:secret');
  assert.equal(JSON.stringify(receipt).includes('secret'), false);
});

test('an action outside the grant is left for the owner wallet', async () => {
  const receipt = await signGrantedTransaction({
    ownerId: 'owner.testnet', receiverId: DCL, actions: [{ type: 'FunctionCall', params: { methodName: 'add_liquidity' } }],
  }, {}, {
    load: async () => ({ expiresAt: Date.now() + 1000, remaining: 1, keys: [{ receiverId: EXCHANGE, methodNames: ['swap'] }] }),
    save: async () => { throw new Error('should not save'); },
    send: async () => { throw new Error('should not send'); },
    lock: async () => () => {},
  });
  assert.equal(receipt, null);
});

test('revoke and grant actions round-trip from the chain view', () => {
  assert.deepEqual(chainAction({ DeleteKey: { public_key: 'ed25519:abc' } }), { type: 'DeleteKey', params: { publicKey: 'ed25519:abc' } });
  const added = chainAction({ AddKey: { public_key: 'ed25519:abc', access_key: { nonce: 0, permission: { FunctionCall: { receiver_id: EXCHANGE, method_names: ['swap'], allowance: '100' } } } } });
  assert.equal(added.params.accessKey.permission.receiverId, EXCHANGE);
  assert.notEqual(added.params.accessKey.permission, 'FullAccess');
});
