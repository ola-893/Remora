import "dotenv/config";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { readConfig } from "./lib/config.mjs";
import { NearAgentStreamsClient } from "./sdk/index.mjs";
import { startProvider } from "./provider.mjs";
import { runDemo } from "./run.mjs";

const { values } = parseArgs({
  options: { sandbox: { type: "boolean" }, config: { type: "string" } },
  strict: true,
});
let sandbox,
  service,
  server,
  currentRun = null,
  running = false,
  runPromise = null;
const csrf = randomBytes(24).toString("hex");
const abort = new AbortController();
try {
  let configPath =
    values.config || process.env.NEAR_CONFIG || ".local/near/deployment.json";
  if (values.sandbox) {
    await mkdir(".local/near", { recursive: true });
    const directory = await mkdtemp(".local/near/dashboard-");
    const { createSandbox } = await import("./scripts/sandbox.mjs");
    sandbox = await createSandbox({ directory });
    service = await startProvider(sandbox.config, { port: 0 });
    sandbox.config.serviceUrl = service.origin;
    configPath = resolve(directory, "deployment.json");
    await writeFile(configPath, JSON.stringify(sandbox.config, null, 2));
  }
  const config = await readConfig(configPath);
  const client = new NearAgentStreamsClient({
    vaultId: config.vaultId,
    rpcUrl: config.rpcUrl,
  });
  server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(JSON.stringify(body));
    };
    if (!["127.0.0.1:5328", "localhost:5328"].includes(req.headers.host))
      return send(403, { error: "Invalid host." });
    try {
      if (req.method === "GET" && req.url === "/api/near/state") {
        const [vault, streams] = await Promise.all([
          client.getVault(),
          client.listStreams(0, 100),
        ]);
        return send(200, {
          network: config.network,
          vaultId: config.vaultId,
          vault,
          streams,
          running,
          run: currentRun,
          csrf,
        });
      }
      if (req.method !== "POST" || req.url !== "/api/near/run")
        return send(404, { error: "Not found." });
      if (
        !["http://127.0.0.1:5327", "http://localhost:5327"].includes(
          req.headers.origin
        )
      )
        return send(403, { error: "Local dashboard origin required." });
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024)
          return send(413, { error: "Request too large." });
      }
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        return send(400, { error: "Invalid JSON." });
      }
      if (input.csrf !== csrf || !["scripted", "model"].includes(input.mode))
        return send(403, {
          error: "Refresh the local dashboard before running.",
        });
      if (running)
        return send(409, { error: "An agent run is already active." });
      running = true;
      currentRun = {
        events: [],
        receipts: [],
        results: {},
        agentMode: input.mode,
        network: config.network,
      };
      runPromise = runDemo({
        configPath,
        service,
        ai: input.mode === "model",
        signal: abort.signal,
        onEvent(event) {
          currentRun.events.push(event);
          if (event.type === "transaction") currentRun.receipts.push(event);
        },
      })
        .then((run) => {
          currentRun = run;
        })
        .catch((error) => {
          currentRun = error.run || {
            ...currentRun,
            ok: false,
            error:
              "Run failed. Inspect the local CLI evidence and recovery status.",
          };
        })
        .finally(() => {
          running = false;
          runPromise = null;
        });
      return send(202, { started: true });
    } catch {
      return send(503, {
        error:
          "NEAR state is unavailable. Check the local node and deployment.",
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(5328, "127.0.0.1", resolve);
  });
  console.log(
    `agentStreams NEAR ${config.network} API · http://127.0.0.1:5328 · config ${configPath}`
  );
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    abort.abort();
    server.close();
    await runPromise;
    await service?.close();
    await sandbox?.sandbox.tearDown();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  console.error(error.message);
  await service?.close();
  await sandbox?.sandbox.tearDown();
  process.exitCode = 1;
}
