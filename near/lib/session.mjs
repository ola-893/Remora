import { sessionExpiry, streamAccessReason } from "./stream.mjs";
import { PublicKey } from "near-api-js";

export function sessionBytes(session) {
  return Buffer.from(
    JSON.stringify({
      domain: "agentpay.session.near.v1",
      origin: session.origin,
      vault_id: session.vault_id,
      agent_id: session.agent_id,
      session_id: session.session_id,
      quote_hash: session.quote_hash,
      expires_at: session.expires_at,
    })
  );
}

export function makeSession({ config, stream, key }) {
  const session = {
    origin: new URL(config.serviceUrl).origin,
    vault_id: config.vaultId,
    agent_id: config.agentId,
    session_id: stream.session_id,
    quote_hash: stream.quote_hash,
    expires_at: sessionExpiry(stream),
  };
  return Buffer.from(
    JSON.stringify({
      ...session,
      signature: Buffer.from(
        key.sign(sessionBytes(session)).signature
      ).toString("base64"),
    })
  ).toString("base64url");
}

export function verifySession(encoded, { config, vault, stream, now }) {
  if (typeof encoded !== "string" || encoded.length > 2048)
    throw new Error("SESSION_REQUIRED");
  const session = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8")
  );
  if (
    !stream ||
    stream.closed_at !== null ||
    vault.active_session !== session.session_id ||
    session.origin !== new URL(config.serviceUrl).origin ||
    session.vault_id !== config.vaultId ||
    session.agent_id !== vault.agent_id ||
    session.session_id !== stream.session_id ||
    session.quote_hash !== stream.quote_hash ||
    session.expires_at !== sessionExpiry(stream) ||
    streamAccessReason(stream, now) !== null
  )
    throw new Error("SESSION_INACTIVE");
  if (
    !PublicKey.fromString(vault.agent_key).verify(
      sessionBytes(session),
      Buffer.from(session.signature, "base64")
    )
  )
    throw new Error("SESSION_SIGNATURE");
  return session;
}
