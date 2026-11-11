# Shark and Remora: demo voice-over

Read the spoken paragraphs; use the italic cues to know when to speak. Start after setup, at the recording prompt in Terminal 1. Pause while approvals, inference, or settlement are still pending. Leave room for the terminal output to be read.

*Opening, before pressing Enter in Terminal 1.*

“Useful work by one agent should be useful to many. Today, agents often repeat the same reasoning, then each needs permission to act with money. Remora separates those jobs: one agent produces decisions, while other agents pay to reuse them under their own controls.”

“Here, Shark uses NEAR AI to evaluate a portfolio rebalance. Remora uses a smaller local Qwen model to review the incoming decision. This is decision reuse with limited inference, not a claim that Remora learns or copies Shark's model.”

*Press Enter. Point to the subscription result in Terminal 2.*

“Remora subscribes to Shark's protected feed through a testnet USDC payment stream. The price is one millionth of a USDC per second. The stream pays for access to the decisions; it isn't a separate payment for every trade.”

*Point to Shark's guard, preview, and returned evidence.*

“Shark checks its rules and previews the rebalance against live Rhea testnet data before submitting. Watch the evidence and transaction result. A model saying it wants to trade is not proof that a transaction happened.”

*Point to Remora's review and veto deadline; speak only after those events appear.*

“Remora receives the proposal and reviews it using local inference. It sizes the copy at fifty percent and checks its own asset, input, age, and slippage limits. The owner's veto window is forty-five seconds: they can block an eligible action, and otherwise it can proceed after the deadline if the checks still pass.”

“The model's review is advisory. It cannot rewrite these limits. The execution guards are deterministic CLI checks, while the separate funded execution account bounds the assets its key can control.”

*After Remora actually confirms its first execution.*

“That is the confirmed follower execution, with its own transaction evidence. Both roles use the same testnet owner in this demo, but they execute from separate accounts. The owner approved setup, rather than signing each copied action.”

*Press Enter in Terminal 1 to tighten the cap and request the second decision.*

“Now I lower only Remora's input cap to zero point zero zero zero five wrapped NEAR. Shark's objective stays the same. Receiving a paid decision does not give it authority to override the follower's rules.”

*Only after `STRATEGY_INPUT_LIMIT` and a skipped result actually appear.*

“This candidate was blocked by Remora's deterministic input limit. This is a policy denial, not an owner veto and not a model opinion. The useful decision was delivered, but the follower retained control over whether it could execute.”

*Press Enter in Terminal 1, then Ctrl+C once in Terminal 2. Wait for the close result.*

“Finally, I stop Remora. The launcher closes the payment stream and shows the real transaction and vault state. It also disables automatic reopening. This recording proves stream closure; it does not display a fresh HTTP access-denial probe.”

*After closure and publication shutdown are confirmed.*

“Remora transfers the results of reasoning: agents publish useful decisions, earn through payment streams, and followers adapt those decisions to their own limits. One agent's work becomes useful to many.”

## If something does not happen

If Shark refuses or only previews: “The agent did not confirm an execution. I won't present this as a completed trade.”

If Remora has not settled: “This is still a candidate or pending transaction. We're waiting for the confirmed outcome.”

If the second candidate is not denied: “The actual proposal did not produce the denial we intended to demonstrate. We'll inspect the result rather than label it as blocked.”

If closure is uncertain: “The close is not confirmed yet. We need to reconcile the on-chain state before claiming payment stopped.”

Privacy boundary if asked: “The advance feed uses protected delivery. Rhea settlement is public, so someone can independently observe completed on-chain actions. This demo does not claim to hide all DeFi activity.”
