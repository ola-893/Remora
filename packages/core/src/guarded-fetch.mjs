export class PaymentDeniedError extends Error {
  constructor(result) { super(`agentStreams: ${result.reason || result.decision}`); this.name = 'PaymentDeniedError'; this.decision = result; }
}

export function guardedFetch(fetchImpl, { client, tier = 'basic' }) {
  const origin = new URL(client.serviceUrl).origin;
  const configured = new URL(origin);
  if (configured.protocol !== 'https:' && !(configured.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname))) throw new Error('UNSAFE_ORIGIN');
  // Serialize the admission path, so concurrent requests cannot open two sessions.
  let queue = Promise.resolve();
  return (input, init = {}) => {
    const run = async () => {
      const events = [];
      const record = result => events.push({ ...result, ...(result.receipt?.hash && client.mode === 'testnet' ? { explorerUrl: `https://testnet.nearblocks.io/txns/${result.receipt.hash}` } : {}) });
      const finish = response => {
        const metadata = { value: { events }, configurable: true };
        Object.defineProperties(response, { agentstreams: metadata, agentpay: metadata });
        return response;
      };
      const req = new Request(input, init);
      req.signal.throwIfAborted();
      const url = new URL(req.url);
      if (url.origin !== origin || url.username || url.password) throw new Error('ORIGIN_DENIED');
      if (!['GET', 'HEAD'].includes(req.method)) throw new Error('UNSAFE_RETRY_METHOD');
      if (req.headers.has('x-agentpay-session') || req.headers.has('x-agentpay-demo-session')) throw new Error('SESSION_HEADER_HOST_ONLY');
      const decision = await client.check({ tier });
      record({ decision: decision.decision, reason: decision.reason, sessionId: decision.sessionId });
      req.signal.throwIfAborted();
      if (!['OPEN', 'CONTINUE'].includes(decision.decision)) {
        if (decision.decision === 'CLOSE') record(await client.close({ sessionId: decision.sessionId }));
        throw new PaymentDeniedError(decision);
      }
      const send = async () => {
        const headers = new Headers(req.headers);
        for (const [key, value] of Object.entries(await client.sessionHeaders())) headers.set(key, value);
        let response;
        try { response = await fetchImpl(new Request(req, { headers, redirect: 'error', credentials: 'omit' })); }
        catch (error) {
          if (headers.has('x-agentpay-session') && client.observeResult) {
            const result = await client.observeResult({ kind: 'transport' });
            if (result.decision === 'CLOSE') await client.close({ sessionId: result.sessionId });
          }
          throw error;
        }
        if (headers.has('x-agentpay-session') && client.observeResult) {
          const result = await client.observeResult({ kind: 'response', status: response.status });
          record(result);
          if (result.decision === 'CLOSE' || client.runtimePolicy?.reuseStream === false) record({ ...await client.close({ sessionId: result.sessionId }), reason: result.decision === 'CLOSE' ? result.reason : 'REUSE_DISABLED' });
        }
        return response;
      };
      const response = await send();
      if (response.status !== 402) return finish(response);
      // Only the supported protocol triggers admission. Never follow quote URLs supplied by a response.
      let challenge;
      try { challenge = await response.clone().json(); } catch { throw new PaymentDeniedError({ decision: 'DENY', reason: 'UNSUPPORTED_PAYMENT_PROTOCOL' }); }
      if (challenge.protocol !== 'agentpay-near-v1') throw new PaymentDeniedError({ decision: 'DENY', reason: 'UNSUPPORTED_PAYMENT_PROTOCOL' });
      req.signal.throwIfAborted();
      if (decision.decision === 'OPEN') record(await client.open({ approvalId: decision.approvalId }));
      else if (decision.decision !== 'CONTINUE') throw new PaymentDeniedError(decision);
      // At most one retry. A second challenge never buys another stream.
      return finish(await send());
    };
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  };
}
