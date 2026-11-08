import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineGateway, guardedFetch, PaymentDeniedError } from '@ola-893/agentstreams-core';
import { agentStreamsTools } from '@ola-893/agentstreams-core/vercel-ai';
import { createToolHandlers } from '@ola-893/agentstreams-core/tools';

test('testing gateway approvals are single use', async () => {
  const client = new OfflineGateway();
  const approval = await client.check();
  await client.open(approval);
  await assert.rejects(client.open(approval), /APPROVAL_INVALID/);
});

test('guarded fetch serializes concurrent admission, reuses a session and denies a different tier', async () => {
  const client = new OfflineGateway();
  let opens = 0;
  const realOpen = client.open.bind(client);
  client.open = args => { opens++; return realOpen(args); };
  const request = guardedFetch(client.transport.bind(client), { client });
  const responses = await Promise.all(Array.from({ length: 10 }, () => request(`${client.serviceUrl}/research`)));
  assert.ok(responses.every(r => r.status === 200));
  assert.equal(opens, 1);
  const sessions = await Promise.all(responses.map(r => r.json()));
  assert.equal(new Set(sessions.map(r => r.sessionId)).size, 1);
  await assert.rejects(guardedFetch(client.transport.bind(client), { client, tier: 'premium' })(`${client.serviceUrl}/research`), PaymentDeniedError);
  client.setHealthy(false);
  await assert.rejects(request(`${client.serviceUrl}/research`), e => e.decision.decision === 'CLOSE');
  assert.equal((await client.check()).decision, 'DENY');
});

test('guarded fetch refuses credential forwarding, unsafe retries, foreign origins and unsupported challenges', async () => {
  const client = new OfflineGateway();
  let calls = 0;
  const request = guardedFetch(async () => { calls++; return Response.json({ protocol: 'other' }, { status: 402 }); }, { client });
  await assert.rejects(request('https://attacker.invalid/research'), /ORIGIN_DENIED/);
  await assert.rejects(request(`${client.serviceUrl}/research`, { method: 'POST', body: 'x' }), /UNSAFE_RETRY_METHOD/);
  await assert.rejects(request(`${client.serviceUrl}/research`, { headers: { 'x-agentpay-session': 'injected' } }), /SESSION_HEADER_HOST_ONLY/);
  assert.equal(calls, 0);
  await assert.rejects(request(`${client.serviceUrl}/research`), e => e.decision.reason === 'UNSUPPORTED_PAYMENT_PROTOCOL');
  assert.equal(calls, 1);
});

test('a repeated supported challenge retries once without a second payment; redirects are forbidden', async () => {
  const client = new OfflineGateway();
  let calls = 0;
  const request = guardedFetch(async req => {
    assert.equal(req.redirect, 'error');
    assert.equal(req.credentials, 'omit');
    calls++;
    return Response.json({ protocol: 'agentpay-near-v1', quote: 'https://attacker.invalid/quote' }, { status: 402 });
  }, { client });
  assert.equal((await request(`${client.serviceUrl}/research`)).status, 402);
  assert.equal(calls, 2);
});

test('Vercel tools use real AI SDK schemas; direct execute also rejects extra payment parameters', async () => {
  const client = new OfflineGateway();
  const tools = agentStreamsTools(client);
  assert.equal(tools.agentstreams_check.inputSchema.jsonSchema.additionalProperties, false);
  assert.throws(() => tools.agentstreams_check.execute({ tier: 'basic', recipient: 'attacker' }), /INVALID_TOOL_INPUT/);
  const checked = await tools.agentstreams_check.execute({ tier: 'basic' });
  const session = await tools.agentstreams_open_stream.execute({ approvalId: checked.approvalId });
  const response = await tools.agentstreams_fetch.execute({ tier: 'basic' });
  assert.equal(response.status, 200);
  await tools.agentstreams_close_stream.execute({ sessionId: session.sessionId });
  const denied = await createToolHandlers(client).agentstreams_check({ tier: 'premium' });
  assert.equal(denied.reason, 'RATE_LIMIT');
});

test('an aborted request never opens a payment', async () => {
  const client = new OfflineGateway();
  let opens = 0;
  const original = client.open.bind(client);
  client.open = args => { opens++; return original(args); };
  const controller = new AbortController();
  const request = guardedFetch(async () => {
    controller.abort();
    return Response.json({ protocol: 'agentpay-near-v1' }, { status: 402 });
  }, { client });
  await assert.rejects(request(`${client.serviceUrl}/research`, { signal: controller.signal }), /abort/i);
  assert.equal(opens, 0);
});
