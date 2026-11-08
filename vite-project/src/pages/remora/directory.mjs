export const activities = {
  'spot-trading': { name: 'Spot trading', action: 'Swap fills', focus: 'Inspect fills, execution mode, and reported P&L. A swap receipt alone does not establish return.' },
  'staking-moves': { name: 'Staking moves', action: 'Staking actions', focus: 'Inspect staking, unstaking, and withdrawals through the pool receipt. Action counts do not measure staking yield.' },
  'liquidity-ranges': { name: 'Liquidity ranges', action: 'Liquidity actions', focus: 'Inspect the pool and range changes in the receipt. Fees, time in range, and impermanent loss require position data.' },
  'portfolio-rebalance': { name: 'Portfolio rebalance', action: 'Rebalances', focus: 'Inspect rebalance receipts for assets and movements. Weight drift and returns require portfolio snapshots.' },
  'yield-reallocation': { name: 'Yield reallocation', action: 'Lending actions', focus: 'Inspect the supplied or withdrawn asset in the receipt. Realized yield requires balance and valuation data.' },
  'reward-reinvestment': { name: 'Reward reinvestment', action: 'Reinvestments', focus: 'Inspect the compounding receipt. Net rewards require before-and-after balances and execution costs.' },
};
export const publisherId = /^ap_[a-f0-9]{64}$/;
const hashPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
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
  return [...new Map(input.slice(0, 100).flatMap(item => {
    try {
      if (typeof item?.id !== 'string' || !publisherId.test(item.id)) return [];
      return [[item.id, { id: item.id, origin: feedOrigin(item.origin, allowLoopback) }]];
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
  const history = Array.isArray(b.history) ? b.history.slice(-50).flatMap(item => {
    const kinds = b.activity === 'spot-trading' ? ['paper-fill', 'intent-fill'] : ['wallet-action'];
    if (!item || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at)) || !kinds.includes(item.kind)) return [];
    return [{ at: item.at, kind: item.kind, ...(item.kind === 'wallet-action' && hashPattern.test(item.receipt ?? '') ? { receipt: item.receipt } : {}) }];
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) : [];
  const points = b.performance?.provenance === 'publisher-reported' && Array.isArray(b.performance.points)
    ? b.performance.points.slice(0, 90).filter(p => p && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number.isFinite(Date.parse(p.date)) && Number.isFinite(p.pnl) && Math.abs(p.pnl) <= Number.MAX_SAFE_INTEGER)
      .sort((a, b) => a.date.localeCompare(b.date)).map(({ date, pnl }) => ({ date, pnl }))
    : [];
  return { ...entry, name: b.name, activity: b.activity, execution: b.execution, network: b.network,
    recipient: b.recipient, rate: b.rate, duration: b.duration, journal: b.journal, history, points };
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

export async function probePublisher(entry, signal = AbortSignal.timeout(6000)) {
  const read = path => json(entry.origin + path, signal);
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
  return { ...listing, checkedAt, state: healthy && modes.includes(listing.execution) ? 'running' : healthy ? 'unconfigured' : 'unavailable' };
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
