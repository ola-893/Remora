import test from 'node:test';
import assert from 'node:assert/strict';
import { intentsAdapter } from '../cli/src/copy-intents.mjs';

test('confidential swaps keep privacy on preview and execution and reject an unconfirmed settlement', async t => {
  process.env.REMORA_PRIVACY_TEST_API = 'fixture-api'; process.env.REMORA_PRIVACY_TEST_GRANT = 'fixture-grant';
  t.after(() => { delete process.env.REMORA_PRIVACY_TEST_API; delete process.env.REMORA_PRIVACY_TEST_GRANT; });
  const order = { origin_asset: 'nep141:wrap.near', destination_asset: 'nep141:usdc.near', amount: '100', min_amount_out: '190' };
  const status = { type: 'swap', agent_id: 'fixture-agent', correlation_id: 'fixture-swap', status: 'SUCCESS', updated_at: new Date().toISOString(),
    details: { confidential: true, request: order, amount_out: '200', intent_hash: 'fixture-intent' } };
  const calls = [];
  const adapter = intentsAdapter({ id: 'fixture-agent', keyEnv: 'REMORA_PRIVACY_TEST_API', grantEnv: 'REMORA_PRIVACY_TEST_GRANT', live: true, confidential: true }, async (url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    assert.equal(body.confidential, true);
    assert.equal(options.headers['X-API-Key'], 'fixture-api');
    if (body.dry) { assert.equal(options.headers['X-Grant-Token'], undefined); return Response.json({ dry: true, type: 'swap', quote: { amountIn: '100', amountOut: '200' }, warnings: [] }); }
    assert.equal(options.headers['X-Grant-Token'], 'fixture-grant'); assert.equal(options.headers['Idempotency-Key'], 'stable-swap-key');
    return Response.json(status);
  });
  const quote = await adapter.quote(order);
  assert.equal(quote.confidentialRequested, true); assert.ok(Number.isFinite(Date.parse(quote.observedAt)));
  const settled = await adapter.settle(await adapter.execute(order, 'stable-swap-key'), order);
  assert.deepEqual(settled.privacy, { requested: true, providerConfirmed: true, independentlyVerified: false });
  for (const confidential of [false, undefined]) await assert.rejects(adapter.settle({ ...status, details: { ...status.details, confidential } }, order), /CONFIDENTIALITY_UNCONFIRMED/);
  await assert.rejects(adapter.settle({ ...status, agent_id: 'other' }, order), /IDENTITY_MISMATCH/);
  assert.equal(calls.length, 2);
});
