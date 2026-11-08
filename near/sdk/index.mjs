import { Account, JsonRpcProvider, KeyPairSigner, KeyPair } from "near-api-js";

export const USDC = Object.freeze({
  testnet: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
  mainnet: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
});
export const AGENT_METHODS = Object.freeze(["open_stream", "close_stream"]);

export function formatUSDC(raw) {
  const n = BigInt(raw);
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;
  return `${sign}${abs / 1000000n}.${String(abs % 1000000n).padStart(6, "0")}`;
}

export function decodeOutcome(outcome) {
  if (outcome.final_execution_status !== "FINAL")
    throw new Error(
      "Transaction is not final; reconcile its hash before taking another action."
    );
  if (
    !outcome.status ||
    typeof outcome.status !== "object" ||
    !("SuccessValue" in outcome.status)
  ) {
    throw new Error(
      `NEAR transaction failed: ${JSON.stringify(outcome.status)}`
    );
  }
  const raw = Buffer.from(outcome.status.SuccessValue, "base64").toString(
    "utf8"
  );
  const value = raw ? JSON.parse(raw) : null;
  const receiptFailures = (outcome.receipts_outcome ?? [])
    .filter((r) => r.outcome.status?.Failure)
    .map((r) => ({ id: r.id, error: r.outcome.status.Failure }));
  return {
    hash: outcome.transaction.hash,
    signerId: outcome.transaction.signer_id,
    receiverId: outcome.transaction.receiver_id,
    value,
    receiptFailures,
    receiptIds: (outcome.receipts_outcome ?? []).map((r) => r.id),
    logs: (outcome.receipts_outcome ?? []).flatMap((r) => r.outcome.logs ?? []),
  };
}

export class NearAgentStreamsClient {
  constructor({ vaultId, accountId, privateKey, rpcUrl, provider }) {
    this.vaultId = vaultId;
    this.provider = provider ?? new JsonRpcProvider({ url: rpcUrl });
    this.accountId = accountId;
    this.account = accountId
      ? new Account(
          accountId,
          this.provider,
          privateKey ? KeyPairSigner.fromSecretKey(privateKey) : undefined
        )
      : null;
    this.publicKey = privateKey
      ? KeyPair.fromString(privateKey).getPublicKey().toString()
      : null;
  }
  async view(method, args = {}, contractId = this.vaultId) {
    return this.provider.callFunction({
      contractId,
      method,
      args,
      blockQuery: { finality: "final" },
    });
  }
  getVault() {
    return this.view("get_vault");
  }
  getStream(sessionId) {
    return this.view("get_stream", { session_id: sessionId });
  }
  listStreams(fromIndex = 0, limit = 20) {
    return this.view("list_streams", { from_index: fromIndex, limit });
  }
  getClaim(accountId) {
    return this.view("get_claim", { account_id: accountId });
  }
  tokenBalance(accountId, tokenId) {
    return this.view("ft_balance_of", { account_id: accountId }, tokenId);
  }
  async assertRestrictedAgent() {
    const vault = await this.getVault();
    if (vault.agent_id !== this.accountId || vault.agent_key !== this.publicKey)
      throw new Error("Agent credentials do not match vault authority.");
    const key = await this.provider.viewAccessKey({
      accountId: this.accountId,
      publicKey: this.publicKey,
      blockQuery: { finality: "final" },
    });
    const permission = key.permission?.FunctionCall;
    if (
      !permission ||
      permission.receiver_id !== this.vaultId ||
      permission.method_names.length !== AGENT_METHODS.length ||
      !AGENT_METHODS.every((m) => permission.method_names.includes(m))
    )
      throw new Error(
        "Agent key must allow only open_stream and close_stream on this vault."
      );
    if (permission.allowance !== null && BigInt(permission.allowance) === 0n)
      throw new Error("Agent gas allowance is exhausted.");
    return vault;
  }
  async execute(
    methodName,
    args = {},
    { deposit = 0n, gas = 100000000000000n, contractId = this.vaultId } = {}
  ) {
    if (!this.account?.getSigner())
      throw new Error("A signing account is required.");
    // One submission only. Transport/timeout errors must be reconciled, never blindly retried.
    const outcome = await this.account.callFunctionRaw({
      contractId,
      methodName,
      args,
      deposit,
      gas,
      waitUntil: "FINAL",
    });
    return decodeOutcome(outcome);
  }
  open(approval) {
    return this.execute("open_stream", approval);
  }
  close(approval) {
    return this.execute("close_stream", approval);
  }
  recover(sessionId) {
    return this.execute("recovery_close", { session_id: sessionId });
  }
  settleExpired(sessionId) {
    return this.execute("settle_expired", { session_id: sessionId });
  }
  claim() {
    return this.execute("claim");
  }
  anchorDecision(root) {
    return this.execute("anchor_decision", { root });
  }
  getDecision(sequence) {
    return this.view("get_decision", { sequence: String(sequence) });
  }
  withdrawEarned(sessionId) {
    return this.execute("withdraw_earned", { session_id: sessionId });
  }
  topUpStream(sessionId, amount) {
    return this.execute("top_up_stream", { session_id: sessionId, amount: String(amount) });
  }
  withdraw(amount) {
    return this.execute("withdraw_available", { amount: String(amount) });
  }
  async fund(amount) {
    const vault = await this.getVault();
    return this.execute(
      "ft_transfer_call",
      { receiver_id: this.vaultId, amount: String(amount), msg: "fund" },
      { contractId: vault.token_id, deposit: 1n, gas: 100000000000000n }
    );
  }
}

export { NearAgentStreamsClient as NearAgentPayClient };
