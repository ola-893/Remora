import { createHash } from "node:crypto";
import { USDC } from "../sdk/index.mjs";

export const DEPLOYMENT_RESERVE = 6000000000000000000000000n;
const STORAGE_PER_BYTE = 10000000000000000000n;
const accountPattern =
  /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/;

export function deploymentPlan({
  ownerId,
  recipientId,
  vaultLabel = "agentstreams",
  agentLabel = "research-agent",
  rpcUrl = "https://test.rpc.fastnear.com",
  serviceUrl = "http://127.0.0.1:5321",
} = {}) {
  const rpc = new URL(rpcUrl);
  if (
    rpc.protocol !== "https:" ||
    rpc.username ||
    rpc.password ||
    rpc.hash ||
    rpc.search
  )
    throw new Error(
      "Testnet RPC must use HTTPS without credentials, query parameters or a fragment."
    );
  const service = new URL(serviceUrl);
  if (
    !(
      service.protocol === "https:" ||
      (service.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(service.hostname))
    ) ||
    service.username ||
    service.password ||
    service.search ||
    service.hash ||
    service.pathname !== "/"
  )
    throw new Error(
      "Service must be an HTTPS or loopback origin without credentials."
    );
  for (const [label, value] of [
    ["owner", ownerId],
    ["provider", recipientId],
  ]) {
    if (value && (!accountPattern.test(value) || value.length > 64))
      throw new Error(`The ${label} must be a valid named .testnet account.`);
  }
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(vaultLabel) ||
    vaultLabel.length < 2 ||
    vaultLabel.length > 24 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentLabel) ||
    agentLabel.length < 2 ||
    agentLabel.length > 24 ||
    vaultLabel === agentLabel ||
    /(^-|-$)/.test(vaultLabel) ||
    /(^-|-$)/.test(agentLabel)
  )
    throw new Error(
      "Choose distinct valid vault and agent labels (2–24 lowercase letters, digits or interior hyphens)."
    );
  const vaultId = ownerId ? `${vaultLabel}.${ownerId}` : null;
  const agentId = ownerId ? `${agentLabel}.${ownerId}` : null;
  if (vaultId?.length > 64 || agentId?.length > 64)
    throw new Error("Subaccount names exceed 64 characters.");
  return {
    ownerId: ownerId || null,
    recipientId: recipientId || null,
    vaultId,
    agentId,
    rpcUrl: rpc.toString(),
    serviceUrl: service.origin,
    tokenId: USDC.testnet,
  };
}

// Only RPC views are accepted here. No account signer, key generator or transaction method is used.
export async function inspectTestnet(
  plan,
  {
    provider,
    readWasm,
    ownerPublicKey,
    credentialError,
    now = () => new Date().toISOString(),
  }
) {
  const report = {
    schemaVersion: 1,
    checkedAt: now(),
    network: "testnet",
    readOnly: true,
    readyToDeploy: false,
    accounts: {
      owner: plan.ownerId,
      provider: plan.recipientId,
      vault: plan.vaultId,
      agent: plan.agentId,
    },
    rpcOrigin: new URL(plan.rpcUrl).origin,
    tokenId: plan.tokenId,
    minimumAvailableTestNear: "6",
    checks: [],
  };
  const check = (id, status, detail) =>
    report.checks.push({ id, status, detail });
  try {
    const wasm = await readWasm();
    if (!WebAssembly.validate(wasm)) throw new Error("Invalid WASM module.");
    report.artifact = {
      bytes: wasm.length,
      sha256: createHash("sha256").update(wasm).digest("hex"),
    };
    check(
      "contract-build",
      "pass",
      "Valid local vault WASM; checksum recorded. This is not a deployment receipt."
    );
  } catch {
    check(
      "contract-build",
      "fail",
      "Vault WASM missing or invalid. Run npm run build:near."
    );
  }
  try {
    const status = await provider.viewNodeStatus();
    if (status.chain_id !== "testnet") {
      check(
        "network",
        "fail",
        "RPC does not identify as NEAR testnet; no account or token checks attempted."
      );
      return report;
    }
    report.blockHash = status.sync_info?.latest_block_hash || null;
    check("network", "pass", "RPC identifies as testnet.");
  } catch {
    check(
      "network",
      "fail",
      "RPC status unavailable; deployment readiness cannot be established."
    );
    return report;
  }
  try {
    const metadata = await provider.callFunction({
      contractId: plan.tokenId,
      method: "ft_metadata",
      args: {},
      blockQuery: { finality: "final" },
    });
    check(
      "usdc-metadata",
      metadata.decimals === 6 && metadata.symbol === "USDC" ? "pass" : "fail",
      "Pinned Circle testnet contract must report USDC with six decimals."
    );
  } catch {
    check(
      "usdc-metadata",
      "fail",
      "Pinned Circle testnet token metadata could not be verified."
    );
  }
  let ownerExists = false;
  for (const [role, accountId] of [
    ["owner", plan.ownerId],
    ["provider", plan.recipientId],
  ]) {
    if (!accountId) {
      check(
        `${role}-account`,
        "pending",
        `Provide the existing ${role} .testnet account ID.`
      );
      continue;
    }
    try {
      const state = await provider.viewAccount({
        accountId,
        blockQuery: { finality: "final" },
      });
      check(`${role}-account`, "pass", `${accountId} exists.`);
      if (role === "owner") {
        ownerExists = true;
        const available =
          BigInt(state.amount) - BigInt(state.storage_usage) * STORAGE_PER_BYTE;
        report.ownerBalanceYoctoNear = String(state.amount);
        report.ownerAvailableYoctoNear = (
          available > 0n ? available : 0n
        ).toString();
        check(
          "owner-funding",
          available >= DEPLOYMENT_RESERVE ? "pass" : "fail",
          "At least 6 test NEAR available after storage reserve are required by the deployment helper."
        );
      }
    } catch {
      check(
        `${role}-account`,
        "fail",
        `Could not verify ${accountId}; confirm the account exists and RPC is available.`
      );
    }
  }
  if (credentialError)
    check(
      "owner-key",
      "fail",
      "Owner credential file could not be validated. Confirm its account and 0600 permissions locally."
    );
  else if (!ownerPublicKey || !ownerExists)
    check(
      "owner-key",
      "pending",
      "Connect the owner wallet to verify its registered public signing key before deployment."
    );
  else {
    try {
      const key = await provider.viewAccessKey({
        accountId: plan.ownerId,
        publicKey: ownerPublicKey,
        blockQuery: { finality: "final" },
      });
      check(
        "owner-key",
        key.permission === "FullAccess" ? "pass" : "fail",
        "Selected owner credential must correspond to an onchain full-access key."
      );
    } catch {
      check(
        "owner-key",
        "fail",
        "Selected owner key was not verified onchain."
      );
    }
  }
  for (const [role, accountId] of [
    ["vault", plan.vaultId],
    ["agent", plan.agentId],
  ]) {
    if (!accountId) {
      check(
        `${role}-name`,
        "pending",
        "The owner ID is needed to check the new subaccount name."
      );
      continue;
    }
    try {
      await provider.viewAccount({
        accountId,
        blockQuery: { finality: "final" },
      });
      check(
        `${role}-name`,
        "fail",
        `${accountId} already exists. Inspect prior deployment records; never overwrite it.`
      );
    } catch (error) {
      if (/UNKNOWN_ACCOUNT|does not exist|not exist/i.test(error.message))
        check(
          `${role}-name`,
          "pass",
          `${accountId} is not allocated at the observed block.`
        );
      else
        check(
          `${role}-name`,
          "fail",
          `Could not establish whether ${accountId} exists. An RPC error is not proof of an available name.`
        );
    }
  }
  report.readyToDeploy = report.checks.every((c) => c.status === "pass");
  return report;
}
