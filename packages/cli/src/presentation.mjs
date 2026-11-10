import { AsyncLocalStorage } from 'node:async_hooks';
import { stripVTControlCharacters } from 'node:util';
import { usesColor, validateColor, tones } from './output-mode.mjs';

// Only the output boundary uses this context. Signing, policy and runner events
// retain their existing inputs, return values and timing.
export const presentationContext = new AsyncLocalStorage();
const hidden = '[redacted]';
const label = value => String(value ?? '').replaceAll('-', ' ');
const short = value => typeof value === 'string' && value.length > 30 ? `${value.slice(0, 16)}…${value.slice(-9)}` : value;
const network = value => value === 'testnet' ? 'NEAR testnet' : value === 'mainnet' ? 'NEAR mainnet' : value;
const mode = value => ({ observe: 'Observe only', approve: 'Owner approval required', veto: 'Timed owner veto', auto: 'Automatic, subject to guards', paper: 'Paper; no on-chain settlement', wallet: 'NEAR testnet execution' })[value] ?? value;
const secretField = /^(?:.*privatekey|apikey|key|paymentkey|computekey|signingkey|ownerkey|encryptionkey|clientsecret|seedphrase|mnemonic|authtoken|sessiontoken|accesstoken|refreshtoken|authorization|password|secret|mastersecret|protectedfeedmaster|credential|sessioncredential|headers|prompt|systemprompt|instructions|messages|thinking|reasoning|content|text|answer|note)$/i;

export function cleanText(value) {
  return stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, hidden)
    .replace(/\bed25519:[1-9A-HJ-NP-Za-km-z]{80,}/g, hidden)
    .replace(/((?:api[_-]?key|private[_-]?key|auth[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, `$1${hidden}`)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@')
    .replace(/([?&](?:api[_-]?key|token|key|secret|authorization)=)[^&#\s]*/gi, `$1${hidden}`)
    .replace(/(https?:\/\/[^\s#]+)#[^\s]+/g, '$1#[redacted]');
}

// Preserve object shape, numeric strings, evidence and status identifiers. Only
// secrets/free-form inference content are hidden, including in detailed output.
export function redact(value, key = '') {
  if (secretField.test(key.replace(/[_-]/g, '')) && value != null && typeof value !== 'boolean') return hidden;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    if (/^\s*[\[{]/.test(value)) { try { return JSON.stringify(redact(JSON.parse(value))); } catch { /* Ordinary text, not encoded JSON. */ } }
    return cleanText(value);
  }
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  return value;
}

export function decimal(raw, decimals) {
  if (!/^\d+$/.test(String(raw)) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return `${cleanText(raw)} raw units`;
  const digits = BigInt(raw).toString().padStart(decimals + 1, '0');
  if (!decimals) return digits;
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return digits.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}

// Protocol NEAR units and the fixed FT metadata used by the shipped testnet
// adapters. Unknown tokens stay explicitly raw; no RPC or symbol inference here.
const tokens = {
  'wrap.testnet': [24, 'test wNEAR'], 'wrap.near': [24, 'wNEAR'],
  'usdc.fakes.testnet': [6, 'test USDC.e'],
  '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af': [6, 'test USDC'],
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': [6, 'USDC'],
};
export function amount(raw, asset) {
  if (raw === undefined || raw === null) return undefined;
  if (asset === 'near:testnet') return `${decimal(raw, 24)} test NEAR`;
  if (asset === 'near:mainnet') return `${decimal(raw, 24)} NEAR`;
  const id = String(asset ?? '').replace(/^nep141:/, '');
  const meta = tokens[id];
  return meta ? `${decimal(raw, meta[0])} ${meta[1]}` : `${cleanText(raw)} raw units${id ? ` (${short(id)})` : ' (token metadata unavailable)'}`;
}
const usdc = (raw, net) => raw == null ? undefined : `${decimal(raw, 6)} ${net === 'testnet' ? 'test USDC' : net === 'mainnet' ? 'USDC' : 'USDC (network not reported)'}`;
const seconds = n => n == null ? undefined : String(n) === '0' ? 'Until closed or funds run out' : `${n} seconds`;
const time = n => n && Number.isFinite(new Date(n).getTime()) ? new Date(n).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : undefined;

export function wrap(text, width = 76) {
  const size = Math.max(12, width), lines = [];
  for (const paragraph of cleanText(text).split('\n')) {
    let line = '';
    for (let word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && Array.from(line + ' ' + word).length > size) { lines.push(line); line = ''; }
      while (Array.from(word).length > size) {
        if (line) { lines.push(line); line = ''; }
        lines.push(Array.from(word).slice(0, size).join('')); word = Array.from(word).slice(size).join('');
      }
      line += (line ? ' ' : '') + word;
    }
    lines.push(line);
  }
  return lines;
}

const policyReasons = /^(?:STRATEGY_(?:INPUT_LIMIT|ASSET|TARGET|POLICY|SLIPPAGE)|ACTION_EXPIRED|ASSET_NOT_ALLOWED|INPUT_LIMIT|MAX_INPUT|SLIPPAGE|ORDER_TOO_OLD|COPY_INPUT|NOTIONAL|RATE_LIMIT|DURATION_LIMIT|DEPOSIT_LIMIT|BUDGET_LIMIT|QUOTE_EXPIRED|PRICE_MOVED|POLICY_DENIED|EXECUTION_POLICY_REQUIRED)/;
const reasons = {
  STRATEGY_INPUT_LIMIT: 'The proposed input exceeds your execution limit.',
  ACTION_EXPIRED: 'The decision is too old to execute.',
  OWNER_VETO: 'You blocked this candidate during its veto window.',
  COPY_AUTHORITY_EXPIRED: 'The subscription or execution authority has expired.',
};

export function createPresentation({ stream = process.stdout, diagnostics = process.stderr, env = process.env, json = false, verbose = false, color = 'auto', command = [] } = {}) {
  validateColor(color);
  const human = Boolean(stream.isTTY && !json);
  const seen = new Map();
  let suppressed = 0;
  let context = {};
  const grouped = new Set(['agent', 'wallet', 'copy', 'task', 'publish', 'guard', 'grant', 'inference', 'stream', 'config', 'signal', 'evidence', 'registry', 'outlayer', 'earnings', 'service']);
  const commandName = grouped.has(command[0]) ? command.slice(0, 2).join(':') : command[0];
  function block(title, rows = [], next, tone = 'info', target = stream) {
    const width = Math.max(20, Math.min(target.columns ?? 80, 96));
    const colored = usesColor({ stream: target, env, color, json });
    const code = tones[tone] ?? tones.info;
    const mark = env.TERM !== 'dumb' && /UTF-?8/i.test(env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? '') ? ({ info: '›', done: '✓', wait: '…', error: '!' })[tone] : ({ info: '>', done: 'OK', wait: '...', error: '!' })[tone];
    const header = wrap(`${mark} ${title}`, width - 2).map(line => colored ? `\x1b[${code};1m${line}\x1b[0m` : line);
    const lines = ['', ...header];
    for (const [key, value] of rows) {
      if (value === undefined || value === null || value === '') continue;
      const content = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
      if (width < 60) { lines.push(`  ${key}`); lines.push(...wrap(content, width - 4).map(s => `    ${s}`)); }
      else {
        const prefix = `  ${key.padEnd(14)} `;
        const parts = wrap(content, width - prefix.length);
        lines.push(prefix + parts[0], ...parts.slice(1).map(s => ' '.repeat(prefix.length) + s));
      }
    }
    if (next) lines.push('', ...wrap(next, width - 2).map(s => '  ' + s));
    target.write(lines.join('\n') + '\n');
  }
  const receiptRows = v => [['Transaction', short(v.transactionHash ?? v.receipt?.hash ?? v.hash)], ['Explorer', v.explorerUrl ?? v.receipt?.explorerUrl]];
  function actionRows(v) {
    const a = v.action ?? {}, order = v.order ?? {}, fill = v.fill ?? {};
    return [['Action ID', v.actionId ?? (typeof a.id === 'string' ? a.id : undefined)], ['Activity', label(v.activity ?? a.activity)],
      ['Operation', a.operation], ['Pool', a.pool ?? a.poolId],
      ['Source', v.evidence?.source], ['Venue', v.evidence?.contract],
      [order.amount ? 'Your input' : a.amount ? 'Requested cap' : 'Input', amount(order.amount ?? a.amount ?? fill.amountIn, order.origin_asset ?? a.base ?? a.token ?? fill.from ?? (v.activity === 'staking-moves' ? 'near:testnet' : undefined))],
      ['Output', amount(fill.amountOut, fill.to)],
      ...Object.entries(v.inputs ?? {}).map(([asset, raw]) => ['Your input', amount(raw, asset)]),
      ['Account', short(v.executionAccountId)]];
  }
  function paymentRows(p, net) {
    if (!p) return [];
    return [['Budget', usdc(p.budget, net)], ['Max escrow', usdc(p.max_deposit, net)], ['Max rate', p.max_rate == null ? undefined : `${usdc(p.max_rate, net)} / second`],
      ['Duration cap', seconds(p.max_duration_seconds)], ['Recipients', p.recipients?.join(', ')]];
  }
  function executionRows(p) {
    if (!p) return [];
    return [['Assets', p.assets?.join(', ')], ['Targets', p.targets?.join(', ')],
      ...Object.entries(p.caps ?? {}).map(([asset, raw]) => ['Input limit', amount(raw, asset)]),
      ['Input limit', amount(p.maxInput, p.inputAsset)], ['Copy input', amount(p.fixedInput, p.inputAsset)],
      ['Copy size', p.copyBps == null ? undefined : `${decimal(p.copyBps, 2)}% of leader`],
      ['Max age', seconds(p.maxAge)], ['Slippage cap', p.slippageBps == null ? undefined : `${p.slippageBps} basis points`]];
  }
  function subscription(v, title) {
    const l = v.listing ?? {};
    if (!title && ['paused', 'stopped'].includes(v.status)) return block(`Copy ${v.status}`, [['Leader', l.name ?? short(l.id)], ['Network', network(l.network)], ['Stream', v.closeHash ? 'Closure receipt recorded' : 'Inspect stream status; no closure receipt in this result'], ['Reason', v.reason], ...receiptRows({ transactionHash: v.closeHash, explorerUrl: v.receipt?.explorerUrl })], undefined, v.closeHash ? 'done' : 'wait');
    block(title ?? `Copy ${v.status ?? 'status'}`, [['Leader', l.name ?? short(l.id)], ['Network', network(l.network)], ['Activity', label(l.activity)],
      ['Payment', l.rate == null ? undefined : `${usdc(l.rate, l.network)} / second`], ['Recipient', l.recipient], ['Duration', seconds(l.duration)],
      ['Mode', mode(v.mode)], ['Veto window', seconds(v.vetoSeconds)], ['Session', short(v.sessionId)], ['Reason', v.reason],
      ['Delivery', l.delivery === 'outlayer' ? 'Encrypted OutLayer feed; attestation checked per response.' : undefined],
      ['Execution', l.visibility === 'public-chain' ? 'Settlement is public on-chain.' : l.visibility === 'confidential-requested' ? 'Confidential execution requested; not proof of privacy.' : l.execution === 'paper' ? 'Paper; no on-chain settlement.' : undefined],
      ...receiptRows({ ...v, transactionHash: v.closeHash ?? v.openHash })],
    v.status === 'active' ? 'Waiting for the next proposed action. Keep the agent runner open.' : undefined,
    v.status === 'active' ? 'info' : 'wait');
  }
  function failure(v) {
    const message = v.reason ?? v.error ?? 'OPERATION_FAILED';
    const uncertain = /UNCONFIRMED|RECONCIL|PENDING|UNKNOWN|RECOVERY/.test(message);
    const next = /OWNER_WALLET|FUNDING/.test(message) ? 'Run agentstream wallet reconcile and inspect the recorded operation before another payment.'
      : /GRANT/.test(message) ? 'Run agentstream grant reconcile before another execution.'
      : 'Inspect agentstream status, stream status and reconcile before another paid operation.';
    block(uncertain ? 'Outcome needs reconciliation' : 'Operation failed', [['Reason', message], ['Submission', uncertain ? 'Outcome uncertain; do not submit again yet.' : 'Not established by this error alone.'], ...receiptRows(v)],
      uncertain ? next : 'Inspect the error and current state before retrying.', 'error', diagnostics);
  }
  function render(v) {
    if (!v || typeof v !== 'object') return block('Remora', [['Result', v]]);
    if (Array.isArray(v)) { for (const item of v) render(item); return; }
    if (Array.isArray(v.events)) for (const e of v.events) render(e);
    if (v.type === 'cli-diagnostics') return block('CLI execution path · read-only', [['Package root', v.packageRoot], ['Executable', v.executable], ['Node', v.node], ['Revision', v.revision], ['Renderer', v.rendererFingerprint], ['State home', v.stateHome], ['stdout / stderr', `${v.stdoutTTY ? 'TTY' : 'pipe'} / ${v.stderrTTY ? 'TTY' : 'pipe'}`], ['TERM', v.term], ['NO_COLOR', v.noColor ? 'Set' : 'Unset'], ['FORCE_COLOR', v.forceColor ?? 'Unset'], ['Output', v.outputMode], ['Color', v.color]], undefined);
    if (v.type === 'close-proof') return block(v.beforeCloseHTTP === 200 && v.afterCloseHTTP === 403 && v.closeTransaction ? 'Stream closed · further access denied' : 'Closure proof needs inspection', [['Before close', `HTTP ${v.beforeCloseHTTP}`], ['After close', `HTTP ${v.afterCloseHTTP}`], ['Transaction', v.closeTransaction], ['Same session', v.sameSessionCredential]], undefined, v.beforeCloseHTTP === 200 && v.afterCloseHTTP === 403 && v.closeTransaction ? 'done' : 'wait');
    if (v.type === 'compute-funded') return block('OutLayer compute funding confirmed', [['Network', network(v.network)], ['Compute key', v.computeKey], ['Amount', amount(v.amountRaw, v.tokenId)], ...receiptRows(v)], undefined, 'done');
    if (v.type === 'demo-check') return block('Demo readiness · no changes made', [['Role', v.role], ['Checkout', v.packageRoot], ['Agent', v.agent], ['Network', network(v.network)], ['Publication', v.publicationEnabled === undefined ? undefined : v.publicationEnabled ? 'Enabled' : 'Disabled'], ['Subscription', v.subscriptionStatus ?? 'None'], ['Runner PID', v.runnerPid], ['Inference', v.inferenceProvider], ['Grant', v.granted === undefined ? undefined : v.granted ? 'Active' : 'Not active'], ['Pending trade', v.pendingTrade], ['Operation', v.operation]], v.next, v.ready === false ? 'wait' : 'info');
    if (v.type === 'tool') {
      if (v.result?.decision === 'DENY' || v.result?.status) return render({ ...v.result, activity: v.result.activity });
      return block(/guard|portfolio/.test(v.name) ? 'Agent reads its configured rules' : 'Agent tool returned', [['Tool', v.name], ['Policy', 'Models cannot change your limits.']], undefined);
    }
    if (v.type === 'answer') return block('Model step finished', [['Steps', v.steps], ['Content', 'Free-form inference text hidden; tool outcomes shown separately.']]);
    if (v.type === 'inference') return block('Model response received', [['Provider', v.provider], ['Model', v.model], ['Attestation', v.attestationVerified === true ? 'Reported verified for this response' : 'Not verified for this response']]);
    if (v.type === 'copy-review') return block('Follower model review · advisory', [['Action ID', v.actionId], ['Review', ({ NO_CONCERN: 'No concern reported; this is not policy or owner approval.', REVIEW: 'Model flagged a concern; execution still follows guards and owner controls.', INSUFFICIENT_CONTEXT: 'Not enough context for a model opinion.', UNAVAILABLE: 'Inference unavailable; execution controls are unchanged.' })[v.status] ?? v.status], ['Evidence', v.evidenceIds?.join(', ')]], undefined, v.status === 'NO_CONCERN' ? 'info' : 'wait');
    if (v.type === 'signal') return block(`Decision signal · ${v.phase}`, [['Signal ID', short(v.signalId)], ['Meaning', ({ proposed: 'Proposed before execution; may expire or be cancelled.', released: 'Released to eligible subscribers; settlement not established.', settled: 'Leader reported settlement; inspect execution evidence.', uncertain: 'Execution outcome uncertain; reconcile before another attempt.', cancelled: 'Cancelled; do not execute this signal.', expired: 'Expired; do not execute this signal.', failed: 'Leader execution failed.' })[v.phase]]], undefined, ['uncertain', 'failed'].includes(v.phase) ? 'error' : 'info');
    if (v.running) {
      block('Agent runner started', [['Agent ID', short(v.agentId)]]);
      return block('Waiting for the next event', [], 'Listening for state changes. Ctrl+C stops this runner.', 'wait');
    }
    if (v.type === 'registry') return block(v.method === 'stop' ? 'Directory marked stopped' : 'Directory heartbeat sent', [['Agent', short(v.publisherId)]], undefined);
    if (v.type?.endsWith('-error') || v.type === 'closure-unconfirmed' || v.error) return failure(v);
    if (['DENY', 'skipped'].includes(v.decision ?? v.status) && policyReasons.test(v.reason ?? '')) return block('Action blocked by policy', [...actionRows(v), ['Reason', reasons[String(v.reason).split(':')[0]] ?? v.reason], ['Code', v.reason ?? v.code]], 'Your execution limits remain unchanged.', 'error');
    if (v.decision === 'DENY') {
      if (/FAILED|UNCONFIRMED|RECONCIL|TRANSPORT|RPC|HTTP_/.test(v.reason ?? '')) return failure(v);
      return block('Operation not admitted', [['Decision', 'DENY'], ['Reason', v.reason]], 'Check the reported prerequisite or service state. Limits remain unchanged.', 'wait');
    }
    if (v.status === 'blocked' || v.reason === 'OWNER_VETO') return block(commandName === 'copy:block' || v.type === 'decision' || v.reason === 'OWNER_VETO' ? 'Action vetoed by owner' : 'Action blocked', [...actionRows(v), ['Reason', v.reason]], undefined, 'error');
    if (['failed', 'error', 'FAILURE'].includes(v.status)) return failure({ ...v, reason: v.reason ?? v.status });
    if (v.status === 'skipped') return block('Action skipped', [...actionRows(v), ['Reason', v.reason]], undefined, 'wait');
    if (v.status === 'pending' && (v.actionId || v.action)) return block(v.blockUntil ? 'Decision waiting · owner veto window' : 'Decision waiting · owner approval', [...actionRows(v), ['Veto deadline', time(v.blockUntil)], ['Review', 'Model advice does not override policy or owner controls.']], v.blockUntil ? `To veto before the deadline: agentstream copy block ${v.actionId ?? v.action?.id}. If not blocked, execution is attempted only if checks still pass.` : `Approve or reject with agentstream copy approve/reject ${v.actionId ?? v.action?.id}.`, 'wait');
    if (v.status === 'waiting-signal') return block('Waiting for signal release', actionRows(v), 'No execution confirmation has been reported.', 'wait');
    if (v.status === 'observed') return block('Decision observed', [...actionRows(v), ['Reason', v.reason]], 'Observation does not establish follower execution.');
    if (v.status === 'rejected') return block('Action rejected by owner', actionRows(v), undefined, 'wait');
    if (v.status === 'approved') return block('Owner approval recorded', actionRows(v), 'The runner must recheck policy before execution.');
    if (v.status === 'preview' || (v.quote && v.signedTransactions === 0)) return block('Action preview · not submitted', [...actionRows(v), ['Network', network(v.network ?? context.network)], ['Mode', mode(v.mode)]], 'Review the preview before requesting execution.');
    if (v.status === 'paper-filled') return block('Paper action recorded', [...actionRows(v), ['Settlement', 'Virtual portfolio only; no on-chain trade.']], undefined, 'done');
    if (v.status === 'wallet-confirmed' || v.status === 'SUCCESS') return block('Execution confirmed', [...actionRows(v), ['Network', network(v.network ?? context.network)], ['Signing', v.signing ?? v.receipt?.signing], ['Settlement', 'On-chain execution'], ...receiptRows(v)], undefined, 'done');
    if (v.reconciliationRequired || ['PENDING', 'PROCESSING', 'submitting', 'executing', 'uncertain'].includes(v.status)) return block('Execution outcome pending', [...actionRows(v), ['Status', v.status], ...receiptRows(v)], 'Reconcile the recorded operation before submitting another execution.', 'wait');
    if (v.listing && Object.hasOwn(v, 'admission')) {
      subscription(v, v.signedTransactions === 0 ? 'Copy preview · no transaction submitted' : 'Copy offer preview');
      return block('Subscription admission', [['Decision', v.admission.decision], ['Reason', v.admission.reason], ['Max escrow', usdc(v.maxEscrowRawUSDC, v.listing.network)]], v.next, v.admission.decision === 'DENY' ? 'wait' : 'info');
    }
    if (v.decision === 'CLOSE') return block(v.receipt ? 'Payment stream closure confirmed' : v.alreadyClosed ? 'Payment stream already closed' : 'Payment stream closure required', [['Session', short(v.sessionId)], ['Reason', v.reason], ['Earned', usdc(v.receipt?.value?.earned, context.network)], ['Refunded', usdc(v.receipt?.value?.refunded, context.network)], ...receiptRows(v)], v.receipt || v.alreadyClosed ? undefined : 'Closure has not been confirmed by this result.', v.receipt || v.alreadyClosed ? 'done' : 'wait');
    if (v.decision === 'CONTINUE' || v.decision === 'OPEN') return block(v.receipt ? 'Payment stream opened' : 'Payment admission check', [['Decision', v.decision], ['Reason', v.reason], ['Session', short(v.sessionId)], ['Escrow', usdc(v.deposit, context.network)], ...receiptRows(v)], v.receipt ? 'The active stream pays for access; this is not a payment per action.' : undefined);
    if (v.listing && v.status) {
      if (['paused', 'stopped'].includes(v.status)) return block(v.closeHash ? 'Copy stopped · payment stream closure confirmed' : `Copy ${v.status} · inspect stream state`, [['Leader', v.listing.name ?? short(v.listing.id)], ['Network', network(v.listing.network)], ['Reason', v.reason], ...receiptRows({ ...v, transactionHash: v.closeHash })], v.closeHash ? undefined : 'No closure receipt in this result. Check agentstream stream status.', v.closeHash ? 'done' : 'wait');
      subscription(v, v.status === 'active' ? 'Subscription active · paying for decisions' : `Copy ${v.status}`);
      return;
    }
    if (Object.hasOwn(v, 'subscription')) {
      if (v.setup) block('Agent status', [['Name', v.name], ['Agent ID', v.id], ['Network', network(v.setup.network)], ['Publication', v.publicationEnabled ? 'Enabled' : 'Disabled']]);
      if (v.subscription) subscription(v.subscription); else block('No copy subscription');
      if (v.tradePending || v.pendingTrade) block('Execution needs reconciliation', [], 'Inspect agentstream reconcile before another execution.', 'wait');
      return;
    }
    if (v.mode && v.sessionId) return block('Copy mode configured', [['Mode', mode(v.mode)], ['Veto window', seconds(v.vetoSeconds)]], v.mode === 'veto' ? 'Eligible actions proceed after the veto deadline only if checks still pass.' : undefined);
    if (v.type === 'subscription') return subscription(v);
    if (v.actions && commandName === 'copy:pending') {
      block(v.actions.length ? `${v.actions.length} pending candidate(s)` : 'No pending candidates');
      for (const item of v.actions) render({ ...item, ...item.preview, action: item.preview?.action ?? item.action?.action ?? item.action, actionId: item.action?.id, activity: item.action?.activity });
      return;
    }
    if (v.history && commandName === 'copy:history') { block('Copy history', [['Entries', v.history.length]]); for (const event of v.history.slice(-12)) render(event); return; }
    if (v.selected && v.id) return block('Agent selected', [['Name', v.selected], ['Agent ID', v.id]]);
    if (commandName === 'agent:create') return block('Agent created locally', [['Name', v.name], ['Agent ID', v.id]], v.next, 'done');
    if (v.agents) { block('Your agents', [['Selected', v.selected], ['Count', v.agents.length]]); for (const a of v.agents) block(a.name, [['Agent ID', a.id]]); return; }
    if (v.signer === 'browser-wallet' || Object.hasOwn(v, 'connected')) return block(v.connected === false ? 'Wallet not connected' : 'Browser wallet connected', [['Network', network(v.network)], ['Account', v.accountId], ['Wallet', v.walletId], ['Private keys', v.privateKeysStored === false ? 'Owner keys stay in the wallet.' : undefined]], v.next, v.connected === false ? 'wait' : 'done');
    if (v.status === 'OWNER_SETUP_REQUIRED') return block('Wallet connection required', [['Network', network(v.network)], ['Submitted', v.signedTransactions === 0 ? 'No transaction submitted' : undefined]], v.next, 'wait');
    if (v.status === 'DEPLOYED') return block('Agent deployment complete', [['Network', network(v.network)], ['Owner', v.ownerId], ['Vault', short(v.vaultId)], ['Payments', v.paymentsEnabled ? 'Enabled' : 'Disabled'], ['Transactions', v.transactions?.length]], v.next, 'done');
    if (v.readyToDeploy !== undefined) return block('Deployment readiness', [['Network', network(v.network)], ['Ready', v.readyToDeploy], ['Owner', v.ownerId]], v.next, 'wait');
    if (command[0] === 'inference' || v.inference && command[0] === 'inference') {
      const i = v.inference ?? v;
      if (v.models) { block('Available inference models', [['Provider', v.provider], ['Count', v.models.length]]); for (const m of v.models) block(m.id, [['Tool support', m.agentCompatible]]); return; }
      return block(i.configured === false ? 'Inference not configured' : 'Inference configuration', [['Provider', i.provider], ['Model', i.model], ['Endpoint', i.baseUrl], ['API key stored', i.apiKeyStored ?? v.credentialsStored], ['Attestation', v.attestationVerified === true ? 'Verified for the reported response' : 'Not established by configuration.']]);
    }
    if (v.financialPolicy || v.payment || command[0] === 'guard' || v.runtimePolicy) {
      const net = v.network ?? context.network;
      if (v.financialPolicy || v.payment) block('Payment guardrails · on-chain policy', [['Network', network(net)], ...paymentRows(v.financialPolicy ?? v.payment, net), ...receiptRows(v)]);
      if (v.execution) block('Execution guardrails · deterministic CLI checks', [['Activity', label(v.activity)], ...executionRows(v.execution)]);
      for (const [a, p] of Object.entries(v.strategyExecution ?? {})) block('Execution guardrails · deterministic CLI checks', [['Activity', label(a)], ...executionRows(p)]);
      if (v.feed) block('Feed guardrails · local checks', [['Max age', seconds(v.feed.staleSeconds)], ['Failure cap', v.feed.failures]]);
      if (v.runtimePolicy || v.runtime) { const p = v.runtimePolicy ?? v.runtime; block('Payment worker · local checks', [['Polling', seconds(p.healthPollSeconds)], ['Idle timeout', seconds(p.idleTimeoutSeconds)], ['Close on exit', p.closeOnExit], ['Reuse stream', p.reuseStream]], v.restartRequired); }
      return;
    }
    if (Object.hasOwn(v, 'granted') || v.revoked !== undefined) return block(v.revoked ? 'Execution grant revoked' : v.granted ? 'Execution grant active' : 'Execution grant unavailable', [['Network', 'NEAR testnet'], ['Account', v.executionAccountId], ['Activities', v.activities?.join(', ')], ['Remaining', v.remaining == null ? undefined : `${v.remaining} transactions (CLI limit)`], ['Expires', time(v.expiresAt)], ['Pending', v.pending ? 'Reconciliation required' : undefined]], v.next ?? (v.granted ? 'The funded execution-account balance is the on-chain bound. Transaction count, expiry and method restrictions are CLI checks.' : undefined), v.granted || v.revoked ? 'done' : 'wait');
    if (v.amountRawUSDC) return block(commandName === 'withdraw' || commandName === 'agent:withdraw' ? 'Vault withdrawal confirmed' : commandName === 'stream:top-up' ? 'Stream top-up confirmed' : 'Vault funding transaction confirmed', [['Network', network(v.network ?? context.network)], ['Amount', usdc(v.amountRawUSDC, v.network ?? context.network)], ...receiptRows(v)], undefined, 'done');
    if (command[0] === 'publish') {
      const p = v.publication ?? v;
      const rate = p.rateRawUSDCPerSecond ?? p.rate;
      return block(p.enabled ? 'Publication enabled' : 'Publication configuration', [['Agent ID', v.agentId ?? v.id], ['Network', 'NEAR testnet'], ['Activity', label(p.activity ?? p.activities?.join(', '))], ['Recipient', p.recipient], ['Rate', rate == null ? undefined : `${usdc(rate, 'testnet')} / second`], ['Duration', seconds(p.durationSeconds ?? p.duration)], ['Delivery', p.delivery === 'outlayer' ? 'Encrypted OutLayer delivery; response attestation checked separately.' : p.origin], ['Public history', p.publicHistory ? 'Delayed summaries enabled' : 'Not enabled']], v.next ?? (p.enabled ? 'Keep agentstream agent run open to serve the feed.' : undefined));
    }
    if (v.activities) { block('Activities'); for (const a of v.activities) block(label(a.id), [['Status', a.status], ['Mode', mode(a.execution)]]); return; }
    if (v.activity && Object.hasOwn(v, 'enabled')) return block(v.enabled ? 'Activity enabled' : 'Activity disabled', [['Activity', label(v.activity)], ['Mode', mode(v.config?.mode)]]);
    if (v.completed !== undefined) return block('Agent run finished', [['Activity', label(v.activity)], ['Mode', mode(v.mode)], ['Steps', v.steps], ['Outcome', v.result?.status ?? (v.fill ? 'Paper fill recorded' : 'Inspect the tool outcomes above.')]]);
    if (commandName === 'grant:prepare') return block('Execution account preparation', [['Account', v.executionAccountId], ['Activity', label(v.activity)], ['Token', v.token], ['Target', amount(v.targetBalance, v.token)], ['Outcome', v.status]], 'Inspect --json for individual preparation receipts.');
    if (v.setup) { block('Agent status', [['Name', v.name], ['Agent ID', v.id], ['Network', network(v.setup.network)], ['Deployed', v.setup.configured], ['Activity publication', v.publicationEnabled]]); if (v.setup.inference) block('Inference', [['Provider', v.setup.inference.provider], ['Model', v.setup.inference.model]]); return; }
    if (v.listings) { block('Agent offers', [['Count', v.listings.length]]); for (const l of v.listings) subscription({ listing: l }, l.name ?? 'Agent offer'); return; }
    if (v.signals) { block('Decision signals', [['Count', v.signals.length]]); for (const s of v.signals) render({ type: 'signal', ...s }); return; }
    if (v.phase && v.signalId) return render({ ...v, type: 'signal' });
    if (v.vault) {
      const vault = v.vault;
      return block('Subscription vault', [['Network', network(v.network ?? context.network)], ['Vault', short(v.vaultId)], ['Available', usdc(vault.available, v.network ?? context.network)], ['Reserved', usdc(vault.reserved, v.network ?? context.network)], ['Active stream', vault.active_session ?? 'None']], undefined);
    }
    if (v.publisher) return block('Feed listening', [['Origin', v.publisher], ['Port', v.port]]);
    // Conservative fallback: only scalar facts, never an object dump or inferred
    // success. All remaining structured fields are inspectable with --json.
    const facts = Object.entries(v).filter(([k, value]) => !secretField.test(k) && ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 7).map(([k, value]) => [label(k), value]);
    block(command.join(' ') || 'Remora status', facts, 'Use --json for structured details (sensitive content is redacted).');
  }
  function emit(value) {
    if (!human) {
      // Legacy pipe output keeps its framing; explicit JSON uses one value per
      // line for event streams. Scalar help/version become valid JSON too.
      const safe = redact(value);
      stream.write(!json && typeof safe === 'string' ? safe + '\n' : JSON.stringify(safe, null, json ? undefined : 2) + '\n');
      return;
    }
    const v = redact(value);
    const repeated = v && typeof v === 'object' && (v.type === 'registry' || v.status === 'waiting-signal' || v.type?.endsWith('-error') || v.status === 'idle');
    if (repeated) {
      const subject = JSON.stringify([v.type, v.actionId, v.publisherId]);
      const key = JSON.stringify([v.type, v.actionId, v.status, v.method, v.publisherId, v.reason]);
      if (seen.get(subject) === key) { suppressed++; return; }
      if (seen.size >= 512) seen.delete(seen.keys().next().value);
      seen.set(subject, key);
    } else if (v && typeof v === 'object') {
      seen.delete(JSON.stringify([v.type, v.actionId, v.publisherId]));
    }
    if (verbose) block('Structured details · redacted', [['Data', JSON.stringify(v)]]);
    render(v);
  }
  function wallet(options, url) {
    const hideLink = env.REMORA_TRANSCRIPT === '1';
    const event = { ownerWalletApproval: true, operation: options.kind === 'connect' ? 'Connect wallet' : options.plan.label, url: hideLink ? '[approval link omitted from transcript]' : url };
    // This fragment is a required one-use approval link. Print it only here,
    // unmodified and unwrapped so it remains clickable/copyable.
    if (!human || !diagnostics.isTTY || json) { diagnostics.write(JSON.stringify(event) + '\n'); return; }
    const p = options.plan ?? {};
    const rows = [['Purpose', event.operation], ['Network', 'NEAR testnet'], ['Owner', p.ownerId ?? options.accountId], ['Recipient', p.receiverId]];
    for (const a of p.actions ?? []) {
      if (a.type === 'Transfer') rows.push(['Amount', amount(a.params?.deposit, 'near:testnet')]);
      if (a.type === 'FunctionCall') {
        rows.push(['Method', a.params?.methodName]);
        if (/^ft_transfer(?:_call)?$/.test(a.params?.methodName)) rows.push(['Token amount', amount(a.params.args?.amount, p.receiverId)], ['Token recipient', a.params.args?.receiver_id]);
        if (/^\d+$/.test(a.params.deposit ?? '') && (BigInt(a.params.deposit) > 1n || verbose)) rows.push(['Attached', amount(a.params.deposit, 'near:testnet')]);
      }
    }
    block('Wallet approval needed', rows, options.kind === 'connect' ? 'Continue in your default browser wallet. This is sign-in, not transaction approval.' : 'Review full transaction details in your browser wallet, then approve or cancel.', 'wait', diagnostics);
    if (verbose && p.actions) block('Transaction details · redacted', [['Actions', JSON.stringify(redact(p.actions))]], undefined, 'info', diagnostics);
    diagnostics.write(hideLink ? 'Approval link omitted from transcript; the request opens in your default browser.\n' : url + '\n');
  }
  function start(agent, state) {
    if (!human) return;
    block('Remora · useful decisions, your own controls', [['Agent', agent?.name], ['Network', network(context.network)], ['Activity', label(state?.follow?.listing?.activity ?? state?.publish?.activity)], ['Provider', context.inference?.provider], ['Model', context.inference?.model]], undefined);
    if (state?.follow?.status === 'active') subscription(state.follow, 'Following a subscribed decision feed');
    if (state?.publish?.enabled) {
      block('Publishing decision feed', [['Activity', label(state.publish.activity)], ['Payment', `${usdc(state.publish.rate, 'testnet')} / second`], ['Delivery', state.publish.delivery === 'outlayer' ? 'Encrypted OutLayer delivery; attestation checked per response.' : 'Locally served subscription-gated feed']]);
    }
  }
  function finish() { if (human && suppressed) block('Repeated background updates collapsed', [['Updates', suppressed]], 'Significant decisions and execution outcomes remain above.'); }
  function toolStarted(name) {
    if (!human) return;
    const executes = /(?:apply|execute|fetch|open|close)$/.test(name);
    block(executes ? 'Agent requests an action' : 'Agent checks a proposed action', [['Tool', name], ['State', executes ? 'Waiting for checks and any required approval; no outcome reported yet.' : 'Reading current evidence and configured rules.']], undefined, 'wait');
  }
  return { emit, wallet, start, finish, failure, human, block, toolStarted, configure(value) { context = value ?? {}; } };
}

export function walletNotice(options, url) {
  const output = presentationContext.getStore()?.output;
  if (output) return output.wallet(options, url);
  // Library consumers keep the original diagnostic event.
  process.stderr.write(JSON.stringify({ ownerWalletApproval: true, operation: options.kind === 'connect' ? 'Connect wallet' : options.plan.label, url }) + '\n');
}

export function printCliError(error, { json = false, color = 'auto' } = {}) {
  const message = cleanText(error.message ?? 'OPERATION_FAILED');
  if (json) process.stderr.write(JSON.stringify({ error: message }) + '\n');
  else if (!process.stderr.isTTY) process.stderr.write(`Remora · ${message}\n`);
  else if (policyReasons.test(message)) createPresentation({ stream: process.stderr, color }).emit({ decision: 'DENY', reason: message });
  else createPresentation({ color }).failure({ reason: message });
}
