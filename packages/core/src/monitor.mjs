export function startMonitor(client, { onEvent = () => {}, onError = () => {} } = {}) {
  let stopped = false, running = Promise.resolve();
  const tick = () => {
    running = running.then(async () => {
      if (stopped) return;
      const status = await client.status();
      if (!status.vault.active_session) return;
      const result = await client.check({ tier: status.tier });
      if (result.decision === 'CLOSE') onEvent({ ...await client.close({ sessionId: result.sessionId }), reason: result.reason });
      else if (result.decision === 'DENY') throw new Error(result.reason);
    }).catch(onError);
  };
  const timer = setInterval(tick, (client.runtimePolicy?.healthPollSeconds || 10) * 1000);
  return { async stop() { stopped = true; clearInterval(timer); await running; } };
}
