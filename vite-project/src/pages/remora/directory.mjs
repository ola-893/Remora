import outlayerNetwork from '../../../../near/lib/outlayer-network.json' with { type: 'json' };

export const activities = {
  'spot-trading': { name: 'Spot trading', action: 'Swap fills', focus: 'Inspect fills, execution mode, and reported P&L. A swap receipt alone does not establish return.' },
  'staking-moves': { name: 'Staking moves', action: 'Staking actions', focus: 'Inspect staking, unstaking, and withdrawals through the pool receipt. Action counts do not measure staking yield.' },
  'liquidity-ranges': { name: 'Liquidity ranges', action: 'Liquidity actions', focus: 'Inspect the pool and range changes in the receipt. Fees, time in range, and impermanent loss require position data.' },
  'portfolio-rebalance': { name: 'Portfolio rebalance', action: 'Rebalances', focus: 'Inspect rebalance receipts for assets and movements. Weight drift and returns require portfolio snapshots.' },
  'yield-reallocation': { name: 'Yield reallocation', action: 'Lending actions', focus: 'Inspect the supplied or withdrawn asset in the receipt. Realized yield requires balance and valuation data.' },
  'limit-orders': { name: 'Limit orders', action: 'Order actions', focus: 'Inspect placement, cancellation, and claim receipts. Placement alone does not establish a fill or return.' },
};
export const publisherId = /^ap_[a-f0-9]{64}$/;
const base58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const encoder = new TextEncoder();

export function feedOrigin(input, allowLoopback = false) {
  const url = new URL(input);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1'))) {
    throw new Error('Enter an HTTPS feed origin with no path, or a loopback feed for local development.');
  }
  return url.origin;
}

export function directoryEntries(input, allowLoopback = false) {
  if (!Array.isArray(input)) return [];
  return [...new Map(input.slice(0, 1000).flatMap(item => {
    try {
      if (typeof item?.id !== 'string' || !publisherId.test(item.id)) return [];
      return [[item.id, { id: item.id, origin: feedOrigin(item.origin, allowLoopback),
        ...(typeof item.registryActive === 'boolean' ? { registryActive: item.registryActive } : {}) }]];
    } catch { return []; }
  })).values()];
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function publicKeyBytes(key) {
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key)) throw new Error('Invalid feed key.');
  const value = key.slice(8);
  let n = 0n;
  for (const char of value) n = n * 58n + BigInt(base58.indexOf(char));
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  const leading = value.match(/^1*/)[0].length;
  if (bytes.length + leading !== 32) throw new Error('Invalid feed key.');
  return Uint8Array.from([...new Array(leading).fill(0), ...bytes]);
}

export async function verifyListing(envelope, entry) {
  const b = envelope?.body;
  if (!b || b.version !== 1 || b.id !== entry.id || !publisherId.test(b.id) || b.origin !== entry.origin || b.network !== 'testnet' ||
      !Object.hasOwn(activities, b.activity) || typeof b.name !== 'string' || !b.name || b.name.length > 64 ||
      typeof b.recipient !== 'string' || !/^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet$/.test(b.recipient) ||
      typeof b.rate !== 'string' || !/^[1-9][0-9]{0,37}$/.test(b.rate) || !Number.isInteger(b.duration) || b.duration < 0 || b.duration > 4294967295 ||
      typeof b.publicKey !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature ?? '')) throw new Error('Invalid signed offer.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(b.publicKey)));
  const id = 'ap_' + [...digest].map(x => x.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', publicKeyBytes(b.publicKey), 'Ed25519', false, ['verify']);
  const sig = Uint8Array.from(atob(envelope.signature), char => char.charCodeAt(0));
  const payload = encoder.encode(canonical({ domain: 'agentpay.listing.v1', body: b }));
  if (id !== entry.id || !await crypto.subtle.verify('Ed25519', key, sig, payload)) throw new Error('Offer signature did not verify.');
  const summaryPolicy = b.historyPolicy?.delaySeconds >= 86400 && b.historyPolicy?.granularity === 'day' && b.historyPolicy?.receipts === false;
  const history = summaryPolicy && Array.isArray(b.history) ? b.history.slice(-50).flatMap(item => {
    const kinds = b.activity === 'spot-trading' ? ['paper-fill', 'intent-fill'] : ['wallet-action'];
    if (!item || !/^\d{4}-\d{2}-\d{2}T00:00:00.000Z$/.test(item.at) || !Number.isFinite(Date.parse(item.at)) ||
        Date.parse(item.at) > Date.now() - 86400000 || !kinds.includes(item.kind) || !Number.isSafeInteger(item.count) || item.count < 1 || item.count > 1000000) return [];
    return [{ at: item.at, kind: item.kind, count: item.count }];
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) : [];
  const points = b.performance?.provenance === 'publisher-reported' && Array.isArray(b.performance.points)
    ? b.performance.points.slice(0, 90).filter(p => p && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Date.parse(p.date + 'T23:59:59.999Z') <= Date.now() - 86400000 && Number.isFinite(p.pnl) && Math.abs(p.pnl) <= Number.MAX_SAFE_INTEGER)
      .sort((a, b) => a.date.localeCompare(b.date)).map(({ date, pnl }) => ({ date, pnl }))
    : [];
  return { ...entry, name: b.name, activity: b.activity, execution: b.execution, network: b.network,
    recipient: b.recipient, rate: b.rate, duration: b.duration, journal: b.journal, history, points,
    visibility: b.execution === 'paper' ? 'paper' : b.visibility === 'confidential-requested' ? 'confidential-requested' : 'public-chain' };
}

async function json(url, signal) {
  const response = await fetch(url, { signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error('Feed returned HTTP ' + response.status);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 131072) throw new Error('Feed response is too large.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(await new Blob(chunks).text());
}

export async function registryEntries(config, signal = AbortSignal.timeout(10000)) {
  if (!config?.contractId) return [];
  const rpc = new URL(config.rpcUrl);
  if (config.network !== 'testnet' || rpc.protocol !== 'https:' || !/^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(config.contractId)) throw new Error('Invalid NEAR registry configuration.');
  const publishers = [];
  let from_index = '0';
  do {
    const response = await fetch(rpc.href, { method: 'POST', signal, credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      jsonrpc: '2.0', id: 'remora-directory', method: 'query', params: {
        request_type: 'call_function', finality: 'final', account_id: config.contractId, method_name: 'list_publishers',
        args_base64: btoa(JSON.stringify({ from_index, limit: 100 })),
      },
    }) });
    if (!response.ok) throw new Error('NEAR registry unavailable.');
    const body = await response.json();
    if (body.error || !Array.isArray(body.result?.result) || body.result.result.length > 131072) throw new Error('Invalid NEAR registry response.');
    const page = JSON.parse(new TextDecoder().decode(Uint8Array.from(body.result.result)));
    const now = Date.now() / 1000;
    if (!Array.isArray(page.publishers) || page.publishers.length > 100 || page.heartbeat_ttl_seconds !== 120 ||
        !/^\d+$/.test(page.observed_at) || Math.abs(now - Number(page.observed_at)) > 120 ||
        page.next_index !== null && (!/^\d+$/.test(page.next_index) || BigInt(page.next_index) <= BigInt(from_index))) throw new Error('Invalid NEAR registry page.');
    publishers.push(...page.publishers.map(item => ({ id: item.id, origin: item.origin,
      registryActive: item.active === true && /^\d+$/.test(item.last_seen) &&
        Number(item.last_seen) <= now + 5 && now - Number(item.last_seen) <= page.heartbeat_ttl_seconds })));
    from_index = page.next_index;
  } while (from_index !== null && publishers.length < 1000);
  return directoryEntries(publishers);
}

export async function probePublisher(entry, signal = AbortSignal.timeout(6000)) {
  const read = path => {
    if (entry.origin !== outlayerNetwork.origin) return json(entry.origin + path, signal);
    const url = new URL('/public/storage/get', outlayerNetwork.origin);
    url.search = new URLSearchParams({ project: outlayerNetwork.project, key: (path === '/copy/health' ? 'health:' : 'listing:') + entry.id, format: 'raw' }).toString();
    return json(url.href, signal);
  };
  const [envelope, health] = await Promise.all([
    read('/.well-known/agentstreams.json').catch(error => {
      if (error.message === 'Feed returned HTTP 404') return read('/.well-known/agentpay.json');
      throw error;
    }),
    read('/copy/health').catch(() => null),
  ]);
  const listing = await verifyListing(envelope, entry);
  const checkedAt = Date.now();
  const healthy = health?.ok === true && Number.isSafeInteger(health.observed_at) && Math.abs(checkedAt - health.observed_at * 1000) <= 30000;
  const modes = listing.activity === 'spot-trading' ? ['paper', 'agent-connect'] : ['wallet'];
  return { ...listing, checkedAt, state: healthy && entry.registryActive !== false && modes.includes(listing.execution) ? 'running' : healthy && entry.registryActive !== false ? 'unconfigured' : 'unavailable' };
}

export function usdcPerSecond(raw) {
  if (!raw) return '—';
  const value = raw.padStart(7, '0');
  const decimal = value.slice(-6).replace(/0+$/, '');
  return value.slice(0, -6) + (decimal ? '.' + decimal : '');
}

function copyTarget(agent) {
  const origin = /^[A-Za-z0-9.:/-]+$/.test(agent.origin)
    ? agent.origin
    : "'" + agent.origin.replaceAll("'", "'\\''") + "'";
  return agent.id + ' --url ' + origin;
}
export const previewCommand = agent => 'agentstream copy ' + copyTarget(agent);
export const startCommand = agent => 'agentstream copy start ' + copyTarget(agent) + ' --activity ' + agent.activity;
export const explorerUrl = hash => 'https://testnet.nearblocks.io/txns/' + hash;
