import { JsonRpcProvider, baseEncode } from 'near-api-js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { verifyRun, canonical } from './audit.mjs';
import { decodeOutcome, NearAgentStreamsClient } from '../sdk/index.mjs';

export const explorer = hash => `https://testnet.nearblocks.io/txns/${hash}`;
export async function verifyPublicRun({ recordingFile, wasmFile, historicalWasmFiles = [], rpcUrl = 'https://test.rpc.fastnear.com', provider = new JsonRpcProvider({ url: rpcUrl }) }) {
  const recording = JSON.parse(await readFile(recordingFile, 'utf8'));
  const journal = verifyRun(recording);
  if (recording.network !== 'testnet') throw new Error('PUBLIC_VERIFICATION_REQUIRES_TESTNET');
  if ((await provider.viewNodeStatus()).chain_id !== 'testnet') throw new Error('RPC_NETWORK_MISMATCH');
  const client = new NearAgentStreamsClient({ vaultId: recording.vaultId, provider });
  const vault = await client.getVault();
  const wasm = await readFile(wasmFile);
  const account = await provider.viewAccount({ accountId: recording.vaultId, blockQuery: { finality: 'final' } });
  let expectedCodeHash = baseEncode(createHash('sha256').update(wasm).digest());
  if (account.code_hash !== expectedCodeHash) {
    const historicalHashes = await Promise.all(historicalWasmFiles.map(async file => baseEncode(createHash('sha256').update(await readFile(file)).digest())));
    if (!historicalHashes.includes(account.code_hash)) throw new Error('DEPLOYED_CODE_HASH_MISMATCH');
    expectedCodeHash = account.code_hash;
  }
  const receipts = [...recording.receipts, ...(recording.providerPayout ? [recording.providerPayout] : [])];
  const checked = [];
  for (const saved of receipts) {
    const raw = await provider.viewTransactionStatusWithReceipts({ txHash: saved.hash, accountId: saved.signerId, waitUntil: 'FINAL' });
    const actual = decodeOutcome(raw);
    if (actual.hash !== saved.hash || actual.signerId !== saved.signerId || actual.receiverId !== saved.receiverId || actual.receiptFailures.length || canonical(actual.value) !== canonical(saved.value) || canonical(actual.receiptIds) !== canonical(saved.receiptIds)) throw new Error('RECORDED_RECEIPT_MISMATCH');
    if (actual.receiverId !== recording.vaultId) throw new Error('RECEIPT_VAULT_MISMATCH');
    const method = raw.transaction.actions?.[0]?.FunctionCall?.method_name;
    if (raw.transaction.actions?.length !== 1 || !['open_stream', 'close_stream', 'claim'].includes(method)) throw new Error('UNEXPECTED_RECORDED_ACTION');
    if (method === 'close_stream') {
      const stream = await client.getStream(actual.value.session_id);
      if (canonical(stream) !== canonical(actual.value)) throw new Error('RECORDED_STREAM_MISMATCH');
    }
    checked.push({ hash: actual.hash, signerId: actual.signerId, method, final: true, explorerUrl: explorer(actual.hash) });
  }
  if (!checked.some(r => r.method === 'open_stream') || !checked.some(r => r.method === 'close_stream')) throw new Error('LIFECYCLE_RECEIPTS_MISSING');
  return {
    verifiedAt: new Date().toISOString(), network: 'testnet', readOnly: true, simulation: false,
    recording: { runId: recording.runId, capturedAt: recording.recordedAt, ...journal },
    vaultId: recording.vaultId, codeHash: expectedCodeHash, receipts: checked,
    currentVault: { available: vault.available, spent: vault.spent, reserved: vault.reserved, activeSession: vault.active_session },
    scope: 'RPC verifies deployed WASM, final payment receipts and settled stream state. HTTP responses and policy observations are saved offchain evidence, not independently attested.',
  };
}
