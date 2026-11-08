# Copy a leader without a follower model

Run a local publisher and two named agents. The leader publishes a paper fill priced by a live signed NEAR Intents quote. The follower pays in testnet USDC and records its own virtual fill. The demo needs no inference configuration on either agent because the leader's order is supplied explicitly. The [recorded run](#read-the-recorded-run) used local Gemma to choose the leader's actions.

Use the [CLI install and testnet prerequisites](NEAR.md). Run setup in Terminal 2 and open Terminal 1 in the same working directory. Replace `YOUR_PUBLISHER_ACCOUNT.testnet` with the testnet recipient you intend to pay.

## Set up the two roles

```sh
mkdir -p remora-copy-demo
cd remora-copy-demo

SELLER='YOUR_PUBLISHER_ACCOUNT.testnet'
USDC_ASSET='nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
WNEAR_ASSET='nep141:wrap.near'
ORIGIN='http://127.0.0.1:5380'

agentstream agent create leader
agentstream agent create follower
agentstream wallet connect --network testnet
agentstream agent setup --agent follower --network testnet --recipient "$SELLER"
agentstream agent setup --agent follower --network testnet --recipient "$SELLER" --deploy

agentstream guard set payment --agent follower \
  --budget 0.01 --max-stream 0.002 --max-rate 0.000001 \
  --max-duration 900 --recipient "$SELLER"
agentstream fund 0.002 --agent follower
agentstream payments --enable --agent follower

for role in leader follower; do
  agentstream task enable spot-trading --agent "$role" --paper-balances "$USDC_ASSET=10000000"
  agentstream guard set execution --agent "$role" --activity spot-trading \
    --assets "$USDC_ASSET,$WNEAR_ASSET" --input-asset "$USDC_ASSET" \
    --max-input-raw 1000000 --copy-input-raw 1000000 \
    --max-notional 2 --max-age 120 --max-slippage-bps 100
done

agentstream inference show --agent follower
agentstream publish set --agent leader --activities spot-trading \
  --url "$ORIGIN" --rate 0.000001 --duration 900 --recipient "$SELLER"
agentstream publish start --agent leader
```

The fresh follower's inference status should show `{"configured": false}`. The offer reserves at most 0.0009 test USDC for 900 seconds. Its final charge depends on how long it stays open. The two asset IDs above are used only for quoting and paper accounting. Vault funding uses Circle USDC on NEAR testnet.

In Terminal 1, run the publisher and leave it running.

```sh
agentstream agent run --agent leader
```

In Terminal 2, use the variables from setup and set `PUBLISHER_ID` to the full ID returned by `publish start`.

## 1. See the follower mirror a fill

```sh
PUBLISHER_ID='ap_REPLACE_WITH_THE_LEADER_ID'
agentstream copy "$PUBLISHER_ID" --url "$ORIGIN" --agent follower
agentstream copy start "$PUBLISHER_ID" --url "$ORIGIN" --activity spot-trading --agent follower
agentstream copy mode auto --agent follower
agentstream task run spot-trading --agent leader \
  --from "$USDC_ASSET" --to "$WNEAR_ASSET" --amount-raw 1000000 --execute
agentstream agent run --agent follower --once
agentstream task portfolio --agent follower
```

Expect the follower to record a `paper-filled` action when the quote passes its guards. The follower gets its own quote. Its fill amount can differ from the leader's output. If the quote moved outside the configured tolerance, the follower skips it. Run the follower checkpoint while the action is fresh.

## 2. See an order refused

Lower the follower's notional cap below the value of the next one-USDC order. The stream stays open.

```sh
agentstream guard set execution --agent follower --activity spot-trading --max-notional 0.01
agentstream task run spot-trading --agent leader \
  --from "$USDC_ASSET" --to "$WNEAR_ASSET" --amount-raw 1000000 --execute
agentstream agent run --agent follower --once
agentstream copy history --agent follower
```

With a fresh quote inside the slippage limit, look for a skipped action with `NOTIONAL_LIMIT`. The follower's virtual balances should match the previous checkpoint. The automated guard tests also cover expiry and maximum order size. [Guard tests](../packages/test/copy.test.mjs#L159)

## 3. Close the stream and publish again

```sh
agentstream guard set execution --agent follower --activity spot-trading --max-notional 2
agentstream copy stop --agent follower
agentstream copy status --agent follower
agentstream task run spot-trading --agent leader \
  --from "$USDC_ASSET" --to "$WNEAR_ASSET" --amount-raw 1000000 --execute
agentstream agent run --agent follower --once
agentstream task portfolio --agent follower
```

The follower should show a stopped subscription and an unchanged portfolio. A publisher returns HTTP 403 for the previously valid signed session after closure. The public offer stays readable while the publisher is running. [Recorded HTTP comparison](evidence/copy-trading/hour-2026-11-07/terminal.txt#L2635)

## Read the recorded run

| Evidence | What it establishes |
| --- | --- |
| [Hour run and transcript](evidence/copy-trading/hour-2026-11-07/evidence.json) · [Terminal log](evidence/copy-trading/hour-2026-11-07/terminal.txt) | Local Gemma published 14 paper fills. The follower copied all 14 on one testnet stream with one top-up. A stale preview was denied. After closure, the old session returned 403 and the follower did not copy the next fill. |
| [Archived profile check](evidence/copy-trading/hour-2026-11-07/follower-inference-check.json) | The follower's `inference show` reported `configured: false`. |
| [On-chain payment policy](https://testnet.nearblocks.io/txns/B5UzyTVyDpwrraZ71rJHXp2A42JiU4ErdRxRzyFcC4SZ) · [Open](https://testnet.nearblocks.io/txns/4JbmkPBeG8kJJNAZrPU5jyfPH9aocjXct2Qpg8KufaYw) · [Close](https://testnet.nearblocks.io/txns/D6Du8Loc9UgjsWJy9nuyKNLNKa46gEfqp1wz57cVZAMf) | The wallet approved the payment policy on-chain. The same stream settled 0.003619 test USDC to the publisher and returned 0.002481 test USDC to the follower's vault. |
| [Live Rhea grant test](evidence/near/remora-execution-grant.json) | One browser funding approval enabled grant-signed preparation and a live rebalance. The CLI refused another action at zero remaining slots. Revocation returned the test assets. |
| [Live limit-order QA](evidence/near/remora-limit-orders.json) | Two CLI profiles shared one testnet wallet. Leader placement and cancellation settled and the paid follower queued the copied orders. Both follower wallet requests expired before execution. |

The hour run used a locally packed CLI `0.6.0`. Its paper fills are virtual balance changes priced by real quotes. The subscription receipts and the separate Rhea execution receipts record on-chain state changes.
