import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { JsonRpcProvider, PublicKey } from 'near-api-js';
import { configHome } from './config.mjs';
import { atomicWrite, readOptional, safeTarget } from './files.mjs';
import { decodeOutcome } from '@ola-893/agentstreams-core/near';

async function walletHome() {
  const home = configHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  if ((await stat(home)).mode & 0o077) throw new Error('AGENTSTREAMS_HOME must have permissions 0700.');
  return home;
}
const ownerWalletFile = () => safeTarget(configHome(), 'owner-wallet.json');
const rpcDefault = 'https://near-testnet.drpc.org';
const explorer = hash => `https://testnet.nearblocks.io/txns/${hash}`;
const hashPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const accountPattern = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet$/;
const walletAssetTypes = new Map([
  ['/', 'text/html; charset=utf-8'],
  ['/wallet.js', 'text/javascript; charset=utf-8'],
  ['/wallet.css', 'text/css; charset=utf-8'],
  ['/remora-icon.svg', 'image/svg+xml'],
  ['/remora-lockup-color.svg', 'image/svg+xml'],
]);
const callbackFields = new Map([
  ['/api/connect', ['accountId', 'publicKey', 'signature', 'walletId']],
  ['/api/transaction', ['hash']],
  ['/api/submitting', []],
  ['/api/cancel', []],
  ['/api/error', []],
]);
const canonical = value => JSON.stringify(sort(value));
function sort(value) { return Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])])) : value; }
const u32 = n => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(n); return bytes; };
const stringBytes = s => { const bytes = Buffer.from(s); return Buffer.concat([u32(bytes.length), bytes]); };

export function ownerMessageBytes({ message, nonce, recipient }) {
  const bytes = Buffer.from(nonce, 'base64');
  if (bytes.length !== 32) throw new Error('INVALID_OWNER_CHALLENGE');
  return createHash('sha256').update(Buffer.concat([u32(2147483648 + 413), stringBytes(message), bytes, stringBytes(recipient), Buffer.from([0])])).digest();
}

export async function verifyOwnerMessage(response, challenge, provider) {
  if (!accountPattern.test(response?.accountId ?? '') || response.accountId.length > 64 || typeof response.publicKey !== 'string' || typeof response.signature !== 'string') throw new Error('OWNER_SIGNATURE_REQUIRED');
  if (challenge.accountId && response.accountId !== challenge.accountId) throw new Error('OWNER_ACCOUNT_MISMATCH');
  if (!PublicKey.fromString(response.publicKey).verify(ownerMessageBytes(challenge), Buffer.from(response.signature, 'base64'))) throw new Error('OWNER_SIGNATURE_INVALID');
  if ((await provider.viewNodeStatus()).chain_id !== 'testnet') throw new Error('RPC_NETWORK_MISMATCH');
  const key = await provider.viewAccessKey({ accountId: response.accountId, publicKey: response.publicKey, blockQuery: { finality: 'final' } });
  if (key.permission !== 'FullAccess') throw new Error('OWNER_FULL_ACCESS_REQUIRED');
  return { version: 1, network: 'testnet', signer: 'browser-wallet', accountId: response.accountId, publicKey: response.publicKey,
    walletId: typeof response.walletId === 'string' ? response.walletId.slice(0, 100) : null, connectedAt: new Date().toISOString() };
}

export async function connectedOwner({ required = false, ownerId } = {}) {
  const home = configHome();
  const exists = await stat(home).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const text = exists ? await readOptional(await ownerWalletFile()) : null;
  if (!text) { if (required) throw new Error('OWNER_WALLET_REQUIRED: run agentstream wallet connect --network testnet.'); return null; }
  const wallet = JSON.parse(text);
  if (wallet.network !== 'testnet' || wallet.signer !== 'browser-wallet' || !accountPattern.test(wallet.accountId) || wallet.accountId.length > 64 || !Number.isInteger(wallet.port) || wallet.port < 1024 || wallet.port > 65535) throw new Error('INVALID_OWNER_WALLET');
  if (ownerId && wallet.accountId !== ownerId) throw new Error(`OWNER_ACCOUNT_MISMATCH: connect the wallet for ${ownerId}.`);
  return wallet;
}

// Compare the final chain transaction, never trust a wallet callback's claimed result.
export function chainAction(action) {
  if (action.FunctionCall) {
    const a = action.FunctionCall;
    return { type: 'FunctionCall', params: { methodName: a.method_name, args: JSON.parse(Buffer.from(a.args, 'base64').toString()), gas: String(a.gas), deposit: String(a.deposit) } };
  }
  if (action.Transfer) return { type: 'Transfer', params: { deposit: String(action.Transfer.deposit) } };
  if (action === 'CreateAccount' || action.CreateAccount) return { type: 'CreateAccount' };
  // NEAR's RPC ActionView returns the SHA-256 digest in the DeployContract code field.
  if (action.DeployContract) return { type: 'DeployContract', params: { codeHash: action.DeployContract.code } };
  if (action.AddKey) {
    const a = action.AddKey, p = a.access_key.permission;
    return { type: 'AddKey', params: { publicKey: a.public_key, accessKey: { nonce: a.access_key.nonce, permission: p === 'FullAccess' ? 'FullAccess' : { receiverId: p.FunctionCall.receiver_id, methodNames: p.FunctionCall.method_names, allowance: p.FunctionCall.allowance } } } };
  }
  if (action.DeleteKey) return { type: 'DeleteKey', params: { publicKey: action.DeleteKey.public_key } };
  if (action.DeleteAccount) return { type: 'DeleteAccount', params: { beneficiaryId: action.DeleteAccount.beneficiary_id } };
  throw new Error('UNEXPECTED_OWNER_ACTION');
}
export function verifyOwnerTransaction(outcome, plan, expectedHash) {
  const tx = outcome.transaction;
  if (outcome.final_execution_status !== 'FINAL') throw new Error('OWNER_TRANSACTION_NOT_FINAL');
  const expectedActions = plan.actions.map(action => {
    if (action.type !== 'DeployContract') return action;
    const codeHash = createHash('sha256').update(Buffer.from(action.params.codeBase64, 'base64')).digest('base64');
    return { type: 'DeployContract', params: { codeHash } };
  });
  if ((expectedHash && tx?.hash !== expectedHash) || tx?.signer_id !== plan.ownerId ||
      tx.receiver_id !== plan.receiverId || canonical(tx.actions.map(chainAction)) !== canonical(expectedActions)) {
    throw new Error('OWNER_TRANSACTION_PLAN_MISMATCH');
  }
  let receipt;
  try { receipt = decodeOutcome(outcome); if (receipt.receiptFailures.length) throw new Error('Receipt failure'); }
  catch { const error = new Error(`OWNER_TRANSACTION_FAILED: ${explorer(tx.hash)}`); error.confirmedFailure = true; throw error; }
  return { ...receipt, explorerUrl: explorer(receipt.hash), signing: 'browser-wallet' };
}

function equalSecret(actual, expected) {
  if (typeof actual !== 'string') return false;
  const bytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return bytes.length === expectedBytes.length && timingSafeEqual(bytes, expectedBytes);
}
async function body(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 8192) throw new Error('REQUEST_TOO_LARGE'); }
  return JSON.parse(raw || '{}');
}
const browserOpen = url => {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  execFile(command, args, error => { if (error) process.stderr.write('Open the owner-wallet URL printed above in your browser.\n'); });
};

export async function startOwnerSession({ kind, plan, minBlockHeight, rpcUrl = rpcDefault, port = 5389, accountId, onConnected, onSubmitting = async () => {}, onHash = async () => {}, provider = new JsonRpcProvider({ url: rpcUrl }), timeoutMs = 600000, assets = new URL('../wallet-ui/', import.meta.url) }) {
  if ((await provider.viewNodeStatus()).chain_id !== 'testnet') throw new Error('RPC_NETWORK_MISMATCH');
  const token = randomBytes(32).toString('hex'), id = randomUUID(), nonce = randomBytes(32).toString('base64');
  let settled = false, submitting = false, processing = false, resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // Callers may inspect the server before attaching their completion handler.
  done.catch(() => {});
  const challenge = { message: `Connect your wallet to Remora on NEAR testnet. Session ${id}. No transaction or spending approval.`, nonce, recipient: 'agentstreams.local', ...(accountId ? { accountId } : {}) };
  const server = createServer(async (req, res) => {
    const send = (status, data, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
      res.end(typeof data === 'string' && type !== 'application/json' ? data : JSON.stringify(data));
    };
    let ownsRequest = false;
    try {
      if (req.headers.host !== `127.0.0.1:${server.address().port}`) return send(403, { error: 'HOST_REJECTED' });
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      const assetType = walletAssetTypes.get(path);
      if (req.method === 'GET' && assetType) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        return send(200, await readFile(new URL(file, assets), 'utf8'), assetType);
      }
      if (!equalSecret(req.headers.authorization, `Bearer ${token}`)) return send(403, { error: 'SESSION_REQUIRED' });
      if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${server.address().port}`) return send(403, { error: 'ORIGIN_REJECTED' });
      if (req.method === 'GET' && path === '/api/session') return send(200, { id, kind, network: 'testnet', challenge, plan, submitted: submitting, complete: settled });
      if (req.method !== 'POST') return send(405, { error: 'METHOD_NOT_ALLOWED' });
      if (settled) return send(409, { error: 'SESSION_COMPLETE' });
      if (processing) return send(409, { error: 'WALLET_REQUEST_IN_PROGRESS' });
      processing = ownsRequest = true;
      const data = await body(req);
      const fields = callbackFields.get(path);
      if (fields && (!data || typeof data !== 'object' || Array.isArray(data) ||
          Object.keys(data).some(field => !fields.includes(field)))) {
        return send(400, { error: 'INVALID_WALLET_CALLBACK' });
      }
      if (path === '/api/connect' && kind === 'connect') {
        const wallet = await verifyOwnerMessage(data, challenge, provider);
        await onConnected?.(wallet);
        settled = true; send(200, { connected: true, accountId: wallet.accountId }); resolveDone(wallet); return;
      }
      if (path === '/api/submitting' && kind === 'transaction') {
        if (submitting) return send(409, { error: 'ALREADY_SUBMITTING' });
        submitting = true;
        try { await onSubmitting(); } catch (error) { submitting = false; throw error; }
        return send(200, { submitting: true });
      }
      if (path === '/api/transaction' && kind === 'transaction' && submitting) {
        if (!hashPattern.test(data.hash ?? '')) return send(400, { error: 'TRANSACTION_HASH_REQUIRED' });
        await onHash(data.hash);
        const outcome = await provider.viewTransactionStatus({ txHash: data.hash, accountId: plan.ownerId, waitUntil: 'FINAL' });
        await verifyTransactionFreshness(provider, outcome, minBlockHeight);
        const receipt = verifyOwnerTransaction(outcome, plan, data.hash);
        settled = true; send(200, { confirmed: true, transactionHash: receipt.hash, explorerUrl: receipt.explorerUrl }); resolveDone(receipt); return;
      }
      if (path === '/api/cancel' && !submitting) { settled = true; send(200, { cancelled: true }); rejectDone(new Error('OWNER_WALLET_CANCELLED')); return; }
      if (path === '/api/error') { settled = true; send(200, { needsReconciliation: submitting }); rejectDone(new Error(submitting ? 'OWNER_WALLET_OUTCOME_UNCONFIRMED: run agentstream wallet reconcile.' : 'OWNER_WALLET_REQUEST_FAILED')); return; }
      return send(404, { error: 'NOT_FOUND' });
    } catch (error) {
      send(400, { error: error.message });
      if (error.confirmedFailure) { settled = true; rejectDone(error); }
    } finally {
      if (ownsRequest) processing = false;
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const timer = setTimeout(() => rejectDone(new Error(submitting ? 'OWNER_WALLET_OUTCOME_UNCONFIRMED: run agentstream wallet reconcile.' : 'OWNER_WALLET_TIMEOUT')), timeoutMs); timer.unref();
  return { url: `http://127.0.0.1:${server.address().port}/#${token}`, id, done, close: async () => { clearTimeout(timer); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); } };
}

async function waitInBrowser(options) {
  const session = await startOwnerSession(options);
  process.stderr.write(JSON.stringify({ ownerWalletApproval: true, operation: options.kind === 'connect' ? 'Connect wallet' : options.plan.label, url: session.url }) + '\n');
  browserOpen(session.url);
  try { return await session.done; } finally { await session.close(); }
}

export async function connectOwnerWallet({ port = 5389, rpcUrl = rpcDefault, accountId } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_OWNER_WALLET_PORT');
  await walletHome();
  const file = await ownerWalletFile();
  const wallet = await waitInBrowser({
    kind: 'connect', port, rpcUrl, accountId,
    onConnected: data => atomicWrite(file, JSON.stringify({ ...data, port, rpcUrl })),
  });
  return { ...wallet, connected: true, port, privateKeysStored: false };

}
export async function disconnectOwnerWallet() {
  try { await unlink(await ownerWalletFile()); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { disconnected: true };
}

async function verifyTransactionFreshness(provider, outcome, minBlockHeight) {
  if (minBlockHeight === undefined) return;
  const blockHash = outcome.transaction_outcome?.block_hash;
  if (!blockHash) throw new Error('OWNER_TRANSACTION_BLOCK_REQUIRED');
  const block = await provider.viewBlock({ blockId: blockHash });
  if (block.header.height <= minBlockHeight) throw new Error('OWNER_TRANSACTION_PREDATES_APPROVAL');
}

async function archiveOperation(file, operation, status) {
  await atomicWrite(join(file, '..', operation.id + '.json'), JSON.stringify({ ...operation, status }));
  await unlink(file);
}

export async function ownerTransaction({ ownerId, receiverId, actions, label, rpcUrl, context = {} }, {
  sign = waitInBrowser, provider = new JsonRpcProvider({ url: rpcUrl }), beforeSubmit,
} = {}) {
  const wallet = await connectedOwner({ required: true, ownerId });
  const directory = await safeTarget(await walletHome(), 'owner-operations');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pendingFile = join(directory, 'pending.json');
  if (await readOptional(pendingFile)) throw new Error('OWNER_OPERATION_RECONCILIATION_REQUIRED: run agentstream wallet reconcile.');
  if ((await provider.viewNodeStatus()).chain_id !== 'testnet') throw new Error('RPC_NETWORK_MISMATCH');
  const minBlockHeight = (await provider.viewBlock({ finality: 'final' })).header.height;
  const operation = {
    version: 1, id: randomUUID(), plan: { ownerId, receiverId, actions, label }, context, rpcUrl,
    minBlockHeight, pid: process.pid, status: 'awaiting-wallet', createdAt: new Date().toISOString(),
  };
  const lock = await open(pendingFile, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('OWNER_OPERATION_BUSY');
    throw error;
  });
  try {
    await lock.writeFile(JSON.stringify(operation));
    await lock.sync();
  } finally {
    await lock.close();
  }
  const save = () => atomicWrite(pendingFile, JSON.stringify(operation));
  try {
    const receipt = await sign({
      kind: 'transaction', port: wallet.port, rpcUrl, provider, plan: operation.plan, minBlockHeight,
      onSubmitting: async () => { await beforeSubmit?.(); operation.status = 'submitting'; await save(); },
      onHash: async hash => { operation.hash = hash; await save(); },
    });
    operation.receipt = receipt;
    await archiveOperation(pendingFile, operation, 'confirmed');
    return receipt;
  } catch (error) {
    if (operation.status === 'awaiting-wallet' || error.confirmedFailure) {
      await archiveOperation(pendingFile, operation, error.confirmedFailure ? 'failed' : 'cancelled');
    } else {
      delete operation.pid;
      await save();
    }
    throw error;
  }
}

export async function reconcileOwnerWallet(hash, { provider: provided, cancel = false } = {}) {
  if (hash && cancel) throw new Error('Choose --hash or --cancel.');
  const file = join(configHome(), 'owner-operations/pending.json');
  if (await readOptional(file) === null) return { resolved: true, reason: 'NO_PENDING_OWNER_OPERATION' };
  const lockFile = file + '.lock';
  const lock = await open(lockFile, 'wx', 0o600);
  try {
    const text = await readOptional(file);
    if (!text) return { resolved: true, reason: 'NO_PENDING_OWNER_OPERATION' };
    const operation = JSON.parse(text);
    if (operation.pid) {
      let active = true;
      try { process.kill(operation.pid, 0); } catch (error) { if (error.code === 'ESRCH') active = false; else throw error; }
      if (active) throw new Error('OWNER_OPERATION_BUSY: finish or cancel the current wallet request first.');
    }
    if (cancel) {
      if (operation.hash) throw new Error('OWNER_TRANSACTION_ALREADY_REPORTED: reconcile the saved transaction hash.');
      await archiveOperation(file, operation, 'cancelled-by-owner');
      return { resolved: true, cancelled: true };
    }
    if (hash) {
      if (!hashPattern.test(hash)) throw new Error('INVALID_TRANSACTION_HASH');
      operation.hash = hash;
    }
    if (!operation.hash) return {
      resolved: false,
      reason: 'OWNER_TRANSACTION_HASH_REQUIRED',
      next: 'If your wallet submitted the transaction, run agentstream wallet reconcile --hash HASH. If you declined and verified that nothing was submitted, run agentstream wallet reconcile --cancel.',
    };
    const provider = provided || new JsonRpcProvider({ url: operation.rpcUrl });
    try {
      const outcome = await provider.viewTransactionStatus({
        txHash: operation.hash, accountId: operation.plan.ownerId, waitUntil: 'FINAL',
      });
      await verifyTransactionFreshness(provider, outcome, operation.minBlockHeight);
      operation.receipt = verifyOwnerTransaction(outcome, operation.plan, operation.hash);
    } catch (error) {
      if (!error.confirmedFailure) throw error;
      await archiveOperation(file, operation, 'failed');
      return { resolved: true, failed: true, transactionHash: operation.hash, explorerUrl: explorer(operation.hash) };
    }
    await archiveOperation(file, operation, 'confirmed');
    return { resolved: true, receipt: operation.receipt, context: operation.context };
  } finally {
    await lock.close();
    await unlink(lockFile);
  }
}
