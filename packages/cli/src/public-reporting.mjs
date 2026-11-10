import { createHash } from 'node:crypto';
import { readAgentState, withAgentState } from './agents.mjs';
import { spot } from './copy-activity.mjs';
import { nativeWalletActivities } from './strategy-actions.mjs';

const dayMs = 86400000;
const digest = text => createHash('sha256').update(text).digest('hex');
const operations = {
  'staking-moves': ['stake', 'unstake', 'withdraw'],
  'liquidity-ranges': ['add', 'remove'],
  'portfolio-rebalance': ['rebalance'],
  'yield-reallocation': ['supply', 'withdraw'],
  'limit-orders': ['place', 'cancel', 'claim'],
  'spot-trading': ['swap'],
};

// Keep the full receipt and context private. Public releases are a separate allowlist.
export function recordPerformance(state, { id, activity, execution, action, receipt, evidence, order, at = Date.now() }) {
  if (activity !== spot && !nativeWalletActivities.has(activity)) throw new Error('INVALID_REPORT_ACTIVITY');
  const records = state.performanceRecords ??= [];
  if (records.some(r => r.id === id)) return;
  const operation = action?.operation ?? (activity === 'portfolio-rebalance' ? 'rebalance' : activity === 'liquidity-ranges' ? 'add' : 'swap');
  if (!operations[activity].includes(operation)) throw new Error('INVALID_REPORT_OPERATION');
  const metrics = [{ key: operation, value: '1', unit: 'confirmed actions' }];
  // This is execution quality for a confirmed rebalance, never a return series.
  if (activity === 'portfolio-rebalance' && /^\d+$/.test(receipt?.value ?? '') && /^\d+$/.test(evidence?.quotedAmountOut ?? '') && BigInt(evidence.quotedAmountOut) > 0n) {
    const bps = (BigInt(receipt.value) - BigInt(evidence.quotedAmountOut)) * 10000n / BigInt(evidence.quotedAmountOut);
    if (bps >= -10000n && bps <= 10000n) metrics.push({ key: 'quoteDifferenceBps', value: bps.toString(), unit: 'basis points versus quote' });
  }
  // Placement is not a fill. Use the contract-confirmed remaining order amount.
  if (activity === 'limit-orders' && /^\d+$/.test(order?.original_amount ?? '') && /^\d+$/.test(order?.remain_amount ?? '') && /^\d+$/.test(order?.cancel_amount ?? '0') && BigInt(order.original_amount) > 0n) {
    const filled = BigInt(order.original_amount) - BigInt(order.remain_amount) - BigInt(order.cancel_amount ?? '0');
    if (filled >= 0n && filled <= BigInt(order.original_amount)) metrics.push({ key: 'orderFilledBps', value: (filled * 10000n / BigInt(order.original_amount)).toString(), unit: 'basis points filled at confirmation' });
  }
  records.push({ id, activity, execution, at, operation, metrics, receipt: receipt?.hash ?? null });
  if (records.length > 500) records.shift();
}

export async function approveEvidence(agent, id, publicReceipt = false) {
  return withAgentState(agent, state => {
    const record = state.performanceRecords?.find(r => r.id === id);
    if (!record) throw new Error('EVIDENCE_NOT_FOUND: select a confirmed action from evidence list.');
    if (publicReceipt && (record.execution === 'paper' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(record.receipt ?? ''))) throw new Error('PUBLIC_TRANSACTION_RECEIPT_UNAVAILABLE');
    const approval = { id, approvedAt: Date.now(), publicReceipt };
    (state.evidenceApprovals ??= {})[id] = approval;
    return { ...approval, releaseAfter: new Date(Date.parse(new Date(record.at).toISOString().slice(0, 10) + 'T00:00:00Z') + 2 * dayMs).toISOString(),
      disclosure: publicReceipt ? 'Delayed activity metrics and public transaction hash' : 'Delayed activity metrics only' };
  });
}

export async function revokeEvidence(agent, id) {
  return withAgentState(agent, state => {
    if (!state.evidenceApprovals?.[id]) throw new Error('EVIDENCE_APPROVAL_NOT_FOUND');
    delete state.evidenceApprovals[id];
    return { id, revoked: true, retainedCopiesMayExist: true };
  });
}

export async function evidenceRecords(agent) {
  const state = await readAgentState(agent);
  return { records: (state.performanceRecords ?? []).map(r => ({ ...r, approval: state.evidenceApprovals?.[r.id] ?? null })) };
}

export function publicEvidence(state, activity, now = Date.now()) {
  const rows = [];
  for (const record of state.performanceRecords ?? []) {
    const approval = state.evidenceApprovals?.[record.id];
    if (!approval || record.activity !== activity || !Number.isSafeInteger(record.at)) continue;
    const day = new Date(record.at).toISOString().slice(0, 10);
    if (Date.parse(day + 'T00:00:00Z') + 2 * dayMs > now) continue;
    // Do not spread stored records: no action, account, target, amount or exact timestamp.
    rows.push({ id: digest('remora.public-evidence.v1:' + record.id), date: day, activity, execution: record.execution,
      operation: record.operation, metrics: record.metrics.map(({ key, value, unit }) => ({ key, value, unit })),
      ...(approval.publicReceipt ? { receipt: record.receipt } : {}) });
  }
  return rows.slice(-50);
}
