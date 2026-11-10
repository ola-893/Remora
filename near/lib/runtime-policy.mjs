import { streamAccessReason } from "./stream.mjs";
// Host-side service rules. Financial limits remain enforced by the vault.
export const runtimeDefaults = Object.freeze({
  maxConsecutive5xx: 3, maxConsecutiveTransportErrors: 2,
  maxConsecutiveHealthFailures: 1, idleTimeoutSeconds: 60,
  maxRequestsPerStream: 1000, healthPollSeconds: 10,
  failureCooldownSeconds: 30,
  reuseStream: true, closeOnExit: true,
});
export function runtimePolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !(k in runtimeDefaults))) throw new Error('INVALID_RUNTIME_POLICY');
  const result = { ...runtimeDefaults, ...input };
  for (const [key, value] of Object.entries(result)) {
    if (typeof runtimeDefaults[key] === 'boolean') { if (typeof value !== 'boolean') throw new Error('INVALID_RUNTIME_POLICY'); }
    else if (!Number.isSafeInteger(value) || value < 1 || value > (key === 'maxRequestsPerStream' ? 1000000 : 3600)) throw new Error('INVALID_RUNTIME_POLICY');
  }
  return result;
}
export function serviceConfig(input = {}) {
  const result = { healthPath: '/health', quotePath: '/quote', requestPath: '/research', tiers: ['basic', 'premium'], ...input };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['healthPath', 'quotePath', 'requestPath', 'tiers', 'publisher'].includes(k))) throw new Error('INVALID_SERVICE_CONFIG');
  if (result.publisher !== undefined && !/^ap_[a-f0-9]{64}$/.test(result.publisher)) throw new Error('INVALID_SERVICE_PUBLISHER');
  for (const key of ['healthPath', 'quotePath', 'requestPath']) {
    const path = result[key];
    if (typeof path !== 'string' || !/^\/(?!\/)/.test(path) || path.includes('\\') || /[?#\s]/.test(path) || new URL(path, 'https://service.invalid').origin !== 'https://service.invalid') throw new Error('INVALID_SERVICE_PATH');
  }
  if (!Array.isArray(result.tiers) || result.tiers.length < 1 || result.tiers.length > 32 || new Set(result.tiers).size !== result.tiers.length || result.tiers.some(t => !/^[a-zA-Z0-9_-]{1,64}$/.test(t))) throw new Error('INVALID_SERVICE_TIERS');
  return result;
}
export function updateObservation(previous, observation, now = Math.floor(Date.now() / 1000)) {
  const state = { requests: 0, consecutive5xx: 0, transportErrors: 0, healthFailures: 0, lastRequestAt: now, ...previous };
  if (observation.kind === 'health') state.healthFailures = observation.ok ? 0 : state.healthFailures + 1;
  else if (observation.kind === 'response' && Number.isInteger(observation.status) && observation.status >= 100 && observation.status <= 599) {
    state.requests++; state.lastRequestAt = now; state.transportErrors = 0;
    state.consecutive5xx = observation.status >= 500 ? state.consecutive5xx + 1 : 0;
    if ([401, 403, 402].includes(observation.status)) state.stopReason = 'SERVICE_ACCESS_REJECTED';
  } else if (observation.kind === 'transport') { state.requests++; state.lastRequestAt = now; state.transportErrors++; state.consecutive5xx = 0; }
  else throw new Error('INVALID_OBSERVATION');
  return state;
}
export function closeReason(policy, state, stream, now = Math.floor(Date.now() / 1000)) {
  const access = streamAccessReason(stream, now);
  if (access && access !== 'STREAM_CLOSED') return access;
  if (state.stopReason) return state.stopReason;
  if (state.consecutive5xx >= policy.maxConsecutive5xx) return 'SERVICE_5XX_LIMIT';
  if (state.transportErrors >= policy.maxConsecutiveTransportErrors) return 'SERVICE_TRANSPORT_LIMIT';
  if (state.healthFailures >= policy.maxConsecutiveHealthFailures) return 'SERVICE_UNAVAILABLE';
  if (now - Number(state.lastRequestAt ?? stream.started_at) >= policy.idleTimeoutSeconds) return 'STREAM_IDLE_TIMEOUT';
  if (state.requests >= policy.maxRequestsPerStream) return 'STREAM_REQUEST_LIMIT';
  return null;
}
