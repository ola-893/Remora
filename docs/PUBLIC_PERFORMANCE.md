# Public evidence without publishing the private feed

The website helps an owner research agents and copy their IDs into the CLI. It must not serve live order instructions to anonymous visitors. Listings contain activity, price, execution visibility and liveness; signed proposals stay behind paid subscription checks.

## Owner-controlled release

New confirmed executions create private reporting records for all six supported activities. They are not published automatically. Inspect records and choose what to release:

```sh
agentstream evidence list
agentstream evidence approve ACTION_ID
agentstream evidence approve ACTION_ID --public-receipt
agentstream evidence revoke ACTION_ID
```

Default approval releases only the activity, UTC date, execution mode, operation and allowlisted metrics. `--public-receipt` additionally discloses the transaction hash; it is unavailable for paper fills. Approving evidence does not authorize any transaction. It updates local publication settings. The runner publishes the revised signed listing on its normal refresh cycle.

Releases wait until **24 hours after the execution's UTC day ends**. For an action on November 5, the earliest release is November 7 at 00:00 UTC. Listings exclude exact execution times, assets, amounts, target pools, ranges, weights, accounts and signal IDs. Optional daily action counts (`publish set --public-history`) and publisher-reported performance series remain separately labelled.

Revoking an approval removes the row from future listings. Anyone who already downloaded a public row can keep it. A public receipt enables independent inspection of the transaction and its public account history; approve that disclosure deliberately.

## What the metrics establish

| Activity | Currently recorded | What must not be inferred |
| --- | --- | --- |
| Spot trading | Confirmed swap count, separated by paper or live execution | Profit, portfolio return or confidential settlement |
| Staking moves | Confirmed stake, unstake and withdrawal operations | Staking yield or APY |
| Liquidity ranges | Confirmed additions and removals | Fees earned, time in range or impermanent loss |
| Portfolio rebalance | Confirmed rebalances; settled output versus fresh quoted output | Portfolio P&L or long-term drift improvement |
| Yield reallocation | Confirmed supplies and withdrawals | Realized interest or net yield |
| Limit orders | Confirmed placements, cancellations and claims; filled fraction at confirmation when the contract reports it | Placement being a fill, or a realized return |

The CLI derives these records from executions it confirmed, but the public listing is signed by the publisher. That signature identifies the publisher; it does not independently prove every metric. Publicly released receipts provide checkable transaction evidence. Full investment performance still needs valuation, fees, cash-flow accounting and longer-lived position snapshots. The website must not manufacture those values from action counts.

## Verification

CLI tests cover all six activities, explicit approval, receipt opt-in, whole-day delays, revocation and exclusion of private fields. Frontend tests independently reject fresh rows, unknown metrics, private context fields and releases without an approval policy. Historical recordings remain clearly labelled recordings.
