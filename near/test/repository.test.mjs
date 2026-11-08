import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createSandbox } from '../scripts/sandbox.mjs';
import { startRepositoryService } from '../../packages/cli/src/repository-service.mjs';
import { createNearGateway } from '../../packages/core/src/near-gateway.mjs';
import { createToolHandlers } from '../../packages/core/src/tools.mjs';

test('actual repository analysis requires NEAR payment, reuses one stream and closes after three paid 503s', { timeout: 240000 }, async () => {
  await mkdir('.local/near-tests', { recursive: true });
  const directory = resolve(await mkdtemp('.local/near-tests/repository-'));
  const env = await createSandbox({ directory });
  let service, client;
  try {
    const root = join(directory, 'sample'); await mkdir(root);
    await writeFile(join(root, 'server.js'), 'const answer = eval(userInput);\n');
    service = await startRepositoryService(env.config, { repository: root, port: 0 });
    const config = { ...env.config, serviceUrl: service.origin, runtimePolicy: { maxConsecutive5xx: 3, failureCooldownSeconds: 1 } };
    const file = join(directory, 'service.json'); await writeFile(file, JSON.stringify(config));
    assert.equal((await fetch(service.origin + '/research')).status, 402);
    assert.equal((await fetch(service.origin + '/research', { headers: { 'x-agentpay-session': 'forged' } })).status, 403);
    client = await createNearGateway({ configPath: file, stateRoot: join(directory, 'state'), paymentsEnabled: true });
    const tools = createToolHandlers(client);
    const overview = await tools.agentstreams_fetch({ tier: 'basic', query: 'view=overview' });
    assert.equal(overview.status, 200);
    const session = JSON.parse(overview.untrustedContent).session_id;
    const findings = await tools.agentstreams_fetch({ tier: 'basic', query: 'view=findings&severity=high' });
    const body = JSON.parse(findings.untrustedContent);
    assert.equal(body.session_id, session); assert.equal(body.findings[0].file, 'server.js'); assert.equal(body.findings[0].line, 1);
    assert.equal(findings.payment.events.some(e => e.receipt), false);
    service.setRequestUnavailable(true);
    for (let i = 0; i < 3; i++) {
      const failed = await tools.agentstreams_fetch({ tier: 'basic', query: 'view=overview' });
      assert.equal(failed.status, 503);
      assert.equal(Boolean((await env.agent.getVault()).active_session), i < 2);
      if (i === 2) assert.ok(failed.payment.events.some(e => e.reason === 'SERVICE_5XX_LIMIT' && e.receipt));
    }
    const stream = await env.agent.getStream(session);
    assert.equal(BigInt(stream.earned) + BigInt(stream.refunded), BigInt(stream.deposit));
  } finally {
    try { await client?.close(); } finally { await client?.dispose(); await service?.close(); await env.sandbox.tearDown(); }
  }
});
