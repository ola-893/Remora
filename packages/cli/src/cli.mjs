import { promptActivity, strategyActivities } from './strategy-actions.mjs';
import { copyFlags, copyPositionals, runCopyCommand } from './copy-commands.mjs';
import { agentSetupState, readAgentState, selectedAgent } from './agents.mjs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { projectPath, readProject, liveProfile, gatewayFor, setPayments } from './config.mjs';
import { showSettings, setRuntime, setService, setInference, setLimits, reconcileLimits, usdc, durationSeconds } from './settings.mjs';
import { readInferenceProfile } from './inference-profile.mjs';
import { assertInferenceModel, inferenceConfig } from './inference.mjs';
import { renderHelp } from './brand.mjs';

const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const help = `Named agents and copy trading:
  agentstreams agent create NAME | list | use NAME | show [NAME]
  agentstreams wallet connect --network testnet [--owner-id ACCOUNT]
                                                Connect an owner or publisher wallet
  agentstreams wallet show | disconnect | reconcile [--hash HASH | --cancel]
  agentstreams agent setup --network testnet [--deploy] [--resume]
  agentstreams agent run [--once]                 Run publication and/or follow a subscribed feed
  agentstreams task list | enable ACTIVITY | disable ACTIVITY
  agentstreams task enable spot-trading --paper-balances ASSET=RAW[,ASSET=RAW]
  agentstreams task enable ACTIVITY            Use the owner wallet on NEAR testnet
  agentstreams task run ACTIVITY --action-json JSON [--execute]
  agentstreams task run limit-orders --action-json '{"pool":"TOKEN_X|TOKEN_Y|FEE","operation":"place","sellToken":"TOKEN_Y","point":123,"amount":"RAW"}' [--execute]
  agentstreams task run limit-orders --action-json '{"pool":"TOKEN_X|TOKEN_Y|FEE","operation":"cancel","placement":"PLACEMENT_ACTION_ID"}' [--execute]
  agentstreams task deposit-range --action-json '{"pool":"TOKEN_X|TOKEN_Y|FEE","token":"TOKEN_Y","amount":"RAW"}' [--execute]
  agentstreams guard set execution --activity ACTIVITY --targets TARGETS --max-inputs ASSET=RAW
  agentstreams task portfolio               Virtual holdings and recent 1Click paper fills
  agentstreams task enable spot-trading --intents-agent-id ID [--live] [--confidential]
  agentstreams task run spot-trading --from ASSET --to ASSET --amount-raw UNITS [--execute]
  agentstreams publish set --url ORIGIN --rate USDC_PER_SECOND --recipient SELLER.testnet [--duration SECONDS]
                                                Add --public-history for daily action counts delayed by at least 24 hours
  agentstreams publish start | status | history | stop
  agentstreams signal list | show ID | cancel ID | reconcile ID --hash HASH
  agentstreams publish register [--registry CONTRACT_ID]
  agentstreams registry deploy | show
  agentstreams registry set --registry CONTRACT_ID
  agentstreams outlayer key --api-key             Configure the compute key through a hidden prompt
  agentstreams outlayer show
  agentstreams earnings show | claim --from VAULT
                                                Approve the claim in the publisher's recipient wallet
  agentstreams discover [--activity ACTIVITY] [--id PUBLISHER --url ORIGIN]
  agentstreams copy PUBLISHER [--url ORIGIN]      Preview a signed offer for free
  agentstreams copy start PUBLISHER [--url ORIGIN]
  agentstreams copy mode observe|approve|auto|veto [--veto-seconds N]
  agentstreams copy pending | approve ACTION | reject ACTION | block ACTION
  agentstreams copy pause | resume | stop | status | history
  agentstreams guard set payment --budget USDC --max-stream USDC --max-rate USDC_PER_SECOND --recipient SELLER.testnet
                                                Approve on-chain limits in the browser wallet
  agentstreams guard set payment --max-5xx 3 --max-health-failures 2 --reuse true
  agentstreams guard set execution --activity spot-trading --assets A,B --input-asset A --max-input-raw UNITS --copy-input-raw UNITS
  agentstreams guard set feed --stale-seconds 45 --feed-failures 3
  agentstreams guard show
  agentstreams grant create --transactions 10 --hours 6 --activities portfolio-rebalance
  agentstreams grant create --transactions 10 --hours 6 --activities staking-moves,liquidity-ranges,yield-reallocation,limit-orders --staking-pool lst.ref-dev.testnet --tokens wrap.testnet
  agentstreams grant show | reconcile | revoke
  agentstreams grant prepare --activity ACTIVITY --token TOKEN [--balance-raw RAW]
                                                One owner signature funds a separate execution account.
                                                The agent signs the granted methods from that account.
                                                On-chain limit: the execution account balance. A leaked key can spend it.
                                                CLI-only limits: transaction count, expiry, receivers and methods.
                                                Exhaustion, expiry and revoke sweep funds back before deleting the account.
  agentstreams fund USDC                         Owner approves funding in the browser wallet
  agentstreams withdraw USDC|all [--agent NAME]   Return available vault USDC to its owner
  agentstreams agent withdraw USDC|all             Same withdrawal for the selected agent
  agentstreams balance | status
  Paper trading uses signed NEAR Intents 1Click dry quotes. Subscription escrow uses NEAR testnet.

Setup (NEAR testnet, funded owner account required):
  agentstreams wallet connect --network testnet
  agentstreams init --network testnet --deploy   Approve each setup transaction in the browser wallet

Configure payment and service guardrails:
  agentstreams config show
  agentstreams config limits --budget 0.10 --max-stream 0.01 --max-rate 0.0001 --max-duration 1000
  agentstreams config set --max-5xx 3 --max-transport-errors 2 --max-health-failures 2 --idle-timeout 60 --max-requests 100 --reuse true --poll-seconds 10 --close-on-exit true
  agentstreams config reconcile                  Reconcile an uncertain owner policy update
  agentstreams service set --url https://api.example.com --request-path /research --health-path /health --quote-path /quote --tiers basic,premium
  agentstreams service serve --repository ./YOUR_REPOSITORY --port 5380
                                              Serve actual repository analysis using this profile's public vault settings
                                              Optional --deployment /path/public-service.json; no signing keys are read
  agentstreams payments --enable|--disable       Disabling OPEN preserves closure

Connect inference, then run an agent:
  agentstreams inference set --base-url http://localhost:11434/v1 --model YOUR_MODEL
                                              Optional --max-output-tokens N --timeout-seconds 120 (10-600)
  agentstreams inference models --provider near-ai  List current models and tool/privacy metadata
  agentstreams inference set --provider local --model MODEL [--base-url LOOPBACK_URL]
  agentstreams inference set --provider near-ai --model MODEL --api-key
  A configured follower model adds advisory notes automatically during copy runs.
                                                Enter your API key at a hidden prompt to save it locally
  agentstreams agent run --prompt "What you want the enabled activity to do."
                                                Uses the one enabled activity. Pass --activity when several are enabled.
  agentstreams install mcp                       Print stdio config for other MCP clients
  agentstreams mcp                               Stdio tools and background health monitor

Operate the same streams directly:
  agentstreams request --tier basic              Actual guarded API request; opens/reuses as needed
  agentstreams stream check [--tier basic]       Read-only admission/health decision
  agentstreams stream open --tier basic          Check policy, then submit OPEN
  agentstreams stream status                     On-chain vault/session state
  agentstreams stream top-up USDC    Approve replenishment in the browser wallet
  agentstreams stream close [--session ID]       Close and return unused escrow
  agentstreams monitor                           Monitor health/idle limits until stopped
  agentstreams reconcile                         Reconcile uncertain payments and payouts
  agentstreams doctor                            Read-only key, RPC, balance and policy checks
  agentstreams verify [--run /path/run.json]      Verify saved testnet receipts (read-only)
  agentstreams ui [--run /path/run.json] Replay captured real NEAR runs

Common: --project PATH, --agent NAME, --json, --help, --version
Financial flags and positional fund/withdraw use decimal USDC. Legacy fund --amount uses raw units.
Paid APIs must implement the agentStreams protocol. CLI inference uses a local tool-capable endpoint or NEAR AI. MCP clients connect to the tool server separately.
One service and one active stream per profile. Streams have no time limit by default; access ends on closure or prepaid funds running out. Run the agent/MCP/monitor for automatic health and idle closure.
Signing depends on the security of the local host. NEAR AI response attestation can be verified separately.
`;
const integer = value => { if (!/^[0-9]+$/.test(value || '')) throw new Error('Expected a positive integer.'); return Number(value); };
const boolean = value => { if (!['true', 'false'].includes(value)) throw new Error('Use true or false.'); return value === 'true'; };

export async function run(argv) {
  const strings = ['action-json', 'targets', 'max-inputs', 'copy-bps', 'hash', 'paper-balances', 'agent', 'activity', 'id', 'activities', 'rate', 'intents-agent-id', 'intents-key-env', 'intents-grant-env', 'from', 'to', 'amount-raw', 'nova-group', 'nova-account', 'nova-network', 'nova-key-env', 'performance-file', 'assets', 'input-asset', 'max-input-raw', 'copy-input-raw', 'max-age', 'max-slippage-bps', 'max-notional', 'stale-seconds', 'feed-failures', 'network', 'deployment', 'session', 'owner-id', 'recipient', 'amount', 'budget', 'max-stream', 'max-rate', 'max-duration', 'max-5xx', 'max-transport-errors', 'max-health-failures', 'idle-timeout', 'max-requests', 'reuse', 'poll-seconds', 'close-on-exit', 'url', 'health-path', 'quote-path', 'request-path', 'tiers', 'base-url', 'model', 'max-steps', 'prompt', 'tier', 'query', 'thinking', 'failure-cooldown', 'provider', 'reasoning-effort', 'max-output-tokens', 'repository', 'basic-rate', 'premium-rate', 'duration', 'run', 'timeout-seconds', 'transactions', 'hours', 'staking-pool', 'tokens', 'fund-near', 'token', 'balance-raw'];
  const booleans = ['api-key', 'cancel', 'resume', 'once', 'live', 'confidential', 'execute', 'json', 'help', 'version', 'enable', 'disable', 'dry-run', 'deploy', 'public-history'];
  const { values: v, positionals: p, tokens } = parseArgs({ args: argv, allowPositionals: true, strict: true, tokens: true, options: {
    ...Object.fromEntries([...strings, 'veto-seconds', 'registry', 'delivery', 'signal-window'].map(k => [k, { type: 'string' }])), ...Object.fromEntries(booleans.map(k => [k, { type: 'boolean' }])),
    project: { type: 'string', default: '.' }, recording: { type: 'string', default: 'testnet' }, port: { type: 'string', default: '0' },
    'vault-name': { type: 'string', default: 'agentstreams' }, 'agent-name': { type: 'string', default: 'research-agent' }, rpc: { type: 'string', default: 'https://test.rpc.fastnear.com' }, service: { type: 'string', default: 'http://127.0.0.1:5321' },
  } });
  const emit = value => process.stdout.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n');
  if (v.version) return emit(version);
  if (v.help || !p.length) return emit(renderHelp(version, help, { plain: v.json }));
  const allowed = {
    ...copyFlags,
    'wallet:connect': 'network rpc port owner-id', 'wallet:show': '', 'wallet:disconnect': '', 'wallet:reconcile': 'hash cancel',
    init: 'network owner-id recipient vault-name agent-name rpc service deploy resume',
    'config:set': 'max-5xx max-transport-errors max-health-failures idle-timeout max-requests reuse poll-seconds close-on-exit failure-cooldown',
    'config:limits': 'budget max-stream max-rate max-duration recipient', 'config:show': '', 'config:reconcile': '', config: '',
    'service:set': 'url recipient health-path quote-path request-path tiers', 'service:show': '', service: '',
    'service:serve': 'repository port deployment basic-rate premium-rate duration',
    'inference:set': 'provider base-url model api-key max-steps thinking reasoning-effort max-output-tokens timeout-seconds', 'inference:models': 'provider', 'inference:show': '', inference: '', 'agent:run': 'prompt max-steps once rpc activity',
    request: 'tier query', 'stream:check': 'tier', 'stream:open': 'tier', 'stream:status': '', 'stream:close': 'session',
    monitor: '', reconcile: '', close: 'session', verify: 'rpc run', fund: 'amount', doctor: '', payments: 'enable disable',
    install: 'dry-run', mcp: '', ui: 'recording port run',
    'grant:show': '', 'grant:create': 'transactions hours activities staking-pool tokens fund-near', 'grant:revoke': '', 'grant:reconcile': '',
    'grant:prepare': 'activity token balance-raw',
  };
  const grouped = ['wallet', 'config', 'service', 'inference', 'agent', 'stream', 'task', 'publish', 'earnings', 'guard', 'copy', 'grant', 'registry', 'outlayer', 'signal'];
  let command = grouped.includes(p[0]) && p[1] ? `${p[0]}:${p[1]}` : p[0];
  if (p[0] === 'copy' && /^ap_[a-f0-9]{64}$/.test(p[1] ?? '')) command = 'copy:preview';
  const maxPositionals = copyPositionals.has(command) ? 3 : grouped.includes(p[0]) || ['install', 'fund', 'withdraw'].includes(p[0]) ? 2 : 1;
  if (p.length > maxPositionals) throw new Error('Unexpected positional arguments. See --help.');
  const common = ['project', 'agent', 'json', 'help', 'version'];
  const provided = tokens.filter(token => token.kind === 'option' && !common.includes(token.name)).map(token => token.name);
  if (Object.hasOwn(allowed, command)) {
    const flags = new Set(allowed[command].split(' '));
    for (const flag of provided) if (!flags.has(flag)) throw new Error(`--${flag} is not supported by ${p.join(' ')}.`);
  }
  const workspace = await projectPath(v.project);
  const identityOnly = ['wallet', 'registry', 'outlayer'].includes(p[0]) || ['agent:create', 'agent:use', 'agent:list'].includes(command);
  const agent = identityOnly ? null : await selectedAgent(workspace, command === 'agent:show' ? p[2] ?? v.agent : v.agent);
  const project = agent?.path ?? workspace;
  if (command === 'agent:run' && (!v.prompt && (provided.includes('max-steps') || v.activity) || v.prompt && (v.once || provided.includes('rpc')))) throw new Error('Use --prompt with --max-steps, or the copy runner with --once and --rpc.');
  if (Object.hasOwn(copyFlags, command) || (command === 'agent:run' && !v.prompt) || (command === 'reconcile' && agent)) {
    const result = await runCopyCommand(command, p, v, workspace, agent, emit, provided);
    if (command === 'reconcile' && !result.resolved) process.exitCode = 1;
    if (result !== undefined) return emit(result);
    return;
  }
  switch (p[0]) {
    case 'grant': {
      const grant = await import('./agent-grant.mjs');
      if (p[1] === 'show' || !p[1]) return emit(await grant.showGrant());
      if (p[1] === 'create') return emit(await grant.createGrant({ agentId: agent?.id, ownerId: agent && (await agentSetupState(agent)).ownerId,
        transactions: v.transactions, hours: v.hours, activities: v.activities, stakingPool: v['staking-pool'], tokens: v.tokens, fundNear: v['fund-near'] }));
      if (p[1] === 'reconcile') return emit(await grant.reconcileGrant());
      if (p[1] === 'prepare') {
        if (!agent) throw new Error('Select a named agent before preparing its grant.');
        const { prepareGrant } = await import('./grant-prepare.mjs');
        return emit(await prepareGrant({ agentId: agent.id, ownerId: (await agentSetupState(agent)).ownerId,
          activity: v.activity, token: v.token, balance: v['balance-raw'] }));
      }
      if (p[1] === 'revoke') return emit(await grant.revokeGrant());
      throw new Error('Use grant show, create, prepare, reconcile or revoke.');
    }
    case 'wallet': {
      const wallet = await import('./owner-wallet.mjs');
      if (p[1] === 'connect') {
        if (v.network && v.network !== 'testnet') throw new Error('Only NEAR testnet owner wallets are supported.');
        return emit(await wallet.connectOwnerWallet({ port: v.port === '0' ? 5389 : Number(v.port), rpcUrl: provided.includes('rpc') ? v.rpc : undefined, accountId: v['owner-id'] }));
      }
      if (p[1] === 'show') return emit(await wallet.connectedOwner() || { connected: false, next: 'agentstream wallet connect --network testnet' });
      if (p[1] === 'disconnect') return emit(await wallet.disconnectOwnerWallet());
      if (p[1] === 'reconcile') { const result = await wallet.reconcileOwnerWallet(v.hash, { cancel: v.cancel }); if (!result.resolved) process.exitCode = 1; return emit(result); }
      throw new Error('Use wallet connect, show, disconnect or reconcile.');
    }
    case 'init': {
      if (v.network && v.network !== 'testnet') throw new Error('Only native NEAR testnet is supported.');
      const { setupTestnet } = await import('./setup.mjs');
      const result = await setupTestnet(project, { ownerId: v['owner-id'], recipientId: v.recipient, vaultLabel: v['vault-name'], agentLabel: v['agent-name'], rpcUrl: provided.includes('rpc') ? v.rpc : undefined, serviceUrl: v.service, deploy: v.deploy, resume: v.resume });
      if (result.readyToDeploy === false || (v.deploy && result.status === 'OWNER_SETUP_REQUIRED')) process.exitCode = 1;
      return emit(result);
    }
    case 'config': {
      if (p[1] === 'show' || !p[1]) {
        const result = await showSettings(project);
        if (agent) result.inference = (await agentSetupState(agent)).inference;
        return emit(result);
      }
      if (p[1] === 'reconcile') { const result = await reconcileLimits(project); if (!result.resolved) process.exitCode = 1; return emit(result); }
      if (p[1] === 'limits') {
        const patch = {};
        for (const [flag, key] of [['budget','budget'], ['max-stream','max_deposit'], ['max-rate','max_rate']]) if (v[flag] !== undefined) patch[key] = usdc(v[flag]);
        if (v['max-duration']) patch.max_duration_seconds = durationSeconds(v['max-duration']);
        if (v.recipient) patch.recipients = v.recipient.split(',');
        return emit(await setLimits(project, patch));
      }
      if (p[1] !== 'set') throw new Error('Use config show, set, limits or reconcile.');
      const patch = {};
      for (const [flag, key] of [['max-5xx','maxConsecutive5xx'], ['max-transport-errors','maxConsecutiveTransportErrors'], ['max-health-failures','maxConsecutiveHealthFailures'], ['idle-timeout','idleTimeoutSeconds'], ['max-requests','maxRequestsPerStream'], ['poll-seconds','healthPollSeconds'], ['failure-cooldown','failureCooldownSeconds']]) if (v[flag] !== undefined) patch[key] = integer(v[flag]);
      for (const [flag, key] of [['reuse','reuseStream'], ['close-on-exit','closeOnExit']]) if (v[flag] !== undefined) patch[key] = boolean(v[flag]);
      return emit(await setRuntime(project, patch));
    }
    case 'service': {
      if (p[1] === 'show' || !p[1]) return emit((await showSettings(project)).service);
      if (p[1] === 'serve') {
        if (!/^\d+$/.test(v.port) || Number(v.port) > 65535) throw new Error('Invalid port.');
        const { readConfig } = await import('@ola-893/agentstreams-core/internal-config');
        const config = await readConfig(v.deployment || (await liveProfile(project)).configPath);
        const { startRepositoryService } = await import('./repository-service.mjs');
        const service = await startRepositoryService(config, { repository: v.repository, port: Number(v.port) || 5380,
          rates: { basic: usdc(v['basic-rate'] || '0.000010'), premium: usdc(v['premium-rate'] || '0.000200') }, durationSeconds: v.duration ? integer(v.duration) : 1000 });
        emit({ listening: service.origin, pid: process.pid, ...service.summary, faultInjection: 'Send SIGUSR1 to this process to toggle explicitly injected paid-request 503s; health stays healthy.' });
        let injected = false;
        const toggle = () => { injected = !injected; service.setRequestUnavailable(injected); emit({ injected503: injected, healthUnchanged: true }); };
        process.on('SIGUSR1', toggle);
        const stop = () => { process.removeListener('SIGUSR1', toggle); void service.close(); };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        return;
      }
      if (p[1] !== 'set') throw new Error('Use service show, set or serve.');
      const patch = {};
      for (const [flag, key] of [['url','url'], ['recipient','recipient'], ['health-path','healthPath'], ['quote-path','quotePath'], ['request-path','requestPath']]) if (v[flag] !== undefined) patch[key] = v[flag];
      if (v.tiers) patch.tiers = v.tiers.split(',');
      return emit(await setService(project, patch));
    }
    case 'inference': {
      if (p[1] === 'show' || !p[1]) {
        if (agent) return emit((await agentSetupState(agent)).inference || { configured: false });
        return emit((await readInferenceProfile(project))?.inference ?? (await liveProfile(project)).inference ?? { configured: false });
      }
      if (p[1] === 'models') {
        const { listInferenceModels } = await import('./inference.mjs');
        const catalog = await listInferenceModels({ provider: v.provider });
        const models = catalog.models.filter(model => model.confidentialEligible);
        return emit({ ...catalog, catalogTotal: catalog.total, total: models.length, models });
      }
      if (p[1] !== 'set') throw new Error('Use inference show, set or models.');
      return emit(await setInference(project, { provider: v.provider, baseUrl: v['base-url'], model: v.model, maxSteps: v['max-steps'] ? integer(v['max-steps']) : undefined,
        ...(v.thinking !== undefined ? { thinking: boolean(v.thinking) } : {}),
        ...(v['reasoning-effort'] !== undefined ? { reasoningEffort: v['reasoning-effort'] } : {}),
        ...(v['timeout-seconds'] !== undefined ? { timeoutSeconds: integer(v['timeout-seconds']) } : {}),
        ...(v['max-output-tokens'] !== undefined ? { maxOutputTokens: integer(v['max-output-tokens']) } : {}) }, agent, { enterApiKey: v['api-key'] }));
    }
    case 'agent': {
      if (p[1] !== 'run') throw new Error('Use agent run --prompt "...".');
      const activity = v.activity ?? (agent ? promptActivity(await readAgentState(agent)) : null);
      const strategy = strategyActivities.has(activity);
      if (activity && !strategy && !['spot-trading', 'paid-api'].includes(activity)) throw new Error('Choose an activity from task list or paid-api.');
      if (strategy && !agent) throw new Error('Select a named agent first.');
      const spot = activity === 'spot-trading';
      if (spot && !agent) throw new Error('Create a named agent with agentstreams agent create NAME first.');
      const savedInference = await readInferenceProfile(project, { withKey: true });
      const inference = savedInference?.inference ?? (agent ? (await agentSetupState(agent)).inference : (await liveProfile(project)).inference);
      if (!inference) throw new Error('Configure local or NEAR AI inference with agentstreams inference set.');
      const config = inferenceConfig({ ...inference, ...(v['max-steps'] ? { maxSteps: integer(v['max-steps']) } : {}) });
      await assertInferenceModel(config);
      const controller = new AbortController();
      const options = { prompt: v.prompt, signal: controller.signal, storedApiKey: savedInference?.apiKey };
      const stop = () => controller.abort(new Error('AGENT_INTERRUPTED'));
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      let client;
      try {
        if (spot) {
          const { runTradingAgent } = await import('./trading-agent.mjs');
          const events = [];
          const result = await runTradingAgent(agent, config, { ...options, emit: v.json ? event => events.push(event) : emit });
          return emit({ ...result, ...(v.json ? { events } : {}) });
        }
        if (strategy) {
          const { runStrategyAgent } = await import('./strategy-agent.mjs');
          const events = [];
          const result = await runStrategyAgent(agent, activity, config, { ...options, emit: v.json ? event => events.push(event) : emit });
          return emit({ ...result, ...(v.json ? { events } : {}) });
        }
        const { runAgent } = await import('./agent.mjs');
        client = await gatewayFor(project);
        return await runAgent(client, config, { ...options, emit });
      } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await client?.dispose(); }
    }
    case 'request':
    case 'stream':
    case 'monitor':
    case 'reconcile':
    case 'close': {
      if (p[0] === 'stream' && !['check', 'open', 'status', 'close'].includes(p[1])) throw new Error('Use stream check, open, status or close.');
      const client = await gatewayFor(project);
      try {
        if (p[0] === 'reconcile') {
          const { reconcilePayouts } = await import('./vault-money.mjs');
          const payment = await client.reconcile();
          const payouts = await reconcilePayouts({ path: dirname((await liveProfile(project)).file) });
          const resolved = payment.resolved && payouts.resolved;
          if (!resolved) process.exitCode = 1;
          return emit({ ...payment, resolved, payouts });
        }
        if (p[0] === 'request') { const { createToolHandlers } = await import('@ola-893/agentstreams-core/tools'); return emit(await createToolHandlers(client).agentstreams_fetch({ tier: v.tier || client.service.tiers[0], ...(v.query !== undefined ? { query: v.query } : {}) })); }
        if (p[0] === 'monitor') {
          const { startMonitor } = await import('@ola-893/agentstreams-core/monitor');
          let finish; const done = new Promise(resolve => { finish = resolve; });
          const stop = () => finish();
          process.once('SIGINT', stop); process.once('SIGTERM', stop);
          const monitor = startMonitor(client, { onEvent: emit, onError: error => { emit({ error: error.message }); process.exitCode = 1; finish(); } });
          emit({ monitoring: true, policy: client.runtimePolicy });
          try { await done; } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await monitor.stop(); if (client.runtimePolicy.closeOnExit) emit(await client.close()); }
          return;
        }
        if (p[0] === 'close' || p[1] === 'close') return emit(await client.close({ sessionId: v.session }));
        if (p[1] === 'status') return emit(await client.status());
        const checked = await client.check({ tier: v.tier });
        if (p[1] === 'check') return emit(checked);
        if (checked.decision === 'CONTINUE') return emit({ ...checked, reused: true });
        if (checked.decision !== 'OPEN') { process.exitCode = 1; return emit(checked); }
        return emit({ ...await client.open({ approvalId: checked.approvalId }), monitoring: 'Run agentstreams monitor for automatic health and idle closure between requests.' });
      } finally { await client.dispose(); }
    }
    case 'verify': {
      const { verifyPublicRun } = await import('@ola-893/agentstreams-core/internal-evidence');
      const { bundledWasm, historicalVaultWasm, publicRecording } = await import('./setup.mjs');
      return emit(await verifyPublicRun({ recordingFile: v.run || publicRecording, wasmFile: bundledWasm, historicalWasmFiles: historicalVaultWasm, rpcUrl: v.rpc }));
    }
    case 'fund': {
      if (p[1] && v.amount) throw new Error('Choose a decimal positional amount or legacy --amount.');
      const { fundProject } = await import('./setup.mjs');
      return emit(await fundProject(project, { amount: p[1] ? usdc(p[1]) : v.amount, decimal: Boolean(p[1]) }));
    }
    case 'doctor': {
      const setup = agent ? await agentSetupState(agent) : null;
      if (agent) {
        const state = await readAgentState(agent);
        if (!setup.configured) {
          const paperTrading = state.tasks['spot-trading']?.mode === 'paper';
          return emit({ ok: paperTrading && Boolean(setup.inference && state.executionPolicy), agentId: agent.id, setup,
            ...(paperTrading ? { paperTrading, inferenceConfigured: Boolean(setup.inference), executionPolicyConfigured: Boolean(state.executionPolicy) } :
              { next: 'agentstreams task list' }) });
        }
        if (state.tradePending) process.exitCode = 1;
      }
      await readProject(project);
      const profile = await liveProfile(project);
      const { inspectNearProfile } = await import('@ola-893/agentstreams-core/near');
      const { summary, config } = await inspectNearProfile(profile.configPath, profile.stateRoot);
      const ok = !process.exitCode && !summary.pendingIntent && !summary.executorBusyOrInterrupted && !summary.policyUpdatePending;
      if (!ok) process.exitCode = 1;
      const inference = setup?.inference ?? (await readInferenceProfile(project))?.inference ?? profile.inference;
      return emit({ ok, node: process.versions.node, paymentsEnabled: profile.paymentsEnabled, inferenceConfigured: Boolean(inference), runtimePolicy: config.runtimePolicy, ...summary });
    }
    case 'payments': { if (Boolean(v.enable) === Boolean(v.disable)) throw new Error('Choose exactly one of --enable or --disable.'); return emit(await setPayments(project, v.enable)); }
    case 'install': {
      if (p[1] === 'mcp') { const { mcpServer } = await import('./install.mjs'); return emit({ mcpServers: { agentstreams: mcpServer(workspace, fileURLToPath(new URL('../bin/agentstreams.mjs', import.meta.url)), { agent: agent?.name }) } }); }
      throw new Error('Use install mcp for the tool server configuration.');
    }
    case 'mcp': { const { startMcp } = await import('./mcp.mjs'); return startMcp(await gatewayFor(project)); }
    case 'ui': {
      if (!/^\d+$/.test(v.port) || Number(v.port) > 65535) throw new Error('Invalid port.');
      const { startUi, openBrowser } = await import('./ui.mjs');
      const ui = await startUi({ port: Number(v.port), recording: v.recording, runFile: v.run });
      emit({ url: ui.url, mode: 'replay-of-real-near-run', recording: v.recording, readOnly: true });
      openBrowser(ui.url);
      process.once('SIGINT', () => void ui.close()); process.once('SIGTERM', () => void ui.close());
      return;
    }
    default: throw new Error('Unknown command. Run agentstreams --help.');
  }
}
