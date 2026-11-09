import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgent, readAgentState, selectedAgent, withAgentState } from '../cli/src/agents.mjs';
import { copyReviewJob, copyReviewer, copyReviewPrompt } from '../cli/src/copy-review.mjs';
import { writeInferenceProfile } from '../cli/src/inference-profile.mjs';

test('automatic copy review uses the named inference profile and can only annotate an action', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'remora-review-')));
  const previous = process.env.AGENTSTREAMS_HOME;
  process.env.AGENTSTREAMS_HOME = join(directory, 'private');
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENTSTREAMS_HOME;
    else process.env.AGENTSTREAMS_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  });
  await createAgent(directory, 'follower');
  const agent = await selectedAgent(directory, 'follower');
  const action = { id: 'rebalance-action', activity: 'portfolio-rebalance', expiresAt: Date.now() + 120000,
    action: { poolId: 0, base: 'wrap.testnet', amount: '2000', weights: { 'wrap.testnet': 5000, 'rft.tokenfactory.testnet': 5000 } } };
  const candidate = { ...action.action, amount: '1000' };
  const job = copyReviewJob(action, { type: 'strategy', status: 'pending', action: candidate,
    evidence: { source: 'rhea-exchange', amountIn: '1000', minimumAmountOut: '200', before: { privateBalance: '123' } } }, 'session');
  assert.equal(copyReviewJob(action, { type: 'strategy', status: 'skipped' }, 'session'), undefined);
  const events = [];
  const reviewer = copyReviewer(agent, event => events.push(event));
  await withAgentState(agent, state => {
    state.follow = { status: 'active', mode: 'approve', sessionId: 'session' };
    state.pending = { [action.id]: { action, status: 'pending', sessionId: 'session', preview: { action: candidate } } };
  });
  reviewer.enqueue(job);
  await reviewer.settled();
  assert.deepEqual(events, []);

  const requests = [];
  const reply = { status: 'NO_CONCERN', evidenceIds: ['follower-record'], note: 'The follower candidate uses a smaller amount.' };
  let message = { content: JSON.stringify(reply) };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks)) });
    res.end(JSON.stringify({ choices: [{ message }] }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await writeInferenceProfile(agent.path, { provider: 'local', model: 'test-reviewer', baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
  reviewer.enqueue(job);
  await reviewer.settled();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].body.model, 'test-reviewer');
  assert.equal(requests[0].body.messages[0].content, copyReviewPrompt);
  assert.equal(requests[0].body.tools, undefined);
  assert.doesNotMatch(requests[0].body.messages[1].content, /privateBalance|session/);
  let state = await readAgentState(agent);
  assert.deepEqual(state.pending[action.id].review, reply);
  assert.equal(state.pending[action.id].status, 'pending');
  assert.deepEqual(state.pending[action.id].preview.action, candidate);
  assert.equal(state.follow.mode, 'approve');

  message = { content: JSON.stringify({ ...reply, evidenceIds: ['unknown-source'] }) };
  reviewer.enqueue(job);
  await reviewer.settled();
  state = await readAgentState(agent);
  assert.equal(events.at(-1).status, 'UNAVAILABLE');
  assert.equal(state.pending[action.id].status, 'pending');

  message = { tool_calls: [{ id: '1', type: 'function', function: { name: 'strategy_apply', arguments: '{}' } }] };
  reviewer.enqueue(job);
  await reviewer.settled();
  assert.equal(events.at(-1).status, 'UNAVAILABLE');
  assert.equal((await readAgentState(agent)).pending[action.id].status, 'pending');

  const previousEvents = events.length;
  await withAgentState(agent, current => { current.follow.sessionId = 'new-session'; });
  reviewer.enqueue(job);
  await reviewer.settled();
  assert.equal(events.length, previousEvents);
});
