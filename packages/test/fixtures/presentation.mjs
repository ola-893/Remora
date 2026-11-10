// Synthetic presentation fixtures only. These IDs/receipts are not live proof.
export const listing = {
  id: 'ap_' + 'a'.repeat(64), name: 'Atlas (fixture)', network: 'testnet',
  activity: 'portfolio-rebalance', rate: '1', duration: 900,
  recipient: 'example-leader.testnet', delivery: 'outlayer', visibility: 'public-chain',
};
export const follow = { listing, status: 'active', mode: 'veto', vetoSeconds: 45, sessionId: 'fixture-session' };
export const pending = {
  type: 'strategy', status: 'pending', actionId: 'fixture-candidate-01', activity: 'portfolio-rebalance',
  action: { poolId: 0, base: 'wrap.testnet', amount: '1000000000000000000000' },
  inputs: { 'nep141:wrap.testnet': '1000000000000000000000' },
  evidence: { source: 'rhea-ref-exchange', contract: 'exchange.ref-dev.testnet' },
  executionAccountId: 'example-follower.testnet', blockUntil: Date.parse('2026-11-10T12:00:45Z'),
};
export const approval = {
  kind: 'transaction', plan: { label: 'Fund the subscription vault', ownerId: 'example-owner.testnet',
    receiverId: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
    actions: [{ type: 'FunctionCall', params: { methodName: 'ft_transfer_call', args: { receiver_id: 'example-vault.testnet', amount: '2000', msg: 'fund' }, gas: '100000000000000', deposit: '1' } }],
  },
};
export const events = [
  { running: true, agentId: 'ap_' + 'b'.repeat(64) },
  { type: 'signal', signalId: 'fixture-signal-01', phase: 'proposed' },
  pending,
  { type: 'copy-review', actionId: pending.actionId, status: 'REVIEW', evidenceIds: ['leader-action', 'follower-record'], note: 'Free-form inference stays hidden.' },
  { type: 'strategy', status: 'waiting-signal', actionId: pending.actionId },
  { type: 'strategy', status: 'waiting-signal', actionId: pending.actionId },
  { type: 'execution', actionId: pending.actionId, status: 'wallet-confirmed', network: 'testnet', receipt: { hash: 'fixture-receipt-not-a-real-transaction', signing: 'grant' } },
  { type: 'strategy', actionId: 'fixture-candidate-02', status: 'skipped', reason: 'STRATEGY_INPUT_LIMIT: nep141:wrap.testnet' },
  { type: 'action', actionId: 'fixture-candidate-03', status: 'blocked', reason: 'OWNER_VETO' },
  { type: 'execution', actionId: 'fixture-paper-01', status: 'paper-filled', fill: { from: 'nep141:wrap.testnet', to: 'nep141:unknown.testnet', amountIn: '1000000000000000000000', amountOut: '12345' } },
  { type: 'action-error', actionId: 'fixture-candidate-04', reason: 'STRATEGY_OUTCOME_UNCONFIRMED' },
  { ...follow, status: 'stopped', closeHash: 'fixture-close-receipt-not-a-real-transaction' },
];
