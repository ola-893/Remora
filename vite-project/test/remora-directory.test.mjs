import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { canonical } from '../../packages/core/runtime/near/lib/audit.mjs';
import { directoryEntries, previewCommand, probePublisher, usdcPerSecond, verifyListing } from '../src/pages/remora/directory.mjs';

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
  history: [{ at: '2026-11-08T07:00:00.000Z', kind: 'wallet-action', receipt: '4voSKkptSLs1BV2qNYWxadsRhkMDBZG6nmDkwST6ebBA' }],
});
const signed = body => ({ body, signature: sign(null, Buffer.from(canonical({ domain: 'agentpay.listing.v1', body })), privateKey).toString('base64') });

test('signed listings bind the rate and activity to the publisher ID and origin', async () => {
  const origin = 'https://publisher.example';
  const listing = signed(offer(origin));
  const verified = await verifyListing(listing, { id, origin });
  assert.equal(verified.history[0].kind, 'wallet-action');
  assert.equal(usdcPerSecond(verified.rate), '0.000001');
  assert.equal(previewCommand(verified), 'agentstream copy ' + id + ' --url ' + origin);
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
    age = 60;
    assert.equal((await probePublisher(entry)).state, 'unavailable');
    age = 0;
    execution = 'unconfigured';
    assert.equal((await probePublisher(entry)).state, 'unconfigured');
  } finally { await new Promise(done => server.close(done)); }
});
