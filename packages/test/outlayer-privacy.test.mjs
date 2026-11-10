import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { encryptOutlayerInput } from '../cli/src/outlayer-transport.mjs';
import { verifyOutlayerCall } from '../cli/src/outlayer-attestation.mjs';
import { outlayerNetwork } from '../../near/lib/outlayer.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('JS and Rust HPKE implementations exchange encrypted feed payloads and reject tampering, expiry and reply swaps', async () => {
  await promisify(execFile)('cargo', ['build', '--manifest-path', 'near/outlayer-feed/Cargo.toml', '--example', 'transport-fixture', '--locked'], { cwd: root });
  const fixture = input => new Promise((resolve, reject) => {
    const child = spawn(root + 'near/outlayer-feed/target/debug/examples/transport-fixture');
    let stdout = ''; child.stdout.on('data', d => stdout += d); child.on('error', reject); child.on('close', code => code ? reject(new Error('Fixture failed')) : resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify(input));
  });
  const { publicKey } = await fixture({ publicKey: true });
  const request = await encryptOutlayerInput(publicKey, { operation: 'append', privateAction: 'secret-amount', session: 'secret-session' });
  assert.doesNotMatch(JSON.stringify(request.input), /secret-|append/);
  const response = await fixture({ envelope: request.input, now: Date.now() });
  assert.doesNotMatch(JSON.stringify(response), /secret-|append/);
  assert.equal((await request.decrypt(response)).received.privateAction, 'secret-amount');
  const other = await encryptOutlayerInput(publicKey, { operation: 'actions' });
  await assert.rejects(other.decrypt(response), /RESPONSE_INVALID/);
  const altered = { ...request.input, ciphertext: Buffer.from('bad ciphertext').toString('base64') };
  assert.equal((await fixture({ envelope: altered, now: Date.now() })).error, 'ENCRYPTED_INPUT_INVALID');
  assert.equal((await fixture({ envelope: request.input, now: Date.now() + 61000 })).error, 'ENCRYPTED_INPUT_EXPIRED');
});

test('attestation adapter rejects every unproven layer and incorrect build, caller or project binding', async () => {
  const callId = '12345678-1234-1234-1234-123456789012', version = 'a'.repeat(64), caller = 'owner.testnet';
  let change = '';
  const run = async (bin, args) => {
    assert.equal(bin, 'outlayer-verify');
    assert.equal(args[args.indexOf('--api') + 1], outlayerNetwork.origin);
    const inputFile = args[args.indexOf('--input') + 1];
    assert.deepEqual(JSON.parse(await readFile(inputFile)), { operation: 'encrypted' });
    const proof = { task_id: 1, format: 'V1', uncovered_fields: [], ...Object.fromEntries(['authenticity','identity','binding','input','output'].map(layer => [layer, { verdict: 'pass' }])) };
    if (['authenticity','identity','binding','input','output'].includes(change)) proof[change].verdict = 'unproven';
    const record = { call_id: callId, wasm_hash: version, caller_account_id: caller, project_id: outlayerNetwork.project, task_type: 'execute', timestamp: Math.floor(Date.now()/1000) };
    if (['wasm_hash','caller_account_id','project_id'].includes(change)) record[change] = 'other';
    if (change === 'stale') record.timestamp -= 301;
    await writeFile(args[args.indexOf('--bundle') + 1], JSON.stringify({ network: 'testnet', register_contract: 'worker.outlayer.testnet', attestation: record }));
    return { stdout: JSON.stringify(proof) };
  };
  const request = { callId, version, caller, input: { operation: 'encrypted' }, output: { enc: 'public-data' } };
  assert.equal((await verifyOutlayerCall(request, { run })).verified, true);
  for (change of ['authenticity','identity','binding','input','output','wasm_hash','caller_account_id','project_id','stale']) await assert.rejects(verifyOutlayerCall(request, { run }), /BINDING_MISMATCH/);
  await assert.rejects(verifyOutlayerCall(request, { run: async () => { throw new Error('secret stderr'); } }), error => !error.message.includes('secret stderr') && /UNPROVEN/.test(error.message));
});

test('bootstrap refuses a missing, broadened or different-build secret policy', async () => {
  const { requireSecretBuildLock } = await import('../cli/src/outlayer.mjs');
  const version = 'a'.repeat(64);
  let access = { WasmHash: { hash: version } };
  const provider = { callFunction: async request => {
    assert.equal(request.method, 'get_secrets'); assert.equal(request.blockQuery.finality, 'final');
    assert.equal(request.args.profile, 'remora-feed-v1');
    return { access };
  } };
  await requireSecretBuildLock(version, provider);
  for (access of [undefined, 'AllowAll', { WasmHash: { hash: 'b'.repeat(64) } }, { Or: [{ WasmHash: { hash: version } }, 'AllowAll'] }]) await assert.rejects(requireSecretBuildLock(version, provider), /BUILD_LOCK_REQUIRED/);
});
