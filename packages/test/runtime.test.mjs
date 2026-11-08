import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { runtimePolicy, updateObservation, closeReason, serviceConfig } from '../../near/lib/runtime-policy.mjs';
import { inferenceConfig, usdc } from '../cli/src/settings.mjs';
import { guardedFetch } from '../core/src/guarded-fetch.mjs';
import { runAgent } from '../cli/src/agent.mjs';
import { OfflineGateway } from '../core/src/offline.mjs';

test('5xx thresholds persist independently of healthy probes; successes reset consecutive errors', () => {
  const policy = runtimePolicy({ maxConsecutive5xx: 3 });
  const stream = { started_at: '100', duration_seconds: 1000 };
  let state = {};
  for (let i = 0; i < 2; i++) {
    state = updateObservation(state, { kind: 'response', status: 503 }, 110);
    state = updateObservation(state, { kind: 'health', ok: true }, 110);
    assert.equal(closeReason(policy, state, stream, 110), null);
  }
  state = updateObservation(state, { kind: 'response', status: 200 }, 111);
  assert.equal(state.consecutive5xx, 0);
  for (let i = 0; i < 3; i++) state = updateObservation(state, { kind: 'response', status: 503 }, 112);
  assert.equal(closeReason(policy, state, stream, 112), 'SERVICE_5XX_LIMIT');
  assert.equal(closeReason(policy, {}, stream, 161), 'STREAM_IDLE_TIMEOUT');
  assert.equal(closeReason(policy, {}, stream, 1100), 'LEASE_EXPIRED');
  assert.equal(closeReason(runtimePolicy({ maxRequestsPerStream: 2 }), { requests: 2, lastRequestAt: 110 }, stream, 110), 'STREAM_REQUEST_LIMIT');
});
test('configuration rejects bypasses and decimal money is exact', () => {
  assert.equal(usdc('0.000001'), '1');
  assert.equal(usdc('0.10'), '100000');
  for (const input of ['1e3', '-1', '0.0000001', 'NaN']) assert.throws(() => usdc(input));
  assert.throws(() => runtimePolicy({ maxConsecutive5xx: 0 }));
  assert.throws(() => runtimePolicy({ unknown: 1 }));
  assert.throws(() => serviceConfig({ requestPath: '//foreign.test' }));
  assert.throws(() => inferenceConfig({ model: 'model', baseUrl: 'http://cloud.invalid/v1' }));
  assert.throws(() => inferenceConfig({ model: 'model', baseUrl: 'https://cloud.invalid/v1', apiKeyEnv: 'secret-value' }));
});
test('host HTTP observations trigger automatic closure at configured limit without reopening', async () => {
  let closed = 0, observed = 0;
  const client = { serviceUrl: 'http://localhost:5321', check: async () => ({ decision: 'CONTINUE' }), sessionHeaders: async () => ({ 'x-agentpay-session': 'host-only' }),
    observeResult: async ({ kind, status }) => { assert.equal(kind, 'response'); assert.equal(status, 503); return { decision: ++observed >= 3 ? 'CLOSE' : 'CONTINUE', sessionId: 'session' }; },
    close: async () => { closed++; } };
  const request = guardedFetch(async () => new Response('unavailable', { status: 503 }), { client });
  await request(client.serviceUrl); await request(client.serviceUrl);
  assert.equal(closed, 0);
  await request(client.serviceUrl);
  assert.equal(closed, 1);
});
test('real chat HTTP tool loop forwards model-selected query and closes on exit without credential leakage', async t => {
  const client = new OfflineGateway();
  let turns = 0, question;
  const original = client.transport.bind(client);
  client.transport = async input => { question = new URL(input.url).searchParams.get('q'); return original(input); };
  client.runtimePolicy = { closeOnExit: true, healthPollSeconds: 60 };
  client.status = async () => ({ vault: { active_session: null } });
  const originalClose = client.close.bind(client);
  const originalOpen = client.open.bind(client);
  client.open = async args => ({ ...await originalOpen(args), receipt: { hash: 'protocol-test-hash', value: { closed_at: null }, logs: ['VERBOSE_RECEIPT_LOG_NOT_FOR_MODEL'] } });
  let closes = 0;
  client.close = async args => { closes++; const state = await client.check(); return originalClose(args || { sessionId: state.sessionId }); };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    assert.equal(req.url, '/v1/chat/completions');
    assert.ok(data.tools.every(tool => !tool.function.name.includes('config')));
    assert.equal(body.includes('private_key'), false);
    if (turns++ === 0) {
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'agentstreams_fetch', arguments: JSON.stringify({ tier: 'basic', query: 'q=real-question' }) } }] } }] }));
    } else {
      assert.equal(data.messages.at(-1).role, 'tool');
      assert.equal(JSON.parse(data.messages.at(-1).content).status, 200);
      assert.equal(data.messages.at(-1).content.includes('VERBOSE_RECEIPT_LOG_NOT_FOR_MODEL'), false);
      assert.ok(JSON.parse(data.messages.at(-1).content).payment.events.some(e => e.transactionHash === 'protocol-test-hash'));
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Answer based on the tool result.' } }] }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const events = [];
  const result = await runAgent(client, { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'test-protocol-model', maxSteps: 3 }, { prompt: 'Research this question.', emit: e => events.push(e) });
  assert.equal(result.completed, true);
  assert.equal(turns, 2);
  assert.equal(question, 'real-question');
  assert.equal(closes, 1);
  assert.equal(events.find(e => e.type === 'answer').text, 'Answer based on the tool result.');
  assert.ok(events.find(e => e.type === 'tool').result.payment.events.some(e => e.receipt?.logs?.includes('VERBOSE_RECEIPT_LOG_NOT_FOR_MODEL')));
});

test('open-ended stream checks have no clock expiry but reject exhaustion and explicit closure', async () => {
  const { sessionExpiry, streamAccessReason } = await import('../../near/lib/stream.mjs');
  const started = 100;
  const stream = { started_at: String(started), duration_seconds: 0, rate: '1', deposit: '4000000000', closed_at: null };
  assert.equal(sessionExpiry(stream), null);
  assert.equal(streamAccessReason(stream, started + 3153600000), null);
  assert.equal(streamAccessReason(stream, started + 4000000000), 'STREAM_FUNDS_EXHAUSTED');
  assert.equal(streamAccessReason({ ...stream, closed_at: '200' }, 200), 'STREAM_CLOSED');
});
