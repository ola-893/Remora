import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { baseEncode } from 'near-api-js';
import { verifyPublicRun } from '../../near/lib/evidence.mjs';

const recordingFile = new URL('../../vite-project/public/near/testnet.json', import.meta.url);
const wasmFile = new URL('../cli/artifacts/agentpay_vault.wasm', import.meta.url);
async function fixture() {
  const run = JSON.parse(await readFile(recordingFile, 'utf8'));
  const receipts = [...run.receipts, run.providerPayout];
  const hash = baseEncode(createHash('sha256').update(await readFile(wasmFile)).digest());
  const calls = [];
  const provider = {
    viewNodeStatus: async () => ({ chain_id: 'testnet' }),
    viewAccount: async () => ({ code_hash: hash }),
    callFunction: async ({ method, args }) => {
      calls.push(method);
      if (method === 'get_vault') return { available: '1', spent: '2', reserved: '0', active_session: null };
      if (method === 'get_stream') return receipts.find(r => r.value?.session_id === args.session_id && r.value.closed_at !== null).value;
      throw new Error('Only views expected');
    },
    viewTransactionStatusWithReceipts: async ({ txHash }) => {
      const saved = receipts.find(r => r.hash === txHash);
      return { final_execution_status: 'FINAL', status: { SuccessValue: Buffer.from(JSON.stringify(saved.value)).toString('base64') }, transaction: { hash: saved.hash, signer_id: saved.signerId, receiver_id: saved.receiverId, actions: [{ FunctionCall: { method_name: saved === run.providerPayout ? 'claim' : saved.value.closed_at === null ? 'open_stream' : 'close_stream' } }] }, receipts_outcome: saved.receiptIds.map(id => ({ id, outcome: { status: { SuccessValue: '' }, logs: [] } })) };
    },
  };
  return { provider, calls };
}

test('public replay verification checks final receipts, deployed code and settled stream via read-only methods', async () => {
  const { provider, calls } = await fixture();
  const result = await verifyPublicRun({ recordingFile, wasmFile, provider });
  assert.equal(result.simulation, false);
  assert.equal(result.readOnly, true);
  assert.equal(result.receipts.length, 5);
  assert.deepEqual(result.receipts.map(r => r.method), ['open_stream', 'close_stream', 'open_stream', 'close_stream', 'claim']);
  assert.deepEqual(calls, ['get_vault', 'get_stream', 'get_stream']);
});

test('replay verification rejects wrong chain, replaced code, altered receipt and unfinished execution', async () => {
  let { provider } = await fixture();
  provider.viewNodeStatus = async () => ({ chain_id: 'mainnet' });
  await assert.rejects(verifyPublicRun({ recordingFile, wasmFile, provider }), /RPC_NETWORK_MISMATCH/);
  ({ provider } = await fixture());
  provider.viewAccount = async () => ({ code_hash: 'changed' });
  await assert.rejects(verifyPublicRun({ recordingFile, wasmFile, provider }), /CODE_HASH_MISMATCH/);
  ({ provider } = await fixture());
  const original = provider.viewTransactionStatusWithReceipts;
  provider.viewTransactionStatusWithReceipts = async args => { const result = await original(args); result.transaction.receiver_id = 'attacker.testnet'; return result; };
  await assert.rejects(verifyPublicRun({ recordingFile, wasmFile, provider }), /RECEIPT_MISMATCH/);
  ({ provider } = await fixture());
  provider.viewTransactionStatusWithReceipts = async () => ({ final_execution_status: 'EXECUTED_OPTIMISTIC' });
  await assert.rejects(verifyPublicRun({ recordingFile, wasmFile, provider }), /not final/);
});
