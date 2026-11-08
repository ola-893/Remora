import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaymentExecutor } from '../core/src/executor.mjs';

async function fixture(t, enabled = true) {
  const stateDir = await mkdtemp(join(tmpdir(), 'agentpay-executor-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const state = { rate: '10', nonce: '0', stream: null, active: null, submissions: 0, timeout: false, denied: false };
  const client = {
    async assertRestrictedAgent() { return { active_session: state.active, next_nonce: state.nonce }; },
    async getStream() { return state.stream; },
    async open({ permit: p }) {
      state.submissions++;
      state.stream = { session_id: p.session_id, recipient_id: p.recipient_id, rate: p.rate, duration_seconds: p.duration_seconds, quote_hash: p.quote_hash, closed_at: null };
      state.active = p.session_id;
      state.nonce = String(BigInt(state.nonce) + 1n);
      if (state.timeout) throw new Error('transport timeout after submission');
      return { hash: `receipt${state.nonce}`, value: state.stream };
    },
    async close() { state.submissions++; state.stream.closed_at = '100'; state.active = null; state.nonce = String(BigInt(state.nonce) + 1n); return { hash: `receipt${state.nonce}`, value: state.stream }; },
  };
  const worker = { async request({ action, sessionId }) {
    if (state.denied) return { decision: 'DENY', reason: 'RATE_LIMIT' };
    if (action === 'CHECK') return { decision: 'CONTINUE', reason: 'SERVICE_HEALTHY' };
    return { decision: action === 'SHUTDOWN' ? 'CLOSE' : 'OPEN', deposit: '10000', reason: 'WITHIN_POLICY', approval: { permit: {
      domain: 'agentpay.near.v1', vault_id: 'vault.testnet', agent_id: 'agent.testnet', action: action === 'SHUTDOWN' ? 'CLOSE' : 'OPEN', session_id: sessionId, recipient_id: 'provider.testnet', rate: state.rate, duration_seconds: 1000, quote_hash: 'a'.repeat(64), nonce: state.nonce, expires_at: '190',
    }, signature: 'not-exposed-to-model' } };
  } };
  const create = () => new PaymentExecutor({ client, worker, stateDir, paymentsEnabled: enabled });
  return { state, executor: create(), create, stateDir };
}

test('opaque approvals are single-use; duplicate submission and readonly profiles cannot pay', async t => {
  const { state, executor } = await fixture(t);
  const approval = await executor.check();
  assert.equal('approval' in approval, false);
  const results = await Promise.allSettled([executor.open(approval), executor.open(approval)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(state.submissions, 1);
  const readonly = await fixture(t, false);
  await assert.rejects(readonly.executor.open(await readonly.executor.check()), /PAYMENTS_DISABLED/);
  assert.equal(readonly.state.submissions, 0);
});

test('changed intent and a fresh policy denial never submit a transaction', async t => {
  const { state, executor } = await fixture(t);
  const approval = await executor.check();
  state.rate = '11';
  await assert.rejects(executor.open(approval), /INTENT_CHANGED/);
  const next = await executor.check();
  state.denied = true;
  await assert.rejects(executor.open(next), /RATE_LIMIT/);
  assert.equal(state.submissions, 0);
});

test('uncertain outcomes persist across instances; reconciliation confirms state without resubmitting', async t => {
  const { state, executor, create, stateDir } = await fixture(t);
  state.timeout = true;
  await assert.rejects(executor.open(await executor.check()), /timeout/);
  const journal = JSON.parse(await readFile(join(stateDir, 'pending.json'), 'utf8'));
  assert.equal('signature' in journal, false);
  await assert.rejects(create().check(), /RECONCILIATION_REQUIRED/);
  const result = await create().reconcile();
  assert.equal(result.reason, 'MATCHING_CHAIN_STATE');
  assert.equal(result.receiptRecovered, false);
  assert.equal(state.submissions, 1);
  await assert.rejects(access(join(stateDir, 'pending.json')), { code: 'ENOENT' });
  const restarted = create();
  assert.equal((await restarted.check()).decision, 'CONTINUE');
  await restarted.close({ sessionId: journal.permit.session_id });
  assert.equal(state.submissions, 2);
  assert.equal((await restarted.close({ sessionId: journal.permit.session_id })).alreadyClosed, true);
  assert.equal(state.submissions, 2);
});

test('unconfirmed or mismatched reconciliation remains blocked', async t => {
  const { state, executor, stateDir } = await fixture(t);
  state.timeout = true;
  await assert.rejects(executor.open(await executor.check()));
  state.stream.recipient_id = 'other.testnet';
  assert.equal((await executor.reconcile()).resolved, false);
  await access(join(stateDir, 'pending.json'));
});

test('a different process executor cannot double-open the same vault state', async t => {
  const { executor, create, state } = await fixture(t);
  const other = create();
  const [a, b] = await Promise.all([executor.check(), other.check()]);
  const results = await Promise.allSettled([executor.open(a), other.open(b)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(state.submissions, 1);
});

test('approvals expire and are scoped to the creating executor', async t => {
  const { executor, create, state } = await fixture(t);
  const approval = await executor.check();
  await assert.rejects(create().open(approval), /APPROVAL_INVALID/);
  const original = Date.now;
  try {
    Date.now = () => original() + 61000;
    await assert.rejects(executor.open(approval), /APPROVAL_INVALID/);
  } finally { Date.now = original; }
  assert.equal(state.submissions, 0);
});

test('a long-running executor rereads operator payment enablement before submission', async t => {
  let enabled = true;
  const { executor, state } = await fixture(t, async () => enabled);
  const checked = await executor.check();
  assert.equal(checked.paymentsEnabled, true);
  enabled = false;
  await assert.rejects(executor.open(checked), /PAYMENTS_DISABLED/);
  assert.equal(state.submissions, 0);
});

test('a disabled payment profile can still close an existing active stream', async t => {
  const { executor, state, stateDir } = await fixture(t);
  const session = await executor.open(await executor.check());
  const disabled = new PaymentExecutor({ stateDir, paymentsEnabled: false, client: {
    assertRestrictedAgent: async () => ({ active_session: state.active, next_nonce: state.nonce }),
    getStream: async () => state.stream,
    close: async () => { state.submissions++; return { hash: 'closed', value: {} }; },
  }, worker: { request: async () => ({ decision: 'CLOSE', approval: { permit: { session_id: session.sessionId, nonce: state.nonce } } }) } });
  assert.equal((await disabled.close({ sessionId: session.sessionId })).decision, 'CLOSE');
  assert.equal(state.submissions, 2);
});
