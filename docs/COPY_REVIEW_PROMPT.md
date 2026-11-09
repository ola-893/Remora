# Default system prompt for copy review

Followers reuse a leader's decisions with limited inference. Remora automatically uses this prompt for advisory review when a follower has a local or NEAR AI inference profile. The model compares the published decision with the follower's record, while the deterministic runner applies the execution rules.

## System prompt

The prompt asks the model to compare the signed leader action with the follower's record and explain a material difference, a missing fact or a reason for operator review. It requires a short JSON note and cites the supplied evidence by ID. [Prompt used by the CLI](../packages/cli/src/copy-review.mjs#L7)

## What the CLI owns

- **When to call.** Review observed, queued or automatically executed actions. Guard refusals and empty polls skip inference. The continuous runner processes reviews in the background with a bounded queue. A one-shot run waits for that poll's reviews. Inference never changes the action's status.
- **What to send.** The model receives selected fields from the signed action and follower record, including relevant quote amounts. It has zero tools. Credentials, session details, signer material and unrelated account balances stay out of the request body.
- **What to accept.** The result contains `status`, `evidenceIds` and `note`. Valid statuses are `REVIEW`, `NO_CONCERN` and `INSUFFICIENT_CONTEXT`. The CLI requests structured output from local endpoints and validates every response. It discards expired or inactive-session reviews and reports `UNAVAILABLE` on timeout or invalid output. Existing approval requirements apply to every result.
- **What to enforce.** The CLI checks feed signatures, replay protection, subscription state and activity-specific policy. A review result never approves, blocks or reschedules a candidate. After explicit approval or an unblocked veto window, the executor rechecks the active session, age and current guards, including quote or venue checks where required.

Keep authorization in the executor and limit the model to the data needed for its review. [OWASP guidance on excessive agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)

## Example

A queued rebalance passes the configured checks. The follower's configured copy size is half the leader's size.

```json
{
  "status": "NO_CONCERN",
  "evidenceIds": ["leader-action", "follower-record"],
  "note": "The follower targets the same allocation with half the leader's maximum input."
}
```

The operator sees the note beside the pending action. If the action expires while they review it, the executor refuses it under the existing age check.
