import test from 'node:test';
import assert from 'node:assert/strict';
import { DCL, EXCHANGE, LENDING } from '../cli/src/strategy-actions.mjs';
import { activeKey, executionFundingYocto, grantLimits, grantScopes, grantTransactionActions, publicGrant, signGrantedTransaction } from '../cli/src/agent-grant.mjs';
import { emptySnapshot, nextSweepStep, runSweep } from '../cli/src/grant-sweep.mjs';
import { activityDeposits, yoctoDeposit } from '../cli/src/activity-deposits.mjs';
import { promptActivity } from '../cli/src/strategy-actions.mjs';
import { assertInferenceModel } from '../cli/src/inference.mjs';
import { runModelAgent } from '../cli/src/agent.mjs';
import { runStrategyAgent } from '../cli/src/strategy-agent.mjs';
import { chainAction } from '../cli/src/owner-wallet.mjs';
import { prepareGrant } from '../cli/src/grant-prepare.mjs';

const pool = 'lst.ref-dev.testnet';
const token = 'wrap.testnet';

test('one grant covers deposit-requiring methods and funds an execution account', () => {
  const scopes = grantScopes({
    activities: ['staking-moves', 'portfolio-rebalance', 'limit-orders', 'limit-orders'],
    stakingPool: pool, tokens: [token],
  });
  assert.deepEqual(scopes.map(scope => scope.receiverId), [DCL, pool, EXCHANGE, token].sort());
  const exchange = scopes.find(scope => scope.receiverId === EXCHANGE);
  assert.deepEqual(exchange.methodNames, ['storage_deposit', 'swap']);
  const moving = scopes.find(scope => scope.receiverId === token);
  assert.ok(moving.methodNames.includes('ft_transfer_call') && moving.methodNames.includes('near_deposit'));
  assert.ok(activityDeposits.filter(item => item.deposit === yoctoDeposit).every(item => item.method));
  const order = scopes.find(scope => scope.receiverId === DCL);
  assert.deepEqual(order.methodNames, ['cancel_order', 'storage_deposit']);
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
  assert.match(shown.limits.onChain, /assets/);
  assert.equal(shown.limits.cliOnly, grantLimits.cliOnly);
});

const agentId = 'ap_' + 'a'.repeat(64);
const request = {
  ownerId: 'owner.testnet', agentId, executionAccountId: 'exec.testnet', receiverId: EXCHANGE,
  rpcUrl: 'https://test.invalid', context: { activity: 'portfolio-rebalance' },
  actions: [{ type: 'FunctionCall', params: { methodName: 'swap', args: {}, gas: '1', deposit: '1' } }],
};
const grantFor = (remaining = 1) => ({
  state: 'active', ownerId: request.ownerId, agentId, executionAccountId: request.executionAccountId,
  activities: ['portfolio-rebalance'], expiresAt: Date.now() + 60_000, remaining,
  scopes: [{ receiverId: EXCHANGE, methodNames: ['swap'] }],
  keys: [{ publicKey: 'ed25519:abc', privateKey: 'ed25519:secret', accountId: 'exec.testnet' }],
});

test('the last covered transaction spends its slot and leaves positions for explicit revoke', async () => {
  const grant = grantFor();
  const snapshots = [];
  let sent = 0;
  const options = {
    load: async () => grant,
    save: async value => { snapshots.push(structuredClone(value)); },
    send: async (plan, key, beforeBroadcast) => {
      assert.equal(plan.ownerId, 'exec.testnet');
      assert.equal(key, 'ed25519:secret');
      assert.equal(plan.actions[0].params.deposit, '1');
      await beforeBroadcast('abc');
      sent++;
      return { hash: 'abc' };
    },
    lock: async () => () => {},
  };
  const receipt = await signGrantedTransaction(request, {}, options);
  assert.equal(receipt.signing, 'grant');
  assert.equal(receipt.grantRemaining, 0);
  assert.equal(snapshots[0].pending.hash, 'abc');
  assert.equal(snapshots[0].remaining, 0);
  assert.equal(snapshots[1].pending, undefined);
  assert.doesNotMatch(JSON.stringify(receipt), /secret/);
  await assert.rejects(signGrantedTransaction(request, {}, options), /GRANT_INACTIVE/);
  assert.equal(sent, 1);
});

test('a plan bound to a different agent, account or scope never falls back to the owner', async () => {
  const options = { load: async () => grantFor(), lock: async () => () => {},
    send: async () => assert.fail('must not send') };
  await assert.rejects(signGrantedTransaction({ ...request, agentId: 'another' }, {}, options), /GRANT_CHANGED/);
  await assert.rejects(signGrantedTransaction({ ...request, executionAccountId: 'other.testnet' }, {}, options), /GRANT_CHANGED/);
  await assert.rejects(signGrantedTransaction({ ...request, receiverId: DCL }, {}, options), /GRANT_SCOPE_DENIED/);
  assert.equal(await signGrantedTransaction({ ...request, executionAccountId: undefined }, {}, options), null);
});

test('an uncertain broadcast keeps the consumed slot and blocks signing until reconciliation', async () => {
  const grant = grantFor(2);
  const options = {
    load: async () => grant, save: async () => {}, lock: async () => () => {},
    send: async (_plan, _key, beforeBroadcast) => { await beforeBroadcast('abc'); throw new Error('RPC timed out'); },
  };
  await assert.rejects(signGrantedTransaction(request, {}, options), /GRANT_OUTCOME_UNCONFIRMED.*abc/);
  assert.equal(grant.remaining, 1);
  assert.equal(grant.pending.hash, 'abc');
  await assert.rejects(signGrantedTransaction(request, {}, options), /GRANT_RECONCILIATION_REQUIRED/);
});

test('grant preparation reaches the requested exchange balance and safely retries the same target', async () => {
  const registered = new Set(), calls = [];
  let held = '0', deposited = '0';
  const input = { agentId, activity: 'portfolio-rebalance', token, balance: '200' };
  const options = {
    connect: async () => ({ accountId: request.ownerId, rpcUrl: request.rpcUrl }),
    accountFor: async () => request.executionAccountId,
    views: async () => ({ view: async (contract, method) => {
      if (method === 'storage_balance_of') return registered.has(contract) ? {} : null;
      if (method === 'storage_balance_bounds') return { min: '12' };
      if (method === 'ft_balance_of') return held;
      if (method === 'get_deposits') return { [token]: deposited };
      assert.fail('unexpected method ' + method);
    } }),
    transact: async (plan, { beforeSubmit }) => {
      assert.equal(plan.executionAccountId, request.executionAccountId);
      await beforeSubmit();
      const { methodName, deposit, args } = plan.actions[0].params;
      calls.push(methodName);
      if (methodName === 'storage_deposit') registered.add(plan.receiverId);
      if (methodName === 'near_deposit') held = deposit;
      if (methodName === 'ft_transfer_call') {
        assert.deepEqual(args, { receiver_id: EXCHANGE, amount: '200', msg: '' });
        deposited = args.amount;
        held = '0';
      }
      return { signing: 'grant', value: args.amount };
    },
  };
  assert.equal((await prepareGrant(input, options)).receipts.length, 4);
  assert.deepEqual(calls, ['storage_deposit', 'storage_deposit', 'near_deposit', 'ft_transfer_call']);
  assert.deepEqual((await prepareGrant(input, options)).receipts, []);
});

test('sweep registers the execution account before withdrawing an exchange deposit', () => {
  const step = nextSweepStep({ ...emptySnapshot(), accountId: 'exec.testnet', exchangeDeposits: { 'rft.tokenfactory.testnet': '4' }, storageMin: { 'rft.tokenfactory.testnet': '1250000000000000000000' } }, 'owner.testnet');
  assert.equal(step.request.receiverId, 'rft.tokenfactory.testnet');
  assert.equal(step.request.actions[0].params.methodName, 'storage_deposit');
  assert.equal(step.request.actions[0].params.args.account_id, 'exec.testnet');
  const empty = nextSweepStep({ ...emptySnapshot(), exchangeDeposits: { 'wrap.testnet': '0' } }, 'owner.testnet');
  assert.equal(empty.request.actions[0].params.args.unregister, true);
  assert.equal(empty.request.actions[0].params.args.amount, '0');
});

test('a failed balance read keeps the execution account', async () => {
  const report = await runSweep({
    grant: { ownerId: 'owner.testnet', executionAccountId: 'exec.testnet' }, rpcUrl: 'https://test.invalid',
    inspect: async () => { throw new Error('Internal server error'); },
    send: async () => { throw new Error('should not send'); },
  });
  assert.equal(report.cleared, false);
  assert.match(report.blocked[0], /SWEEP_VIEW_FAILED/);
});

test('sweep registers the owner before moving a fungible token and does not delete first', () => {
  const step = nextSweepStep({ ...emptySnapshot(), tokenBalances: { 'rft.tokenfactory.testnet': '4' }, storageMin: { 'rft.tokenfactory.testnet': '1250000000000000000000' } }, 'owner.testnet');
  assert.equal(step.request.actions[0].params.methodName, 'storage_deposit');
  assert.equal(step.request.actions[0].params.deposit, '1250000000000000000000');
  const open = nextSweepStep({ ...emptySnapshot(), lending: { borrowed: [{ balance: '1' }], supplied: [] } }, 'owner.testnet');
  assert.match(open.blocked[0], /LENDING_BORROW_OPEN/);
});

test('one prompted run applies every swap instead of stopping after the first confirmation', async () => {
  const wrap = 'wrap.testnet', rft = 'rft.tokenfactory.testnet';
  const first = { poolId: 0, base: wrap, amount: '100', weights: { [wrap]: 9000, [rft]: 1000 } };
  const second = { poolId: 0, base: wrap, amount: '100', weights: { [wrap]: 1000, [rft]: 9000 } };
  const planned = [first, first, second, second];
  const names = ['strategy_preview', 'strategy_apply', 'strategy_preview', 'strategy_apply'];
  let calls = 0, executed = 0, instructions;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    instructions ??= body.messages[0].content;
    const name = names[calls];
    const action = planned[calls];
    calls += 1;
    if (!name) return { ok: true, json: async () => ({ choices: [{ message: { content: 'both swaps confirmed' } }] }) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: null, tool_calls: [{ id: 'c' + calls, type: 'function', function: { name, arguments: JSON.stringify({ action: JSON.stringify(action) }) } }] } }] }) };
  };
  const result = await runStrategyAgent({ path: 'unused' }, 'portfolio-rebalance', { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', model: 'local', maxSteps: 6 }, {
    prompt: 'Swap twice', fetchImpl,
    loadState: async () => ({ tasks: { 'portfolio-rebalance': { mode: 'wallet' } } }),
    runTask: async (_agent, _activity, _action, options) => {
      if (options.execute) executed += 1;
      return { status: options.execute ? 'wallet-confirmed' : 'preview', action: _action, inputs: {}, evidence: {}, receipt: options.execute ? { hash: 'h' + executed, explorerUrl: 'https://testnet.nearblocks.io/txns/h' + executed, signing: 'grant' } : undefined };
    },
  });
  assert.match(instructions, /signing "grant"/);
  assert.match(instructions, /Do not stop after the first confirmation/);
  assert.equal(executed, 2);
  assert.equal(result.results.length, 2);
  assert.equal(result.completed, true);
});

test('a chain deposit rejection is shown to the model', async () => {
  let seen;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const last = body.messages.at(-1);
    if (last.role === 'tool') {
      seen = last.content;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'reported' } }] }) };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'strategy_apply', arguments: '{}' } }] } }] }) };
  };
  await runModelAgent({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', model: 'local', maxSteps: 2 }, {
    prompt: 'swap', fetchImpl, instructions: 'test',
    definitions: { strategy_apply: { description: 'apply', properties: {}, required: [] } },
    handlers: { strategy_apply: async () => { throw new Error('Deposit is not allowed with function call'); } },
  });
  assert.match(seen, /Deposit is not allowed with function call/);
  assert.doesNotMatch(seen, /TOOL_OPERATION_FAILED/);
});

test('prompted runs use the one enabled activity', () => {
  assert.equal(promptActivity({ tasks: { 'portfolio-rebalance': { mode: 'wallet' }, 'spot-trading': { mode: 'paper' } } }), 'portfolio-rebalance');
  assert.equal(promptActivity({ tasks: { 'spot-trading': { mode: 'paper' } } }), 'spot-trading');
  assert.throws(() => promptActivity({ tasks: { 'portfolio-rebalance': { mode: 'wallet' }, 'limit-orders': { mode: 'wallet' } } }), /Pass --activity/);
});

test('inference set rejects a placeholder before asking for a catalog entry', async () => {
  await assert.rejects(assertInferenceModel({ provider: 'near-ai', model: 'MODEL_ID' }, async () => { throw new Error('catalog was fetched'); }), /UNKNOWN_INFERENCE_MODEL/);
  const catalog = async () => ({ ok: true, json: async () => ({ total: 1, offset: 0, models: [{ modelId: 'deepseek/deepseek-v3.2', metadata: {
    providerType: 'vllm', verifiable: true, attestationSupported: true, supportedFeatures: ['tools'], architecture: { outputModalities: ['text'] },
  } }] }) });
  await assert.rejects(assertInferenceModel({ provider: 'near-ai', model: 'missing/model' }, catalog), /not in the NEAR AI catalog/);
  await assertInferenceModel({ provider: 'near-ai', model: 'deepseek/deepseek-v3.2' }, catalog);
});

test('revoke and grant actions round-trip from the chain view', () => {
  assert.deepEqual(chainAction({ DeleteKey: { public_key: 'ed25519:abc' } }), { type: 'DeleteKey', params: { publicKey: 'ed25519:abc' } });
  const added = chainAction({ AddKey: { public_key: 'ed25519:abc', access_key: { nonce: 0, permission: { FunctionCall: { receiver_id: EXCHANGE, method_names: ['swap'], allowance: '100' } } } } });
  assert.equal(added.params.accessKey.permission.receiverId, EXCHANGE);
  assert.deepEqual(chainAction({ DeleteAccount: { beneficiary_id: 'owner.testnet' } }), { type: 'DeleteAccount', params: { beneficiaryId: 'owner.testnet' } });
});
