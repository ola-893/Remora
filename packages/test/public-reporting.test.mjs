import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgent, selectedAgent, withAgentState, readAgentState } from '../cli/src/agents.mjs';
import { approveEvidence, revokeEvidence, publicEvidence, recordPerformance } from '../cli/src/public-reporting.mjs';

test('all six activities expose only explicitly approved delayed metrics, never their private plans', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'remora-evidence-'));
  const previous = process.env.AGENTSTREAMS_HOME;
  process.env.AGENTSTREAMS_HOME = join(workspace, 'profiles');
  t.after(async () => { if (previous === undefined) delete process.env.AGENTSTREAMS_HOME; else process.env.AGENTSTREAMS_HOME = previous; await rm(workspace, { recursive: true, force: true }); });
  await createAgent(workspace, 'reporting'); const agent = await selectedAgent(workspace);
  const at = Date.parse('2026-11-05T12:10:00Z');
  const all = ['spot-trading', 'staking-moves', 'liquidity-ranges', 'portfolio-rebalance', 'yield-reallocation', 'limit-orders'];
  await withAgentState(agent, state => {
    for (const activity of all) recordPerformance(state, { id: activity, activity, execution: activity === 'spot-trading' ? 'paper' : 'wallet', at,
      action: { operation: { 'staking-moves': 'stake', 'yield-reallocation': 'supply', 'limit-orders': 'place' }[activity], target: 'private-pool', amount: '999999' },
      receipt: { hash: 'B'.repeat(44), value: '990' }, evidence: { quotedAmountOut: '1000', secret: 'never-public' },
      order: { original_amount: '1000', remain_amount: '750', cancel_amount: '0' } });
  });
  for (const activity of all) {
    assert.deepEqual(publicEvidence(await readAgentState(agent), activity), []);
    await approveEvidence(agent, activity);
    assert.deepEqual(publicEvidence(await readAgentState(agent), activity, Date.parse('2026-11-06T23:59:59.999Z')), []);
    const [row] = publicEvidence(await readAgentState(agent), activity, Date.parse('2026-11-07T00:00:00Z'));
    assert.equal(row.activity, activity); assert.equal(row.date, '2026-11-05'); assert.equal(row.metrics[0].value, '1');
    assert.doesNotMatch(JSON.stringify(row), /private-pool|999999|never-public|BBBBBB|12:10|"action"/);
    if (activity === 'portfolio-rebalance') assert.equal(row.metrics.find(m => m.key === 'quoteDifferenceBps').value, '-100');
    if (activity === 'limit-orders') assert.equal(row.metrics.find(m => m.key === 'orderFilledBps').value, '2500');
  }
  await assert.rejects(approveEvidence(agent, 'spot-trading', true), /RECEIPT_UNAVAILABLE/);
  await approveEvidence(agent, 'staking-moves', true);
  assert.equal(publicEvidence(await readAgentState(agent), 'staking-moves')[0].receipt, 'B'.repeat(44));
  await revokeEvidence(agent, 'staking-moves');
  assert.deepEqual(publicEvidence(await readAgentState(agent), 'staking-moves'), []);
});
