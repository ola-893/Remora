# Delegate testnet execution

Approve one funding transfer in Meteor. Remora generates a signing key for a separate testnet execution account and stores it locally. The key for your owner account stays in the wallet. A covered strategy can execute without another browser approval.

## Create and prepare a grant

Use the [source build](NEAR.md#build-from-source), a named agent and a connected owner wallet. This example prepares a Rhea Exchange rebalance.

```sh
agentstream grant create --agent my-agent --transactions 7 --hours 1 \
  --activities portfolio-rebalance --tokens wrap.testnet,rft.tokenfactory.testnet --fund-near 0.15
agentstream grant prepare --agent my-agent --activity portfolio-rebalance \
  --token wrap.testnet --balance-raw 20000000000000000000000
agentstream grant show
```

`--balance-raw` is a target balance in the token's atomic units. Rebalance preparation targets the exchange balance. For other supported preparation activities it targets the execution wallet balance. The command can register storage, wrap test NEAR and deposit it into Rhea Exchange. Preparation transactions count toward the grant. For a concentrated-liquidity range, prepare the token and DCL storage before using `task deposit-range` with the same grant. Staking uses native test NEAR.

Set the activity's execution guard before running `task run` or `agent run --prompt`. A native strategy copied in approval mode still needs `copy approve`. A matching grant signs the approved action without opening Meteor again. Spot trading uses the separate NEAR Intents execution path.

## Recover funds

Expiry or exhaustion stops execution and leaves the account and positions available for recovery. Use `agentstream grant revoke` to recover supported balances and retire the account. Pending settlement, an unavailable venue or staking unbonding can delay recovery. Use `grant reconcile` for an uncertain execution transaction and `wallet reconcile` for an uncertain initial funding transfer.

One grant can be active per connected owner. It is bound to the named agent and selected activities. Remora applies the count, expiry, receiver and method rules locally. The execution key has full access to the separate account, including later deposits and trading gains. For limits that hold even if the key leaks, a production design would place the assets in a policy contract and scope the agent key to that contract.

[Recorded funding, execution and asset return](evidence/near/remora-execution-grant.json) · [Configure inference](NEAR.md#leader-inference)
