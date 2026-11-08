import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPolicyWorker } from '../../near/lib/worker-client.mjs';

test('an unavailable worker rejects current and subsequent requests without exposing raw errors', async t => {
  const worker = startPolicyWorker('/nonexistent/agentpay-config.json', { env: {} });
  t.after(() => worker.stop());
  await assert.rejects(worker.request({ action: 'OPEN', sessionId: 'test', tier: 'basic' }), /Policy worker stopped/);
  await assert.rejects(worker.request({ action: 'OPEN', sessionId: 'test2', tier: 'basic' }), /POLICY_WORKER_UNAVAILABLE/);
});
