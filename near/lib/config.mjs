import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { KeyPair } from "near-api-js";
import { USDC } from "../sdk/index.mjs";
import { runtimePolicy, serviceConfig } from './runtime-policy.mjs';

export async function readKey(path) {
  if (!path)
    throw new Error("A dedicated key file is required. See docs/NEAR.md.");
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0)
    throw new Error("NEAR key files must have permissions 0600.");
  const file = JSON.parse(await readFile(path, "utf8"));
  const key = KeyPair.fromString(file.private_key);
  if (!key.getPublicKey().toString().startsWith("ed25519:"))
    throw new Error("Ed25519 key required.");
  return {
    accountId: file.account_id,
    privateKey: file.private_key,
    publicKey: key.getPublicKey().toString(),
  };
}

export async function readConfig(
  path = process.env.NEAR_CONFIG || ".local/near/deployment.json"
) {
  const config = JSON.parse(await readFile(resolve(path), "utf8"));
  if (!["sandbox", "testnet"].includes(config.network))
    throw new Error("This prototype enables sandbox and testnet only.");
  for (const field of [
    "vaultId",
    "agentId",
    "ownerId",
    "recipientId",
    "tokenId",
  ]) {
    if (
      !/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(config[field] ?? "") ||
      config[field].length > 64 ||
      config[field].length < 2
    )
      throw new Error(`Invalid ${field}.`);
  }
  const rpc = new URL(config.rpcUrl);
  const service = new URL(config.serviceUrl);
  const loopback = (host) => ["127.0.0.1", "localhost", "[::1]"].includes(host);
  if (
    rpc.username ||
    rpc.password ||
    service.username ||
    service.password ||
    service.search ||
    service.hash
  )
    throw new Error(
      "URLs cannot contain credentials or service query parameters."
    );
  if (
    !(
      rpc.protocol === "https:" ||
      (rpc.protocol === "http:" && loopback(rpc.hostname))
    )
  )
    throw new Error("Use HTTPS or loopback RPC.");
  if (
    !(
      service.protocol === "https:" ||
      (service.protocol === "http:" && loopback(service.hostname))
    )
  )
    throw new Error("Use HTTPS or loopback service.");
  if (config.network === "testnet" && config.tokenId !== USDC.testnet)
    throw new Error(
      "Testnet config must use the verified Circle USDC contract."
    );
  if (config.network === "sandbox" && !loopback(rpc.hostname))
    throw new Error("Sandbox RPC must be loopback.");
  config.runtimePolicy = runtimePolicy(config.runtimePolicy);
  config.service = serviceConfig(config.service);
  if (service.pathname !== '/' && service.pathname !== '') throw new Error('Service URL must be an origin; configure endpoint paths separately.');
  config.serviceUrl = service.origin;
  return config;
}
