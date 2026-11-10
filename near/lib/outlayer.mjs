import { createHash } from 'node:crypto';
import { PublicKey } from 'near-api-js';
import { canonical } from './audit.mjs';
import network from './outlayer-network.json' with { type: 'json' };

export const outlayerNetwork = network;

export async function publicOutlayerRecord(key, { signal = AbortSignal.timeout(10000), fetchImpl = fetch } = {}) {
  const url = new URL('/public/storage/get', network.origin);
  url.search = new URLSearchParams({ project: network.project, key, format: 'raw' }).toString();
  const response = await fetchImpl(url, { signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`FEED_HTTP_${response.status}`);
  const bytes = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > 131072) throw new Error('FEED_RESPONSE_TOO_LARGE');
    bytes.push(part);
  }
  return JSON.parse(Buffer.concat(bytes).toString('utf8'));
}

export async function outlayerListing(id, options) {
  const envelope = await publicOutlayerRecord('listing:' + id, options);
  const b = envelope?.body;
  if (!b || b.id !== id || b.origin !== network.origin || b.network !== network.network || b.delivery !== 'outlayer' ||
      id !== 'ap_' + createHash('sha256').update(b.publicKey ?? '').digest('hex') || typeof envelope.signature !== 'string' ||
      !PublicKey.fromString(b.publicKey).verify(Buffer.from(canonical({ domain: 'agentpay.listing.v1', body: b })), Buffer.from(envelope.signature, 'base64'))) {
    throw new Error('INVALID_SIGNED_LISTING');
  }
  return envelope;
}

export async function outlayerServiceJson(config, path, options) {
  const id = config.service.publisher;
  if (config.serviceUrl !== network.origin || !/^ap_[a-f0-9]{64}$/.test(id ?? '')) throw new Error('INVALID_OUTLAYER_SERVICE');
  if (path === config.service.healthPath) return publicOutlayerRecord('health:' + id, options);
  const url = new URL(path, network.origin);
  const parts = url.pathname.split('/');
  if (parts[1] !== 'copy' || parts[2] !== 'quote' || parts[3] !== config.vaultId || url.searchParams.get('tier') !== 'basic') throw new Error('INVALID_OUTLAYER_QUOTE_PATH');
  const { body: listing } = await outlayerListing(id, options);
  const now = Math.floor(Date.now() / 1000);
  const next = Math.floor(now / 60) * 60 + 120;
  const expiresAt = parts[4] === undefined ? next : Number(parts[4]);
  if (parts.length > 5 || ![next, next - 60].includes(expiresAt) || expiresAt <= now) throw new Error('INVALID_QUOTE_REQUEST');
  return { version: 1, vault_id: config.vaultId, token_id: config.tokenId, recipient_id: listing.recipient,
    tier: 'basic', rate: listing.rate, duration_seconds: listing.duration, expires_at: expiresAt,
    publisher: listing.id, origin: listing.origin, activity: listing.activity };
}
