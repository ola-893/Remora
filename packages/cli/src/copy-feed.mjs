import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PublicKey, baseEncode } from 'near-api-js';
import { NearAgentStreamsClient, USDC } from '@ola-893/agentstreams-core/near';
import { verifySession } from '@ola-893/agentstreams-core/internal-session';
import { canonical } from '@ola-893/agentstreams-core/internal-evidence-audit';
import { atomicWrite, readOptional } from './files.mjs';
import { feedKey, fingerprint, readAgentState, withAgentState } from './agents.mjs';
import { assetId, rawAmount, spot } from './copy-activity.mjs';
import { credential } from './copy-intents.mjs';
import { bundledWasm, historicalVaultWasm } from './setup.mjs';
import { activityMode, nativeWalletActivities, strategyAction } from './strategy-actions.mjs';
import { usdc } from './settings.mjs';
import { outlayerNetwork } from '@ola-893/agentstreams-core/internal-outlayer';

export const agentIdPattern = /^ap_[a-f0-9]{64}$/;
export const accountId = value => typeof value === 'string' && /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(value);
export const quotePath = (vaultId, expiresAt) => `/copy/quote/${vaultId}` + (expiresAt ? `/${expiresAt}` : "");
export const listingPath = '/.well-known/agentstreams.json';
const legacyListingPath = '/.well-known/agentpay.json';
export const feedPath = '/copy/actions';
export const healthPath = '/copy/health';
export const quoteHash = quote => fingerprint(JSON.stringify(quote));

export function originOf(value) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))) throw new Error('Use an HTTPS feed origin or http://127.0.0.1 for a local feed.');
  return url.origin;
}

export async function readJsonResponse(response, max = 131072) {
  const parts = [];
  let size = 0;
  for await (const part of response.body ?? []) {
    size += part.length;
    if (size > max) throw new Error('FEED_RESPONSE_TOO_LARGE');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

export async function fetchFeed(origin, path, headers, publisher) {
  const response = origin === outlayerNetwork.origin
    ? await (await import('./outlayer.mjs')).outlayerFeedResponse(publisher, path, headers)
    : await fetch(`${origin}${path}`, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`FEED_HTTP_${response.status}`);
  return readJsonResponse(response);
}

function signed(key, domain, body) {
  const signature = key.sign(Buffer.from(canonical({ domain, body }))).signature;
  return { body, signature: Buffer.from(signature).toString('base64') };
}

function verified(envelope, key, domain) {
  return envelope?.body && typeof envelope.signature === 'string' && envelope.signature.length === 88 &&
    PublicKey.fromString(key).verify(Buffer.from(canonical({ domain, body: envelope.body })), Buffer.from(envelope.signature, 'base64'));
}

export async function configurePublish(agent, flags) {
  const selected = flags.activities?.split(',') ?? [spot];
  if (selected.length !== 1 || selected[0] !== spot && !nativeWalletActivities.has(selected[0])) throw new Error('Choose one supported activity from agentstreams task list.');
  if (flags.delivery !== undefined && !['local', 'outlayer'].includes(flags.delivery)) throw new Error('Use --delivery local or outlayer.');
  const origin = originOf(flags.url ?? (flags.delivery === 'outlayer' ? outlayerNetwork.origin : 'http://127.0.0.1:5380'));
  if (flags.delivery === 'outlayer' && origin !== outlayerNetwork.origin) throw new Error('OUTLAYER_ORIGIN_MISMATCH');
  const port = Number(flags.port ?? (new URL(origin).protocol === 'http:' ? new URL(origin).port || 80 : 5380));
  const duration = Number(flags.duration ?? 0);
  const rate = usdc(flags.rate);
  if (BigInt(rate) < 1n || !accountId(flags.recipient) || !flags.recipient.endsWith('.testnet') || !Number.isInteger(duration) || duration < 0 || duration > 4294967295 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Provide a positive --rate, .testnet --recipient, --duration seconds (0 keeps the stream open until closed or funding is exhausted) and a valid --port.');
  const nova = flags['nova-group'] ? { group: flags['nova-group'], account: flags['nova-account'], keyEnv: flags['nova-key-env'] ?? 'NOVA_API_KEY', network: flags['nova-network'] ?? 'testnet' } : null;
  if (nova && (!/^[A-Za-z0-9._-]{1,64}$/.test(nova.group) || !accountId(nova.account) || !/^[A-Z][A-Z0-9_]{0,127}$/.test(nova.keyEnv) || !['testnet', 'mainnet'].includes(nova.network))) throw new Error('Provide a valid --nova-group, --nova-account and --nova-network.');
  const performance = flags['performance-file'] ? JSON.parse(await readFile(flags['performance-file'], 'utf8')) : null;
  if (performance && (!Array.isArray(performance) || performance.length > 90 || !performance.every(p => Object.keys(p).length === 2 && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number.isFinite(p.pnl)))) throw new Error('Performance file must contain up to 90 { date, pnl } points.');
  return withAgentState(agent, state => {
    if (state.publish?.enabled) throw new Error('Stop publication before changing the listing.');
    const publicHistory = flags['public-history'] === true;
    state.publish = { enabled: false, activity: selected[0], origin, port, duration, rate, recipient: flags.recipient, nova, performance, publicHistory,
      ...(flags.delivery === 'outlayer' ? { delivery: 'outlayer' } : {}) };
    return { origin, activity: selected[0], rateRawUSDCPerSecond: rate, durationSeconds: duration, recipient: flags.recipient, journal: nova ? 'nova' : 'local-encrypted', publicHistory, enabled: false };
  });
}

export function publicListingHistory(state, activity) {
  const cutoff = Date.now() - 86400000;
  const days = new Map();
  for (const event of state.history ?? []) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at > cutoff || !event.publication?.journalHash) continue;
    let kind;
    if (activity === spot && event.type === 'trade' && ['paper-filled', 'SUCCESS'].includes(event.status)) {
      kind = event.status === 'paper-filled' ? 'paper-fill' : 'intent-fill';
    }
    if (event.type === 'strategy' && event.activity === activity && event.status === 'wallet-confirmed') kind = 'wallet-action';
    if (!kind) continue;
    const day = new Date(at).toISOString().slice(0, 10) + 'T00:00:00.000Z';
    const key = `${day}:${kind}`;
    const row = days.get(key) ?? { at: day, kind, count: 0 };
    row.count++;
    days.set(key, row);
  }
  return [...days.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-50);
}

function executionVisibility(state, activity) {
  if (activity !== spot) return 'public-chain';
  if (state.tasks[spot]?.mode === 'paper') return 'paper';
  return state.tasks[spot]?.confidential ? 'confidential-requested' : 'public-chain';
}

function publicPerformance(performance) {
  const cutoff = Date.now() - 86400000;
  return performance.filter(point => Date.parse(point.date + 'T23:59:59.999Z') <= cutoff);
}

/* Public discovery contains delayed statistics. The signed journal retains
   actionable records and receipts behind the subscription check. */
function listing(agent, state) {
  const p = state.publish;
  return {
    version: 1, id: agent.id, name: agent.name, publicKey: agent.publicKey, origin: p.origin, network: 'testnet',
    activity: p.activity ?? spot, recipient: p.recipient, rate: p.rate, duration: p.duration,
    journal: p.nova ? 'nova' : 'local-encrypted',
    execution: activityMode(state, p.activity ?? spot) ?? 'unconfigured',
    visibility: executionVisibility(state, p.activity ?? spot),
    ...(p.delivery === 'outlayer' ? { delivery: 'outlayer', deliveryKey: state.outlayerDeliveryKey } : {}),
    ...(p.publicHistory ? { history: publicListingHistory(state, p.activity ?? spot), historyPolicy: { delaySeconds: 86400, granularity: 'day', receipts: false } } : {}),
    ...(p.performance ? { performance: { provenance: 'publisher-reported', points: publicPerformance(p.performance) } } : {}),
  };
}

export async function signedListing(agent, state) {
  return signed(await feedKey(agent), 'agentpay.listing.v1', listing(agent, state));
}

export async function getListing(id, origin) {
  const envelope = await fetchFeed(origin, listingPath, undefined, id).catch(error => {
    if (error.message !== 'FEED_HTTP_404') throw error;
    return fetchFeed(origin, legacyListingPath, undefined, id);
  });
  const b = envelope?.body;
  if (!b || b.version !== 1 || b.id !== id || !agentIdPattern.test(id) || typeof b.publicKey !== 'string' || b.publicKey.length > 70 ||
      `ap_${fingerprint(b.publicKey)}` !== id || b.origin !== origin || b.network !== 'testnet' || (b.activity !== spot && !nativeWalletActivities.has(b.activity)) ||
      !accountId(b.recipient) || !b.recipient.endsWith('.testnet') || !rawAmount(b.rate) || !Number.isInteger(b.duration) || b.duration < 0 || b.duration > 4294967295 ||
      !verified(envelope, b.publicKey, 'agentpay.listing.v1')) throw new Error('INVALID_SIGNED_LISTING');
  if (b.delivery === 'outlayer' && (b.origin !== outlayerNetwork.origin || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(b.deliveryKey ?? ''))) throw new Error('INVALID_DELIVERY_KEY');
  return b;
}

function quoteFor(b, vaultId, tokenId, expiresAt) {
  return {
    version: 1, vault_id: vaultId, token_id: tokenId, recipient_id: b.recipient, tier: 'basic', rate: b.rate,
    duration_seconds: b.duration, expires_at: expiresAt, publisher: b.id, origin: b.origin, activity: b.activity,
  };
}

export function checkListingQuote(b, vaultId, tokenId, quote) {
  if (!Number.isSafeInteger(quote?.expires_at) || quote.expires_at <= Date.now() / 1000 || quote.expires_at > Date.now() / 1000 + 300 ||
      canonical(quote) !== canonical(quoteFor(b, vaultId, tokenId, quote.expires_at))) throw new Error('QUOTE_DOES_NOT_MATCH_SIGNED_LISTING');
  return quoteHash(quote);
}

function quoteMatchesStream(b, vault, stream, vaultId) {
  if (stream?.recipient_id !== b.recipient || stream.rate !== b.rate || stream.duration_seconds !== b.duration) return false;
  const bucket = Math.floor(Number(stream.started_at) / 60) * 60;
  // The quote lasts 60–120 seconds. Include the preceding buckets for a transaction crossing a boundary.
  return [0, 60, 120].some(offset => quoteHash(quoteFor(b, vaultId, vault.token_id, bucket + 120 - offset)) === stream.quote_hash);
}

function localJournalKey(key) {
  return createHash('sha256').update('agentpay.local.journal.v1\0').update(key.toString()).digest();
}

async function novaSdk(nova) {
  const { NovaSdk } = await import('nova-sdk-js');
  const settings = nova.network === 'testnet' ? { contractId: 'nova-sdk-7.testnet', rpcUrl: 'https://test.rpc.fastnear.com' } : {};
  return new NovaSdk(nova.account, { ...settings, apiKey: credential(nova.keyEnv) });
}

async function storeEntry(agent, key, entry, nova) {
  const data = Buffer.from(JSON.stringify(entry));
  const hash = fingerprint(data);
  if (nova) {
    const sdk = await novaSdk(nova);
    const result = await sdk.upload(nova.group, data, `${hash}.json`);
    if (result.file_hash !== hash || typeof result.cid !== 'string') throw new Error('NOVA_JOURNAL_HASH_MISMATCH');
    return { nova, ref: result.cid, hash };
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', localJournalKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const file = join(agent.path, 'journal', `${hash}.json`);
  await atomicWrite(file, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
  return { hash };
}

async function loadEntry(agent, key, pointer) {
  let data;
  if (pointer.nova) {
    const sdk = await novaSdk(pointer.nova);
    data = (await sdk.retrieve(pointer.nova.group, pointer.ref)).data;
  } else {
    const content = JSON.parse(await readFile(join(agent.path, 'journal', `${pointer.hash}.json`), 'utf8'));
    const cipher = createDecipheriv('aes-256-gcm', localJournalKey(key), Buffer.from(content.iv, 'base64'));
    cipher.setAuthTag(Buffer.from(content.tag, 'base64'));
    data = Buffer.concat([cipher.update(Buffer.from(content.ciphertext, 'base64')), cipher.final()]);
  }
  if (fingerprint(data) !== pointer.hash) throw new Error('JOURNAL_HASH_MISMATCH');
  return JSON.parse(data);
}

const strategyDomain = 'agentstreams.strategy-action.v1';

async function appendAction(agent, state, entry, domain) {
  if (!state.publish?.enabled || (state.publish.activity ?? spot) !== entry.activity) return null;
  const journal = state.journal ??= [];
  if (journal.some(item => item.id === entry.id)) return null;
  const key = await feedKey(agent);
  const action = { ...entry, sequence: (journal.at(-1)?.sequence ?? 0) + 1, publisher: agent.id };
  const pointer = await storeEntry(agent, key, signed(key, domain, action), state.publish.nova);
  journal.push({ ...pointer, id: action.id, sequence: action.sequence, activity: action.activity });
  return { id: action.id, sequence: action.sequence, journalHash: pointer.hash };
}

export function appendFill(agent, state, fill) {
  return appendAction(agent, state, { ...fill, activity: spot }, fill.execution === 'paper' ? 'agentstreams.paper-action.v1' : 'agentpay.action.v1');
}

export function appendStrategyAction(agent, state, entry) {
  return appendAction(agent, state, entry, strategyDomain);
}

export function verifyAction(envelope, listing) {
  const b = envelope?.body;
  if (!b || b.publisher !== listing.id || b.activity !== listing.activity || !/^[a-f0-9]{64}$/.test(b.id ?? '') ||
      !Number.isSafeInteger(b.sequence) || b.sequence < 1 || !Number.isSafeInteger(b.at) || !Number.isSafeInteger(b.expiresAt) || b.expiresAt <= b.at ||
      (b.copiedFrom !== undefined && !agentIdPattern.test(b.copiedFrom))) throw new Error('INVALID_SIGNED_ACTION');
  if (nativeWalletActivities.has(b.activity)) {
    if (b.execution !== 'wallet' || b.expiresAt - b.at > 120000 ||
        !verified(envelope, listing.publicKey, strategyDomain) || canonical(strategyAction(b.activity, b.action)) !== canonical(b.action)) throw new Error('INVALID_SIGNED_STRATEGY');
    if (b.execution === 'wallet' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(b.settlementRef ?? '')) throw new Error('INVALID_STRATEGY_SETTLEMENT');
    return b;
  }
  if (b.activity !== spot || !assetId(b.from) || !assetId(b.to) || b.from === b.to || !rawAmount(b.amountIn) || !rawAmount(b.amountOut) ||
      (b.execution !== undefined && !['paper', 'agent-connect'].includes(b.execution)) ||
      typeof b.settlementRef !== 'string' || !b.settlementRef.length || b.settlementRef.length > 160 ||
      !verified(envelope, listing.publicKey, b.execution === 'paper' ? 'agentstreams.paper-action.v1' : 'agentpay.action.v1')) throw new Error('INVALID_SIGNED_ACTION');
  return b;
}

export async function publicationHistory(agent) {
  const state = await readAgentState(agent);
  const key = await feedKey(agent);
  return { actions: await Promise.all((state.journal ?? []).slice(-20).map(p => loadEntry(agent, key, p))) };
}

export async function pendingOutlayerEntries(agent) {
  const state = await readAgentState(agent);
  if (state.publish?.delivery !== 'outlayer') return [];
  const key = await feedKey(agent);
  return Promise.all((state.journal ?? []).filter(pointer => !pointer.outlayerUploaded).slice(0, 8).map(async pointer => ({
    id: pointer.id, entry: await loadEntry(agent, key, pointer),
  })));
}

export async function subscribers(agent) {
  const directory = join(agent.path, 'subscribers');
  let files;
  try { files = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return Promise.all(files.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))));
}

export async function serveFeed(agent, { rpcUrl = 'https://test.rpc.fastnear.com', network = 'testnet', token = USDC.testnet, codeFile = bundledWasm, port } = {}) {
  const { publish } = await readAgentState(agent);
  if (!publish) throw new Error('Configure publish set first.');
  const key = await feedKey(agent);
  const trustedCodeFiles = codeFile === bundledWasm ? [codeFile, ...historicalVaultWasm] : [codeFile];
  const trustedCodeHashes = new Set(await Promise.all(trustedCodeFiles.map(async file =>
    baseEncode(createHash('sha256').update(await readFile(file)).digest()))));
  const rpc = new NearAgentStreamsClient({ rpcUrl });
  if ((await rpc.provider.viewNodeStatus()).chain_id !== network) throw new Error('FEED_RPC_NETWORK_MISMATCH');
  const server = createServer(async (req, res) => {
    let publicRead = false;
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        ...(publicRead ? { 'access-control-allow-origin': '*' } : {}) });
      res.end(JSON.stringify(value));
    };
    try {
      const path = new URL(req.url, publish.origin);
      publicRead = [listingPath, legacyListingPath, healthPath].includes(path.pathname);
      if (req.method !== 'GET') return send(405, { error: 'METHOD_NOT_ALLOWED' });
      const state = await readAgentState(agent);
      if (!state.publish?.enabled || state.publish.origin !== publish.origin || state.publish.port !== publish.port) return send(503, { error: 'PUBLICATION_STOPPED' });
      const b = listing(agent, state);
      if ([listingPath, legacyListingPath].includes(path.pathname)) return send(200, signed(key, 'agentpay.listing.v1', b));
      if (path.pathname === healthPath) return send(200, { ok: true, observed_at: Math.floor(Date.now() / 1000) });
      if (path.pathname.startsWith('/copy/quote/')) {
        const [vaultId, expiry, ...extra] = path.pathname.slice('/copy/quote/'.length).split('/');
        const now = Math.floor(Date.now() / 1000);
        const next = Math.floor(now / 60) * 60 + 120;
        const expiresAt = expiry === undefined ? next : Number(expiry);
        if (!accountId(vaultId) || path.searchParams.get('tier') !== 'basic' || extra.length ||
            ![next, next - 60].includes(expiresAt) || expiresAt <= now) return send(400, { error: 'INVALID_QUOTE_REQUEST' });
        return send(200, quoteFor(b, vaultId, token, expiresAt));
      }
      if (path.pathname !== feedPath) return send(404, { error: 'NOT_FOUND' });
      const header = req.headers['x-agentpay-session'];
      if (!header) return send(402, { protocol: 'agentpay-near-v1' });
      if (typeof header !== 'string' || header.length > 2048) return send(403, { error: 'SESSION_INVALID' });
      let untrusted;
      try { untrusted = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')); } catch { return send(403, { error: 'SESSION_INVALID' }); }
      if (!accountId(untrusted?.vault_id) || !/^[a-zA-Z0-9_-]{1,64}$/.test(untrusted?.session_id ?? '')) return send(403, { error: 'SESSION_INVALID' });
      const client = new NearAgentStreamsClient({ rpcUrl, vaultId: untrusted.vault_id });
      const authenticate = async () => {
        const [account, vault, stream] = await Promise.all([
          client.provider.viewAccount({ accountId: untrusted.vault_id, blockQuery: { finality: 'final' } }), client.getVault(), client.getStream(untrusted.session_id),
        ]);
        const now = Math.floor(Date.now() / 1000);
        if (!trustedCodeHashes.has(account.code_hash) || vault.token_id !== token || Math.abs(now - Number(vault.now)) > 30 || !quoteMatchesStream(b, vault, stream, untrusted.vault_id)) throw new Error('UNTRUSTED_PAYMENT');
        return { session: verifySession(header, { config: { serviceUrl: b.origin, vaultId: untrusted.vault_id }, vault, stream, now: Math.max(now, Number(vault.now)) }), stream };
      };
      let access;
      try { access = await authenticate(); } catch { return send(403, { error: 'STREAM_ACCESS_DENIED' }); }
      const after = Number(path.searchParams.get('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) return send(400, { error: 'INVALID_CURSOR' });
      const pointers = (state.journal ?? []).filter(p => p.sequence > after).slice(0, 8);
      const entries = [];
      for (const pointer of pointers) {
        if ((pointer.activity ?? spot) !== b.activity) continue;
        const entry = await loadEntry(agent, key, pointer);
        if (entry.body.at >= Number(access.stream.started_at) * 1000) entries.push(entry);
      }
      // A close may finalize while NOVA is retrieving the ciphertext. Check again before releasing entries.
      if (pointers.length) try { await authenticate(); } catch { return send(403, { error: 'STREAM_ACCESS_DENIED' }); }
      if (!(await readAgentState(agent)).publish?.enabled) return send(503, { error: 'PUBLICATION_STOPPED' });
      const sub = { vaultId: untrusted.vault_id, sessionId: access.session.session_id, recipient: b.recipient, rpcUrl };
      const file = join(agent.path, 'subscribers', `${fingerprint(`${sub.vaultId}:${sub.sessionId}`)}.json`);
      if (!await readOptional(file)) {
        await mkdir(join(agent.path, 'subscribers'), { recursive: true, mode: 0o700 });
        await atomicWrite(file, JSON.stringify(sub));
      }
      const cursor = pointers.at(-1)?.sequence ?? after;
      return send(200, signed(key, 'agentpay.page.v1', { sessionId: access.session.session_id, observedAt: Date.now(), after, cursor, entries }));
    } catch { return send(503, { error: 'FEED_TEMPORARILY_UNAVAILABLE' }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port ?? publish.port, '127.0.0.1', resolve); });
  return { port: server.address().port, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

export function verifyPage(envelope, listing, sessionId, after, freshness) {
  const page = envelope?.body;
  if (!page || page.sessionId !== sessionId || page.after !== after || !Number.isSafeInteger(page.cursor) || page.cursor < after || page.cursor > after + 8 ||
      !Number.isSafeInteger(page.observedAt) || page.observedAt > Date.now() + 5000 || Date.now() - page.observedAt > freshness * 1000 ||
      !Array.isArray(page.entries) || page.entries.length > 8 || !verified(envelope, listing.delivery === 'outlayer' ? listing.deliveryKey : listing.publicKey, 'agentpay.page.v1')) throw new Error('FEED_STALE_OR_INVALID');
  let previous = after;
  const actions = page.entries.map(entry => {
    const action = verifyAction(entry, listing);
    if (action.sequence <= previous || action.sequence > page.cursor) throw new Error('INVALID_ACTION_ORDER');
    previous = action.sequence;
    return action;
  });
  return { actions, cursor: page.cursor };
}
