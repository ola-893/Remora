import { encryptOutlayerInput, transportProtocol } from './outlayer-transport.mjs';
import { requireOutlayerVerifier, verifyOutlayerCall } from './outlayer-attestation.mjs';
import { JsonRpcProvider } from 'near-api-js';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical } from '@ola-893/agentstreams-core/internal-evidence-audit';
import { outlayerNetwork, publicOutlayerRecord, outlayerListing, outlayerServiceJson } from '@ola-893/agentstreams-core/internal-outlayer';
import { configHome } from './config.mjs';
import { atomicWrite } from './files.mjs';
import { feedKey, readAgentState, withAgentState } from './agents.mjs';
import { signedListing } from './copy-feed.mjs';

export { outlayerNetwork };

async function computeKey() {
  const file = join(configHome(), 'outlayer-key.json');
  const info = await stat(file).catch(error => { if (error.code === 'ENOENT') throw new Error('REMORA_COMPUTE_UNAVAILABLE: Remora compute sponsorship is not configured on this host. Users do not provide OutLayer keys.'); throw error; });
  if (!info.isFile() || info.mode & 0o077 || (await stat(configHome())).mode & 0o077) throw new Error('OUTLAYER_KEY_STORAGE_NOT_PRIVATE');
  const { apiKey } = JSON.parse(await readFile(file, 'utf8'));
  if (!/^[a-z0-9._-]+:[0-9]+:[A-Za-z0-9_-]{32,256}$/.test(apiKey ?? '')) throw new Error('INVALID_OUTLAYER_COMPUTE_KEY');
  return apiKey;
}

export async function callAttestedOutlayer(input, { fetchImpl = fetch, version = outlayerNetwork.version, verify = verifyOutlayerCall } = {}) {
  if (!version || !/^[a-f0-9]{64}$/.test(version)) throw new Error('OUTLAYER_PROJECT_NOT_DEPLOYED');
  const apiKey = await computeKey();
  if (verify === verifyOutlayerCall) await requireOutlayerVerifier();
  const response = await fetchImpl(`${outlayerNetwork.origin}/call/${outlayerNetwork.project}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
    headers: { 'content-type': 'application/json', 'X-Payment-Key': apiKey, 'X-Compute-Limit': '2000' },
    body: JSON.stringify({ input, version_key: version }) });
  let result = await response.json();
  if (!response.ok) {
    const reason = typeof result.reason === 'string' && /^[a-z_]{1,64}$/.test(result.reason) ? ':' + result.reason : '';
    throw new Error(`OUTLAYER_HTTP_${response.status}${reason}`);
  }
  const callId = result.call_id;
  // Poll the original call. Retrying POST can charge and execute it twice.
  for (let attempt = 0; result.status === 'pending' && attempt < 30; attempt++) {
    if (!/^[a-f0-9-]{36}$/.test(result.call_id ?? '')) throw new Error('OUTLAYER_CALL_ID_REQUIRED');
    await new Promise(resolve => setTimeout(resolve, 1000));
    const poll = await fetchImpl(`${outlayerNetwork.origin}/calls/${result.call_id}`, { headers: { 'X-Payment-Key': apiKey }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!poll.ok) throw new Error(`OUTLAYER_HTTP_${poll.status}`);
    result = await poll.json();
  }
  if (result.status !== 'completed' || !result.output || typeof result.output !== 'object') throw new Error('OUTLAYER_EXECUTION_UNCONFIRMED');
  const proof = await verify({ callId, input, output: result.output, version, caller: apiKey.split(':')[0] });
  if (proof?.verified) await atomicWrite(join(configHome(), 'outlayer-verification.json'), JSON.stringify({ ...proof, verifiedAt: new Date().toISOString(), transport: input.operation }));
  if (result.output.error) throw new Error('OUTLAYER_FEED_' + String(result.output.error).slice(0, 120));
  return result.output;
}

export async function requireSecretBuildLock(version, provider = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' })) {
  const owner = outlayerNetwork.project.split('/')[0];
  const row = await provider.callFunction({ contractId: 'outlayer.testnet', method: 'get_secrets',
    args: { accessor: { Project: { project_id: outlayerNetwork.project } }, profile: 'remora-feed-v1', owner }, blockQuery: { finality: 'final' } });
  if (JSON.stringify(row?.access) !== JSON.stringify({ WasmHash: { hash: version } })) throw new Error('OUTLAYER_SECRET_BUILD_LOCK_REQUIRED');
}

const transportKeys = new Map();
export async function callOutlayer(input, options = {}) {
  const version = options.version ?? outlayerNetwork.version;
  if (!transportKeys.has(version)) {
    if (!options.verify || options.verify === verifyOutlayerCall) await requireSecretBuildLock(version);
    const key = await callAttestedOutlayer({ operation: 'transport-key' }, options);
    if (key.protocol !== transportProtocol || typeof key.publicKey !== 'string') throw new Error('OUTLAYER_TRANSPORT_KEY_INVALID');
    transportKeys.set(version, key.publicKey);
  }
  const encrypted = await encryptOutlayerInput(transportKeys.get(version), input);
  const envelope = await callAttestedOutlayer(encrypted.input, options);
  const result = await encrypted.decrypt(envelope);
  if (result.error) throw new Error('OUTLAYER_FEED_' + String(result.error).slice(0, 120));
  return result;
}

export async function outlayerDeliveryKey(agent) {
  const { publicKey } = await callOutlayer({ operation: 'delivery-key' });
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(publicKey ?? '')) throw new Error('INVALID_OUTLAYER_DELIVERY_KEY');
  await withAgentState(agent, state => {
    if (state.outlayerDeliveryKey && state.outlayerDeliveryKey !== publicKey) for (const pointer of state.journal ?? []) pointer.outlayerUploaded = false;
    state.outlayerDeliveryKey = publicKey;
  });
  return publicKey;
}

export async function publishOutlayer(agent, active = true) {
  const state = await readAgentState(agent);
  if (state.publish?.delivery !== 'outlayer') return null;
  if (!state.outlayerDeliveryKey) throw new Error('OUTLAYER_DELIVERY_KEY_REQUIRED');
  const listing = await signedListing(agent, state);
  const body = { publisher: agent.id, at: Date.now(), active, listingHash: createHash('sha256').update(canonical(listing)).digest('hex') };
  const key = await feedKey(agent);
  const control = { body, signature: Buffer.from(key.sign(Buffer.from(canonical({ domain: 'remora.delivery-control.v1', body }))).signature).toString('base64') };
  await callOutlayer({ operation: 'publish', listing, control });
  return { publisherId: agent.id, delivery: 'outlayer', active };
}

export async function appendOutlayer(agent, entry) {
  return callOutlayer({ operation: 'append', publisher: agent.id, entry });
}

export async function outlayerFeedResponse(publisher, path, headers = {}) {
  try {
    let result;
    if (path.startsWith('/.well-known/')) result = await outlayerListing(publisher);
    else if (path === '/copy/health') result = await publicOutlayerRecord('health:' + publisher);
    else if (path.startsWith('/copy/quote/')) {
      const { body: listing } = await outlayerListing(publisher);
      const vaultId = new URL(path, outlayerNetwork.origin).pathname.split('/')[3];
      result = await outlayerServiceJson({ serviceUrl: outlayerNetwork.origin, vaultId,
        tokenId: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af', service: { publisher, healthPath: '/copy/health' } }, path);
      if (result.publisher !== listing.id) throw new Error('OUTLAYER_PUBLISHER_MISMATCH');
    } else if (path.startsWith('/copy/signals/')) {
      if (!headers['x-agentpay-session']) return Response.json({ protocol: 'agentpay-near-v1' }, { status: 402 });
      const url = new URL(path, outlayerNetwork.origin);
      result = await callOutlayer({ operation: 'signal', publisher, session: headers['x-agentpay-session'],
        signalId: url.pathname.slice('/copy/signals/'.length), nonce: url.searchParams.get('nonce') });
    } else if (path.startsWith('/copy/actions')) {
      if (!headers['x-agentpay-session']) return Response.json({ protocol: 'agentpay-near-v1' }, { status: 402 });
      result = await callOutlayer({ operation: 'actions', publisher, session: headers['x-agentpay-session'], after: Number(new URL(path, outlayerNetwork.origin).searchParams.get('after') ?? 0) });
    } else return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    return Response.json(result);
  } catch (error) {
    const denied = /^OUTLAYER_FEED_(STREAM_|SESSION_|SIGNAL_|UNTRUSTED_|QUOTE_|PUBLICATION_STOPPED)/.test(error.message);
    if (denied) return Response.json({ error: 'STREAM_ACCESS_DENIED' }, { status: 403 });
    throw error;
  }
}
