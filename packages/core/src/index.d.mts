export interface Decision {
  decision: 'OPEN' | 'CONTINUE' | 'CLOSE' | 'DENY';
  reason?: string; approvalId?: string; sessionId?: string; deposit?: string;
  [key: string]: unknown;
}
export interface Gateway {
  readonly mode: string; readonly serviceUrl: string;
  readonly service?: { healthPath: string; quotePath: string; requestPath: string; tiers: string[] };
  readonly runtimePolicy?: { reuseStream: boolean; closeOnExit: boolean; healthPollSeconds: number; [key: string]: number | boolean };
  check(args?: { tier?: string }): Promise<Decision>;
  open(args: { approvalId: string }): Promise<Decision>;
  close(args: { sessionId: string }): Promise<Decision>;
  sessionHeaders(): Promise<Record<string, string>>;
  dispose(): Promise<void>;
}
export class OfflineGateway implements Gateway {
  mode: 'offline'; serviceUrl: string;
  setHealthy(value: boolean): void;
  check(args?: { tier?: string }): Promise<Decision>;
  open(args: { approvalId: string }): Promise<Decision>;
  close(args: { sessionId: string }): Promise<Decision>;
  sessionHeaders(): Promise<Record<string, string>>;
  transport(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}
export class PaymentDeniedError extends Error { decision: Decision; constructor(result: Decision); }
export function guardedFetch(fetchImpl: typeof fetch, options: { client: Gateway; tier?: string }): typeof fetch;
export function assessQuote(args: { vault: { vault_id: string; token_id: string; policy: { recipients: string[]; max_rate: string; max_deposit: string; max_duration_seconds: number; budget: string }; spent: string; available: string; paused: boolean; active_session: string | null }; quote: { version: number; vault_id: string; token_id: string; recipient_id: string; rate: string; duration_seconds: number; expires_at: number }; health: { ok: boolean; observed_at: number }; now?: number }): Decision;
export function assessPrices(samples: { usd: number; observedAt: number; source?: string }[], now?: number): { decision: 'ALLOW' | 'DENY'; reason: string; samples?: unknown[] };
