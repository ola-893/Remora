import { assessQuote } from './policy.mjs';

export function requireTier(tier) {
  if (!['basic', 'premium'].includes(tier)) throw new Error('INVALID_TIER');
}

// Deliberately separate from NEAR credentials, receipts and session signatures.
export class OfflineGateway {
  #approvals = new Map();
  #counter = 0;
  #stream = null;
  #tier = null;
  #healthy = true;
  #spent = 0n;
  #requests = 0;
  serviceUrl = 'https://offline.agentpay.invalid';
  mode = 'offline';
  setHealthy(value) { this.#healthy = Boolean(value); }
  async check({ tier = 'basic' } = {}) {
    requireTier(tier);
    if (this.#stream) {
      if (tier !== this.#tier) return { decision: 'DENY', reason: 'ACTIVE_STREAM' };
      return { decision: this.#healthy ? 'CONTINUE' : 'CLOSE', reason: this.#healthy ? 'SERVICE_HEALTHY' : 'SERVICE_UNAVAILABLE', sessionId: this.#stream };
    }
    const now = 100000;
    const quote = { version: 1, vault_id: 'offline-vault', token_id: 'offline-usdc', recipient_id: 'offline-provider', rate: tier === 'basic' ? '10' : '200', duration_seconds: 1000, expires_at: now + 300 };
    const result = assessQuote({ now, health: { ok: this.#healthy, observed_at: now }, quote, vault: {
      vault_id: quote.vault_id, token_id: quote.token_id, policy: { recipients: [quote.recipient_id], max_rate: '100', max_deposit: '10000', max_duration_seconds: 1000, budget: '20000' },
      spent: String(this.#spent), available: String(100000n - this.#spent), paused: false, active_session: null,
    } });
    if (result.decision !== 'OPEN') return result;
    this.#approvals.clear();
    const approvalId = `offline-approval-${++this.#counter}`;
    this.#approvals.set(approvalId, tier);
    return { ...result, approvalId, mode: 'offline' };
  }
  async open({ approvalId }) {
    const tier = this.#approvals.get(approvalId);
    this.#approvals.delete(approvalId);
    if (!tier || this.#stream || !this.#healthy) throw new Error('APPROVAL_INVALID');
    this.#tier = tier;
    this.#stream = `offline-session-${this.#counter}`;
    return { decision: 'CONTINUE', sessionId: this.#stream, mode: 'offline', simulated: true };
  }
  async close({ sessionId }) {
    if (!this.#stream || sessionId !== this.#stream) throw new Error('SESSION_NOT_ACTIVE');
    this.#spent += 20n;
    this.#stream = null;
    this.#tier = null;
    return { decision: 'CLOSE', sessionId, mode: 'offline', simulated: true, accounting: { deposit: '10000', earned: '20', refunded: '9980', unit: 'simulated six-decimal USDC' } };
  }
  async sessionHeaders() { return this.#stream ? { 'x-agentpay-demo-session': this.#stream } : {}; }
  async transport(input, init) {
    const req = new Request(input, init);
    if (new URL(req.url).origin !== this.serviceUrl) throw new Error('ORIGIN_DENIED');
    if (!this.#healthy) return Response.json({ error: 'SIMULATED_OUTAGE' }, { status: 503 });
    if (!this.#stream || req.headers.get('x-agentpay-demo-session') !== this.#stream) return Response.json({ protocol: 'agentpay-near-v1', simulated: true }, { status: 402 });
    return Response.json({ simulated: true, sessionId: this.#stream, request: ++this.#requests, content: 'Offline agentStreams fixture response' });
  }
  async dispose() {}
}
