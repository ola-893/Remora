import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'smol-toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installAgent } from '../cli/src/install.mjs';

const exec = promisify(execFile);
const bin = resolve('packages/cli/bin/agentstreams.mjs');
async function project(t) {
  const path = await mkdtemp(join(tmpdir(), 'agentpay-cli-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const run = (cwd, ...args) => exec(process.execPath, [bin, ...args], { cwd, env: { ...process.env, AGENTSTREAMS_HOME: join(cwd, 'private'), NEAR_CONFIG: '/nonexistent/never-read.json' } });

test('CLI exposes operational controls and rejects removed scripted commands', async t => {
  const cwd = await project(t);
  await writeFile(join(cwd, '.env'), 'THIS_IS_NOT_VALID_ENV=do-not-read\n');
  const help = (await run(cwd, '--help')).stdout;
  assert.match(help, /config limits/);
  assert.match(help, /agent run/);
  assert.match(help, /^Remora CLI /);
  assert.match(help, /remora-agents\.pages\.dev\/explore/);
  assert.doesNotMatch(help, /\x1b/);
  assert.doesNotMatch(help, /--(?:owner|recipient)-key/);
  assert.doesNotMatch(help, /--no-open/);
  assert.doesNotMatch(help, /agentstreams (?:demo|simulate)/);
  for (const command of ['demo', 'simulate', 'unknown']) await assert.rejects(run(cwd, command), /Unknown command/);
  await assert.rejects(run(cwd, 'init', '--quick'), /Unknown option/);
  await assert.rejects(run(cwd, 'demo', '--pay'), /Unknown option/);
  await assert.rejects(run(cwd, 'mcp'), /not initialized/);
  assert.equal((await run(cwd, '--version')).stdout.trim(), JSON.parse(await readFile(new URL('../cli/package.json', import.meta.url))).version);
  assert.ok(JSON.parse((await run(cwd, 'install', 'mcp')).stdout).mcpServers.agentstreams);
});

test('cold testnet init gives funding/setup steps without generating keys or pretending to deploy', async t => {
  const cwd = await project(t);
  const result = JSON.parse((await run(cwd, 'init', '--network', 'testnet')).stdout);
  assert.equal(result.status, 'OWNER_SETUP_REQUIRED');
  assert.equal(result.signedTransactions, 0);
  assert.match(result.next, /wallet connect/);
  assert.equal(result.localKeyAlternative, undefined);
  assert.equal(result.usdcFaucet, 'https://faucet.circle.com/');
  await assert.rejects(access(join(cwd, '.agentstreams/config.json')), { code: 'ENOENT' });
  await assert.rejects(run(cwd, 'simulate'), /Unknown command/);
  await assert.rejects(run(cwd, 'init', '--network', 'testnet', '--deploy'), error =>
    error.code === 1 && JSON.parse(error.stdout).status === 'OWNER_SETUP_REQUIRED');
});

test('wallet-only CLI refuses wallet key flags and signing-profile imports before reading files', async t => {
  const cwd = await project(t);
  const keyFlags = [
    ['init'], ['agent', 'setup'], ['fund', '0.1'], ['withdraw', 'all'],
    ['stream', 'top-up', '0.1'], ['guard', 'set', 'payment'], ['config', 'limits'],
  ];
  for (const args of keyFlags) {
    await assert.rejects(run(cwd, ...args, '--owner-key=private-fixture'), error =>
      /Unknown option '--owner-key'/.test(error.stderr) && !error.stderr.includes('private-fixture'));
  }
  await assert.rejects(run(cwd, 'earnings', 'claim', '--recipient-key', 'missing.json'), /Unknown option '--recipient-key'/);
  for (const args of [['init'], ['agent', 'setup']]) {
    await assert.rejects(run(cwd, ...args, '--deployment', 'missing.json'), /--deployment is not supported/);
  }
});

test('Cursor installation preserves other servers, supports dry-run/idempotence and refuses conflicts', async t => {
  const cwd = await project(t);
  await mkdir(join(cwd, '.cursor'));
  const before = JSON.stringify({ mcpServers: { existing: { command: 'existing-server' } }, other: true });
  await writeFile(join(cwd, '.cursor/mcp.json'), before);
  const dry = await installAgent('cursor', cwd, bin, { dryRun: true });
  assert.equal(dry.changedFiles.length, 2);
  assert.equal(await readFile(join(cwd, '.cursor/mcp.json'), 'utf8'), before);
  await installAgent('cursor', cwd, bin);
  const config = JSON.parse(await readFile(join(cwd, '.cursor/mcp.json'), 'utf8'));
  assert.equal(config.mcpServers.existing.command, 'existing-server');
  assert.equal(config.other, true);
  assert.equal(config.mcpServers.agentstreams.env, undefined);
  assert.equal((await installAgent('cursor', cwd, bin)).changedFiles.length, 0);
  config.mcpServers.agentstreams.command = 'different';
  await writeFile(join(cwd, '.cursor/mcp.json'), JSON.stringify(config));
  await assert.rejects(installAgent('cursor', cwd, bin), /CONFLICT/);
});

test('Codex installation preserves root settings, table scope, comments and existing AGENTS guidance', async t => {
  const cwd = await project(t);
  await mkdir(join(cwd, '.codex'));
  const before = '# operator comment\nsandbox_mode = "workspace-write"\napproval_policy = "on-request"\n\n[mcp_servers.other]\ncommand = "keep-me"\n';
  await writeFile(join(cwd, '.codex/config.toml'), before);
  await writeFile(join(cwd, 'AGENTS.md'), '# Existing\nKeep these instructions.\n');
  await installAgent('codex', cwd, bin);
  const text = await readFile(join(cwd, '.codex/config.toml'), 'utf8');
  assert.ok(text.startsWith(before));
  const config = parse(text);
  assert.equal(config.sandbox_mode, 'workspace-write');
  assert.equal(config.approval_policy, 'on-request');
  assert.equal(config.mcp_servers.other.command, 'keep-me');
  assert.equal(config.mcp_servers.agentstreams.command, process.execPath);
  const agents = await readFile(join(cwd, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith('# Existing\nKeep these instructions.\n'));
  assert.equal((await installAgent('codex', cwd, bin)).changedFiles.length, 0);
  await writeFile(join(cwd, '.codex/config.toml'), '[mcp_servers.agentstreams]\ncommand = "unmanaged"\n');
  await assert.rejects(installAgent('codex', cwd, bin), /CONFLICT/);
});

test('installers migrate managed AgentPay configuration and keep unrelated entries', async t => {
  const cwd = await project(t);
  const root = await realpath(cwd);
  const oldBin = join(root, 'bin/agentpay.mjs');
  await installAgent('cursor', cwd, bin);
  const cursorRule = join(cwd, '.cursor/rules/agentstreams.mdc');
  const legacy = (await readFile(cursorRule, 'utf8')).replaceAll('agentStreams', 'AgentPay').replaceAll('agentstreams_', 'agentpay_');
  await rm(cursorRule);
  await writeFile(join(cwd, '.cursor/rules/agentpay.mdc'), legacy);
  await writeFile(join(cwd, '.cursor/mcp.json'), JSON.stringify({ mcpServers: {
    agentpay: { command: process.execPath, args: [oldBin, 'mcp', '--project', root] },
    other: { command: 'keep-me' },
  } }));
  await installAgent('cursor', cwd, bin);
  const cursor = JSON.parse(await readFile(join(cwd, '.cursor/mcp.json')));
  assert.equal(cursor.mcpServers.agentpay, undefined);
  assert.equal(cursor.mcpServers.agentstreams.args[0], bin);
  assert.equal(cursor.mcpServers.other.command, 'keep-me');
  await assert.rejects(access(join(cwd, '.cursor/rules/agentpay.mdc')), { code: 'ENOENT' });

  await mkdir(join(cwd, '.codex'));
  const operator = '# keep this setting\nsandbox_mode = "workspace-write"\n';
  await writeFile(join(cwd, '.codex/config.toml'), operator +
    '# BEGIN AGENTPAY MCP\n[mcp_servers.agentpay]\ncommand = "old"\n# END AGENTPAY MCP\n');
  await writeFile(join(cwd, 'AGENTS.md'), '# Existing guidance\n<!-- BEGIN AGENTPAY -->\nOld rule\n<!-- END AGENTPAY -->\n');
  await installAgent('codex', cwd, bin);
  const text = await readFile(join(cwd, '.codex/config.toml'), 'utf8');
  assert.ok(text.startsWith(operator));
  assert.equal(parse(text).mcp_servers.agentpay, undefined);
  assert.equal(parse(text).mcp_servers.agentstreams.args[0], bin);
  const instructions = await readFile(join(cwd, 'AGENTS.md'), 'utf8');
  assert.match(instructions, /agentstreams_fetch/);
  assert.doesNotMatch(instructions, /Old rule/);
});

test('installers reject malformed configuration and symlink escapes without changing other files', async t => {
  const cwd = await project(t), outside = await project(t);
  await symlink(outside, join(cwd, '.codex'));
  await assert.rejects(installAgent('codex', cwd, bin), /SYMLINK_CONFIG_REFUSED/);
  await assert.rejects(access(join(outside, 'config.toml')), { code: 'ENOENT' });
  await mkdir(join(cwd, '.cursor'));
  await writeFile(join(cwd, '.cursor/mcp.json'), 'malformed');
  await assert.rejects(installAgent('cursor', cwd, bin));
  assert.equal(await readFile(join(cwd, '.cursor/mcp.json'), 'utf8'), 'malformed');
});

test('harness installers preserve an explicit private profile home without copying model secrets', async t => {
  const cwd = await project(t), home = join(cwd, 'private');
  await installAgent('cursor', cwd, bin, { home });
  const cursor = JSON.parse(await readFile(join(cwd, '.cursor/mcp.json')));
  assert.deepEqual(cursor.mcpServers.agentstreams.env, { AGENTSTREAMS_HOME: home });
  await installAgent('codex', cwd, bin, { home });
  const codex = parse(await readFile(join(cwd, '.codex/config.toml'), 'utf8'));
  assert.deepEqual({ ...codex.mcp_servers.agentstreams.env }, { AGENTSTREAMS_HOME: home });
});

test('real stdio MCP client lists strict tools and completes an offline session and denied payment', async t => {
  const cwd = await project(t);
  // Protocol test with an explicit in-memory gateway; never exposed by the product CLI.
  const entry = join(cwd, 'mcp-fixture.mjs');
  await writeFile(entry, `import { OfflineGateway } from ${JSON.stringify(new URL('../core/src/offline.mjs', import.meta.url).href)}; import { startMcp } from ${JSON.stringify(new URL('../cli/src/mcp.mjs', import.meta.url).href)}; await startMcp(new OfflineGateway());`);
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'pipe' });
  const client = new Client({ name: 'agentpay-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 4);
  assert.equal(tools.find(t => t.name === 'agentstreams_check').annotations.readOnlyHint, true);
  assert.equal(tools.find(t => t.name === 'agentstreams_open_stream').annotations.destructiveHint, true);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const checked = await call('agentstreams_check', { tier: 'basic' });
  assert.equal(checked.decision, 'OPEN');
  const session = await call('agentstreams_open_stream', { approvalId: checked.approvalId });
  assert.equal((await call('agentstreams_fetch', { tier: 'basic' })).status, 200);
  assert.equal((await call('agentstreams_check', { tier: 'basic' })).decision, 'CONTINUE');
  await call('agentstreams_close_stream', { sessionId: session.sessionId });
  assert.equal((await call('agentstreams_check', { tier: 'premium' })).decision, 'DENY');
  const malicious = await client.callTool({ name: 'agentstreams_check', arguments: { tier: 'basic', rate: '1' } });
  assert.equal(malicious.isError, true);
  const replay = await client.callTool({ name: 'agentstreams_open_stream', arguments: { approvalId: checked.approvalId } });
  assert.equal(replay.isError, true);
});
