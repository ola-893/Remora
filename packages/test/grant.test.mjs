import test from 'node:test';
import assert from 'node:assert/strict';
import { DCL, EXCHANGE, LENDING } from '../cli/src/strategy-actions.mjs';
import { activeKey, executionFundingYocto, grantScopes, grantTransactionActions, publicGrant, signGrantedTransaction } from '../cli/src/agent-grant.mjs';
import { chainAction } from '../cli/src/owner-wallet.mjs';

const pool = 'lst.ref-dev.testnet';
const token = 'wrap.testnet';

test('one grant covers each contract and adds one full-access key', () => {
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
  assert.deepEqual(grantTransactionActions(), [{ type: 'Transfer', params: { deposit: executionFundingYocto.toString() } }]);
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
  const shown = publicGrant({ ...grant, executionAccountId: 'exec.testnet', scopes: grant.keys.map(({ privateKey, ...scope }) => scope), keys: [{ privateKey: 'secret', accountId: 'exec.testnet' }] });
  assert.equal(JSON.stringify(shown).includes('secret'), false);
  assert.equal(shown.executionAccountId, 'exec.testnet');
});

test('a covered strategy signs with the function-call key and spends one granted transaction', async () => {
  const grant = { ownerId: 'owner.testnet', executionAccountId: 'exec.testnet', expiresAt: Date.now() + 60_000, remaining: 2, keys: [
    { receiverId: EXCHANGE, methodNames: ['swap'], privateKey: 'ed25519:secret' },
  ] };
  let saved, usedKey, signer;
  const receipt = await signGrantedTransaction({
    ownerId: 'owner.testnet', receiverId: EXCHANGE, rpcUrl: 'https://test.invalid',
    actions: [{ type: 'FunctionCall', params: { methodName: 'swap', args: { pool_id: 0 }, gas: '1', deposit: '1' } }],
  }, { beforeSubmit: async () => {} }, {
    load: async () => grant,
    save: async value => { saved = value.remaining; },
    send: async (request, privateKey) => { usedKey = privateKey; signer = request.ownerId; return { hash: 'abc' }; },
    lock: async () => () => {},
  });
  assert.equal(receipt.signing, 'grant');
  assert.equal(receipt.grantRemaining, 1);
  assert.equal(saved, 1);
  assert.equal(usedKey, 'ed25519:secret');
  assert.equal(signer, 'exec.testnet');
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

test('the last granted transaction returns the execution account balance', async () => {
  const grant = { ownerId: 'owner.testnet', executionAccountId: 'exec.testnet', expiresAt: Date.now() + 60_000, remaining: 1,
    scopes: [{ receiverId: EXCHANGE, methodNames: ['swap'] }],
    keys: [{ publicKey: 'ed25519:abc', privateKey: 'ed25519:secret', accountId: 'exec.testnet' }] };
  const sent = [];
  await signGrantedTransaction({
    ownerId: 'owner.testnet', receiverId: EXCHANGE, rpcUrl: 'https://test.invalid',
    actions: [{ type: 'FunctionCall', params: { methodName: 'swap', args: {}, gas: '1', deposit: '1' } }],
  }, {}, {
    load: async () => grant,
    save: async () => {},
    send: async request => { sent.push({ signer: request.ownerId, types: request.actions.map(action => action.type), beneficiary: request.actions[0].params.beneficiaryId }); return { hash: 'abc' }; },
    lock: async () => () => {},
  });
  assert.equal(sent[0].signer, 'exec.testnet');
  assert.deepEqual(sent[0].types, ['FunctionCall']);
  assert.deepEqual(sent[1], { signer: 'exec.testnet', types: ['DeleteAccount'], beneficiary: 'owner.testnet' });
});

test('revoke and grant actions round-trip from the chain view', () => {
  assert.deepEqual(chainAction({ DeleteKey: { public_key: 'ed25519:abc' } }), { type: 'DeleteKey', params: { publicKey: 'ed25519:abc' } });
  const added = chainAction({ AddKey: { public_key: 'ed25519:abc', access_key: { nonce: 0, permission: { FunctionCall: { receiver_id: EXCHANGE, method_names: ['swap'], allowance: '100' } } } } });
  assert.equal(added.params.accessKey.permission.receiverId, EXCHANGE);
  assert.deepEqual(chainAction({ DeleteAccount: { beneficiary_id: 'owner.testnet' } }), { type: 'DeleteAccount', params: { beneficiaryId: 'owner.testnet' } });
});
