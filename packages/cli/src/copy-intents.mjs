import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { rawAmount } from './copy-activity.mjs';

const api = 'https://api.agentsonintents.com';
const final = new Set(['SUCCESS', 'FAILED', 'REFUNDED']);
const pending = new Set(['QUEUED', 'PROCESSING']);

export function credential(name) {
  const value = process.env[name];
  if (!value || value.length > 8192 || /[^\x21-\x7e]/.test(value)) throw new Error(`Set ${name} in the agent process environment.`);
  return value;
}

export function intentsConfig(flags) {
  if (!/^[a-z0-9_-]{1,128}$/i.test(flags['intents-agent-id'] ?? '')) throw new Error('Provide --intents-agent-id for an owner-provisioned Agent Connect account.');
  const result = { id: flags['intents-agent-id'], keyEnv: flags['intents-key-env'] ?? 'NEAR_INTENTS_AGENT_API_KEY', grantEnv: flags['intents-grant-env'] ?? 'NEAR_INTENTS_GRANT_TOKEN', live: flags.live === true, confidential: flags.confidential === true };
  if (![result.keyEnv, result.grantEnv].every(value => /^[A-Z][A-Z0-9_]{0,127}$/.test(value))) throw new Error('Credential options accept environment variable names.');
  return result;
}

export function intentsAdapter(config, fetchImpl = fetch) {
  const basePath = `/v1/agents/${encodeURIComponent(config.id)}`;
  async function request(path, { body, key, grant = false } = {}) {
    const headers = { 'X-API-Key': credential(config.keyEnv) };
    if (grant) headers['X-Grant-Token'] = credential(config.grantEnv);
    if (key) headers['Idempotency-Key'] = key;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetchImpl(`${api}${path}`, { headers, redirect: 'error', signal: AbortSignal.timeout(15000), ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) {
      const code = data.code ?? data.errors?.[0]?.code;
      throw new Error(`INTENTS_HTTP_${response.status}${/^[a-z0-9_]+$/.test(code ?? '') ? ` ${code}` : ''}`);
    }
    return data;
  }

  return {
    async quote(order) {
      const result = await request(`${basePath}/swap`, { key: randomUUID(), body: { ...order, confidential: config.confidential, dry: true } });
      if (result.dry !== true || result.type !== 'swap') throw new Error('INTENTS_EXPECTED_DRY_QUOTE');
      const quote = result.quote?.quote ?? result.quote;
      const amountOut = quote?.amountOut ?? quote?.amount_out;
      const amountIn = quote?.amountIn ?? quote?.amount_in;
      if (!rawAmount(amountOut) || !rawAmount(amountIn)) throw new Error('INTENTS_QUOTE_AMOUNTS_MISSING');
      return { source: 'agent-connect', observedAt: new Date(Date.now()).toISOString(), confidentialRequested: config.confidential === true, amountIn, amountOut, amountInUsd: result.spend?.amount_usd ?? null, warnings: (result.warnings ?? []).map(item => item.code), ownerApproval: result.owner_approval === true };
    },
    async execute(order, key) {
      if (!config.live) throw new Error('INTENTS_LIVE_DISABLED');
      return request(`${basePath}/swap`, { key, grant: true, body: { ...order, confidential: config.confidential } });
    },
    async status(correlationId) {
      if (typeof correlationId !== 'string' || !correlationId.length || correlationId.length > 128) throw new Error('INTENTS_CORRELATION_MISSING');
      return request(`/v1/status?${new URLSearchParams({ correlation_id: correlationId })}`);
    },
    async settle(result, order, { attempts = 8 } = {}) {
      const correlationId = result.correlation_id;
      const validate = value => {
        if (!/^[a-z0-9_-]{1,128}$/i.test(correlationId ?? '') || value.correlation_id !== correlationId ||
            value.agent_id !== config.id || value.type !== 'swap') throw new Error('INTENTS_STATUS_IDENTITY_MISMATCH');
      };
      validate(result);
      for (let i = 0; i < attempts && pending.has(result.status); i++) {
        await delay(1500);
        result = await this.status(correlationId);
        validate(result);
      }
      if (result.status === 'SUCCESS') {
        const details = result.details, requested = details?.request, at = Date.parse(result.updated_at);
        if (config.confidential && details?.confidential !== true) throw new Error('INTENTS_CONFIDENTIALITY_UNCONFIRMED: reconcile this execution before another trade.');
        if (!requested || !['origin_asset', 'destination_asset', 'amount'].every(key => requested[key] === order[key]) ||
            !rawAmount(details.amount_out) || BigInt(details.amount_out) < BigInt(order.min_amount_out) ||
            !Number.isSafeInteger(at) || at > Date.now() + 5000) throw new Error('INTENTS_SETTLEMENT_MISMATCH');
      }
      return { status: result.status, final: final.has(result.status), correlationId, details: result.details, updatedAt: Date.parse(result.updated_at),
        privacy: { requested: config.confidential === true, providerConfirmed: result.status === 'SUCCESS' && result.details?.confidential === true, independentlyVerified: false } };
    },
  };
}

export function minimumOutput(action, order, policy) {
  const numerator = BigInt(action.amountOut) * BigInt(order.amount) * BigInt(10000 - policy.slippageBps);
  const denominator = BigInt(action.amountIn) * 10000n;
  return ((numerator + denominator - 1n) / denominator).toString();
}
