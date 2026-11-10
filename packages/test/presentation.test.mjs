import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPresentation, decimal, amount, redact, presentationContext, walletNotice } from '../cli/src/presentation.mjs';
import { renderHelp } from '../cli/src/brand.mjs';
import { events, approval, follow, pending } from './fixtures/presentation.mjs';
import { runModelAgent } from '../cli/src/agent.mjs';

function capture(options = {}) {
  const stream = options.stream ?? { isTTY: true, columns: 72, value: '', write(s) { this.value += s; } };
  const diagnostics = options.diagnostics ?? { ...stream };
  const output = createPresentation({ stream, diagnostics, env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }, ...options });
  return { stream, diagnostics, output };
}
const plain = stream => stripVTControlCharacters(stream.value);

test('exact token formatting never rounds large amounts or guesses unknown metadata', () => {
  assert.equal(decimal('9007199254740993123456789', 6), '9007199254740993123.456789');
  assert.equal(decimal('1', 24), '0.000000000000000000000001');
  assert.equal(decimal('0000000', 6), '0');
  assert.equal(amount('1000000000000000000000', 'nep141:wrap.testnet'), '0.001 test wNEAR');
  assert.equal(amount('1', 'usdc.fakes.testnet'), '0.000001 test USDC.e');
  assert.equal(amount('12345', 'unknown.testnet'), '12345 raw units (unknown.testnet)');
  assert.match(amount('12345'), /metadata unavailable/);
});

test('human states distinguish model opinion, owner veto, policy, paper and actual execution', () => {
  const { output, stream, diagnostics } = capture();
  for (const event of events) output.emit(event);
  const text = plain(stream).replace(/\s+/g, ' '), errors = plain(diagnostics).replace(/\s+/g, ' ');
  for (const title of ['owner veto window', 'model review · advisory', 'guards and owner controls', 'Execution confirmed', 'blocked by policy', 'vetoed by owner', 'Paper action recorded', 'no on-chain trade', 'closure confirmed']) assert.ok(text.includes(title), title);
  assert.match(text, /0.001 test wNEAR/);
  assert.match(text, /rhea-ref-exchange/);
  assert.match(text, /STRATEGY_INPUT_LIMIT/);
  assert.doesNotMatch(text, /No transaction submitted/); // a skipped event alone is not proof
  assert.match(errors, /Outcome uncertain/);
  assert.match(errors, /before another paid operation/);
  assert.doesNotMatch(errors, /confirmed\b|No transaction submitted/);
});

test('previews, submissions and failures cannot acquire confirmed or policy labels', () => {
  const { output, stream, diagnostics } = capture();
  output.emit({ status: 'preview', signedTransactions: 0, network: 'testnet' });
  output.emit({ status: 'submitting', transactionHash: 'an-unconfirmed-hash' });
  output.emit({ type: 'tool', name: 'strategy_apply', result: { decision: 'DENY', reason: 'RPC_TRANSPORT_FAILED' } });
  assert.match(plain(stream), /preview · not submitted/);
  assert.match(plain(stream), /Execution outcome pending/);
  assert.doesNotMatch(plain(stream), /Execution confirmed|blocked by policy/);
  assert.match(plain(diagnostics), /Operation failed/);
});

test('scripts keep their schemas; explicit JSON is one parseable value per event with no terminal decoration', () => {
  for (const json of [true, false]) {
    const { output, stream } = capture({ json, stream: { isTTY: false, value: '', write(s) { this.value += s; } } });
    const result = { status: 'pending', amount: '9007199254740993123456789', events: [{ type: 'signal', phase: 'proposed' }] };
    output.emit(result);
    assert.deepEqual(JSON.parse(stream.value), result);
    assert.doesNotMatch(stream.value, /\x1b|✓|›|…/);
  }
  const { output, stream } = capture({ json: true });
  output.emit({ received: 0 }); output.emit({ received: 0 });
  assert.deepEqual(stream.value.trim().split('\n').map(s => JSON.parse(s)), [{ received: 0 }, { received: 0 }]);
});

test('no-color presence (even empty) and dumb terminals retain readable plain status words', () => {
  for (const env of [{ TERM: 'xterm', NO_COLOR: '' }, { TERM: 'dumb' }]) {
    const { output, stream } = capture({ env });
    output.emit({ status: 'paper-filled' });
    assert.doesNotMatch(stream.value, /\x1b/);
    assert.match(stream.value, /Paper action recorded/);
    assert.doesNotMatch(renderHelp('1.0', 'Commands:\n  example', { stream, env }), /\x1b/);
  }
});

test('redaction hides secrets, terminal escapes and free-form inference without mutating events', () => {
  const fixture = { apiKey: 'not-for-logs', nested: { private_key: 'never-print', authorization: 'Bearer secret' }, apiKeyStored: true, publicKey: 'public-key',
    arguments: JSON.stringify({ privateKey: 'encoded-secret' }), key: 'opaque-compute-secret', text: 'sensitive model output', note: 'sensitive advisory', endpoint: 'https://user:pass@example.com?token=token-value', reason: '\x1b[31mRPC_FAILED', leakedError: 'ed25519:' + 'A'.repeat(88) };
  const before = structuredClone(fixture);
  for (const json of [true, false]) {
    const { output, stream } = capture({ json, verbose: true }); output.emit(fixture);
    for (const secret of ['not-for-logs', 'never-print', 'encoded-secret', 'opaque-compute-secret', 'sensitive model output', 'sensitive advisory', 'token-value', 'user:pass', 'A'.repeat(88)]) assert.ok(!stream.value.includes(secret), secret);
  }
  assert.deepEqual(fixture, before);
  assert.equal(redact(fixture).apiKeyStored, true);
  assert.equal(redact(fixture).publicKey, 'public-key');
  assert.equal(redact(fixture).reason, 'RPC_FAILED');
});

test('wallet prompts expose purpose, full recipients and exact amounts; link appears once unwrapped', () => {
  const { output, diagnostics, stream } = capture();
  const url = 'http://127.0.0.1:5389/#one-use-approval-link';
  presentationContext.run({ output }, () => walletNotice(approval, url));
  assert.match(plain(diagnostics), /Wallet approval needed/);
  assert.match(plain(diagnostics), /0.002 test USDC/);
  assert.match(plain(diagnostics), /example-vault.testnet/);
  assert.match(plain(diagnostics), /NEAR testnet/);
  assert.equal(diagnostics.value.split(url).length, 2);
  assert.equal(stream.value, '');
  const machine = capture({ json: true }); machine.output.wallet(approval, url);
  assert.deepEqual(JSON.parse(machine.diagnostics.value), { ownerWalletApproval: true, operation: approval.plan.label, url });
});

test('narrow-terminal summaries wrap without losing actionable IDs or deadlines', () => {
  const stream = { isTTY: true, columns: 42, value: '', write(s) { this.value += s; } };
  const { output } = capture({ stream });
  output.emit(pending);
  const lines = plain(stream).split('\n');
  assert.ok(lines.every(line => Array.from(line).length <= 42), lines.join('\n'));
  assert.match(lines.join('\n'), /fixture-candidate-01/);
  assert.match(lines.join('\n'), /2026-11-10/);
});

test('runner collapses repeated waiting and heartbeat updates but keeps distinct actions and errors', () => {
  const { output, stream, diagnostics } = capture();
  output.emit({ type: 'registry', method: 'heartbeat', publisherId: 'a', transactionHash: 'first' });
  output.emit({ type: 'registry', method: 'heartbeat', publisherId: 'a', transactionHash: 'next' });
  for (let i = 0; i < 3; i++) output.emit({ type: 'execution', status: 'waiting-signal', actionId: 'one' });
  output.emit({ type: 'execution', status: 'waiting-signal', actionId: 'two' });
  output.emit({ type: 'feed-error', reason: 'FEED_HTTP_503', failures: 1 });
  output.emit({ type: 'feed-error', reason: 'FEED_HTTP_503', failures: 2 });
  output.emit({ type: 'feed-error', reason: 'FEED_STALE' });
  output.finish();
  assert.equal(plain(stream).match(/Waiting for signal release/g).length, 2);
  assert.equal(plain(stream).match(/heartbeat sent/g).length, 1);
  assert.match(plain(diagnostics), /FEED_STALE/);
  assert.match(plain(stream), /Updates\s+4/);
  // Machine streams preserve every event, including repeated maintenance.
  const m = capture({ json: true });
  m.output.emit({ status: 'waiting-signal' }); m.output.emit({ status: 'waiting-signal' });
  assert.equal(m.stream.value.trim().split('\n').length, 2);
});

test('subscription and guards show exact rates, timing, sizing and enforcement boundaries', () => {
  const { output, stream } = capture({ command: ['guard', 'show'] });
  output.configure({ network: 'testnet' });
  output.emit({ payment: { budget: '10000', max_deposit: '2000', max_rate: '1', max_duration_seconds: 900 }, strategyExecution: { 'portfolio-rebalance': { caps: { 'nep141:wrap.testnet': '1000000000000000000000' }, copyBps: 5000, maxAge: 120, slippageBps: 100 } } });
  output.emit(follow);
  const text = plain(stream);
  for (const value of ['0.01 test USDC', '0.000001 test USDC / second', '900 seconds', '50% of leader', '0.001 test wNEAR', 'on-chain policy', 'deterministic CLI checks', 'NEAR testnet', 'Settlement is public']) assert.ok(text.includes(value), value);
});

test('model tool progress is presentation-only and leaves machine event schemas unchanged', async () => {
  for (const json of [false, true]) {
    const { output, stream } = capture({ json });
    let calls = 0;
    await presentationContext.run({ output }, () => runModelAgent({ provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture-model', maxSteps: 2 }, {
      prompt: 'never show this prompt', instructions: 'private instructions',
      definitions: { strategy_preview: { description: 'Preview', properties: {}, required: [] } },
      handlers: { strategy_preview: async () => ({ status: 'preview', signedTransactions: 0 }) }, emit: output.emit,
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: calls++ === 0 ? { tool_calls: [{ id: 'fixture-call', type: 'function', function: { name: 'strategy_preview', arguments: '{}' } }] } : { content: 'private model answer' } }] })),
    }));
    if (json) assert.deepEqual(stream.value.trim().split('\n').map(s => JSON.parse(s).type), ['tool', 'answer']);
    else assert.match(plain(stream), /Agent checks a proposed action/);
    assert.doesNotMatch(stream.value, /never show this prompt|private instructions|private model answer/);
  }
});

test('actual CLI pipe and JSON modes keep matching command schemas and exit codes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'remora-presentation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exec = promisify(execFile);
  const bin = resolve('packages/cli/bin/agentstreams.mjs');
  const run = args => exec(process.execPath, [bin, ...args], { cwd: root, env: { ...process.env, AGENTSTREAMS_HOME: join(root, 'private') } });
  for (const args of [['agent', 'list'], ['wallet', 'show'], ['init', '--network', 'testnet'], ['install', 'mcp']]) {
    const legacy = JSON.parse((await run(args)).stdout), explicit = JSON.parse((await run([...args, '--json'])).stdout);
    assert.deepEqual(explicit, legacy);
  }
  assert.equal(typeof JSON.parse((await run(['--version', '--json'])).stdout), 'string');
  assert.equal(typeof JSON.parse((await run(['--help', '--json'])).stdout), 'string');
  const invoke = `import { run } from ${JSON.stringify(new URL('../cli/src/cli.mjs', import.meta.url).href)}; Object.defineProperty(process.stdout, 'isTTY', { value: true }); Object.defineProperty(process.stdout, 'columns', { value: 64 }); await run(['agent','create','named-agent']);`;
  const terminal = await exec(process.execPath, ['--input-type=module', '-e', invoke], { cwd: root, env: { ...process.env, AGENTSTREAMS_HOME: join(root, 'private'), NO_COLOR: '' } });
  assert.match(terminal.stdout, /Agent created locally/);
  assert.doesNotMatch(terminal.stdout, /publicKey|createdAt|\x1b/);
  assert.match((await run(['agent', 'list', '--verbose'])).stdout, /named-agent/);
  await assert.rejects(run(['unknown', '--json']), error => error.code === 1 && /Unknown command/.test(JSON.parse(error.stderr).error) && error.stdout === '');
});
