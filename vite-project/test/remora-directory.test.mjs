import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { canonical } from '../../near/lib/audit.mjs';
import { directoryEntries, previewCommand, probePublisher, registryEntries, startCommand, usdcPerSecond, verifyListing } from '../src/pages/remora/directory.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const bytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let n = BigInt('0x' + bytes.toString('hex'));
let key = '';
while (n) { key = alphabet[Number(n % 58n)] + key; n /= 58n; }
const firstNonZero = bytes.findIndex(byte => byte !== 0);
key = 'ed25519:' + '1'.repeat(firstNonZero) + key;
const id = 'ap_' + createHash('sha256').update(key).digest('hex');
const offer = origin => ({
  version: 1, id, origin, publicKey: key, name: 'Test publisher', network: 'testnet',
  recipient: 'publisher.testnet', activity: 'staking-moves', execution: 'wallet', rate: '1', duration: 0,
  historyPolicy: { delaySeconds: 86400, granularity: 'day', receipts: false },
  history: [{ at: '2026-11-07T00:00:00.000Z', kind: 'wallet-action', count: 2, receipt: '4voSKkptSLs1BV2qNYWxadsRhkMDBZG6nmDkwST6ebBA' }],
});
const signed = body => ({ body, signature: sign(null, Buffer.from(canonical({ domain: 'agentpay.listing.v1', body })), privateKey).toString('base64') });

test('signed listings bind the rate and activity to the publisher ID and origin', async () => {
  const origin = 'https://publisher.example';
  const listing = signed(offer(origin));
  const verified = await verifyListing(listing, { id, origin });
  assert.equal(verified.history[0].kind, 'wallet-action');
  assert.equal(verified.history[0].count, 2);
  assert.equal(verified.history[0].receipt, undefined);
  assert.equal(usdcPerSecond(verified.rate), '0.000001');
  assert.equal(previewCommand(verified), 'agentstream copy ' + id + ' --url ' + origin);
  assert.equal(startCommand(verified), 'agentstream copy start ' + id + ' --url ' + origin + ' --activity staking-moves');
  await assert.rejects(verifyListing({ ...listing, body: { ...listing.body, rate: '2' } }, { id, origin }), /signature/i);
  await assert.rejects(verifyListing(listing, { id, origin: 'https://elsewhere.example' }), /invalid/i);
  assert.deepEqual(directoryEntries([{ id, origin: 'https://publisher.example/path' }]), []);
});

test('fresh health and enabled activity are required for running status', async () => {
  let age = 0;
  let execution = 'wallet';
  const server = createServer((req, res) => {
    const origin = 'http://127.0.0.1:' + server.address().port;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/copy/health'
      ? { ok: true, observed_at: Math.floor(Date.now() / 1000) - age }
      : signed({ ...offer(origin), execution })));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const entry = { id, origin: 'http://127.0.0.1:' + server.address().port };
  try {
    assert.equal((await probePublisher(entry)).state, 'running');
    assert.equal((await probePublisher({ ...entry, registryActive: false })).state, 'unavailable');
    age = 60;
    assert.equal((await probePublisher(entry)).state, 'unavailable');
    age = 0;
    execution = 'unconfigured';
    assert.equal((await probePublisher(entry)).state, 'unconfigured');
  } finally { await new Promise(done => server.close(done)); }
});

test('Explore reads paginated NEAR registrations and expires stopped or stale publishers', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://rpc.testnet.example/');
    const request = JSON.parse(options.body);
    assert.equal(request.params.method_name, 'list_publishers');
    assert.equal(request.params.finality, 'final');
    const args = JSON.parse(atob(request.params.args_base64));
    assert.equal(args.from_index, calls === 0 ? '0' : '1');
    const now = Math.floor(Date.now() / 1000);
    const page = { publishers: [{ id: calls === 0 ? id : 'ap_' + 'f'.repeat(64), origin: 'https://publisher.example', active: true,
      last_seen: String(now - (calls === 0 ? 0 : 121)) }], observed_at: String(now), next_index: calls === 0 ? '1' : null, heartbeat_ttl_seconds: 120 };
    calls++;
    return new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(page))] } }));
  });
  const entries = await registryEntries({ network: 'testnet', contractId: 'registry.testnet', rpcUrl: 'https://rpc.testnet.example' });
  assert.equal(calls, 2);
  assert.equal(entries[0].registryActive, true);
  assert.equal(entries[1].registryActive, false);
  assert.equal(directoryEntries([{ ...entries[0], registryActive: true }, { ...entries[0], registryActive: false }])[0].registryActive, false);
});

test('Explore refuses malformed registry pagination and stale RPC snapshots', async t => {
  const page = { publishers: [], observed_at: String(Math.floor(Date.now() / 1000)), next_index: '0', heartbeat_ttl_seconds: 120 };
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(page))] } })));
  const config = { network: 'testnet', contractId: 'registry.testnet', rpcUrl: 'https://rpc.testnet.example' };
  await assert.rejects(registryEntries(config), /Invalid NEAR registry page/);
  page.next_index = null;
  page.observed_at = '1';
  await assert.rejects(registryEntries(config), /Invalid NEAR registry page/);
});

test('Explore accepts signed limit-order history and builds the matching copy command', async () => {
  const origin = 'https://publisher.example';
  const verified = await verifyListing(signed({ ...offer(origin), activity: 'limit-orders' }), { id, origin });
  assert.equal(verified.activity, 'limit-orders');
  assert.equal(verified.history[0].count, 2);
  assert.equal(verified.history[0].receipt, undefined);
  assert.equal(startCommand(verified), 'agentstream copy start ' + id + ' --url ' + origin + ' --activity limit-orders');
});
