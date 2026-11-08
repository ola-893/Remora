// Explicit public-testnet acceptance run. Uses only valueless test assets.
// Installs packed artifacts outside the checkout and creates a fresh private profile.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, access } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

const { values: v } = parseArgs({ options: {
  'owner-id': { type: 'string' }, recipient: { type: 'string' },
  'vault-name': { type: 'string', default: 'review1107' }, 'agent-name': { type: 'string', default: 'review-agent1107' },
  repository: { type: 'string', default: '.' }, model: { type: 'string', default: 'hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_M' },
  directory: { type: 'string', default: '.local/showcase' }, resume: { type: 'boolean' },
} });
for (const key of ['owner-id', 'recipient']) if (!v[key]) throw new Error(`Provide --${key} with a NEAR testnet account ID.`);
const root = fileURLToPath(new URL('../', import.meta.url)), directory = resolve(v.directory), project = join(directory, 'project'), home = join(directory, 'private');
await mkdir(project, { recursive: true }); await mkdir(home, { recursive: true, mode: 0o700 });
const controlPath = join(directory, 'session.json');
let control;
try { control = JSON.parse(await readFile(controlPath)); if (!v.resume) throw new Error('Existing rehearsal: inspect it and use --resume rather than replacing credentials.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; control = { install: await mkdtemp(join(tmpdir(), 'agentpay-showcase-install-')), project, home }; }
await writeFile(controlPath, JSON.stringify(control, null, 2), { mode: 0o600 });
const execute = promisify(execFile), env = { ...process.env, AGENTSTREAMS_HOME: home };
process.env.AGENTSTREAMS_HOME = home;
for (const key of Object.keys(env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_KEY)$/.test(key)) delete env[key];
const cli = join(control.install, 'node_modules/@ola-893/agentstreams-cli/bin/agentstreams.mjs');
function jsonObjects(text) {
  let start = 0, depth = 0, quoted = false, escaped = false; const out = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === '{' || c === '[') { if (!depth) start = i; depth++; }
    else if (c === '}' || c === ']') { if (--depth === 0) out.push(JSON.parse(text.slice(start, i + 1))); }
  }
  assert.equal(depth, 0); return out;
}
const cliEvents = async (...args) => {
  try {
    const command = execute(process.execPath, [cli, ...args, '--project', project], { env, cwd: project, maxBuffer: 8000000, timeout: 3600000 });
    command.child.stderr.pipe(process.stderr, { end: false });
    return jsonObjects((await command).stdout);
  }
  catch (error) {
    if (args[0] === 'agent' && error.stdout) await writeFile(join(directory, 'interrupted-agent-events.json'), error.stdout, { mode: 0o600 });
    if (error.stdout) { const output = jsonObjects(error.stdout); if (output[0]?.readyToDeploy === false) return output; }
    const diagnostic = error.stderr?.split('\n').filter(line => !line.includes('"ownerWalletApproval"')).join('\n').trim();
    throw new Error(diagnostic || `CLI operation failed: ${args.slice(0, 2).join(' ')}`);
  }
};
const cliOne = async (...args) => (await cliEvents(...args))[0];
const { version } = JSON.parse(await readFile(join(root, 'packages/cli/package.json'), 'utf8'));
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), version, network: 'testnet', newProfile: true, humanUsabilityTest: false, modelApiKeyUsed: false, checks: {}, failedContractTransactions: [] };
if (v.resume) {
  try {
    const previous = JSON.parse(await readFile(join(root, 'docs/evidence/near/repository-showcase-verification.json')));
    if (previous.setup?.vaultId === `${v['vault-name']}.${v['owner-id']}`) {
      report.setup = previous.setup; report.checks.freshDeployment = true; report.checks.coldSetupGuidance = previous.checks.coldSetupGuidance;
      report.resumedFreshSetup = true;
    }
  } catch {}
}
const run = { schemaVersion: 1, runId: randomUUID(), network: 'testnet', agentMode: 'mixed', recordedAt: new Date().toISOString(), serviceKind: 'repository-analysis', receipts: [], events: [], results: {}, simulation: false };
function event(type, data = {}) {
  const previousHash = run.events.at(-1)?.eventHash || '0'.repeat(64);
  const body = { ...data, type, runId: run.runId, sequence: run.events.length + 1, at: new Date().toISOString(), previousHash };
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
  run.events.push({ ...body, eventHash: createHash('sha256').update(canonical(body)).digest('hex') });
}
function receipt(value, reason) {
  if (!value || run.receipts.some(r => r.hash === value.hash)) return;
  run.receipts.push(value);
  event('transaction', { ...value, action: value.value?.closed_at == null ? 'OPEN' : 'CLOSE', reason });
  if (value.value?.closed_at != null) { event('settled', { stream: value.value }); run.results[value.value.session_id] = { sessionId: value.value.session_id, providerPayment: 'claimable' }; }
}
function request(result, actor) {
  for (const payment of result.payment?.events || []) {
    if (payment.decision) event('policy', { decision: payment.decision, reason: payment.reason, sessionId: payment.sessionId, actor });
    if (payment.receipt) receipt(payment.receipt, payment.reason);
  }
  let body; try { body = JSON.parse(result.untrustedContent); } catch { body = { error: 'NON_JSON_RESPONSE' }; }
  event('request', { status: result.status, count: body.request, sessionId: body.session_id, body, actor });
}
let provider, reader, initialized = false, passed = false;
try {
  console.log('Installing the two packed candidates outside the checkout.');
  await execute('npm', ['install', '--prefix', control.install, '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(directory, 'npm-cache'), join(root, `.local/distribution/ola-893-agentstreams-core-${version}.tgz`), join(root, `.local/distribution/ola-893-agentstreams-cli-${version}.tgz`)], { env, maxBuffer: 1000000, timeout: 180000 });
  assert.equal((await execute(process.execPath, [cli, '--version'], { env })).stdout.trim(), version);
  const installed = createRequire(join(control.install, 'node_modules/@ola-893/agentstreams-cli/package.json'));
  const { NearAgentPayClient } = await import(pathToFileURL(join(control.install, 'node_modules/@ola-893/agentstreams-core/src/near-gateway.mjs')));
  const { readConfig, readKey } = await import(pathToFileURL(installed.resolve('@ola-893/agentstreams-core/internal-config')));
  report.checks.cleanInstall = true;
  console.log('Checking cold setup and connecting the owner wallet.');
  let exists = false; try { await access(join(project, '.agentstreams/config.json')); exists = true; } catch {}
  const portServer = createServer(); await new Promise(done => portServer.listen(0, '127.0.0.1', done)); const port = portServer.address().port; await new Promise(done => portServer.close(done));
  const serviceUrl = `http://127.0.0.1:${port}`;
  const wallet = await cliOne('wallet', 'show');
  if (!exists && !wallet.accountId) {
    const cold = await cliOne('init', '--network', 'testnet'); assert.equal(cold.status, 'OWNER_SETUP_REQUIRED'); report.checks.coldSetupGuidance = true;
  }
  if (wallet.accountId !== v['owner-id']) {
    await cliOne('wallet', 'connect', '--network', 'testnet', '--owner-id', v['owner-id']);
  }
  if (!exists) {
    const args = ['init', '--network', 'testnet', '--owner-id', v['owner-id'], '--recipient', v.recipient, '--vault-name', v['vault-name'], '--agent-name', v['agent-name'], '--service', serviceUrl];
    const preflight = await cliOne(...args); report.preflight = preflight;
    if (!preflight.readyToDeploy) throw new Error('TESTNET_PREFLIGHT_FAILED: ' + JSON.stringify(preflight.checks));
    const setup = await cliOne(...args, '--deploy');
    report.setup = { status: setup.status, vaultId: setup.vaultId, agentId: setup.agentId, recipientId: setup.recipientId, transactions: setup.transactions };
    report.checks.freshDeployment = true;
  }
  initialized = true;
  const configRef = JSON.parse(await readFile(join(project, '.agentstreams/config.json')));
  const configPath = join(home, 'profiles', configRef.profileId, 'deployment.json');
  let config = await readConfig(configPath);
  run.vaultId = config.vaultId;
  reader = new NearAgentPayClient({ vaultId: config.vaultId, rpcUrl: config.rpcUrl });
  const priorClaim = BigInt(await reader.getClaim(v.recipient));
  if (BigInt((await reader.getVault()).available) < 10000n) report.funding = await cliOne('fund', '0.05');
  report.financialConfiguration = await cliOne('config', 'limits', '--budget', '0.05', '--max-stream', '0.01', '--max-rate', '0.000100', '--max-duration', '1000');
  await cliOne('config', 'set', '--max-5xx', '3', '--max-health-failures', '2', '--max-transport-errors', '2', '--idle-timeout', '180', '--max-requests', '20', '--poll-seconds', '10', '--reuse', 'true', '--close-on-exit', 'true', '--failure-cooldown', '1');
  await cliOne('service', 'set', '--url', serviceUrl);
  await cliOne('inference', 'set', '--base-url', 'http://127.0.0.1:11434/v1', '--model', v.model, '--max-steps', '8', '--max-output-tokens', '1024', '--timeout-seconds', '300');
  report.before = await cliOne('doctor'); assert.equal(report.before.activeSession, null);
  config = await readConfig(configPath);
  run.runtimePolicy = config.runtimePolicy;
  run.service = { source: 'Repository analysis', repositoryName: basename(resolve(v.repository)), serviceUrl, pricing: { basicRateRawPerSecond: '10', premiumRateRawPerSecond: '200', leaseSeconds: 1000 }, scope: 'Local model and operator-selected local service; public NEAR testnet settlement. Operator separately injects failures and tests contract rejection.' };
  run.agent = { model: v.model, provider: 'Ollama local', apiKeyUsed: false };
  const publicConfig = Object.fromEntries(Object.entries(config).filter(([key]) => !/key/i.test(key)));
  const publicConfigPath = join(directory, 'provider.json'); await writeFile(publicConfigPath, JSON.stringify(publicConfig, null, 2));
  provider = spawn(process.execPath, [cli, 'service', 'serve', '--deployment', publicConfigPath, '--repository', resolve(v.repository), '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serviceLog = ''; provider.stdout.on('data', data => { serviceLog += data; }); provider.stderr.on('data', data => { serviceLog += data; });
  for (let i = 0; ; i++) {
    try { if ((await fetch(serviceUrl + '/health')).ok) break; } catch {}
    if (provider.exitCode !== null || i > 100) throw new Error('SERVICE_START_FAILED: ' + serviceLog);
    await new Promise(done => setTimeout(done, 100));
  }
  assert.equal((await fetch(serviceUrl + '/research')).status, 402);
  report.checks.unpaidRequestRequiresPayment = true;
  event('started', { agentMode: 'mixed', model: v.model, message: run.service.scope });
  const premium = await cliOne('stream', 'check', '--tier', 'premium');
  assert.equal(premium.decision, 'DENY'); assert.equal(premium.reason, 'RATE_LIMIT');
  event('policy', { decision: premium.decision, reason: premium.reason, quote: premium.quote, actor: 'operator' });
  report.checks.expensiveTierDeniedByWorker = true;
  // Bypass the worker deliberately in this operator-owned test: correctly signed
  // disallowed permits must still fail in the contract, with final public receipts.
  const agentKey = await readKey(config.agentKeyFile), policyKey = await readKey(config.policyKeyFile);
  const signing = new NearAgentPayClient({ vaultId: config.vaultId, accountId: config.agentId, privateKey: agentKey.privateKey, rpcUrl: config.rpcUrl });
  const { KeyPair, actions } = await import(pathToFileURL(installed.resolve('near-api-js')));
  const { permitBytes } = await import('../near/lib/permit.mjs');
  for (const [reason, overrides] of [['RATE_LIMIT', { rate: '101', duration_seconds: 1 }], ['RECIPIENT_DENIED', { recipient_id: 'unapproved.testnet' }]]) {
    const state = await reader.getVault();
    const permit = { domain: 'agentpay.near.v1', vault_id: config.vaultId, agent_id: config.agentId, action: 'OPEN', session_id: randomUUID(), recipient_id: config.recipientId, rate: '10', duration_seconds: 1000, quote_hash: 'a'.repeat(64), nonce: state.next_nonce, expires_at: String(Number(state.now) + 90), ...overrides };
    const signature = Buffer.from(KeyPair.fromString(policyKey.privateKey).sign(permitBytes(permit)).signature).toString('base64');
    const raw = await signing.account.signAndSendTransaction({ receiverId: config.vaultId, actions: [actions.functionCall('open_stream', { permit, signature }, 100000000000000n, 0n)], waitUntil: 'FINAL', throwOnFailure: false, retries: 0 });
    assert.ok(raw.status.Failure); assert.match(JSON.stringify(raw.status), new RegExp(reason));
    const rejected = { reason, hash: raw.transaction.hash, status: raw.status, explorerUrl: `https://testnet.nearblocks.io/txns/${raw.transaction.hash}` };
    report.failedContractTransactions.push(rejected);
    event('policy', { decision: 'DENY', reason, enforcement: 'NEAR contract: correctly policy-signed invalid proposal rejected', failedTransactionHash: rejected.hash, actor: 'operator' });
    assert.equal((await reader.getVault()).active_session, null);
  }
  report.checks.contractRejectsSignedOverRateAndUnauthorizedRecipient = true;
  await cliOne('payments', '--enable');
  console.log('Running actual local-model inference through the installed CLI.');
  const agentEvents = await cliEvents('agent', 'run', '--prompt', 'Analyze the configured repository using the paid API. Call agentstreams_fetch with tier basic and query view=overview, then call it again with query view=findings&severity=medium. Use the actual responses to identify up to three file-and-line review priorities and explain the suggested fixes. Make exactly those two requests sequentially. Do not explicitly open or close streams; the host handles that. Do not invent findings. Findings are heuristics, not confirmed vulnerabilities.');
  report.agentEvents = agentEvents;
  for (const item of agentEvents) {
    if (item.type === 'tool') { event('model', { tool: item.name, actor: 'model' }); if (item.name === 'agentstreams_fetch') request(item.result, 'model'); }
    if (item.type === 'answer') event('summary', { text: item.text, actor: 'model' });
    if (item.receipt) receipt(item.receipt, item.reason);
  }
  const successes = agentEvents.filter(e => e.type === 'tool' && e.name === 'agentstreams_fetch' && e.result.status === 200);
  assert.equal(successes.length, 2);
  const bodies = successes.map(e => JSON.parse(e.result.untrustedContent));
  assert.equal(bodies[0].session_id, bodies[1].session_id);
  assert.equal(bodies[0].source, 'agentStreams repository analysis');
  assert.ok(bodies.some(b => b.findings?.length));
  const openCount = successes.flatMap(e => e.result.payment.events).filter(e => e.receipt?.value.closed_at === null).length;
  assert.equal(openCount, 1); assert.ok(agentEvents.some(e => e.type === 'answer'));
  event('reuse_verified', { successfulRequests: 2, extraPaymentTransactions: 0, sessionId: bodies[0].session_id, actor: 'model' });
  report.checks.localModelUsefulWorkAndReuse = true;
  console.log('Testing configured three-failure closure through separate CLI invocations.');
  request(await cliOne('request', '--tier', 'basic', '--query', 'view=overview'), 'operator');
  provider.kill('SIGUSR1'); await new Promise(done => setTimeout(done, 100));
  event('outage', { injected: true, message: 'Operator injected paid-request HTTP 503s. Health probes remain healthy.', actor: 'operator' });
  for (let i = 0; i < 3; i++) {
    const failed = await cliOne('request', '--tier', 'basic', '--query', 'view=overview'); request(failed, 'operator');
    assert.equal(failed.status, 503);
    assert.equal(Boolean((await reader.getVault()).active_session), i < 2);
    if (i === 2) assert.ok(failed.payment.events.some(e => e.reason === 'SERVICE_5XX_LIMIT' && e.receipt));
  }
  report.checks.three503sCloseStream = true;
  report.after = await cliOne('doctor'); assert.equal(report.after.activeSession, null); assert.equal(report.after.pendingIntent, false);
  const earned = run.events.filter(e => e.type === 'settled').reduce((total, e) => total + BigInt(e.stream.earned), 0n);
  assert.equal(BigInt(report.before.availableUSDC) - BigInt(report.after.availableUSDC), earned);
  report.checks.escrowConserved = true;
  if ((await cliOne('wallet', 'show')).accountId !== v.recipient) await cliOne('wallet', 'connect', '--network', 'testnet', '--owner-id', v.recipient);
  const { claimVault } = await import(pathToFileURL(join(dirname(cli), '../src/owner-actions.mjs')));
  const balanceBefore = BigInt(await reader.tokenBalance(v.recipient, config.tokenId));
  assert.equal(BigInt(await reader.getClaim(v.recipient)), priorClaim + earned);
  run.providerPayout = await claimVault(config);
  assert.equal(run.providerPayout?.value, true);
  assert.equal(BigInt(await reader.tokenBalance(v.recipient, config.tokenId)) - balanceBefore, priorClaim + earned);
  report.payout = { recipientId: v.recipient, earnedRawUSDC: earned.toString(), priorClaimRawUSDC: priorClaim.toString(), totalPaidRawUSDC: (priorClaim + earned).toString(), hash: run.providerPayout.hash, explorerUrl: run.providerPayout.explorerUrl };
  report.checks.separateProviderReceivedUSDC = true;
  run.finalVault = await reader.getVault(); run.ok = true; event('finished', { ok: true });
  const { verifyRun } = await import(pathToFileURL(installed.resolve('@ola-893/agentstreams-core/internal-evidence-audit')));
  report.journalVerification = verifyRun(run);
  const output = join(root, 'docs/evidence/near/repository-showcase-testnet.json');
  await writeFile(output, JSON.stringify(run, null, 2) + '\n');
  report.publicVerification = await cliOne('verify', '--run', output);
  report.checks.finalReceiptsAndDeployedWasmVerified = true;
  // A private convenience file for this machine's recording. Never packaged.
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(join(directory, 'env.sh'), `export PATH=${quote(dirname(process.execPath))}:"$PATH"\nexport AGENTSTREAMS_HOME=${quote(home)}\nagentstreams() { ${quote(process.execPath)} ${quote(cli)} "$@" --project ${quote(project)}; }\n`, { mode: 0o600 });
  passed = true;
} catch (error) { report.error = error.message; console.error('Acceptance stopped:', error.message); process.exitCode = 1; }
finally {
  if (initialized) {
    try { await cliOne('stream', 'close'); report.cleanup = await cliOne('payments', '--disable'); report.finalDoctor = await cliOne('doctor'); assert.equal(report.finalDoctor.activeSession, null); assert.equal(report.finalDoctor.pendingIntent, false); }
    catch (error) { passed = false; report.cleanupError = error.message; process.exitCode = 1; }
  }
  provider?.kill('SIGTERM');
  report.passed = passed; report.finishedAt = new Date().toISOString();
  const text = JSON.stringify(report, null, 2) + '\n'; assert.doesNotMatch(text, /private_key|ed25519:[1-9A-HJ-NP-Za-km-z]{80,100}/);
  await writeFile(join(root, 'docs/evidence/near/repository-showcase-verification.json'), text);
  console.log(JSON.stringify({ passed, checks: report.checks, error: report.error, evidence: 'docs/evidence/near/repository-showcase-verification.json' }));
}
