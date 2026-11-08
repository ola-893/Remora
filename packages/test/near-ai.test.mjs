import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, realpath, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { KeyPair } from 'near-api-js';
import { assertInferenceModel, inferenceConfig, completionBody, listInferenceModels, NEAR_AI_BASE_URL } from '../cli/src/inference.mjs';
import { runAgent } from '../cli/src/agent.mjs';
import { OfflineGateway } from '../core/src/offline.mjs';
import { initProject } from '../cli/src/config.mjs';

const exec = promisify(execFile);
const model = 'z-ai/glm-5.3-flash';

test('NEAR AI preset pins its endpoint and rejects environment key references', () => {
  const config = inferenceConfig({ provider: 'near-ai', model });
  assert.equal(config.baseUrl, NEAR_AI_BASE_URL);
  assert.equal(config.apiKeyEnv, undefined);
  assert.equal(config.maxOutputTokens, 2048);
  assert.equal(config.provider, 'near-ai');
  const stored = inferenceConfig({ provider: 'near-ai', model, apiKeyStored: true });
  assert.equal(stored.apiKeyEnv, undefined);
  assert.equal(stored.apiKeyStored, true);
  for (const baseUrl of ['https://attacker.invalid/v1', 'http://cloud-api.near.ai/v1', 'https://cloud-api.near.ai/v1?key=secret', 'https://user:password@cloud-api.near.ai/v1']) assert.throws(() => inferenceConfig({ provider: 'near-ai', model, baseUrl }));
  assert.throws(() => inferenceConfig({ provider: 'near-ai', model, apiKeyEnv: 'MY_NEAR_KEY' }), /inference set with --api-key/);
  assert.throws(() => inferenceConfig({ provider: 'unknown', model, baseUrl: 'https://service.invalid/v1' }));
  assert.equal(inferenceConfig({ baseUrl: 'http://localhost:11434/v1', model: 'local' }).provider, 'local');
  assert.equal(inferenceConfig({ provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'legacy' }).provider, 'local');
  for (const provider of ['local', 'openai-compatible', 'codex']) {
    assert.throws(() => inferenceConfig({ provider, baseUrl: 'https://service.invalid/v1', model: 'remote' }), /INFERENCE_(ENDPOINT|PROVIDER)_UNSUPPORTED/);
  }
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
  assert.deepEqual(result.models.map(item => item.confidentialEligible), [true, false, false]);
  await assert.rejects(assertInferenceModel(inferenceConfig({ provider: 'near-ai', model: 'external/model' }),
    async () => Response.json({ offset: 0, total: 1, models: [{ modelId: 'external/model', metadata: {
      providerType: 'external', verifiable: true, attestationSupported: true, supportedFeatures: ['tools'], architecture: { outputModalities: ['text'] },
    } }] })), /INFERENCE_MODEL_ATTESTATION_REQUIRED/);
  assert.equal(result.attestationVerified, false);
  assert.equal(result.policySignerLocation, 'local host');
  await assert.rejects(listInferenceModels({ fetchImpl: async () => Response.json({ offset: 0, total: 1, models: [] }) }), /INVALID_NEAR_AI_CATALOG/);
  await assert.rejects(listInferenceModels({ fetchImpl: async () => new Response('', { status: 503 }) }), /NEAR_AI_CATALOG_HTTP_503/);
});

test('named NEAR transport drives the shared tool loop, keeps the key off tools, and closes on error', async () => {
  const storedApiKey = 'near-ai-protocol-fixture-key';
  const inference = { provider: 'near-ai', model, apiKeyStored: true };
  // Explicit test double: this validates the provider wire protocol, not live cloud inference or NEAR settlement.
  const client = new OfflineGateway();
  client.runtimePolicy = { closeOnExit: true, healthPollSeconds: 60 };
  client.status = async () => ({ vault: { active_session: null } });
  const originalClose = client.close.bind(client);
  let closes = 0;
  client.close = async () => { closes++; const current = await client.check(); return current.sessionId ? originalClose({ sessionId: current.sessionId }) : { decision: 'CLOSE', alreadyClosed: true }; };
  let turns = 0;
  const events = [];
  await runAgent(client, { ...inference, thinking: false }, { storedApiKey, prompt: 'Request the paid API.', emit: e => events.push(e), fetchImpl: async (url, init) => {
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
  await assert.rejects(runAgent(client, inference, { storedApiKey, prompt: 'Request data.', fetchImpl: async () => new Response('upstream details must not be echoed', { status: 401 }) }), /INFERENCE_HTTP_401/);
  assert.equal(closes, 2);
  await assert.rejects(runAgent(client, inference, { storedApiKey, prompt: 'Request data.', fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null } }] }) }), /INFERENCE_OUTPUT_LIMIT/);
  assert.equal(closes, 3);
  await assert.rejects(runAgent(client, inference, { storedApiKey: 'private-value-with-newline\n', prompt: 'Request data.' }), error => error.message === 'INFERENCE_CREDENTIAL_INVALID');
  let touched = false;
  await assert.rejects(runAgent(client, inference, { prompt: 'Request data.', fetchImpl: async () => { touched = true; } }), /inference set with --api-key/);
  assert.equal(touched, false);
});

test('CLI prompts for a NEAR AI key and ignores an existing environment key', async t => {
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
  const catalogFixture = join(directory, 'catalog.mjs');
  await writeFile(catalogFixture, `globalThis.fetch = async url => {
    if (url !== '${NEAR_AI_BASE_URL}/model/list') throw new Error('Unexpected request');
    return Response.json({ offset: 0, total: 1, models: [{ modelId: '${model}', metadata: {
      providerType: 'vllm', verifiable: true, attestationSupported: true, supportedFeatures: ['tools'], architecture: { outputModalities: ['text'] },
    } }] });
  };`);
  const run = async (args, input) => {
    const call = exec(process.execPath, ['--import', catalogFixture, resolve('packages/cli/bin/agentstreams.mjs'), ...args], { cwd: project, env });
    call.child.stdin.end(input);
    return JSON.parse((await call).stdout);
  };
  const previousHome = process.env.AGENTSTREAMS_HOME;
  process.env.AGENTSTREAMS_HOME = home;
  try { await initProject(project, { deployment }); }
  finally {
    if (previousHome === undefined) delete process.env.AGENTSTREAMS_HOME;
    else process.env.AGENTSTREAMS_HOME = previousHome;
  }
  const set = ['inference', 'set', '--provider', 'near-ai', '--model', model, '--thinking', 'false', '--max-output-tokens', '1024'];
  await assert.rejects(run(set), /No inference API key entered/);
  const key = 'near-ai-cli-fixture-key';
  const result = await run(set, `${key}\n`);
  assert.equal(result.credentialsStored, true); assert.equal(result.attestationVerified, false);
  assert.equal(result.inference.baseUrl, NEAR_AI_BASE_URL);
  assert.equal(result.inference.maxOutputTokens, 1024);
  const saved = await run(['inference', 'show']);
  assert.equal(saved.provider, 'near-ai'); assert.equal(saved.apiKeyStored, true);
  assert.equal(JSON.stringify(saved).includes(key), false);
  const directoryPath = join(home, 'inference');
  const [profileFile] = await readdir(directoryPath);
  assert.equal(JSON.parse(await readFile(join(directoryPath, profileFile), 'utf8')).apiKey, key);
  await assert.rejects(run(['inference', 'set', '--provider', 'near-ai', '--model', model, '--base-url', 'https://attacker.invalid/v1']), /near-ai provider uses/);
  assert.deepEqual(await run(['inference', 'show']), saved);
});

test('CLI stores a provider key privately and uses it in a later agent process', async t => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'agentstreams-inference-key-')));
  t.after(() => rm(project, { recursive: true, force: true }));
  const key = 'inference-fixture-local-key';
  const env = { ...process.env, AGENTSTREAMS_HOME: join(project, 'private'), OPENAI_API_KEY: 'fixture-environment-key' };
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, authorization: request.headers.authorization, body });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'Fixture response' } }] }));
  }).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const run = async (args, input) => {
    const call = exec(process.execPath, [resolve('packages/cli/bin/agentstreams.mjs'), ...args], { cwd: project, env });
    call.child.stdin.end(input);
    const { stdout, stderr } = await call;
    assert.equal((stdout + stderr).includes(key), false);
    return JSON.parse(stdout);
  };
  await run(['agent', 'create', 'local']);
  await run(['task', 'enable', 'portfolio-rebalance']);
  const set = ['inference', 'set', '--base-url', `${endpoint}/v1`, '--model', 'fixture-model'];
  const invoke = ['agent', 'run', '--activity', 'portfolio-rebalance', '--prompt', 'Hello', '--json'];
  const saved = await run([...set, '--api-key'], `${key}\n`);
  assert.equal(saved.credentialsStored, true);
  assert.equal((await run(['inference', 'show'])).apiKeyStored, true);
  const directory = join(env.AGENTSTREAMS_HOME, 'inference');
  const [file] = await readdir(directory);
  assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
  await assert.rejects(run([...set, '--api-key-env', 'OPENAI_API_KEY']), /Unknown option '--api-key-env'/);
  await assert.rejects(run([...set, '--api-key'], 'invalid key\n'), /INFERENCE_CREDENTIAL_INVALID/);
  assert.equal((await run(invoke)).completed, true);
  assert.equal(requests[0].path, '/v1/chat/completions');
  assert.equal(requests[0].authorization, `Bearer ${key}`);
  assert.equal(requests[0].body.includes(key), false);
  await run(set);
  const profilePath = join(directory, file);
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  assert.equal(profile.apiKey, undefined);
  assert.equal((await run(invoke)).completed, true);
  assert.equal(requests[1].authorization, undefined);
  profile.inference.apiKeyEnv = 'OPENAI_API_KEY';
  await writeFile(profilePath, JSON.stringify(profile));
  assert.equal((await run(['inference', 'show'])).apiKeyEnv, undefined);
  await assert.rejects(run(invoke), /inference set with --api-key/);
  assert.equal(requests.length, 2);
});
