import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { JsonRpcProvider } from "near-api-js";
import { deploymentPlan, inspectTestnet } from "../lib/testnet-preflight.mjs";

const plan = deploymentPlan({
  ownerId: "owner.testnet",
  recipientId: "provider.testnet",
});
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const readWasm = async () => wasm;
function provider(overrides = {}) {
  return {
    viewNodeStatus: async () => ({ chain_id: "testnet" }),
    callFunction: async () => ({ symbol: "USDC", decimals: 6 }),
    viewAccessKey: async () => ({ permission: "FullAccess" }),
    viewAccount: async ({ accountId }) => {
      if ([plan.vaultId, plan.agentId].includes(accountId))
        throw new Error("UNKNOWN_ACCOUNT");
      return { amount: "7000000000000000000000000", storage_usage: 1000 };
    },
    ...overrides,
  };
}
const inspect = (p = provider(), extra = {}) =>
  inspectTestnet(plan, {
    provider: p,
    readWasm,
    ownerPublicKey: "ed25519:test-public-key",
    ...extra,
  });

test("deployment plan rejects mainnet, credentials in URLs and invalid account labels", () => {
  for (const invalid of [
    { ownerId: "owner.near" },
    { recipientId: "Provider.testnet" },
    { rpcUrl: "http://public.example" },
    { rpcUrl: "https://user:password@rpc.example" },
    { vaultLabel: "-vault" },
    { agentLabel: "agent--one" },
    { vaultLabel: "research-agent" },
  ])
    assert.throws(() =>
      deploymentPlan({
        ownerId: "owner.testnet",
        recipientId: "provider.testnet",
        ...invalid,
      })
    );
});

test("missing accounts or owner credential cannot be called ready", async () => {
  const report = await inspectTestnet(deploymentPlan(), {
    provider: provider(),
    readWasm,
  });
  assert.equal(report.readyToDeploy, false);
  assert.equal(report.checks.find((x) => x.id === "network").status, "pass");
  assert.equal(
    report.checks.find((x) => x.id === "owner-account").status,
    "pending"
  );
  assert.equal(
    report.checks.find((x) => x.id === "provider-account").status,
    "pending"
  );
  assert.equal(
    report.checks.find((x) => x.id === "owner-key").status,
    "pending"
  );
});

test("wrong network stops all account and token RPC calls", async () => {
  let laterCalls = 0;
  const report = await inspect(
    provider({
      viewNodeStatus: async () => ({ chain_id: "mainnet" }),
      callFunction: async () => {
        laterCalls++;
      },
      viewAccount: async () => {
        laterCalls++;
      },
    })
  );
  assert.equal(report.readyToDeploy, false);
  assert.equal(laterCalls, 0);
  assert.equal(report.checks.find((x) => x.id === "network").status, "fail");
});

test("existing subaccount and ambiguous RPC failure both prevent deployment readiness", async () => {
  const existing = await inspect(
    provider({
      viewAccount: async () => ({
        amount: "7000000000000000000000000",
        storage_usage: 0,
      }),
    })
  );
  assert.equal(existing.readyToDeploy, false);
  assert.equal(
    existing.checks.find((x) => x.id === "vault-name").status,
    "fail"
  );
  const fallback = provider();
  const unknown = await inspect(
    provider({
      viewAccount: async (args) => {
        if (args.accountId === plan.vaultId)
          throw new Error("RPC request timed out");
        return fallback.viewAccount(args);
      },
    })
  );
  assert.equal(unknown.readyToDeploy, false);
  assert.equal(
    unknown.checks.find((x) => x.id === "vault-name").status,
    "fail"
  );
});

test("restricted owner key, insufficient funds, token mismatch and invalid WASM fail closed", async () => {
  const key = await inspect(
    provider({
      viewAccessKey: async () => ({ permission: { FunctionCall: {} } }),
    })
  );
  assert.equal(key.readyToDeploy, false);
  assert.equal(key.checks.find((x) => x.id === "owner-key").status, "fail");
  const original = provider();
  const funds = await inspect(
    provider({
      viewAccount: (args) =>
        args.accountId === plan.ownerId
          ? { amount: "5999999999999999999999999", storage_usage: 0 }
          : original.viewAccount(args),
    })
  );
  assert.equal(
    funds.checks.find((x) => x.id === "owner-funding").status,
    "fail"
  );
  const token = await inspect(
    provider({ callFunction: async () => ({ decimals: 18, symbol: "USDC" }) })
  );
  assert.equal(token.readyToDeploy, false);
  const artifact = await inspect(provider(), {
    readWasm: async () => Buffer.from("not WASM"),
  });
  assert.equal(artifact.readyToDeploy, false);
});

test("preflight uses the installed SDK against a real RPC transport and never sends mutations", async (t) => {
  const methods = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    methods.push(input.method);
    let result, error;
    if (input.method === "status")
      result = {
        chain_id: "testnet",
        sync_info: { latest_block_hash: "test-block" },
      };
    else if (input.method === "query") {
      const p = input.params;
      if (p.request_type === "call_function")
        result = {
          result: [
            ...Buffer.from(JSON.stringify({ symbol: "USDC", decimals: 6 })),
          ],
          logs: [],
          block_height: 1,
          block_hash: "test-block",
        };
      else if (p.request_type === "view_access_key")
        result = {
          nonce: 1,
          permission: "FullAccess",
          block_height: 1,
          block_hash: "test-block",
        };
      else if (
        p.request_type === "view_account" &&
        [plan.vaultId, plan.agentId].includes(p.account_id)
      )
        error = {
            name: "HANDLER_ERROR",
            code: -32000,
          message: "Server error",
          cause: {
            name: "UNKNOWN_ACCOUNT",
              info: { requested_account_id: p.account_id, block_hash: "test-block", block_height: 1 },
          },
        };
      else if (p.request_type === "view_account")
        result = {
          amount: "7000000000000000000000000",
          locked: "0",
          code_hash: "11111111111111111111111111111111",
          storage_usage: 1000,
          block_height: 1,
          block_hash: "test-block",
        };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: input.id,
        ...(error ? { error } : { result }),
      })
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      })
  );
  const actual = new JsonRpcProvider({
    url: `http://127.0.0.1:${server.address().port}`,
  });
  const report = await inspect(actual);
  assert.equal(report.readyToDeploy, true, JSON.stringify(report));
  assert.equal(report.readOnly, true);
  assert.equal(report.blockHash, "test-block");
  assert.ok(methods.includes("status"));
  assert.ok(methods.every((method) => ["status", "query"].includes(method)));
  assert.equal(JSON.stringify(report).includes("test-public-key"), false);
});
