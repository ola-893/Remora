use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use outlayer::{env, storage};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
mod signals;
mod transport;

#[cfg(target_arch = "wasm32")]
#[used]
#[link_section = "outlayer.manifest"]
static MANIFEST: [u8; include_bytes!("../manifest.json").len()] =
    *include_bytes!("../manifest.json");

const RPC: &str = "https://test.rpc.fastnear.com";
const TOKEN: &str = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const TRUSTED_VAULTS: &str = include_str!("../trusted-vaults.json");

type Result<T> = std::result::Result<T, String>;

// Field order matches quoteFor/JSON.stringify in the CLI payment protocol.
#[derive(Serialize)]
struct Quote<'a> {
    version: u8,
    vault_id: &'a str,
    token_id: &'a str,
    recipient_id: &'a str,
    tier: &'a str,
    rate: &'a str,
    duration_seconds: u64,
    expires_at: u64,
    publisher: &'a str,
    origin: &'a str,
    activity: &'a str,
}

fn main() {
    let result = env::input_json::<Value>()
        .map_err(|_| "INVALID_INPUT".to_string())
        .and_then(|input| input.ok_or("INPUT_REQUIRED".to_string()))
        .and_then(run);
    let response = result.unwrap_or_else(|error| json!({"error": error}));
    let _ = env::output_json(&response);
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("MISSING_{key}"))
}

fn number(value: &Value) -> Result<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .ok_or("INVALID_NUMBER".to_string())
}

fn amount(value: &Value) -> Result<u128> {
    value
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or("INVALID_AMOUNT".to_string())
}

fn public_key(text: &str) -> Result<VerifyingKey> {
    let bytes = bs58::decode(text.strip_prefix("ed25519:").ok_or("ED25519_REQUIRED")?)
        .into_vec()
        .map_err(|_| "INVALID_KEY")?;
    VerifyingKey::from_bytes(&bytes.try_into().map_err(|_| "INVALID_KEY")?)
        .map_err(|_| "INVALID_KEY".to_string())
}

fn verify(envelope: &Value, key: &str, domain: &str) -> Result<()> {
    let bytes = STANDARD
        .decode(string(envelope, "signature")?)
        .map_err(|_| "INVALID_SIGNATURE")?;
    let signature = Signature::from_slice(&bytes).map_err(|_| "INVALID_SIGNATURE")?;
    let payload = serde_json::to_vec(&json!({"domain":domain,"body":envelope["body"]})).unwrap();
    public_key(key)?
        .verify(&payload, &signature)
        .map_err(|_| "INVALID_SIGNATURE".to_string())
}

fn delivery_key() -> Result<SigningKey> {
    Ok(SigningKey::from_bytes(&transport::derive(
        &transport::master()?,
        b"delivery-ed25519",
    )))
}

fn sign(body: Value) -> Result<Value> {
    sign_domain(body, "agentpay.page.v1")
}

fn sign_domain(body: Value, domain: &str) -> Result<Value> {
    let bytes = serde_json::to_vec(&json!({"domain":domain,"body":body})).unwrap();
    let signature = delivery_key()?.sign(&bytes);
    Ok(json!({"body":body,"signature":STANDARD.encode(signature.to_bytes())}))
}

fn get(key: &str) -> Result<Option<Value>> {
    let public = key.starts_with("listing:") || key.starts_with("health:");
    let address = if public {
        key.to_string()
    } else {
        format!("sealed:v1:{key}")
    };
    storage::get_worker(&address)
        .map_err(|_| "STORAGE_UNAVAILABLE".to_string())?
        .map(|bytes| {
            let plain = if public {
                bytes
            } else {
                transport::open_record(key, &bytes, &transport::master()?)?
            };
            serde_json::from_slice(&plain).map_err(|_| "INVALID_STORED_RECORD".to_string())
        })
        .transpose()
}

fn put(key: &str, value: &Value, public: bool) -> Result<()> {
    let plain = serde_json::to_vec(value).unwrap();
    let (address, bytes) = if public {
        (key.to_string(), plain)
    } else {
        (
            format!("sealed:v1:{key}"),
            transport::seal_record(key, &plain, &transport::master()?)?,
        )
    };
    storage::set_worker_with_options(&address, &bytes, Some(!public))
        .map_err(|_| "STORAGE_UNAVAILABLE".to_string())
}

fn rpc(method: &str, params: Value) -> Result<Value> {
    let body = serde_json::to_vec(
        &json!({"jsonrpc":"2.0","id":"remora-feed","method":method,"params":params}),
    )
    .unwrap();
    let response = wasi_http_client::Client::new()
        .post(RPC)
        .header("content-type", "application/json")
        .body(&body)
        .send()
        .map_err(|_| "RPC_UNAVAILABLE")?;
    if response.status() != 200 {
        return Err("RPC_UNAVAILABLE".to_string());
    }
    let data: Value = serde_json::from_slice(&response.body().map_err(|_| "RPC_UNAVAILABLE")?)
        .map_err(|_| "INVALID_RPC_RESPONSE")?;
    if data.get("error").is_some() {
        return Err("RPC_UNAVAILABLE".to_string());
    }
    data.get("result")
        .cloned()
        .ok_or("RPC_UNAVAILABLE".to_string())
}

fn view(account: &str, method: &str, args: Value) -> Result<Value> {
    let result = rpc(
        "query",
        json!({"request_type":"call_function","finality":"final","account_id":account,
        "method_name":method,"args_base64":STANDARD.encode(serde_json::to_vec(&args).unwrap())}),
    )?;
    let bytes = result["result"]
        .as_array()
        .ok_or("INVALID_RPC_RESPONSE")?
        .iter()
        .map(|n| {
            n.as_u64()
                .filter(|n| *n <= 255)
                .map(|n| n as u8)
                .ok_or("INVALID_RPC_RESPONSE".to_string())
        })
        .collect::<Result<Vec<u8>>>()?;
    serde_json::from_slice(&bytes).map_err(|_| "INVALID_RPC_RESPONSE".to_string())
}

fn authenticate(header: &str, listing: &Value) -> Result<Value> {
    if header.len() > 2048 {
        return Err("SESSION_INVALID".to_string());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(header)
        .map_err(|_| "SESSION_INVALID")?;
    let session: Value = serde_json::from_slice(&bytes).map_err(|_| "SESSION_INVALID")?;
    let vault_id = string(&session, "vault_id")?;
    if vault_id.len() > 64
        || !vault_id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"-_.".contains(&c))
    {
        return Err("SESSION_INVALID".to_string());
    }
    let account = rpc(
        "query",
        json!({"request_type":"view_account","finality":"final","account_id":vault_id}),
    )?;
    let vault = view(vault_id, "get_vault", json!({}))?;
    let stream = view(
        vault_id,
        "get_stream",
        json!({"session_id":session["session_id"]}),
    )?;
    validate_session(&session, listing, &account, &vault, &stream, now())?;
    Ok(stream)
}

fn validate_session(
    session: &Value,
    listing: &Value,
    account: &Value,
    vault: &Value,
    stream: &Value,
    timestamp: u64,
) -> Result<()> {
    let vault_id = string(session, "vault_id")?;
    let trusted: Vec<String> = serde_json::from_str(TRUSTED_VAULTS).unwrap();
    if !trusted
        .iter()
        .any(|hash| account["code_hash"].as_str() == Some(hash))
    {
        return Err("UNTRUSTED_VAULT".to_string());
    }
    if timestamp.abs_diff(number(&vault["now"])?) > 30
        || vault["token_id"] != TOKEN
        || vault["active_session"] != session["session_id"]
        || stream.is_null()
        || !stream["closed_at"].is_null()
        || session["agent_id"] != vault["agent_id"]
        || session["quote_hash"] != stream["quote_hash"]
        || session["session_id"] != stream["session_id"]
        || session["origin"] != listing["origin"]
        || stream["recipient_id"] != listing["recipient"]
        || stream["rate"] != listing["rate"]
        || stream["duration_seconds"] != listing["duration"]
    {
        return Err("STREAM_ACCESS_DENIED".to_string());
    }
    let started = number(&stream["started_at"])?;
    let duration = number(&stream["duration_seconds"])?;
    if duration == 0 {
        let accrued = amount(&stream["rate"])?
            .checked_mul(u128::from(timestamp.saturating_sub(started)))
            .ok_or("STREAM_ACCESS_DENIED")?;
        if !session["expires_at"].is_null() || accrued >= amount(&stream["deposit"])? {
            return Err("STREAM_ACCESS_DENIED".to_string());
        }
    } else if session["expires_at"] != json!(started + duration) || timestamp >= started + duration
    {
        return Err("STREAM_ACCESS_DENIED".to_string());
    }
    let mut matches = false;
    let bucket = started / 60 * 60;
    for offset in [0, 60, 120] {
        let quote = Quote {
            version: 1,
            vault_id,
            token_id: TOKEN,
            recipient_id: string(listing, "recipient")?,
            tier: "basic",
            rate: string(listing, "rate")?,
            duration_seconds: number(&listing["duration"])?,
            expires_at: bucket + 120 - offset,
            publisher: string(listing, "id")?,
            origin: string(listing, "origin")?,
            activity: string(listing, "activity")?,
        };
        let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&quote).unwrap()));
        matches |= stream["quote_hash"].as_str() == Some(&digest);
    }
    if !matches {
        return Err("QUOTE_MISMATCH".to_string());
    }
    // This field order is the session signing protocol in near/lib/session.mjs.
    let message = format!("{{\"domain\":\"agentpay.session.near.v1\",\"origin\":{},\"vault_id\":{},\"agent_id\":{},\"session_id\":{},\"quote_hash\":{},\"expires_at\":{}}}",
        session["origin"], session["vault_id"], session["agent_id"], session["session_id"], session["quote_hash"], session["expires_at"]);
    let signature = STANDARD
        .decode(string(&session, "signature")?)
        .map_err(|_| "SESSION_INVALID")?;
    public_key(string(&vault, "agent_key")?)?
        .verify(
            message.as_bytes(),
            &Signature::from_slice(&signature).map_err(|_| "SESSION_INVALID")?,
        )
        .map_err(|_| "SESSION_INVALID")?;
    Ok(())
}

fn run(input: Value) -> Result<Value> {
    let master = transport::master()?;
    match string(&input, "operation")? {
        "transport-key" => Ok(transport::public_key(&master)),
        "encrypted" => {
            let request = transport::open(&input, &master, now() * 1000)?;
            let output =
                run_private(request.input.clone()).unwrap_or_else(|error| json!({"error":error}));
            transport::respond(&request, output)
        }
        _ => Err("ENCRYPTED_TRANSPORT_REQUIRED".into()),
    }
}

fn run_private(input: Value) -> Result<Value> {
    if input.to_string().len() > 131072 {
        return Err("INPUT_TOO_LARGE".to_string());
    }
    let operation = string(&input, "operation")?;
    if operation == "delivery-key" {
        return Ok(
            json!({"publicKey":format!("ed25519:{}", bs58::encode(delivery_key()?.verifying_key().as_bytes()).into_string())}),
        );
    }
    if operation == "publish" {
        let envelope = &input["listing"];
        let body = &envelope["body"];
        let id = string(body, "id")?;
        let key = string(body, "publicKey")?;
        if id != format!("ap_{:x}", Sha256::digest(key.as_bytes())) || body["network"] != "testnet"
        {
            return Err("PUBLISHER_KEY_MISMATCH".to_string());
        }
        verify(envelope, key, "agentpay.listing.v1")?;
        let control = &input["control"];
        verify(control, key, "remora.delivery-control.v1")?;
        let at = number(&control["body"]["at"])?;
        if control["body"]["publisher"] != id
            || now().abs_diff(at / 1000) > 30
            || control["body"]["listingHash"]
                != format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(envelope).unwrap())
                )
        {
            return Err("PUBLICATION_CONTROL_INVALID".to_string());
        }
        let control_key = format!("control:{id}");
        if let Some(previous) = get(&control_key)? {
            if number(&previous["at"])? > at {
                return Err("PUBLICATION_CONTROL_STALE".to_string());
            }
        }
        put(&control_key, &control["body"], false)?;
        put(&format!("listing:{id}"), envelope, true)?;
        put(
            &format!("health:{id}"),
            &json!({"ok":control["body"]["active"]==true,"observed_at":at/1000}),
            true,
        )?;
        return Ok(json!({"published":true}));
    }
    let id = string(&input, "publisher")?;
    if id.len() != 67 || !id.starts_with("ap_") || !id[3..].bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("INVALID_PUBLISHER".to_string());
    }
    let listing = get(&format!("listing:{id}"))?.ok_or("PUBLISHER_NOT_FOUND")?;
    let body = &listing["body"];
    if operation == "append" {
        let envelope = &input["entry"];
        let action = &envelope["body"];
        let domain = if action.get("signalId").is_some() {
            "remora.signal.v1"
        } else if action["activity"] != "spot-trading" {
            "agentstreams.strategy-action.v1"
        } else if action["execution"] == "paper" {
            "agentstreams.paper-action.v1"
        } else {
            "agentpay.action.v1"
        };
        verify(envelope, string(body, "publicKey")?, domain)?;
        if action["publisher"] != id || action["activity"] != body["activity"] {
            return Err("ACTION_IDENTITY_MISMATCH".to_string());
        }
        if action.get("signalId").is_some() {
            signals::validate(action)?;
            let phase_key = signals::key(id, string(action, "signalId")?, string(action, "phase")?);
            if let Some(existing) = get(&phase_key)? {
                if existing != *envelope {
                    return Err("SIGNAL_PHASE_CHANGED".into());
                }
            } else {
                // Separate immutable phase records prevent late duplicate proposals
                // from overwriting a cancellation or settlement under concurrency.
                put(&phase_key, envelope, false)?;
            }
        }
        let sequence = number(&action["sequence"])?;
        if sequence == 0 || sequence > 1000000000 {
            return Err("INVALID_SEQUENCE".to_string());
        }
        let key = format!("entry:{id}:{sequence}");
        if let Some(existing) = get(&key)? {
            if existing != *envelope {
                return Err("ACTION_SEQUENCE_CONFLICT".to_string());
            }
        } else {
            put(&key, envelope, false)?;
        }
        return Ok(json!({"stored":true,"sequence":sequence}));
    }
    if operation != "actions" && operation != "signal" {
        return Err("UNKNOWN_OPERATION".to_string());
    }
    let control = get(&format!("control:{id}"))?.ok_or("PUBLICATION_STOPPED")?;
    if control["active"] != true || now().saturating_sub(number(&control["at"])? / 1000) > 120 {
        return Err("PUBLICATION_STOPPED".to_string());
    }
    let header = string(&input, "session")?;
    let stream = authenticate(header, body)?;
    if operation == "signal" {
        let signal_id = string(&input, "signalId")?;
        let nonce = string(&input, "nonce")?;
        if [signal_id, nonce]
            .iter()
            .any(|s| s.len() != 64 || !s.bytes().all(|c| c.is_ascii_hexdigit()))
        {
            return Err("SIGNAL_INVALID".into());
        }
        let mut status = signals::state(id, signal_id, now() * 1000)?;
        if number(&status["signalCreatedAt"])? < number(&stream["started_at"])? * 1000 {
            return Err("SESSION_SIGNAL_PREDATES_SUBSCRIPTION".into());
        }
        authenticate(header, body)?;
        let session: Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(header)
                .map_err(|_| "SESSION_INVALID")?,
        )
        .map_err(|_| "SESSION_INVALID")?;
        status["sessionId"] = session["session_id"].clone();
        status["nonce"] = json!(nonce);
        status["observedAt"] = json!(now() * 1000);
        return sign_domain(status, "remora.signal-status.v1");
    }
    let after = number(&input["after"])?;
    if after > 1000000000 {
        return Err("INVALID_CURSOR".to_string());
    }
    let mut entries = Vec::new();
    let mut cursor = after;
    for sequence in after + 1..=after + 8 {
        let Some(entry) = get(&format!("entry:{id}:{sequence}"))? else {
            break;
        };
        cursor = sequence;
        let created = entry["body"]
            .get("signalCreatedAt")
            .unwrap_or(&entry["body"]["at"]);
        if number(created)? >= number(&stream["started_at"])? * 1000 {
            entries.push(entry);
        }
    }
    authenticate(header, body)?;
    let session: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(header)
            .map_err(|_| "SESSION_INVALID")?,
    )
    .map_err(|_| "SESSION_INVALID")?;
    sign(
        json!({"sessionId":session["session_id"],"observedAt":now()*1000,"after":after,"cursor":cursor,"entries":entries}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../session-fixture.json")).unwrap()
    }

    fn authorize(f: &Value) -> Result<()> {
        validate_session(
            &f["session"],
            &f["listing"],
            &f["account"],
            &f["vault"],
            &f["stream"],
            f["timestamp"].as_u64().unwrap(),
        )
    }

    #[test]
    fn accepts_the_actual_javascript_quote_and_session_protocol() {
        assert!(authorize(&fixture()).is_ok());
    }

    #[test]
    fn rejects_closed_exhausted_forged_and_mismatched_sessions() {
        let changes = [
            ("stream", "closed_at", json!("1794240005")),
            ("stream", "deposit", json!("10")),
            ("stream", "recipient_id", json!("attacker.testnet")),
            ("stream", "rate", json!("2")),
            ("stream", "quote_hash", json!("a".repeat(64))),
            ("vault", "active_session", json!("other-session")),
            ("vault", "token_id", json!("fake-token.testnet")),
            ("vault", "now", json!("1794230000")),
            ("session", "signature", json!(STANDARD.encode([0u8; 64]))),
            ("session", "origin", json!("https://attacker.example")),
            ("session", "expires_at", json!(1794249999u64)),
            ("account", "code_hash", json!("untrusted-vault")),
        ];
        for (section, key, value) in changes {
            let mut f = fixture();
            f[section][key] = value;
            assert!(authorize(&f).is_err(), "accepted {section}.{key}");
        }
    }
}
