import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPresentation } from '../cli/src/presentation.mjs';
import { usesColor } from '../cli/src/output-mode.mjs';

const exec = promisify(execFile), root = resolve('.'), bin = join(root, 'packages/cli/bin/agentstreams.mjs');
function surface() { return { isTTY: true, columns: 70, value: '', write(s) { this.value += s; } }; }

test('color precedence is shared and explicit JSON always wins over color settings', () => {
  const stream = { isTTY: true }, env = { TERM: 'xterm-256color' };
  assert.equal(usesColor({ stream, env }), true);
  assert.equal(usesColor({ stream, env: { ...env, NO_COLOR: '' } }), false);
  assert.equal(usesColor({ stream, env: { TERM: 'dumb', FORCE_COLOR: '1' } }), true);
  assert.equal(usesColor({ stream, env: { ...env, NO_COLOR: '1', FORCE_COLOR: '1' } }), false);
  assert.equal(usesColor({ stream, env: { TERM: 'dumb', NO_COLOR: '1' }, color: 'always' }), true);
  assert.equal(usesColor({ stream, env: { FORCE_COLOR: '3' }, color: 'never' }), false);
  assert.equal(usesColor({ stream, env, color: 'always', json: true }), false);
});

test('headings, confirmation, waiting and errors use distinct restrained colors on the real renderer', () => {
  const stream = surface(), diagnostics = surface();
  const output = createPresentation({ stream, diagnostics, color: 'always', env: { TERM: 'dumb', NO_COLOR: '1' } });
  output.emit({ running: true, agentId: 'example' });
  output.emit({ connected: true, network: 'testnet', accountId: 'example.testnet' });
  output.emit({ decision: 'DENY', reason: 'STRATEGY_INPUT_LIMIT' });
  assert.match(stream.value, /\x1b\[38;5;30;1m/);
  assert.match(stream.value, /\x1b\[38;5;71;1m/);
  assert.match(stream.value, /\x1b\[38;5;172;1m/);
  assert.match(stream.value, /\x1b\[38;5;167;1m/);
  assert.match(stream.value, /Waiting for the next event/);
});

test('transcript capture omits one-use approval links but retains the approval explanation', () => {
  const stream = surface(), diagnostics = surface();
  const output = createPresentation({ stream, diagnostics, color: 'always', env: { TERM: 'xterm', REMORA_TRANSCRIPT: '1' } });
  output.wallet({ kind: 'connect', accountId: 'example.testnet' }, 'http://127.0.0.1:5389/#must-not-be-recorded');
  assert.doesNotMatch(diagnostics.value, /must-not-be-recorded/);
  assert.match(diagnostics.value, /Wallet approval needed/);
  assert.match(diagnostics.value, /default browser/);
});

test('stopped subscription status cannot look like an active per-second payment', () => {
  const stream = surface();
  createPresentation({ stream, color: 'never' }).emit({ subscription: { status: 'stopped', closeHash: 'stored-close-receipt', listing: { name: 'Example', network: 'testnet', rate: '1' } } });
  assert.match(stream.value, /Closure receipt recorded/);
  assert.doesNotMatch(stream.value, /Payment|second|Waiting for the next/);
});

test('both shell roles replace stale functions and pin CLI, helpers and Node to this checkout', async t => {
  const demo = await mkdtemp(join(tmpdir(), 'remora-shell-route-'));
  t.after(() => rm(demo, { recursive: true, force: true }));
  for (const role of ['leader', 'follower']) {
    const shell = `function agentstream() { print old-global-package; }; source "$1/scripts/demo-shell.zsh" "$2" >/dev/null; agentstream diagnostics --json;`;
    const result = await exec('/bin/zsh', ['-f', '-c', shell, 'route-test', root, role], { env: { ...process.env, REMORA_DEMO: demo, CLI_ROOT: '/old/global/package' } });
    const d = JSON.parse(result.stdout);
    assert.equal(d.packageRoot, join(root, 'packages/cli'));
    assert.equal(d.executable, bin);
    assert.equal(d.stateHome, join(demo, `${role}-state`));
    assert.match(d.revision, /^[a-f0-9]{40}$/);
    assert.match(d.rendererFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(d.outputMode, 'JSON');
    assert.equal(d.color, 'Disabled (always)');
    await assert.rejects(stat(join(demo, `${role}-state`)), { code: 'ENOENT' });
  }
});

test('helper defaults are this checkout; an explicit different package root fails before any operation', async () => {
  for (const file of ['demo-close-proof.mjs', 'demo-compute-top-up.mjs']) {
    const help = await exec(process.execPath, [join(root, 'scripts', file), '--help', '--json', '--color=always']);
    assert.equal(typeof JSON.parse(help.stdout), 'string');
    assert.doesNotMatch(help.stdout, /\x1b/);
    await assert.rejects(exec(process.execPath, [join(root, 'scripts', file), '--check', '--cli-root', tmpdir(), '--json']), e => e.code === 1 && /DEMO_CLI_ROOT_MISMATCH/.test(JSON.parse(e.stderr).error) && !e.stdout);
  }
});

test('actual CLI accepts color globally while pipes and explicit JSON remain parseable and uncolored', async () => {
  const d = JSON.parse((await exec(process.execPath, [bin, 'diagnostics', '--color=always', '--json'], { env: { ...process.env, FORCE_COLOR: '3' } })).stdout);
  assert.equal(d.packageRoot, join(root, 'packages/cli'));
  assert.equal(d.color, 'Disabled (always)');
  const help = (await exec(process.execPath, [bin, '--help', '--json', '--color=always'])).stdout;
  assert.equal(typeof JSON.parse(help), 'string');
  assert.doesNotMatch(help, /\x1b/);
  await assert.rejects(exec(process.execPath, [bin, 'diagnostics', '--color=broken', '--json']), e => e.code === 1 && /INVALID_COLOR_MODE/.test(JSON.parse(e.stderr).error));
});

test('cross-role launcher diagnostics use the requested role state rather than inherited leader state', async t => {
  const demo = await mkdtemp(join(tmpdir(), 'remora-role-route-'));
  t.after(() => rm(demo, { recursive: true, force: true }));
  const result = await exec(process.execPath, [join(root, 'scripts/demo.mjs'), '--project', demo, '--role', 'follower', 'diagnostics', '--json', '--color=always'], {
    env: { ...process.env, REMORA_ROLE: 'leader', AGENTSTREAMS_HOME: join(demo, 'leader-state'), CLI_ROOT: '/old/global/cli' },
  });
  const d = JSON.parse(result.stdout);
  assert.equal(d.stateHome, join(await realpath(demo), 'follower-state'));
  assert.equal(d.executable, bin);
  assert.equal(d.packageRoot, join(root, 'packages/cli'));
  assert.doesNotMatch(result.stdout, /\x1b/);
});

test('launcher --check always inspects, even if an execution command was supplied', async t => {
  const demo = await mkdtemp(join(tmpdir(), 'remora-readonly-launch-'));
  t.after(() => rm(demo, { recursive: true, force: true }));
  const env = { ...process.env, AGENTSTREAMS_HOME: join(demo, 'leader-state') };
  await exec(process.execPath, [bin, 'agent', 'create', 'leader', '--project', demo], { env });
  const result = await exec(process.execPath, [join(root, 'scripts/demo.mjs'), '--project', demo, '--role', 'leader', '--check', 'decide', '--json'], { env });
  const inspected = JSON.parse(result.stdout);
  assert.equal(inspected.type, 'demo-check');
  assert.equal(inspected.inferenceProvider, 'Not configured');
  await assert.rejects(stat(join(demo, 'leader-state/owner-operations')), { code: 'ENOENT' });
});
