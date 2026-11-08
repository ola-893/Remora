import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';

export class PaymentExecutor {
  #client; #worker; #approvals = new Map(); #tier; #active; #queue = Promise.resolve(); #dir; #enabled; #tiers; #serviceId;
  constructor({ client, worker, stateDir, paymentsEnabled = false, tiers = ['basic', 'premium'], serviceId = 'default' }) {
    this.#client = client; this.#worker = worker; this.#dir = stateDir; this.#enabled = paymentsEnabled; this.#tiers = tiers; this.#serviceId = serviceId;
  }
  async #ready() {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    try { await access(join(this.#dir, 'policy-pending.json')); throw new Error('POLICY_RECONCILIATION_REQUIRED'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    try { await access(join(this.#dir, 'pending.json')); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    throw new Error('RECONCILIATION_REQUIRED');
  }
  #serial(fn) { const result = this.#queue.then(fn); this.#queue = result.catch(() => {}); return result; }
  async #exclusive(fn) {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const path = join(this.#dir, 'operation.lock');
    let lock;
    try { lock = await open(path, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') throw new Error('EXECUTOR_BUSY_OR_INTERRUPTED'); throw e; }
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); return await fn(); }
    finally { await lock.close(); await unlink(path); }
  }
  async context() {
    const vault = await this.#client.assertRestrictedAgent();
    if (!vault.active_session) { this.#active = null; return { vault, stream: null }; }
    const stream = await this.#client.getStream(vault.active_session);
    let saved;
    try { saved = JSON.parse(await readFile(join(this.#dir, 'session-context.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const matches = saved && saved.serviceId === this.#serviceId && saved.sessionId === vault.active_session && stream && stream.closed_at === null && saved.quoteHash === stream.quote_hash && saved.recipientId === stream.recipient_id;
    if (matches) { this.#active = saved.sessionId; this.#tier = saved.tier; }
    else { this.#active = null; this.#tier = null; }
    return { vault, stream, reusable: Boolean(matches), tier: matches ? saved.tier : undefined };
  }
  async check({ tier, expectedQuoteHash } = {}) {
    await this.#ready();
    const { vault } = await this.context();
    tier ??= this.#tier || this.#tiers[0];
    if (!this.#tiers.includes(tier)) throw new Error('INVALID_TIER');
    if (vault.active_session) {
      if (vault.active_session !== this.#active || tier !== this.#tier) return { decision: 'DENY', reason: 'ACTIVE_SESSION_RECOVERY_REQUIRED', sessionId: vault.active_session };
      const result = await this.#worker.request({ action: 'CHECK', sessionId: this.#active });
      return { decision: result.decision, reason: result.reason, counters: result.counters, sessionId: this.#active };
    }
    this.#active = null;
    const sessionId = randomUUID();
    const result = await this.#worker.request({ action: 'OPEN', sessionId, tier });
    if (result.decision !== 'OPEN') return { decision: result.decision, reason: result.reason };
    if (expectedQuoteHash !== undefined && result.approval.permit.quote_hash !== expectedQuoteHash) return { decision: 'DENY', reason: 'QUOTE_CHANGED' };
    // Do not retain raw signed permits across tool calls; a fresh worker check signs on submission.
    const approvalId = randomUUID();
    this.#approvals.clear();
    this.#approvals.set(approvalId, { sessionId, tier, intent: intent(result.approval), expires: Date.now() + 60000 });
    return { decision: 'OPEN', reason: result.reason, deposit: result.deposit, approvalId, paymentsEnabled: await this.#paymentsEnabled() };
  }
  open({ approvalId }) {
    return this.#serial(async () => {
      if (!await this.#paymentsEnabled()) throw new Error('PAYMENTS_DISABLED');
      await this.#ready();
      const saved = this.#approvals.get(approvalId);
      this.#approvals.delete(approvalId);
      if (!saved || saved.expires < Date.now()) throw new Error('APPROVAL_INVALID');
      await this.#client.assertRestrictedAgent();
      const fresh = await this.#worker.request({ action: 'OPEN', sessionId: saved.sessionId, tier: saved.tier });
      if (fresh.decision !== 'OPEN') throw new Error(fresh.reason || 'POLICY_DENIED');
      if (intent(fresh.approval) !== saved.intent) throw new Error('INTENT_CHANGED');
      if (!await this.#paymentsEnabled()) throw new Error('PAYMENTS_DISABLED');
      const receipt = await this.#submit('OPEN', fresh.approval, { tier: saved.tier, serviceId: this.#serviceId, sessionId: saved.sessionId, quoteHash: fresh.approval.permit.quote_hash, recipientId: fresh.approval.permit.recipient_id });
      this.#active = saved.sessionId; this.#tier = saved.tier;
      return { decision: 'CONTINUE', sessionId: saved.sessionId, receipt };
    });
  }
  #paymentsEnabled() { return typeof this.#enabled === 'function' ? this.#enabled() : this.#enabled; }
  close({ sessionId } = {}) {
    return this.#serial(async () => {
      await this.#ready();
      const vault = await this.#client.assertRestrictedAgent();
      sessionId ??= vault.active_session;
      if (!sessionId) return { decision: 'CLOSE', alreadyClosed: true };
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) throw new Error('INVALID_SESSION');
      const stream = await this.#client.getStream(sessionId);
      if (stream?.closed_at !== null && stream?.closed_at !== undefined) return { decision: 'CLOSE', sessionId, alreadyClosed: true };
      if (!stream || vault.active_session !== sessionId) throw new Error('SESSION_NOT_ACTIVE');
      const result = await this.#worker.request({ action: 'SHUTDOWN', sessionId });
      if (result.decision !== 'CLOSE') throw new Error('CLOSE_NOT_APPROVED');
      const receipt = await this.#submit('CLOSE', result.approval);
      this.#active = null; this.#tier = null;
      return { decision: 'CLOSE', sessionId, receipt };
    });
  }
  async observe(observation) {
    await this.#ready();
    const { vault, reusable } = await this.context();
    if (!vault.active_session) return { decision: 'CONTINUE', reason: 'NO_ACTIVE_STREAM' };
    if (!reusable) throw new Error('ACTIVE_SESSION_RECOVERY_REQUIRED');
    const result = await this.#worker.request({ action: 'OBSERVE', sessionId: vault.active_session, observation });
    return { decision: result.decision, reason: result.reason, counters: result.counters, sessionId: vault.active_session };
  }
  async #submit(action, approval, context) {
    return this.#exclusive(async () => {
    await this.#ready();
    const current = await this.#client.assertRestrictedAgent();
    if (current.next_nonce !== approval.permit.nonce || (action === 'OPEN' ? current.active_session !== null : current.active_session !== approval.permit.session_id)) throw new Error('APPROVAL_STALE');
    const file = join(this.#dir, 'pending.json');
    let handle;
    try { handle = await open(file, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') throw new Error('RECONCILIATION_REQUIRED'); throw e; }
    try { await handle.writeFile(JSON.stringify({ action, permit: approval.permit, context, createdAt: new Date().toISOString() })); await handle.sync(); } finally { await handle.close(); }
    // Any exception after recording the intent leaves the journal in place, including transport timeouts.
    const receipt = await (action === 'OPEN' ? this.#client.open(approval) : this.#client.close(approval));
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(receipt.hash)) throw new Error('INVALID_RECEIPT_HASH');
    await writeFile(join(this.#dir, `receipt-${receipt.hash}.json`), JSON.stringify(receipt), { mode: 0o600 });
    if (context) await this.#saveContext(context);
    await unlink(file);
    return receipt;
    });
  }
  async #saveContext(context) {
    const file = join(this.#dir, 'session-context.json');
    const temp = file + `.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(context), { mode: 0o600 });
    const { rename } = await import('node:fs/promises');
    await rename(temp, file);
  }
  async reconcile() {
    return this.#exclusive(async () => {
    // Read-only chain queries; clear only a journal whose exact intended state is visible.
    const file = join(this.#dir, 'pending.json');
    let pending;
    try { pending = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { resolved: true, reason: 'NO_PENDING_INTENT' }; throw e; }
    const p = pending.permit;
    const vault = await this.#client.assertRestrictedAgent();
    const stream = await this.#client.getStream(p.session_id);
    const matches = stream && stream.recipient_id === p.recipient_id && stream.rate === p.rate && stream.duration_seconds === p.duration_seconds && stream.quote_hash === p.quote_hash;
    const applied = matches && (pending.action === 'OPEN' || stream.closed_at !== null) && BigInt(vault.next_nonce) > BigInt(p.nonce);
    if (!applied) return { resolved: false, reason: 'OUTCOME_UNCONFIRMED', sessionId: p.session_id };
    await writeFile(join(this.#dir, `reconciled-${p.session_id}-${p.nonce}.json`), JSON.stringify({ pending, stream, verifiedAt: new Date().toISOString(), receiptRecovered: false }), { mode: 0o600 });
    if (pending.action === 'OPEN' && pending.context) await this.#saveContext(pending.context);
    await unlink(file);
    return { resolved: true, reason: 'MATCHING_CHAIN_STATE', sessionId: p.session_id, receiptRecovered: false };
    });
  }
}

function intent(approval) {
  const { nonce, expires_at, ...bound } = approval.permit;
  return createHash('sha256').update(JSON.stringify(bound)).digest('hex');
}
