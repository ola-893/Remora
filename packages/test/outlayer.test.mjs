import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { KeyPair } from 'near-api-js';
import { canonical } from '../../near/lib/audit.mjs';
import { outlayerListing, outlayerNetwork, outlayerServiceJson, publicOutlayerRecord } from '../../near/lib/outlayer.mjs';
import { callOutlayer } from '../cli/src/outlayer.mjs';
import { verifyPage } from '../cli/src/copy-feed.mjs';

const key = KeyPair.fromRandom('ed25519');
const publicKey = key.getPublicKey().toString();
const id = 'ap_' + createHash('sha256').update(publicKey).digest('hex');
const listing = { version: 1, id, publicKey, network: 'testnet', origin: outlayerNetwork.origin, recipient: 'publisher.testnet',
  delivery: 'outlayer', activity: 'portfolio-rebalance', rate: '1', duration: 0 };
const signed = (signer, domain, body) => ({ body, signature: Buffer.from(signer.sign(Buffer.from(canonical({ domain, body }))).signature).toString('base64') });

test('OutLayer public records verify publisher signatures and cannot substitute a listing', async () => {
  const envelope = signed(key, 'agentpay.listing.v1', listing);
  const fetchImpl = async (url, init) => {
    assert.equal(url.origin, outlayerNetwork.origin);
    assert.equal(url.searchParams.get('key'), 'listing:' + id);
    assert.equal(url.searchParams.get('format'), 'raw');
    assert.equal(init.credentials, 'omit');
    return Response.json(envelope);
  };
  assert.equal((await outlayerListing(id, { fetchImpl })).body.id, id);
  envelope.body = { ...envelope.body, rate: '2' };
  await assert.rejects(outlayerListing(id, { fetchImpl }), /INVALID_SIGNED_LISTING/);
  await assert.rejects(publicOutlayerRecord('entry:' + id, { fetchImpl: async () => new Response('', { status: 403 }) }), /FEED_HTTP_403/);
});

test('OutLayer service quotes preserve the vault payment hash format', async () => {
  const config = { serviceUrl: outlayerNetwork.origin, vaultId: 'vault.testnet', tokenId: 'circle.testnet',
    service: { publisher: id, healthPath: '/copy/health' } };
  const envelope = signed(key, 'agentpay.listing.v1', listing);
  const quote = await outlayerServiceJson(config, '/copy/quote/vault.testnet?tier=basic', { fetchImpl: async () => Response.json(envelope) });
  assert.deepEqual(Object.keys(quote), ['version', 'vault_id', 'token_id', 'recipient_id', 'tier', 'rate', 'duration_seconds', 'expires_at', 'publisher', 'origin', 'activity']);
  assert.equal(quote.publisher, id);
  assert.equal(quote.rate, '1');
  assert.equal(quote.vault_id, config.vaultId);
  await assert.rejects(outlayerServiceJson(config, '/copy/quote/other.testnet?tier=basic'), /INVALID_OUTLAYER_QUOTE_PATH/);
  await assert.rejects(outlayerServiceJson({ ...config, serviceUrl: 'https://attacker.example' }, '/copy/health'), /INVALID_OUTLAYER_SERVICE/);
});

test('paid pages accept only the delivery key explicitly delegated by the publisher', () => {
  const delivery = KeyPair.fromRandom('ed25519');
  const offer = { ...listing, deliveryKey: delivery.getPublicKey().toString() };
  const page = { sessionId: 'session', after: 0, cursor: 0, observedAt: Date.now(), entries: [] };
  assert.equal(verifyPage(signed(delivery, 'agentpay.page.v1', page), offer, 'session', 0, 30).cursor, 0);
  assert.throws(() => verifyPage(signed(key, 'agentpay.page.v1', page), offer, 'session', 0, 30), /FEED_STALE_OR_INVALID/);
  assert.throws(() => verifyPage(signed(delivery, 'agentpay.page.v1', page), offer, 'other', 0, 30), /FEED_STALE_OR_INVALID/);
});

test('OutLayer execution pins the build, caps compute and polls the original pending call', async t => {
  const previousHome = process.env.AGENTSTREAMS_HOME;
  const home = await mkdtemp(join(tmpdir(), 'remora-outlayer-'));
  process.env.AGENTSTREAMS_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.AGENTSTREAMS_HOME;
    else process.env.AGENTSTREAMS_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });
  const apiKey = 'fixture.testnet:1:' + 'a'.repeat(64);
  await writeFile(join(home, 'outlayer-key.json'), JSON.stringify({ version: 1, apiKey }), { mode: 0o600 });
  let posts = 0, polls = 0;
  const result = await callOutlayer({ operation: 'delivery-key' }, { version: 'b'.repeat(64), fetchImpl: async (url, init) => {
    assert.equal(new URL(url).origin, outlayerNetwork.origin);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['X-Payment-Key'], apiKey);
    if (init.method === 'POST') {
      posts++;
      const body = JSON.parse(init.body);
      assert.equal(body.version_key, 'b'.repeat(64));
      assert.equal(init.headers['X-Compute-Limit'], '2000');
      assert.equal(body.apiKey, undefined);
      return Response.json({ status: 'pending', call_id: '12345678-1234-1234-1234-123456789012' });
    }
    polls++;
    return Response.json({ status: 'completed', output: { publicKey } });
  } });
  assert.equal(result.publicKey, publicKey);
  assert.equal(posts, 1);
  assert.equal(polls, 1);
});
