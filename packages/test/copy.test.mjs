import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkQuote, proposedOrder } from '../cli/src/copy-activity.mjs';
import { intentsAdapter, minimumOutput } from '../cli/src/copy-intents.mjs';
import { runTradingAgent } from '../cli/src/trading-agent.mjs';
import { runModelAgent } from '../cli/src/agent.mjs';
import { describePaperFill, paperSeed } from '../cli/src/paper-trading.mjs';
import { appendFill, appendStrategyAction, publicationHistory, publicListingHistory, verifyAction } from '../cli/src/copy-feed.mjs';
import { createAgent, selectedAgent, withAgentState } from '../cli/src/agents.mjs';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../cli/bin/agentstreams.mjs', import.meta.url));

test('native strategy fills retain their activity and settlement in the signed journal', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'remora-native-publication-'));
  const previousHome = process.env.AGENTSTREAMS_HOME;
  process.env.AGENTSTREAMS_HOME = join(workspace, 'profiles');
  t.after(async () => {
    if (previousHome === undefined) delete process.env.AGENTSTREAMS_HOME;
    else process.env.AGENTSTREAMS_HOME = previousHome;
    await rm(workspace, { recursive: true, force: true });
  });
  const actions = {
    'liquidity-ranges': { pool: 'usdc.fakes.testnet|wrap.testnet|2000', left: 40, right: 80, amountX: '0', amountY: '100', minX: '0', minY: '90' },
    'portfolio-rebalance': { poolId: 0, base: 'wrap.testnet', amount: '100', weights: { 'rft.tokenfactory.testnet': 5000, 'wrap.testnet': 5000 } },
    'yield-reallocation': { token: 'wrap.testnet', operation: 'supply', amount: '100' },
    'reward-reinvestment': { operation: 'compound' },
  };
  for (const [activity, action] of Object.entries(actions)) {
    await createAgent(workspace, activity);
    const agent = await selectedAgent(workspace, activity);
    const at = Date.now(), settlementRef = 'A'.repeat(44);
    const entry = { id: 'a'.repeat(64), activity, action, execution: 'wallet', at, expiresAt: at + 120000, settlementRef };
    const publication = await withAgentState(agent, async state => {
      state.publish = { enabled: true, activity };
      return appendStrategyAction(agent, state, entry);
    });
    const { actions: [envelope] } = await publicationHistory(agent);
    const listing = { id: agent.id, publicKey: agent.publicKey, activity };
    assert.equal(verifyAction(envelope, listing).settlementRef, settlementRef);
    assert.throws(() => verifyAction(envelope, { ...listing, activity: 'staking-moves' }), /INVALID_SIGNED_ACTION/);
    const history = [{ type: 'strategy', activity, status: 'wallet-confirmed', at: new Date(at).toISOString(),
      transactionHash: settlementRef, publication, action }];
    assert.deepEqual(publicListingHistory({ history }, activity), [{ at: history[0].at, kind: 'wallet-action', receipt: settlementRef }]);
  }
});

test('paper trade confirmation uses quoted token units and needs no model summary', async () => {
  const fill = {
    from: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', to: 'nep141:wrap.near',
    amountIn: '1000000', amountOut: '271465625104598802395209', amountInFormatted: '1', amountOutFormatted: '0.271465625104598802395209',
  };
  const events = [];
  let requests = 0;
  const result = await runModelAgent({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'local', maxSteps: 1 }, {
    prompt: 'Place the paper trade.', instructions: 'Use the trade tool.', emit: event => events.push(event),
    definitions: { trade: { description: 'Place the paper trade.', properties: {}, required: [] } },
    handlers: { trade: async () => ({ status: 'paper-filled', fill }) },
    finishOnTool: tool => describePaperFill(tool.fill),
    fetchImpl: async () => {
      requests++;
      return Response.json({ choices: [{ message: { tool_calls: [{ id: 'trade', type: 'function', function: { name: 'trade', arguments: '{}' } }] } }] });
    },
  });
  assert.equal(result.completed, true);
  assert.equal(requests, 1);
  assert.equal(events.at(-1).source, 'tool-result');
  assert.equal(events.at(-1).text, 'Paper trade filled. Spent 1 USDC and received 0.271465625104598802395209 wNEAR.');
  assert.match(describePaperFill({ ...fill, amountOutFormatted: undefined }), /271465625104598802395209 atomic units of wNEAR/);
});

test('named CLI agents isolate task, publication, inference setup and guard settings', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agentpay-agents-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.AGENTSTREAMS_HOME;
  process.env.AGENTSTREAMS_HOME = join(dir, 'keys');
  t.after(() => { if (previous === undefined) delete process.env.AGENTSTREAMS_HOME; else process.env.AGENTSTREAMS_HOME = previous; });
  const run = async (...args) => JSON.parse((await exec(process.execPath, [bin, ...args, '--json'], { cwd: dir })).stdout);
  const alpha = await run('agent', 'create', 'alpha');
  assert.match(alpha.id, /^ap_[a-f0-9]{64}$/);
  const beta = await run('agent', 'create', 'beta');
  assert.notEqual(alpha.id, beta.id);
  assert.equal((await run('agent', 'list')).selected, 'beta');
  assert.equal((await run('agent', 'use', 'alpha')).id, alpha.id);
  assert.equal((await run('agent', 'setup', '--network', 'testnet')).status, 'OWNER_SETUP_REQUIRED');
  assert.equal((await run('agent', 'show', 'beta')).setup.configured, false);
  assert.equal((await run('install', 'mcp')).mcpServers.agentstreams.args.at(-1), 'alpha');
  const catalog = (await run('task', 'list')).activities;
  assert.equal(catalog.filter(item => item.status === 'available').length, 6);
  assert.equal(catalog.find(item => item.id === 'prediction-markets').status, 'blocked');
  await assert.rejects(run('task', 'enable', 'prediction-markets'), /PREDICTION_TESTNET_VENUE_UNAVAILABLE/);
  await assert.rejects(run('task', 'enable', 'staking-moves', '--paper-balances', 'near:testnet=10'), /browser wallet/);
  assert.equal((await run('task', 'enable', 'staking-moves')).config.mode, 'wallet');
  await run('guard', 'set', 'execution', '--activity', 'staking-moves', '--targets', 'lst.ref-dev.testnet', '--max-inputs', 'near:testnet=1000');
  await assert.rejects(run('task', 'run', 'staking-moves', '--action-json', '{"pool":"lst.ref-dev.testnet","operation":"stake","amount":"1"}'), /OWNER_WALLET_REQUIRED/);
  await run('task', 'enable', 'spot-trading', '--intents-agent-id', 'test-agent');
  assert.equal((await run('task', 'list')).activities[0].status, 'enabled');
  assert.equal((await run('task', 'list', '--agent', 'beta')).activities[0].status, 'available');
  await run('task', 'disable', 'spot-trading');
  assert.equal((await run('task', 'list')).activities[0].status, 'available');
  assert.equal((await run('guard', 'set', 'feed', '--stale-seconds', '11')).feed.staleSeconds, 11);
  assert.equal((await run('guard', 'show', '--agent', 'beta')).feed.staleSeconds, 45);
  await assert.rejects(run('guard', 'set', 'feed', '--budget', '1'), /does not apply/);
  await assert.rejects(run('copy', 'start', alpha.id), /another agent/);
  await assert.rejects(run('copy', 'approve', 'missing'), /No copy subscription/);
  await assert.rejects(run('publish', 'set', '--activities', 'unknown-activity', '--rate', '0.1'), /supported activity/);
  await run('publish', 'set', '--rate', '0.000001', '--recipient', 'publisher.testnet');
  await run('publish', 'start');
  assert.equal((await run('publish', 'status')).publication.enabled, true);
  const agent = await selectedAgent(dir);
  assert.equal((await stat(join(agent.path, 'feed-key'))).mode & 0o777, 0o600);
  const now = Date.now();
  const fill = { id: 'a'.repeat(64), at: now, expiresAt: now + 60000, from: 'nep141:wrap.near', to: 'nep141:usdc.near', amountIn: '100', amountOut: '200', execution: 'paper', settlementRef: 'test-fill' };
  const pointer = await withAgentState(agent, state => appendFill(agent, state, fill));
  assert.doesNotMatch(await readFile(join(agent.path, 'journal', pointer.journalHash + '.json'), 'utf8'), /wrap\.near|test-fill/);
  assert.equal(await withAgentState(agent, state => appendFill(agent, state, fill)), null);
  const [action] = (await publicationHistory(agent)).actions;
  const listing = { ...agent, activity: 'spot-trading' };
  assert.equal(verifyAction(action, listing).execution, 'paper');
  assert.equal(verifyAction(action, listing).sequence, 1);
  assert.throws(() => verifyAction({ ...action, body: { ...action.body, amountIn: '9' } }, listing), /INVALID_SIGNED_ACTION/);
  await run('publish', 'stop');
  assert.equal((await run('publish', 'status')).publication.enabled, false);
  assert.equal((await run('agent', 'run', '--once')).status, 'idle');
  assert.equal((await run('status')).pendingTrade, false);
  const seed = 'nep141:wrap.near=10000000';
  assert.deepEqual(paperSeed(seed), { 'nep141:wrap.near': '10000000' });
  await run('task', 'enable', 'spot-trading', '--paper-balances', seed);
  await assert.rejects(run('task', 'enable', 'spot-trading', '--paper-balances', seed, '--live'), /Choose paper balances/);
  assert.equal((await run('task', 'portfolio')).portfolio.balances['nep141:wrap.near'], '10000000');
  await run('task', 'disable', 'spot-trading');
  await assert.rejects(run('task', 'enable', 'spot-trading', '--paper-balances', 'nep141:wrap.near=2'), /already has a paper portfolio/);
  await run('task', 'enable', 'spot-trading', '--paper-balances', seed);
  assert.equal((await run('task', 'portfolio', '--agent', 'beta')).portfolio, null);
  await run('inference', 'set', '--base-url', 'http://127.0.0.1:11434/v1', '--model', 'local-trading-model');
  const inference = await run('inference', 'show');
  assert.equal(inference.model, 'local-trading-model');
  assert.equal((await run('inference', 'show', '--agent', 'beta')).configured, false);
  await run('guard', 'set', 'execution', '--activity', 'spot-trading', '--assets', 'nep141:wrap.near,nep141:usdc.near',
    '--input-asset', 'nep141:wrap.near', '--max-input-raw', '100', '--copy-input-raw', '10');
  assert.equal((await run('doctor')).ok, true);
  const events = [];
  let turn = 0;
  const response = await runTradingAgent(agent, inference, {
    prompt: 'Try an oversized order.', emit: event => events.push(event),
    fetchImpl: async () => {
      const args = JSON.stringify({ from: 'nep141:wrap.near', to: 'nep141:usdc.near', amount: '101' });
      const tool = name => ({ id: name, type: 'function', function: { name, arguments: args } });
      const message = turn++ ? { content: 'The order was denied.' } :
        { tool_calls: [tool('agentstreams_trade_execute'), tool('agentstreams_trade_quote')] };
      return Response.json({ choices: [{ message }] });
    },
  });
  assert.equal(response.fill, null);
  assert.deepEqual(events.filter(e => e.type === 'tool').map(e => e.result.reason), ['MATCHING_QUOTE_REQUIRED', 'ORDER_OUTSIDE_EXECUTION_POLICY']);
  assert.equal((await run('status')).lastRun.fillId, null);
  assert.equal((await run('task', 'portfolio')).portfolio.fills.length, 0);
  assert.equal((await run('reconcile')).resolved, true);
});

test('spot quote and settlement are bound to size, price and agent identity', async t => {
  process.env.AGENTPAY_TEST_INTENTS_KEY = 'test-token';
  t.after(() => { delete process.env.AGENTPAY_TEST_INTENTS_KEY; });
  const calls = [];
  const now = Date.now();
  const policy = { inputAsset: 'nep141:wrap.near', assets: ['nep141:wrap.near', 'nep141:usdc.near'], fixedInput: '25', maxAge: 60, slippageBps: 50, maxNotionalRawUSDC: '2000000' };
  const action = { at: now, expiresAt: now + 1000, from: policy.inputAsset, to: policy.assets[1], amountIn: '100', amountOut: '200' };
  const { order } = proposedOrder(action, policy, now);
  assert.equal(order.amount, '25');
  assert.equal(proposedOrder(action, policy, now + 1001).reason, 'ACTION_EXPIRED');
  assert.equal(minimumOutput(action, order, policy), '50');
  const adapter = intentsAdapter({ id: 'agent-test', keyEnv: 'AGENTPAY_TEST_INTENTS_KEY', live: false }, async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ dry: true, type: 'swap', quote: { quote: { amountIn: '25', amountOut: '50' } }, spend: { amount_usd: '1' }, warnings: [] }), { status: 202 });
  });
  const quote = await adapter.quote(order);
  assert.equal(checkQuote(quote, order, action, policy), null);
  assert.equal(checkQuote({ ...quote, amountOut: '49' }, order, action, policy), 'PRICE_MOVED');
  assert.equal(checkQuote({ ...quote, amountInUsd: '3' }, order, action, policy), 'NOTIONAL_LIMIT');
  assert.equal(checkQuote({ ...quote, amountInUsd: '2.000000000001' }, order, action, policy), 'NOTIONAL_LIMIT');
  assert.equal(checkQuote({ ...quote, amountInUsd: '1.999999999999' }, order, action, policy), null);
  assert.equal(JSON.parse(calls[0].options.body).dry, true);
  assert.equal(calls[0].options.headers['X-Grant-Token'], undefined);
  await assert.rejects(adapter.execute(order, 'key'), /INTENTS_LIVE_DISABLED/);
  const settled = { status: 'SUCCESS', type: 'swap', agent_id: 'agent-test', correlation_id: 'swap-test', updated_at: new Date(now).toISOString(),
    details: { amount_out: '50', request: order } };
  const boundOrder = { ...order, min_amount_out: '50' };
  assert.equal((await adapter.settle(settled, boundOrder)).final, true);
  await assert.rejects(adapter.settle({ ...settled, agent_id: 'other' }, boundOrder), /IDENTITY_MISMATCH/);
  await assert.rejects(adapter.settle(settled, { ...boundOrder, amount: '30' }), /SETTLEMENT_MISMATCH/);
});
