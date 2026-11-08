import { createServer } from "node:http";
import { NearAgentStreamsClient } from "./sdk/index.mjs";
import { verifySession } from "./lib/session.mjs";

export async function startProvider(config, { port, host = "127.0.0.1", handleRequest, rates = { basic: '10', premium: '200' }, durationSeconds = 1000 } = {}) {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 4294967295 ||
      Object.keys(rates).length !== 2 || !['basic', 'premium'].every(tier => /^[1-9][0-9]{0,20}$/.test(rates[tier]))) throw new Error('INVALID_SERVICE_PRICING');
  const client = new NearAgentStreamsClient({
    vaultId: config.vaultId,
    rpcUrl: config.rpcUrl,
  });
  let unavailable = false;
  let requestUnavailable = false;
  const counters = new Map();
  const quotes = new Map();
  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method !== "GET")
        return send(405, { error: "METHOD_NOT_ALLOWED" });
      if (url.pathname === (config.service?.healthPath || "/health"))
        return send(200, {
          ok: !unavailable,
          observed_at: Math.floor(Date.now() / 1000),
        });
      if (url.pathname === (config.service?.quotePath || "/quote")) {
        const tier = url.searchParams.get("tier") || "basic";
        if (!["basic", "premium"].includes(tier))
          return send(400, { error: "INVALID_TIER" });
        const now = Math.floor(Date.now() / 1000);
        let quote = quotes.get(tier);
        if (!quote || quote.expires_at <= now + 30) {
          quote = {
            version: 1,
            vault_id: config.vaultId,
            token_id: config.tokenId,
            recipient_id: config.recipientId,
            tier,
            rate: rates[tier],
            duration_seconds: durationSeconds,
            expires_at: now + 300,
          };
          quotes.set(tier, quote);
        }
        return send(200, quote);
      }
      if (url.pathname !== (config.service?.requestPath || "/research"))
        return send(404, { error: "NOT_FOUND" });
      if (unavailable || requestUnavailable)
        return send(503, { error: "DEMO_OUTAGE", injected: true });
      const encoded = req.headers["x-agentpay-session"];
      if (!encoded)
        return send(402, {
          error: "PAYMENT_REQUIRED",
          quote: `${config.serviceUrl}/quote?tier=basic`,
          protocol: "agentpay-near-v1",
        });
      let session;
      try {
        const untrusted = JSON.parse(
          Buffer.from(encoded, "base64url").toString("utf8")
        );
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(untrusted.session_id ?? ""))
          throw new Error();
        const [vault, stream] = await Promise.all([
          client.getVault(),
          client.getStream(untrusted.session_id),
        ]);
        session = verifySession(encoded, {
          config,
          vault,
          stream,
          now: Number(vault.now),
        });
        if (stream.recipient_id !== config.recipientId) throw new Error();
      } catch {
        return send(403, { error: "INVALID_OR_INACTIVE_SESSION" });
      }
      const count = (counters.get(session.session_id) || 0) + 1;
      counters.set(session.session_id, count);
      if (handleRequest) {
        const result = await handleRequest(url.searchParams);
        return send(result.status || 200, { request: count, session_id: session.session_id, ...result.body });
      }
      return send(200, {
        request: count,
        session_id: session.session_id,
        source: "agentStreams local research fixture",
        content:
          "This paid API response reused the active NEAR payment session. Provider earnings accrue by time, not request count.",
      });
    } catch {
      send(503, { error: "PROVIDER_VERIFICATION_UNAVAILABLE" });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      port ?? Number(new URL(config.serviceUrl).port || 5321),
      host,
      resolve
    );
  });
  return {
    server,
    origin: `http://${host}:${server.address().port}`,
    setUnavailable(value) {
      unavailable = Boolean(value);
    },
    setRequestUnavailable(value) {
      requestUnavailable = Boolean(value);
    },
    requests(sessionId) {
      return counters.get(sessionId) || 0;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
