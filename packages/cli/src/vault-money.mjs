import { createHash } from 'node:crypto';
import { mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { actions, baseEncode, encodeTransaction, JsonRpcProvider } from 'near-api-js';
import { atomicWrite, readOptional } from './files.mjs';
import { fingerprint } from './agents.mjs';

const explorer = hash => `https://testnet.nearblocks.io/txns/${hash}`;

async function finalize(file, intent, outcome) {
  const tx = outcome.transaction;
  if (outcome.final_execution_status !== 'FINAL' || tx?.hash !== intent.hash || tx.signer_id !== intent.accountId || tx.receiver_id !== intent.vaultId) throw new Error('VAULT_PAYOUT_OUTCOME_UNCONFIRMED');
  const status = outcome.status;
  let value;
  try { value = JSON.parse(Buffer.from(status?.SuccessValue ?? '', 'base64').toString()); } catch { value = null; }
  const ok = status && typeof status === 'object' && 'SuccessValue' in status &&
    (intent.method === 'top_up_stream' ? value?.session_id === intent.args?.session_id && value?.closed_at === null && value?.duration_seconds === 0 : value === true) &&
    !outcome.receipts_outcome?.some(receipt => receipt.outcome.status?.Failure);
  const result = { resolved: true, paid: Boolean(ok), method: intent.method, transactionHash: intent.hash, explorerUrl: explorer(intent.hash) };
  await atomicWrite(join(file, '..', `receipt-${intent.hash}.json`), JSON.stringify(result));
  await unlink(file);
  return result;
}

export async function payout(agent, client, method, args = {}) {
  const root = join(agent.path, 'payouts');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = join(root, fingerprint(`${client.vaultId}:${client.accountId}`) + '.pending');
  const lockFile = file + '.lock';
  const lock = await open(lockFile, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('VAULT_PAYOUT_BUSY');
    throw error;
  });
  try {
    const existing = await readOptional(file);
    if (existing) throw new Error(`VAULT_PAYOUT_RECONCILIATION_REQUIRED: ${explorer(JSON.parse(existing).hash)}. Run agentstreams reconcile${agent.name ? ' --agent ' + agent.name : ''}.`);
    const signed = await client.account.createSignedTransaction({ receiverId: client.vaultId, actions: [actions.functionCall(method, args, 100000000000000n)] });
    const hash = baseEncode(createHash('sha256').update(encodeTransaction(signed.transaction)).digest());
    const intent = { hash, method, args, accountId: client.accountId, vaultId: client.vaultId, rpcUrl: client.provider.connection.url };
    await atomicWrite(file, JSON.stringify(intent));
    let result;
    try { result = await finalize(file, intent, await client.provider.sendTransactionUntil(signed, 'FINAL')); }
    catch { throw new Error(`VAULT_PAYOUT_RECONCILIATION_REQUIRED: ${explorer(hash)}. Run agentstreams reconcile${agent.name ? ' --agent ' + agent.name : ''}.`); }
    if (!result.paid) throw new Error(`VAULT_PAYOUT_FAILED: ${result.explorerUrl}`);
    return result;
  } finally { await lock.close(); await unlink(lockFile); }
}

export async function reconcilePayouts(agent) {
  const root = join(agent.path, 'payouts');
  let files;
  try { files = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return { resolved: true, transactions: [] }; throw error; }
  const transactions = [];
  for (const name of files.filter(item => /^[a-f0-9]{64}\.pending$/.test(item))) {
    const file = join(root, name), lockFile = file + '.lock';
    let lock;
    try { lock = await open(lockFile, 'wx', 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; transactions.push({ resolved: false, reason: 'VAULT_PAYOUT_BUSY' }); continue; }
    try {
      const pending = await readOptional(file);
      if (!pending) continue;
      const intent = JSON.parse(pending);
      const provider = new JsonRpcProvider({ url: intent.rpcUrl });
      try {
        const outcome = await provider.viewTransactionStatus({ txHash: intent.hash, accountId: intent.accountId, waitUntil: 'FINAL' });
        transactions.push(await finalize(file, intent, outcome));
      } catch { transactions.push({ resolved: false, transactionHash: intent.hash, explorerUrl: explorer(intent.hash) }); }
    } finally { await lock.close(); await unlink(lockFile); }
  }
  return { resolved: transactions.every(x => x.resolved), transactions };
}
