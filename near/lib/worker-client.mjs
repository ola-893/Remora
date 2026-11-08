import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function startPolicyWorker(configPath, { env = process.env } = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../policy-worker.mjs", import.meta.url))], {
    env: { ...env, NEAR_CONFIG: resolve(configPath) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let counter = 0;
  let stopped = false;
  child.stdin.on("error", () => fail("Policy worker connection stopped."));
  // Do not forward raw process errors or file paths into a hosted dashboard.
  child.stderr.on("data", () => {});
  child.on("error", () => fail("Policy worker could not start."));
  child.on("exit", () =>
    fail("Policy worker stopped; owner recovery may be needed.")
  );
  function fail(message) {
    stopped = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(message));
    }
    pending.clear();
  }
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on(
    "line",
    (line) => {
      try {
        const response = JSON.parse(line),
          item = pending.get(response.id);
        if (!item) return;
        clearTimeout(item.timer);
        pending.delete(response.id);
        response.ok
          ? item.resolve(response.result)
          : item.reject(new Error(response.error));
      } catch {
        fail("Invalid policy worker response.");
      }
    }
  );
  return {
    request(request) {
      if (stopped) return Promise.reject(new Error("POLICY_WORKER_UNAVAILABLE"));
      return new Promise((resolve, reject) => {
        const id = ++counter;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Policy worker timed out."));
        }, 45000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ ...request, id }) + "\n");
      });
    },
    stop() {
      child.stdin.end();
      child.kill("SIGTERM");
      fail("Policy worker stopped.");
    },
  };
}
