# Set up Remora on NEAR testnet

Use Node.js 22.22.2 or later. For the paid copy flow you need a named NEAR testnet account connected to a browser wallet, at least 6 test NEAR available after storage reserve for the follower deployment, and Circle testnet USDC. The CLI opens approvals in your default browser. Keep the owner key in the wallet. [Circle testnet faucet](https://faucet.circle.com/)

## Install from npm

```sh
npm install -g @ola-893/agentstreams-cli
agentstream --version
```

Use version `0.11.0` for timed veto windows, execution grants and automatic follower review. [Ten-minute rebalance demo](REBALANCE_DEMO.md)

## Build from source

From the repository root, install Rust with the `wasm32-unknown-unknown` target and run the following commands.

```sh
rustup target add wasm32-unknown-unknown
npm run install:all
npm run pack:distribution
npm install -g \
  .local/distribution/ola-893-agentstreams-core-0.8.0.tgz \
  .local/distribution/ola-893-agentstreams-cli-0.11.0.tgz
agentstream --help
```

For repository checks use `npm test`, `npm run check:distribution` and `npm run build:web`.

## Wallet and subscription vault

Use a named agent for each role and keep the CLI commands for that role in the same working directory. Connect the owner's wallet before deploying the follower's payment vault. `agent setup` without `--deploy` checks readiness.

```sh
agentstream agent create my-agent
agentstream wallet connect --network testnet
agentstream agent setup --agent my-agent --network testnet
agentstream agent setup --agent my-agent --network testnet --deploy
```

The browser reviews owner operations, including deployment funding, payment policy changes and USDC transfers. The restricted payment signer opens and closes streams under the vault policy. Once the vault is ready, preview the chosen publisher and use its recipient and quoted rate to set the payment limits. [Full commands and demo values](NEAR_DEMO.md)

Use `wallet reconcile` for an uncertain browser operation and `agent setup --deploy --resume` to continue an interrupted deployment with the original setup options. Use `reconcile` for an uncertain stream operation and `copy status` to verify the outcome before retrying.

## Leader inference

A model can help a leader decide what to publish. The copy runner automatically adds an advisory review to eligible events when the follower has inference configured. Running `agentstream agent run --prompt` on either profile starts a separate model-driven task. [Default copy review prompt](COPY_REVIEW_PROMPT.md)

```sh
agentstream inference set --agent leader --provider local \
  --base-url http://127.0.0.1:11434/v1 --model MODEL

agentstream inference models --provider near-ai
agentstream inference set --agent leader --provider near-ai --model MODEL --api-key
agentstream inference show --agent leader
```

Choose one provider and replace `MODEL` with a tool-capable model ID. The local provider uses an OpenAI-compatible loopback server. NEAR AI uses its Cloud Gateway and a hidden CLI prompt for the API key. The CLI filters for tool-capable models with provider-reported verifiability and attestation support. A response ID lets you verify the response independently. The CLI does not mark an individual response as attested based on the catalog. [NEAR AI verification](https://docs.near.ai/cloud/verification)

## Activities and execution

| Activity | Execution path |
| --- | --- |
| `spot-trading` | Virtual fills from signed live NEAR Intents 1Click quotes, or a separately configured Agent Connect live route |
| `staking-moves` | Stake, unstake and withdraw with a testnet staking pool |
| `liquidity-ranges` | Fund a position and add or remove a range in Rhea DCL |
| `portfolio-rebalance` | Trade toward target weights in a Rhea Exchange pool |
| `yield-reallocation` | Supply or withdraw in Rhea Lending |
| `limit-orders` | Place, cancel and claim Rhea DCL orders |

Spot paper mode uses a virtual portfolio while the subscription moves real testnet USDC. Native NEAR strategies support explicit approval or a timed veto window. Veto mode requires an active grant for the follower and activity. [Execution grants and recovery](EXECUTION_GRANTS.md)

With an active subscription, run `agentstream copy mode veto --veto-seconds 30` and keep `agentstream agent run` running. `copy pending` shows each candidate and its `blockUntil` deadline in Unix milliseconds. Use `agentstream copy block ACTION_ID` before the deadline. Once the window closes, the executor checks the current session, age, guard and quote again. A missing grant or changed candidate can prevent execution. Switching modes or closing the stream cancels candidates that are still waiting.

## Where the limits run

| Layer | Enforcement |
| --- | --- |
| Subscription | The NEAR vault enforces budget, maximum stream deposit, rate, duration and allowed recipients. The publisher checks the signed session against the active stream. |
| Execution | The CLI validates the asset, venue, size and freshness rules configured for the activity. Spot orders also check slippage and configured notional. The model has no tool for changing those limits. |
| Testnet grant | A locally generated key controls a separate funded account. Transaction count, expiry, receivers and methods are CLI rules. A leaked execution key can control all assets in that account. |

The [evidence guide](NEAR_DEMO.md#read-the-recorded-run) identifies which checks ran on-chain, which used paper balances and where live coverage is incomplete.
