// Preserve the current session in memory, close it, prove denial. --check is read-only.
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { withDemoOutput, demoOutputOptions, demoError } from './demo-support.mjs';

async function main() {
  const { values } = parseArgs({ options: { ...demoOutputOptions, project: { type: 'string' }, agent: { type: 'string', default: 'follower' } } });
  await withDemoOutput(values, ['demo', 'close-proof'], async ({ root, output, moduleAt }) => {
    if (values.help) return output.emit('node scripts/demo-close-proof.mjs --project PATH --agent follower [--check] [--json] [--color=always]');
    if (!values.project) throw new Error('--project is required.');
    const { selectedAgent, readAgentState } = await moduleAt('agents');
    const agent = await selectedAgent(await realpath(resolve(values.project)), values.agent);
    if (!agent) throw new Error('Select the follower agent first.');
    const state = await readAgentState(agent), follow = state.follow;
    const runnerPid = await readFile(join(agent.path, 'runner.lock'), 'utf8').then(s => Number(s.trim())).catch(() => null);
    if (values.check) return output.emit({ type: 'demo-check', agent: agent.name, packageRoot: root, network: 'testnet', subscriptionStatus: follow?.status, runnerPid, operation: 'Read-only closure readiness; no requests or transactions sent.' });
    if (runnerPid) { try { process.kill(runnerPid, 0); throw new Error('DEMO_RUNNER_ACTIVE: inspect the runner and its close-on-exit policy before stopping it. No closure attempted.'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    if (follow?.status !== 'active' || follow.listing.delivery !== 'outlayer') throw new Error('An active OutLayer copy subscription is required.');
    const { gatewayFor } = await moduleAt('config');
    const { stopCopy } = await moduleAt('copy-runtime');
    const { outlayerFeedResponse } = await moduleAt('outlayer');
    const client = await gatewayFor(agent.path);
    try {
      const headers = await client.sessionHeaders();
      if (!headers['x-agentpay-session']) throw new Error('The active session credential is unavailable.');
      const path = '/copy/actions?after=' + follow.cursor;
      const before = await outlayerFeedResponse(follow.listing.id, path, headers);
      const closed = await stopCopy(agent, 'stopped', 'DEMO_COMPLETE');
      const after = await outlayerFeedResponse(follow.listing.id, path, headers);
      output.emit({ type: 'close-proof', beforeCloseHTTP: before.status, streamStatus: closed.status, closeTransaction: closed.closeHash, afterCloseHTTP: after.status, sameSessionCredential: true });
      if (before.status !== 200 || after.status !== 403 || !closed.closeHash) process.exitCode = 1;
    } finally { await client.dispose(); }
  });
}
main().catch(demoError);
