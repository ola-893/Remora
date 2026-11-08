import { createHash } from "node:crypto";
import { KeyPair } from "near-api-js";

export const hashQuote = (quote) =>
  createHash("sha256").update(JSON.stringify(quote)).digest("hex");

export function permitBytes(p) {
  // Keep exactly aligned with Rust Permit field order and integer encodings.
  return Buffer.from(
    JSON.stringify({
      domain: p.domain,
      vault_id: p.vault_id,
      agent_id: p.agent_id,
      action: p.action,
      session_id: p.session_id,
      recipient_id: p.recipient_id,
      rate: p.rate,
      duration_seconds: p.duration_seconds,
      quote_hash: p.quote_hash,
      nonce: p.nonce,
      expires_at: p.expires_at,
    })
  );
}
export function signPermit(permit, privateKey) {
  const key = KeyPair.fromString(privateKey);
  if (!key.getPublicKey().toString().startsWith("ed25519:"))
    throw new Error("Ed25519 policy key required.");
  return {
    permit,
    signature: Buffer.from(key.sign(permitBytes(permit)).signature).toString(
      "base64"
    ),
  };
}
