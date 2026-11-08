// Synthetic, deterministic provider fixtures. No LLM/model quality is claimed.
// Showcase can only answer the exact published examples; no split flag is sent.
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import {
  makeTask,
  expectedAnswer,
  providers,
  families,
  taskSchema,
} from "../../policy/toolbuyer-core.ts";

const key = (t) => JSON.stringify({ family: t.family, input: t.input });
export const visibleTasks = families.flatMap((f) =>
  [0, 1, 2].map((i) => makeTask(f, 1, i))
);
const memorized = new Map(visibleTasks.map((t) => [key(t), expectedAnswer(t)]));
export function providerAnswer(provider, task) {
  const x = task.input;
  if (provider === "showcase") return memorized.get(key(task)) ?? "UNKNOWN";
  if (provider === "budget") {
    if (task.family === "invoice")
      return x.lines.reduce((s, l) => s + l.unitRaw * l.quantity, 0).toString();
    if (task.family === "units")
      return String(Math.round(Number(x.usdc) * 100) * 10000);
    return x.routes[0].latencyMs <= x.maxLatencyMs ? x.routes[0].id : "NONE";
  }
  // Separate implementation from the grading oracle, checked with known vectors.
  if (task.family === "invoice") {
    let total = 0;
    for (const line of x.lines) total += line.unitRaw * line.quantity;
    return String(Math.floor(total * (1 - x.discountBps / 10000) + 1e-7));
  }
  if (task.family === "units")
    return String(Math.round(Number(x.usdc) * 1000000));
  let winner;
  for (const r of x.routes)
    if (
      r.latencyMs <= x.maxLatencyMs &&
      (!winner ||
        r.feeRaw < winner.feeRaw ||
        (r.feeRaw === winner.feeRaw && r.id < winner.id))
    )
      winner = r;
  return winner?.id || "NONE";
}
export async function startProviders() {
  const run = randomBytes(8).toString("hex"),
    ledger = [],
    cache = new Map();
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method !== "GET" || !url.pathname.startsWith(`/run/${run}/`))
        throw new Error("Unknown route");
      const [, , , kind, account, provider] = url.pathname.split("/");
      if (
        !["trial", "service"].includes(kind) ||
        !["toolbuyer", "cheapest", "fixed-showcase", "fixed-expert"].includes(
          account
        ) ||
        !providers.some((p) => p.id === provider)
      )
        throw new Error("Invalid purchase");
      const task = taskSchema.parse(JSON.parse(url.searchParams.get("task")));
      const requestKey = `${kind}/${account}/${provider}/${task.id}`;
      const previous = cache.get(requestKey);
      if (previous && previous.input !== JSON.stringify(task))
        throw new Error("Idempotency key reused for different input");
      if (previous) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(previous.reply));
        return;
      }
      const p = providers.find((p) => p.id === provider);
      const reply = {
        taskId: task.id,
        provider,
        answer: providerAnswer(provider, task),
        costRaw: kind === "trial" ? p.trialCostRaw : p.serviceCostRaw,
        receiptId: createHash("sha256")
          .update(`${run}/${requestKey}`)
          .digest("hex"),
        billingMode: "benchmark-credits",
      };
      ledger.push({
        account,
        kind,
        taskId: task.id,
        provider,
        costRaw: reply.costRaw,
        receiptId: reply.receiptId,
      });
      cache.set(requestKey, { input: JSON.stringify(task), reply });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    } catch {
      res.writeHead(400);
      res.end("Invalid benchmark request");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/run/${run}`,
    ledger,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
export function purchaseUrl(base, kind, account, provider, task) {
  return `${base}/${kind}/${account}/${provider}?task=${encodeURIComponent(
    JSON.stringify(task)
  )}`;
}
