// Required deposits read from the deployed NEAR testnet contracts on 2026-11-08.
// Payable methods were taken from the deployed code: a method is non-payable when the
// binary contains "Method <name> doesn't accept deposit". Storage minimums are view results.
export const yoctoDeposit = '1';
export const activityDeposits = [
  { activity: 'portfolio-rebalance', contract: 'ref-finance-101.testnet', method: 'swap', deposit: yoctoDeposit, evidence: 'payable; code requires at least 1 yoctoNEAR' },
  { activity: 'portfolio-rebalance', contract: 'ref-finance-101.testnet', method: 'withdraw', deposit: yoctoDeposit, evidence: 'payable withdraw used to return internal deposits' },
  { activity: 'portfolio-rebalance', contract: 'ref-finance-101.testnet', method: 'storage_deposit', deposit: '>=1020000000000000000000', evidence: 'storage_balance_bounds.min' },
  { activity: 'portfolio-rebalance', contract: 'wrap.testnet', method: 'near_deposit', deposit: 'positive', evidence: 'code: Requires positive attached deposit' },
  { activity: 'portfolio-rebalance', contract: 'wrap.testnet', method: 'near_withdraw', deposit: yoctoDeposit, evidence: 'code: exactly 1 yoctoNEAR' },
  { activity: 'portfolio-rebalance', contract: 'wrap.testnet', method: 'ft_transfer_call', deposit: yoctoDeposit, evidence: 'code: exactly 1 yoctoNEAR' },
  { activity: 'staking-moves', contract: 'lst.ref-dev.testnet', method: 'deposit_and_stake', deposit: 'stake amount', evidence: 'payable; attached deposit is the stake' },
  { activity: 'staking-moves', contract: 'lst.ref-dev.testnet', method: 'unstake', deposit: '0', evidence: 'Method unstake does not accept deposit' },
  { activity: 'staking-moves', contract: 'lst.ref-dev.testnet', method: 'withdraw', deposit: '0', evidence: 'Method withdraw does not accept deposit' },
  { activity: 'staking-moves', contract: 'lst.ref-dev.testnet', method: 'storage_deposit', deposit: '>=1250000000000000000000', evidence: 'storage_balance_bounds.min' },
  { activity: 'liquidity-ranges', contract: 'dclv2.ref-dev.testnet', method: 'add_liquidity', deposit: '0', evidence: 'Method add_liquidity does not accept deposit' },
  { activity: 'liquidity-ranges', contract: 'dclv2.ref-dev.testnet', method: 'remove_liquidity', deposit: '0', evidence: 'Method remove_liquidity does not accept deposit' },
  { activity: 'liquidity-ranges', contract: 'dclv2.ref-dev.testnet', method: 'withdraw_asset', deposit: '0', evidence: 'Method withdraw_asset does not accept deposit' },
  { activity: 'liquidity-ranges', contract: 'nep141 token', method: 'ft_transfer_call', deposit: yoctoDeposit, evidence: 'NEP-141 code: exactly 1 yoctoNEAR' },
  { activity: 'yield-reallocation', contract: 'nep141 token', method: 'ft_transfer_call', deposit: yoctoDeposit, evidence: 'NEP-141 code: exactly 1 yoctoNEAR' },
  { activity: 'yield-reallocation', contract: 'contract.1689937928.burrow.testnet', method: 'execute', deposit: yoctoDeposit, evidence: 'code: exactly 1 yoctoNEAR' },
  { activity: 'yield-reallocation', contract: 'contract.1689937928.burrow.testnet', method: 'storage_deposit', deposit: '>=100000000000000000000000', evidence: 'storage_balance_bounds.min' },
  { activity: 'limit-orders', contract: 'nep141 token', method: 'ft_transfer_call', deposit: yoctoDeposit, evidence: 'NEP-141 code: exactly 1 yoctoNEAR' },
  { activity: 'limit-orders', contract: 'dclv2.ref-dev.testnet', method: 'cancel_order', deposit: '0', evidence: 'Method cancel_order does not accept deposit' },
];
