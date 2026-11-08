import type { JsonRpcProvider } from "near-api-js";
export interface Policy {
  budget: string;
  max_deposit: string;
  max_rate: string;
  /** 0 allows open-ended streams; otherwise an owner-selected duration limit in seconds. */
  max_duration_seconds: number;
  recipients: string[];
}
export interface Permit {
  domain: "agentpay.near.v1";
  vault_id: string;
  agent_id: string;
  action: "OPEN" | "CLOSE";
  session_id: string;
  recipient_id: string;
  rate: string;
  /** 0 keeps the stream open until closed or prepaid funds are exhausted. */
  duration_seconds: number;
  quote_hash: string;
  nonce: string;
  expires_at: string;
}
export interface Approval {
  permit: Permit;
  signature: string;
}
export interface Stream {
  session_id: string;
  recipient_id: string;
  quote_hash: string;
  deposit: string;
  rate: string;
  /** 0 keeps the stream open until closed or prepaid funds are exhausted. */
  duration_seconds: number;
  started_at: string;
  closed_at: string | null;
  earned: string;
  refunded: string;
}
export interface Vault {
  version: string;
  owner_id: string;
  token_id: string;
  agent_id: string;
  agent_key: string;
  policy_key: string;
  policy: Policy;
  available: string;
  spent: string;
  reserved: string;
  claimable_total: string;
  pending_total: string;
  next_nonce: string;
  active_session: string | null;
  paused: boolean;
  now: string;
}
export interface Receipt<T = unknown> {
  hash: string;
  signerId: string;
  receiverId: string;
  value: T;
  receiptFailures: { id: string; error: unknown }[];
  receiptIds: string[];
  logs: string[];
}
export const USDC: Readonly<{ testnet: string; mainnet: string }>;
export const AGENT_METHODS: readonly string[];
export function formatUSDC(raw: string | bigint): string;
export function decodeOutcome(outcome: unknown): Receipt;
export class NearAgentStreamsClient {
  constructor(options: {
    vaultId: string;
    accountId?: string;
    privateKey?: string;
    rpcUrl?: string;
    provider?: JsonRpcProvider;
  });
  vaultId: string;
  accountId?: string;
  publicKey: string | null;
  view<T>(method: string, args?: object, contractId?: string): Promise<T>;
  getVault(): Promise<Vault>;
  getStream(sessionId: string): Promise<Stream | null>;
  listStreams(fromIndex?: number, limit?: number): Promise<Stream[]>;
  getClaim(accountId: string): Promise<string>;
  tokenBalance(accountId: string, tokenId: string): Promise<string>;
  assertRestrictedAgent(): Promise<Vault>;
  execute<T>(
    method: string,
    args?: object,
    options?: { deposit?: bigint; gas?: bigint; contractId?: string }
  ): Promise<Receipt<T>>;
  open(approval: Approval): Promise<Receipt<Stream>>;
  close(approval: Approval): Promise<Receipt<Stream>>;
  recover(sessionId: string): Promise<Receipt<Stream>>;
  settleExpired(sessionId: string): Promise<Receipt<Stream>>;
  claim(): Promise<Receipt<boolean>>;
  anchorDecision(
    root: string
  ): Promise<Receipt<{ sequence: string; root: string; recorded_at: string }>>;
  getDecision(
    sequence: string | number
  ): Promise<{ sequence: string; root: string; recorded_at: string } | null>;
  withdrawEarned(sessionId: string): Promise<Receipt<boolean>>;
  topUpStream(sessionId: string, amount: string | bigint): Promise<Receipt<Stream>>;
  withdraw(amount: string | bigint): Promise<Receipt<boolean>>;
  fund(amount: string | bigint): Promise<Receipt<string>>;
}

export { NearAgentStreamsClient as NearAgentPayClient };
