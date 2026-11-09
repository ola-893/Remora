import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), 'agentpay-installed-')));
const prefix = join(root, 'global');
const project = join(root, 'project');
const out = resolve('.local/distribution');
const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
const { values } = parseArgs({ options: { registry: { type: 'boolean' }, 'fixture-port': { type: 'string' }, 'provision-owner': { type: 'string' }, 'vault-name': { type: 'string', default: 'agentstreams' }, 'agent-name': { type: 'string', default: 'research-agent' }, 'verify-public': { type: 'boolean' }, 'verify-near-ai': { type: 'boolean' } } });
let client;
try {
  await mkdir(project);
  const registryPackages = [];
  if (values.registry) {
    for (const item of manifest) {
      const metadata = JSON.parse((await exec('npm', ['view', `${item.name}@${item.version}`, '--json', '--registry=https://registry.npmjs.org/', '--prefer-online', '--fetch-retries=0'])).stdout);
      assert.equal(metadata.name, item.name);
      assert.equal(metadata.version, item.version);
      assert.equal(metadata.dist.integrity, item.integrity);
      assert.equal(metadata['dist-tags'].latest, item.version);
      registryPackages.push({ name: item.name, version: item.version, integrity: metadata.dist.integrity, tarball: metadata.dist.tarball, url: `https://www.npmjs.com/package/${item.name}` });
    }
  }
  // Registry mode installs only the CLI; its published dependency must pull core from npm.
  const sources = values.registry ? [manifest.filter(m => m.name.endsWith('/agentstreams-cli')).map(m => `${m.name}@${m.version}`)[0]] : manifest.map(m => join(out, m.filename));
  await exec('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', ...sources], { cwd: root });
  const bin = join(prefix, 'bin/agentstreams');
  const run = async args => JSON.parse((await exec(bin, args, { cwd: project, env: { ...process.env, NEAR_CONFIG: '/not-a-checkout', AGENTSTREAMS_HOME: join(root, 'private') } })).stdout);
  assert.equal((await exec(bin, ['--version'], { cwd: project })).stdout.trim(), manifest.find(m => m.name.endsWith('/agentstreams-cli')).version);
  const help = (await exec(bin, ['--help'], { cwd: project })).stdout;
  assert.match(help, values.registry ? /^(?:agentStreams|Remora CLI) / : /^Remora CLI /);
  assert.equal((await exec(join(prefix, 'bin/agentpay'), ['--version'], { cwd: project })).stdout.trim(), (await exec(bin, ['--version'], { cwd: project })).stdout.trim());
  assert.equal((await exec(join(prefix, 'bin/agentstream'), ['--version'], { cwd: project })).stdout.trim(), manifest.find(m => m.name.endsWith('/agentstreams-cli')).version);
  assert.match(help, /config limits/);
  assert.match(help, /agent run/);
  if (help.includes('wallet connect')) {
    assert.equal((await run(['wallet', 'show'])).connected, false);
    assert.equal((await run(['wallet', 'reconcile'])).resolved, true);
    assert.match(help, /withdraw USDC\|all/);
    const walletUi = join(prefix, 'lib/node_modules/@ola-893/agentstreams-cli/wallet-ui');
    const walletPage = await readFile(join(walletUi, 'index.html'), 'utf8');
    assert.match(walletPage, /Owner wallet/);
    if (help.startsWith('Remora CLI ')) {
      assert.match(walletPage, /<title>Remora · Owner wallet<\/title>/);
      for (const asset of ['remora-icon.svg', 'remora-lockup-color.svg']) {
        assert.match(await readFile(join(walletUi, asset), 'utf8'), /^<svg /);
      }
    }
  }
  assert.doesNotMatch(help, /agentpay demo|agentstreams simulate/);
  for (const command of ['unknown-command', 'demo', 'simulate']) await assert.rejects(run([command]), error => error.code === 1 && /Unknown command/.test(error.stderr));
  assert.equal((await run(['init', '--network', 'testnet'])).status, 'OWNER_SETUP_REQUIRED');
  assert.ok((await run(['install', 'mcp'])).mcpServers.agentstreams);
  const agent = await run(['agent', 'create', 'release-check']);
  const second = await run(['agent', 'create', 'release-peer']);
  assert.equal((await run(['agent', 'list'])).agents.length, 2);
  assert.equal((await run(['agent', 'show', 'release-peer'])).id, second.id);
  assert.equal((await run(['agent', 'use', 'release-check'])).id, agent.id);
  assert.equal((await run(['agent', 'setup', '--network', 'testnet'])).status, 'OWNER_SETUP_REQUIRED');
  assert.equal((await run(['install', 'mcp'])).mcpServers.agentstreams.args.at(-1), 'release-check');
  assert.equal((await run(['task', 'list'])).activities.filter(x => x.status === 'available').length, 6);
  assert.equal((await run(['task', 'enable', 'spot-trading', '--intents-agent-id', 'release-check'])).enabled, true);
  await assert.rejects(run(['task', 'run', 'spot-trading', '--from', 'nep141:wrap.near', '--to', 'nep141:usdc.near', '--amount-raw', '1', '--intents-agent-id', 'unexpected']), /not supported/);
  assert.equal((await run(['task', 'disable', 'spot-trading'])).enabled, false);
  await run(['guard', 'set', 'feed', '--stale-seconds', '20', '--feed-failures', '2']);
  await run(['guard', 'set', 'execution', '--assets', 'nep141:wrap.near,nep141:usdc.near', '--input-asset', 'nep141:wrap.near', '--max-input-raw', '1000', '--copy-input-raw', '1']);
  assert.equal((await run(['guard', 'show'])).feed.staleSeconds, 20);
  await run(['task', 'enable', 'spot-trading', '--paper-balances', 'nep141:wrap.near=1000']);
  await run(['inference', 'set', '--base-url', 'http://127.0.0.1:11434/v1', '--model', 'operator-selected-model']);
  assert.equal((await run(['inference', 'show'])).model, 'operator-selected-model');
  assert.equal((await run(['task', 'portfolio'])).portfolio.balances['nep141:wrap.near'], '1000');
  assert.equal((await run(['doctor'])).ok, true);
  assert.equal((await run(['status'])).lastRun, null);

  await run(['publish', 'set', '--recipient', 'release-seller.testnet', '--rate', '0.000001']);
  assert.equal((await run(['publish', 'start'])).enabled, true);
  assert.equal((await run(['publish', 'status'])).publication.enabled, true);
  assert.deepEqual((await run(['publish', 'history'])).actions, []);
  assert.deepEqual((await run(['earnings', 'show'])).vaults, []);
  await assert.rejects(run(['earnings', 'claim']), /earnings claim --from/);
  assert.equal((await run(['publish', 'stop'])).enabled, false);
  assert.deepEqual((await run(['discover', '--activity', 'spot-trading'])).listings, []);
  assert.equal((await run(['copy', 'status'])).subscription, null);
  assert.deepEqual((await run(['copy', 'history'])).history, []);
  assert.deepEqual((await run(['copy', 'pending'])).actions, []);
  for (const args of [['mode', 'observe'], ['approve', 'missing'], ['reject', 'missing'], ['pause'], ['stop']]) {
    await assert.rejects(run(['copy', ...args]), /No copy subscription/);
  }
  await assert.rejects(run(['copy', 'resume']), /Resolve or close/);
  await assert.rejects(run(['copy', agent.id]), /another agent/);
  assert.equal((await run(['agent', 'run', '--once'])).status, 'idle');
  assert.equal((await run(['status'])).pendingTrade, false);
  assert.equal((await run(['reconcile'])).resolved, true);
  assert.equal((await run(['doctor'])).setup.configured, false);
  // Import the installed UI module, not repository code; no browser is opened by this check.
  const { startUi } = await import(pathToFileURL(join(prefix, 'lib/node_modules/@ola-893/agentstreams-cli/src/ui.mjs')).href);
  const ui = await startUi();
  try {
    const page = await (await fetch(ui.url)).text();
    assert.match(page, /__AGENTSTREAMS_RECORDED_ONLY__/);
    assert.match(page, values.registry ? /<title>(?:agentStreams|Remora)/ : /<title>Remora · Payment evidence<\/title>/);
    assert.equal((await fetch(ui.url + '/agentstreams.svg')).status, 200);
    assert.equal((await (await fetch(ui.url + '/near/latest.json')).json()).network, 'testnet');
    assert.equal((await fetch(ui.url + '/api/near/state')).status, 404);
  } finally { await ui.close(); }
  // Check the installed runtime does not depend on the repository's near/ directory.
  const probe = join(prefix, 'lib/node_modules/@ola-893/agentstreams-cli', '.verify-near.mjs');
  await writeFile(probe, `await import('@ola-893/agentstreams-core/near'); console.log('ok');`);
  assert.equal((await exec(process.execPath, [probe], { cwd: project })).stdout.trim(), 'ok');
  const report = { verifiedAt: new Date().toISOString(), installedOutsideCheckout: true, installedFrom: values.registry ? 'npm registry; CLI only with transitive core dependency' : 'local tarballs', packages: values.registry ? registryPackages : manifest.map(({ name, version, integrity }) => ({ name, version, integrity })), checks: ['operational command help', 'removed demo/simulate rejected', 'cold testnet setup instructions', 'generic MCP config', 'installed recorded UI HTTP', 'portable native runtime imports', 'named agent isolation', 'copy, guard, task and publisher command routing', 'paper portfolio and named inference without vault setup'], browserVisualQA: false, publishedToNpm: Boolean(values.registry) };
  if (values['verify-near-ai']) {
    assert.match(help, /--provider near-ai/);
    const catalog = await run(['inference', 'models', '--provider', 'near-ai']);
    assert.equal(catalog.baseUrl, 'https://cloud-api.near.ai/v1');
    assert.equal(catalog.models.length, catalog.total);
    assert.ok(catalog.models.some(m => m.agentCompatible));
    assert.equal(catalog.attestationVerified, false);
    report.nearAiCatalog = { provider: catalog.provider, catalogUrl: catalog.catalogUrl, fetchedAt: catalog.fetchedAt, total: catalog.total, agentCompatible: catalog.models.filter(m => m.agentCompatible).length, attestationVerified: false, authenticatedInferenceTested: false };
    report.checks.push('installed NEAR AI public model discovery; no key, wallet or inference charge');
  }
  if (values['verify-public']) {
    report.publicReplayVerification = await run(['verify', '--json']);
    report.checks.push('read-only public RPC replay verification: deployed WASM, final receipts and settled stream');
  }
  if (values['provision-owner']) {
    if (!/^\d+$/.test(values['fixture-port'] ?? '')) throw new Error('Fresh provisioning needs --fixture-port.');
    const liveProject = join(root, 'live-project');
    await mkdir(liveProject);
    const liveRun = async args => {
      const command = exec(bin, args, { cwd: liveProject, env: { ...process.env, AGENTSTREAMS_HOME: join(root, 'private') } });
      command.child.stderr.pipe(process.stderr, { end: false });
      return JSON.parse((await command).stdout);
    };
    await liveRun(['wallet', 'connect', '--network', 'testnet', '--owner-id', values['provision-owner']]);
    const setupArgs = ['init', '--network', 'testnet', '--owner-id', values['provision-owner'], '--vault-name', values['vault-name'], '--agent-name', values['agent-name'], '--service', `http://127.0.0.1:${values['fixture-port']}`];
    const preflight = await liveRun(setupArgs);
    assert.equal(preflight.readOnly, true);
    assert.equal(preflight.readyToDeploy, true);
    const setup = await liveRun([...setupArgs, '--deploy']);
    assert.equal(setup.status, 'DEPLOYED');
    assert.equal(setup.paymentsEnabled, false);
    assert.equal(setup.ownerPrivateKeyStored, false);
    const funding = await liveRun(['fund', '0.1']);
    assert.equal(funding.signing, 'browser-wallet');
    const before = await liveRun(['doctor']);
    assert.equal(before.paymentsEnabled, false);
    assert.equal(before.activeSession, null);
    let provider;
    if (values['fixture-port']) {
      const { createRequire } = await import('node:module');
      const installed = createRequire(join(prefix, 'lib/node_modules/@ola-893/agentstreams-cli/package.json'));
      const { startProvider } = await import(pathToFileURL(installed.resolve('@ola-893/agentstreams-core/internal-provider')));
      const source = JSON.parse(await readFile(join(liveProject, '.agentstreams/config.json'), 'utf8'));
      const config = JSON.parse(await readFile(join(root, 'private/profiles', source.profileId, 'deployment.json'), 'utf8'));
      provider = await startProvider(config);
    }
    let result;
    try {
      await liveRun(['config', 'set', '--max-5xx', '3', '--idle-timeout', '120']);
      assert.equal((await liveRun(['config', 'show'])).runtimePolicy.maxConsecutive5xx, 3);
      await liveRun(['inference', 'set', '--base-url', 'http://localhost:11434/v1', '--model', 'operator-selected-model']);
      assert.equal((await liveRun(['inference', 'show'])).model, 'operator-selected-model');
      await assert.rejects(liveRun(['stream', 'open', '--tier', 'basic']), error => error.code === 1 && /PAYMENTS_DISABLED/.test(error.stderr));
      await liveRun(['payments', '--enable']);
      const opened = await liveRun(['stream', 'open', '--tier', 'basic']);
      assert.ok(opened.receipt.hash);
      for (let i = 0; i < 3; i++) assert.equal((await liveRun(['request', '--tier', 'basic'])).status, 200);
      const continued = await liveRun(['stream', 'check', '--tier', 'basic']);
      assert.equal(continued.decision, 'CONTINUE');
      assert.equal(continued.sessionId, opened.sessionId);
      client = new Client({ name: 'installed-agentpay-test', version: '1.0.0' });
      await client.connect(new StdioClientTransport({ command: bin, args: ['mcp', '--project', liveProject], env: { ...process.env, AGENTSTREAMS_HOME: join(root, 'private') }, stderr: 'pipe', cwd: liveProject }));
      assert.equal((await client.listTools()).tools.length, 4);
      const fetched = await client.callTool({ name: 'agentstreams_fetch', arguments: { tier: 'basic', query: 'q=verification' } });
      assert.equal(fetched.isError, undefined);
      assert.equal(JSON.parse(fetched.content[0].text).status, 200);
      const closeTool = await client.callTool({ name: 'agentstreams_close_stream', arguments: { sessionId: opened.sessionId } });
      assert.equal(closeTool.isError, undefined);
      const closed = JSON.parse(closeTool.content[0].text);
      await client.close(); client = null;
      assert.equal((await liveRun(['stream', 'status'])).vault.active_session, null);
      const denied = await liveRun(['stream', 'check', '--tier', 'premium']);
      assert.equal(denied.decision, 'DENY');
      result = { opened, continued, closed, denied, requestsReusingSession: 4 };
    } finally {
      await client?.close(); client = null;
      try { await liveRun(['stream', 'close']); } finally { await provider?.close(); }
    }
    await liveRun(['payments', '--disable']);
    assert.equal(result.requestsReusingSession, 4);
    assert.equal(result.denied.decision, 'DENY');
    assert.ok(result.opened.receipt.hash);
    const stream = result.closed.receipt.value;
    assert.equal(BigInt(stream.earned) + BigInt(stream.refunded), BigInt(stream.deposit));
    const after = await liveRun(['doctor']);
    assert.equal(after.activeSession, null);
    assert.equal(after.pendingIntent, false);
    assert.equal(BigInt(before.availableUSDC) - BigInt(after.availableUSDC), BigInt(stream.earned));
    assert.equal(BigInt(after.spentUSDC) - BigInt(before.spentUSDC), BigInt(stream.earned));
    const reconciled = await liveRun(['reconcile']);
    assert.equal(reconciled.reason, 'NO_PENDING_INTENT');
    const liveReport = { verifiedAt: new Date().toISOString(), installedOutsideCheckout: true, installedFrom: report.installedFrom, setup, funding, before, result, after, reconciled, publishedToNpm: Boolean(values.registry) };
    await writeFile(join(out, values.registry ? 'npm-live-verification.json' : 'live-verification.json'), JSON.stringify(liveReport, null, 2) + '\n');
    report.checks.push('installed operational CLI: configuration, OPEN, cross-process request reuse, MCP request/CLOSE, DENY');
    report.live = { network: 'testnet', vaultId: before.vaultId, openTransaction: result.opened.receipt.hash, premiumDenied: result.denied.reason, activeSessionAfter: after.activeSession, pendingIntentAfter: after.pendingIntent };
  }
  report.verifiedAt = new Date().toISOString();
  await writeFile(join(out, values.registry ? 'npm-verification.json' : 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  await client?.close();
  if (values['provision-owner']) process.stderr.write(`Private setup/recovery files retained at ${root}\n`);
  else await rm(root, { recursive: true, force: true });
}
