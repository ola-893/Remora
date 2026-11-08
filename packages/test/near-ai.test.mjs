import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { KeyPair } from 'near-api-js';
import { inferenceConfig, completionBody, listInferenceModels, NEAR_AI_BASE_URL } from '../cli/src/inference.mjs';
import { runAgent } from '../cli/src/agent.mjs';
import { OfflineGateway } from '../core/src/offline.mjs';

const exec = promisify(execFile);
const model = 'z-ai/glm-5.3-flash';

test('NEAR AI preset pins its endpoint and stores only a provider-specific key reference', () => {
  const config = inferenceConfig({ provider: 'near-ai', model });
  assert.equal(config.baseUrl, NEAR_AI_BASE_URL);
  assert.equal(config.apiKeyEnv, 'NEAR_AI_API_KEY');
  assert.equal(config.maxOutputTokens, 2048);
  assert.equal(config.provider, 'near-ai');
  assert.equal(inferenceConfig({ provider: 'near-ai', model, apiKeyEnv: 'MY_NEAR_KEY' }).apiKeyEnv, 'MY_NEAR_KEY');
  for (const baseUrl of ['https://attacker.invalid/v1', 'http://cloud-api.near.ai/v1', 'https://cloud-api.near.ai/v1?key=secret', 'https://user:password@cloud-api.near.ai/v1']) assert.throws(() => inferenceConfig({ provider: 'near-ai', model, baseUrl }));
  assert.throws(() => inferenceConfig({ provider: 'near-ai', model, apiKeyEnv: '' }));
  assert.throws(() => inferenceConfig({ provider: 'unknown', model, baseUrl: 'https://service.invalid/v1' }));
  assert.equal(inferenceConfig({ baseUrl: 'http://localhost:11434/v1', model: 'local' }).provider, 'openai-compatible');
});

test('provider request options handle NEAR reasoning controls without changing generic providers', () => {
  const body = args => completionBody(inferenceConfig(args), [], []);
  assert.deepEqual(body({ provider: 'near-ai', model, thinking: false }).chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(body({ provider: 'near-ai', model: 'moonshotai/kimi-k2.6', thinking: false }).chat_template_kwargs, { thinking: false });
  assert.equal(body({ baseUrl: 'http://localhost:11434/v1', model: 'local', thinking: false }).enable_thinking, false);
  assert.equal(body({ baseUrl: 'http://localhost:11434/v1', model: 'local' }).max_tokens, undefined);
  assert.equal(body({ provider: 'near-ai', model: 'openai/gpt-oss-120b', reasoningEffort: 'low', maxOutputTokens: 512 }).reasoning_effort, 'low');
  assert.throws(() => inferenceConfig({ provider: 'near-ai', model: 'openai/gpt-oss-120b', thinking: false }), /always on/);
  for (const maxOutputTokens of [0, 1.5, 131073]) assert.throws(() => inferenceConfig({ provider: 'near-ai', model, maxOutputTokens }));
  assert.throws(() => inferenceConfig({ provider: 'near-ai', model, reasoningEffort: 'unlimited' }));
});

test('public catalog pagination reports capabilities without treating provider metadata as verified attestation', async () => {
  const calls = [];
  const result = await listInferenceModels({ fetchImpl: async (url, init) => {
    calls.push(url);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers, undefined);
    if (calls.length === 1) return Response.json({ offset: 0, total: 3, models: [
      { modelId: 'local/confidential', metadata: { verifiable: true, attestationSupported: true, providerType: 'vllm', supportedFeatures: ['tools'], architecture: { outputModalities: ['text'] } } },
      { modelId: 'embedding/model', metadata: { supportedFeatures: [], architecture: { outputModalities: ['embedding'] } } },
    ] });
    assert.equal(new URL(url).searchParams.get('offset'), '2');
    return Response.json({ offset: 2, total: 3, models: [{ modelId: 'external/model', metadata: { providerType: 'external', supportedFeatures: ['tools'], architecture: { outputModalities: ['text'] } } }] });
  } });
  assert.equal(calls.length, 2);
  assert.equal(result.total, 3);
  assert.equal(result.models[0].agentCompatible, true);
  assert.equal(result.models[1].agentCompatible, false);
  assert.equal(result.models[2].providerReportedVerifiable, false);
  assert.equal(result.attestationVerified, false);
  assert.equal(result.policySignerLocation, 'local host');
  await assert.rejects(listInferenceModels({ fetchImpl: async () => Response.json({ offset: 0, total: 1, models: [] }) }), /INVALID_NEAR_AI_CATALOG/);
  await assert.rejects(listInferenceModels({ fetchImpl: async () => new Response('', { status: 503 }) }), /NEAR_AI_CATALOG_HTTP_503/);
});

test('named NEAR transport drives the shared tool loop, keeps the key off tools, and closes on error', async t => {
  const previous = process.env.NEAR_AI_API_KEY;
  process.env.NEAR_AI_API_KEY = 'near-ai-protocol-fixture-key';
  t.after(() => { if (previous === undefined) delete process.env.NEAR_AI_API_KEY; else process.env.NEAR_AI_API_KEY = previous; });
  // Explicit test double: this validates the provider wire protocol, not live cloud inference or NEAR settlement.
  const client = new OfflineGateway();
  client.runtimePolicy = { closeOnExit: true, healthPollSeconds: 60 };
  client.status = async () => ({ vault: { active_session: null } });
  const originalClose = client.close.bind(client);
  let closes = 0;
  client.close = async () => { closes++; const current = await client.check(); return current.sessionId ? originalClose({ sessionId: current.sessionId }) : { decision: 'CLOSE', alreadyClosed: true }; };
  let turns = 0;
  const events = [];
  await runAgent(client, { provider: 'near-ai', model, thinking: false }, { prompt: 'Request the paid API.', emit: e => events.push(e), fetchImpl: async (url, init) => {
    assert.equal(url, `${NEAR_AI_BASE_URL}/chat/completions`);
    assert.equal(init.headers.authorization, 'Bearer near-ai-protocol-fixture-key');
    assert.equal(init.redirect, 'error');
    assert.equal(init.body.includes('near-ai-protocol-fixture-key'), false);
    const body = JSON.parse(init.body);
    assert.equal(body.max_tokens, 2048);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal('enable_thinking' in body, false);
    assert.equal(body.messages.some(m => Object.hasOwn(m, 'reasoning_content')), false);
    if (turns++ === 0) return Response.json({ choices: [{ message: { role: 'assistant', content: null, reasoning_content: 'fixture internal reasoning', tool_calls: [{ id: 'near-call', type: 'function', function: { name: 'agentstreams_fetch', arguments: '{"tier":"basic","query":"q=near-ai"}' } }] } }] });
    assert.equal(JSON.parse(body.messages.at(-1).content).status, 200);
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'Answered from the tool result.' } }] });
  } });
  assert.equal(turns, 2); assert.equal(closes, 1);
  assert.ok(events.some(e => e.type === 'answer'));
  assert.equal(JSON.stringify(events).includes('near-ai-protocol-fixture-key'), false);
  await assert.rejects(runAgent(client, { provider: 'near-ai', model }, { prompt: 'Request data.', fetchImpl: async () => new Response('upstream details must not be echoed', { status: 401 }) }), /INFERENCE_HTTP_401/);
  assert.equal(closes, 2);
  await assert.rejects(runAgent(client, { provider: 'near-ai', model }, { prompt: 'Request data.', fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null } }] }) }), /INFERENCE_OUTPUT_LIMIT/);
  assert.equal(closes, 3);
  process.env.NEAR_AI_API_KEY = 'private-value-with-newline\n';
  await assert.rejects(runAgent(client, { provider: 'near-ai', model }, { prompt: 'Request data.' }), error => error.message === 'INFERENCE_CREDENTIAL_INVALID');
  delete process.env.NEAR_AI_API_KEY;
  let touched = false;
  await assert.rejects(runAgent(client, { provider: 'near-ai', model }, { prompt: 'Request data.', fetchImpl: async () => { touched = true; } }), /NEAR_AI_API_KEY/);
  assert.equal(touched, false);
});

test('CLI saves the NEAR preset without RPC or reading a key value into configuration', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agentpay-near-ai-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project'), home = join(directory, 'private');
  await mkdir(project);
  const keys = {};
  for (const name of ['agent', 'policy']) {
    keys[name] = join(directory, `${name}.json`);
    await writeFile(keys[name], JSON.stringify({ account_id: name === 'agent' ? 'agent.testnet' : undefined, private_key: KeyPair.fromRandom('ed25519').toString() }), { mode: 0o600 });
  }
  const deployment = join(directory, 'deployment.json');
  await writeFile(deployment, JSON.stringify({ network: 'testnet', rpcUrl: 'https://rpc.invalid', serviceUrl: 'http://127.0.0.1:5321', vaultId: 'vault.testnet', agentId: 'agent.testnet', ownerId: 'owner.testnet', recipientId: 'provider.testnet', tokenId: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af', agentKeyFile: keys.agent, policyKeyFile: keys.policy }));
  const env = { ...process.env, AGENTSTREAMS_HOME: home, NEAR_AI_API_KEY: 'fixture-value-must-never-be-saved' };
  const run = async args => JSON.parse((await exec(process.execPath, [resolve('packages/cli/bin/agentstreams.mjs'), ...args], { cwd: project, env })).stdout);
  await run(['init', '--network', 'testnet', '--deployment', deployment]);
  const result = await run(['inference', 'set', '--provider', 'near-ai', '--model', model, '--thinking', 'false', '--max-output-tokens', '1024']);
  assert.equal(result.credentialsStored, false); assert.equal(result.attestationVerified, false);
  assert.equal(result.inference.baseUrl, NEAR_AI_BASE_URL);
  assert.equal(result.inference.maxOutputTokens, 1024);
  const saved = await run(['inference', 'show']);
  assert.equal(saved.provider, 'near-ai'); assert.equal(saved.apiKeyEnv, 'NEAR_AI_API_KEY');
  const { profileId } = JSON.parse(await readFile(join(project, '.agentstreams/config.json')));
  assert.equal((await readFile(join(home, 'profiles', profileId, 'profile.json'), 'utf8')).includes(env.NEAR_AI_API_KEY), false);
  await assert.rejects(run(['inference', 'set', '--provider', 'near-ai', '--model', model, '--base-url', 'https://attacker.invalid/v1']), /near-ai provider uses/);
  assert.deepEqual(await run(['inference', 'show']), saved);
});
