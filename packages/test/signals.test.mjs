import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { KeyPair } from 'near-api-js';
import { canonical } from '../../near/lib/audit.mjs';
import { signalActionHash, signalEventId, validateSignalEvent, transitionSignal, signalState, assertSignalExecutable, applySignalUpdate } from '../cli/src/signal-protocol.mjs';
import { checkSignalBeforeExecution } from '../cli/src/signals.mjs';

const id = 'a'.repeat(64), now = Date.now();
const action = { token: 'wrap.testnet', operation: 'supply', amount: '100' };
const proposal = { signalId: id, phase: 'proposed', id: signalEventId(id, 'proposed'), publisher: 'ap_' + 'b'.repeat(64),
  activity: 'yield-reallocation', execution: 'wallet', action, actionHash: signalActionHash(action), signalCreatedAt: now, signalExpiresAt: now + 60000, at: now };
const event = phase => ({ ...proposal, phase, id: signalEventId(id, phase), at: now + 1, ...(phase === 'settled' ? { settlementRef: 'receipt' } : {}) });

test('private signals bind the immutable action and have a bounded expiry', () => {
  assert.equal(validateSignalEvent(proposal), proposal);
  assert.throws(() => validateSignalEvent({ ...proposal, action: { ...action, amount: '999' } }), /INVALID_SIGNAL/);
  assert.throws(() => validateSignalEvent({ ...proposal, signalExpiresAt: now + 120001 }), /INVALID_SIGNAL/);
  assert.throws(() => transitionSignal(proposal, 'settled'), /TRANSITION/);
  assert.throws(() => transitionSignal(proposal, 'released', now + 60000), /EXPIRED/);
  assert.equal(transitionSignal(proposal, 'cancelled').phase, 'cancelled');
});

test('late or replayed proposals cannot overwrite cancellation or authorize execution', () => {
  const status = signalState([event('cancelled'), proposal], now + 5);
  assert.equal(status.phase, 'cancelled');
  assert.throws(() => assertSignalExecutable(status, proposal), /NOT_EXECUTABLE/);
  assert.throws(() => signalState([proposal, event('released'), event('cancelled')]), /CONFLICT/);
  assert.throws(() => signalState([proposal, event('settled')]), /CONFLICT/);
  assert.throws(() => assertSignalExecutable(signalState([proposal, event('released')]), proposal, now + 60000), /EXPIRED/);
});

test('follower control updates cancel queued actions and never undo a confirmed execution', () => {
  const state = { follow: {}, pending: { [id]: { status: 'pending' } } };
  applySignalUpdate(state, proposal);
  applySignalUpdate(state, event('cancelled'));
  assert.equal(state.pending[id].status, 'cancelled');
  assert.equal(applySignalUpdate(state, event('cancelled')).duplicate, true);
  const executed = { follow: {}, pending: { [id]: { status: 'wallet-confirmed' } } };
  applySignalUpdate(executed, proposal);
  applySignalUpdate(executed, event('released'));
  applySignalUpdate(executed, event('failed'));
  assert.equal(executed.pending[id].status, 'wallet-confirmed');
});

test('execution requires a fresh, session-bound and nonce-bound signed signal status', async t => {
  const key = KeyPair.fromRandom('ed25519');
  let phase = 'released', mode = 'valid';
  const server = createServer((req, res) => {
    assert.equal(req.headers['x-agentpay-session'], 'test-session-header');
    const nonce = new URL(req.url, 'http://localhost').searchParams.get('nonce');
    const body = { ...signalState([proposal, event('released')]), phase, sessionId: mode === 'session' ? 'other' : 'session',
      nonce: mode === 'replay' ? '0'.repeat(64) : nonce, observedAt: Date.now() - (mode === 'stale' ? 11000 : 0) };
    const signature = Buffer.from(key.sign(Buffer.from(canonical({ domain: 'remora.signal-status.v1', body }))).signature).toString('base64');
    if (mode === 'tampered') body.phase = 'settled';
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ body, signature }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const follow = { sessionId: 'session', listing: { id: proposal.publisher, origin: 'http://127.0.0.1:' + server.address().port, publicKey: key.getPublicKey().toString() } };
  const client = { sessionHeaders: async () => ({ 'x-agentpay-session': 'test-session-header' }) };
  assert.equal(await checkSignalBeforeExecution(proposal, follow, client), true);
  phase = 'proposed'; assert.equal(await checkSignalBeforeExecution(proposal, follow, client), false);
  phase = 'cancelled'; await assert.rejects(checkSignalBeforeExecution(proposal, follow, client), /NOT_EXECUTABLE/);
  phase = 'released';
  for (mode of ['session', 'replay', 'stale', 'tampered']) await assert.rejects(checkSignalBeforeExecution(proposal, follow, client), /STATUS_INVALID/);
});

test('leader runtime delivers proposal and release before broadcast, cancels before execution, and reconciles once', async t => {
  const { mkdtemp, rm, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createAgent, selectedAgent, withAgentState, readAgentState } = await import('../cli/src/agents.mjs');
  const { publicationHistory, verifyAction } = await import('../cli/src/copy-feed.mjs');
  const { updateSignal } = await import('../cli/src/signals.mjs');
  const { runSpotTask, reconcileCopy } = await import('../cli/src/copy-runtime.mjs');
  const workspace = await mkdtemp(join(tmpdir(), 'remora-signals-runtime-'));
  const oldHome = process.env.AGENTSTREAMS_HOME, realFetch = globalThis.fetch, realNow = Date.now;
  process.env.AGENTSTREAMS_HOME = join(workspace, 'profiles');
  process.env.REMORA_TEST_API_KEY = 'test-api-key'; process.env.REMORA_TEST_GRANT = 'test-grant';
  let clock = realNow(); Date.now = () => clock;
  t.after(async () => {
    globalThis.fetch = realFetch; Date.now = realNow;
    if (oldHome === undefined) delete process.env.AGENTSTREAMS_HOME; else process.env.AGENTSTREAMS_HOME = oldHome;
    delete process.env.REMORA_TEST_API_KEY; delete process.env.REMORA_TEST_GRANT;
    await rm(workspace, { recursive: true, force: true });
  });
  const order = { origin_asset: 'nep141:wrap.near', destination_asset: 'nep141:usdc.near', amount: '100' };
  let agent, scenario, broadcasts = 0, quoteCalls = 0, healthCalls = 0;
  const settled = status => ({ type: 'swap', agent_id: 'test-agent', correlation_id: 'test-swap', status,
    updated_at: new Date(clock).toISOString(), details: { amount_out: '200', tx_hash: 'test-receipt', request: order } });
  // Protocol fixture: no real swap, payment or network call is made in this test.
  globalThis.fetch = async (url, options = {}) => {
    const state = await readAgentState(agent), active = Object.values(state.leaderSignals ?? {}).at(-1);
    if (url === 'http://127.0.0.1:5380/copy/health') {
      healthCalls++;
      if (active.phase === 'proposed') {
        assert.equal(broadcasts, 0);
        const { actions } = await publicationHistory(agent);
        assert.equal(verifyAction(actions.at(-1), { ...agent, activity: 'spot-trading' }).phase, 'proposed');
        if (scenario === 'cancel') await updateSignal(agent, active.signalId, 'cancelled');
        else clock += 31000; // Advance the test clock through the actual runtime wait.
      }
      return Response.json({ ok: true, observed_at: Math.floor(clock / 1000) });
    }
    assert.match(url, /^https:\/\/api\.agentsonintents\.com\//);
    if (url.includes('/v1/status?')) return Response.json(settled('REFUNDED'));
    const body = JSON.parse(options.body);
    if (body.dry) {
      quoteCalls++;
      if (scenario === 'price-moved' && quoteCalls === 2) return Response.json({ dry: true, type: 'swap', quote: { amountIn: '100', amountOut: '100' }, warnings: [] });
      return Response.json({ dry: true, type: 'swap', quote: { amountIn: '100', amountOut: '200' }, warnings: [] });
    }
    assert.equal(active.phase, 'released');
    assert.ok(active.deliveredPhases.includes('released'), 'release delivery acknowledged before broadcast');
    assert.equal(options.headers['X-Grant-Token'], 'test-grant');
    broadcasts++;
    if (scenario === 'uncertain') throw new Error('NETWORK_RESPONSE_LOST');
    return Response.json(settled(scenario === 'refund' ? 'REFUNDED' : 'SUCCESS'));
  };
  for (scenario of ['success', 'cancel', 'price-moved', 'refund', 'uncertain']) {
    await createAgent(workspace, scenario); agent = await selectedAgent(workspace, scenario);
    broadcasts = 0; quoteCalls = 0; healthCalls = 0;
    await withAgentState(agent, state => {
      state.tasks['spot-trading'] = { id: 'test-agent', keyEnv: 'REMORA_TEST_API_KEY', grantEnv: 'REMORA_TEST_GRANT', live: true };
      state.executionPolicy = { inputAsset: order.origin_asset, assets: [order.origin_asset, order.destination_asset], maxInput: '100', fixedInput: '100', maxAge: 90, slippageBps: 50 };
      state.publish = { enabled: true, activity: 'spot-trading', origin: 'http://127.0.0.1:5380', signalWindowSeconds: 30 };
    });
    if (scenario === 'cancel') await assert.rejects(runSpotTask(agent, order, true), /LEADER_SIGNAL_CANCELLED/);
    else if (scenario === 'price-moved') await assert.rejects(runSpotTask(agent, order, true), /PRICE_MOVED/);
    else if (scenario === 'uncertain') await assert.rejects(runSpotTask(agent, order, true), /NETWORK_RESPONSE_LOST/);
    else assert.equal((await runSpotTask(agent, order, true)).status, scenario === 'refund' ? 'REFUNDED' : 'SUCCESS');
    const state = await readAgentState(agent), signal = Object.values(state.leaderSignals)[0];
    assert.equal(signal.phase, { success: 'settled', cancel: 'cancelled', 'price-moved': 'cancelled', refund: 'failed', uncertain: 'uncertain' }[scenario]);
    assert.equal(broadcasts, ['success', 'refund', 'uncertain'].includes(scenario) ? 1 : 0);
    const journal = await publicationHistory(agent);
    assert.deepEqual(journal.actions.map(e => verifyAction(e, { ...agent, activity: 'spot-trading' }).phase),
      scenario === 'success' ? ['proposed', 'released', 'settled'] : scenario === 'refund' ? ['proposed', 'released', 'failed'] : scenario === 'uncertain' ? ['proposed', 'released', 'uncertain'] : ['proposed', 'cancelled']);
    for (const pointer of state.journal) assert.doesNotMatch(await readFile(join(agent.path, 'journal', pointer.hash + '.json'), 'utf8'), /nep141:|test-receipt/);
    if (scenario === 'uncertain') {
      await assert.rejects(runSpotTask(agent, order, true), /RECONCILIATION_REQUIRED/);
      assert.equal(broadcasts, 1);
      await withAgentState(agent, state => { state.tradePending.correlationId = 'test-swap'; });
      assert.equal((await reconcileCopy(agent)).trade.status, 'REFUNDED');
      assert.equal(Object.values((await readAgentState(agent)).leaderSignals)[0].phase, 'failed');
      assert.equal((await reconcileCopy(agent)).resolved, true);
      assert.equal(broadcasts, 1);
    }
  }
});
