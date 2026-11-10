use crate::{json, string, Digest, Engine, Result, Sha256, Value, STANDARD};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use hpke::{
    aead::AesGcm256, kdf::HkdfSha256, kem::DhP256HkdfSha256, rand_core::SeedableRng,
    Deserializable, Kem as KemTrait, OpModeR, OpModeS, Serializable,
};
use rand_chacha::ChaCha20Rng;
type Kem = DhP256HkdfSha256;
const REQUEST: &[u8] = b"remora.transport.request.v1";
const RESPONSE: &[u8] = b"remora.transport.response.v1";

pub fn master() -> Result<[u8; 32]> {
    let text =
        std::env::var("PROTECTED_FEED_MASTER").map_err(|_| "PROTECTED_FEED_MASTER_REQUIRED")?;
    if text.len() != 64 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("INVALID_PROTECTED_FEED_MASTER".into());
    }
    let mut key = [0u8; 32];
    for (i, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16)
            .map_err(|_| "INVALID_PROTECTED_FEED_MASTER")?;
    }
    Ok(key)
}

pub fn derive(master: &[u8; 32], purpose: &[u8]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"remora.feed.keys.v1\0");
    hash.update(purpose);
    hash.update(master);
    hash.finalize().into()
}
fn keys(master: &[u8; 32]) -> (<Kem as KemTrait>::PrivateKey, <Kem as KemTrait>::PublicKey) {
    Kem::derive_keypair(&derive(master, b"hpke-p256"))
}
fn random() -> Result<ChaCha20Rng> {
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).map_err(|_| "RANDOMNESS_UNAVAILABLE")?;
    Ok(ChaCha20Rng::from_seed(seed))
}
fn bytes(v: &Value, k: &str, max: usize) -> Result<Vec<u8>> {
    let text = string(v, k)?;
    if text.len() > max * 2 {
        return Err("ENCRYPTED_INPUT_TOO_LARGE".into());
    }
    let b = STANDARD
        .decode(text)
        .map_err(|_| "INVALID_ENCRYPTED_INPUT")?;
    if b.len() > max {
        return Err("ENCRYPTED_INPUT_TOO_LARGE".into());
    }
    Ok(b)
}
pub fn public_key(master: &[u8; 32]) -> Value {
    json!({"protocol":"remora.hpke-p256-sha256-aes256gcm.v1","publicKey":STANDARD.encode(keys(master).1.to_bytes())})
}

pub struct Request {
    pub input: Value,
    reply: <Kem as KemTrait>::PublicKey,
    nonce: String,
}
pub fn open(envelope: &Value, master: &[u8; 32], now_ms: u64) -> Result<Request> {
    let enc = <Kem as KemTrait>::EncappedKey::from_bytes(&bytes(envelope, "enc", 65)?)
        .map_err(|_| "INVALID_ENCRYPTED_KEY")?;
    let mut receiver = hpke::setup_receiver::<AesGcm256, HkdfSha256, Kem>(
        &OpModeR::Base,
        &keys(master).0,
        &enc,
        REQUEST,
    )
    .map_err(|_| "INVALID_ENCRYPTED_KEY")?;
    let plain = receiver
        .open(&bytes(envelope, "ciphertext", 262144)?, b"")
        .map_err(|_| "ENCRYPTED_INPUT_INVALID")?;
    let body: Value = serde_json::from_slice(&plain).map_err(|_| "ENCRYPTED_INPUT_INVALID")?;
    let at = crate::number(&body["at"])?;
    if now_ms.abs_diff(at) > 60000 {
        return Err("ENCRYPTED_INPUT_EXPIRED".into());
    }
    let nonce = string(&body, "nonce")?.to_string();
    if nonce.len() != 64 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("ENCRYPTED_NONCE_INVALID".into());
    }
    let reply = <Kem as KemTrait>::PublicKey::from_bytes(&bytes(&body, "replyKey", 65)?)
        .map_err(|_| "ENCRYPTED_REPLY_KEY_INVALID")?;
    Ok(Request {
        input: body["input"].clone(),
        reply,
        nonce,
    })
}
pub fn respond(request: &Request, output: Value) -> Result<Value> {
    let (enc, mut sender) = hpke::setup_sender::<AesGcm256, HkdfSha256, Kem, _>(
        &OpModeS::Base,
        &request.reply,
        RESPONSE,
        &mut random()?,
    )
    .map_err(|_| "RESPONSE_ENCRYPTION_FAILED")?;
    let plain = serde_json::to_vec(&json!({"nonce":request.nonce,"output":output}))
        .map_err(|_| "RESPONSE_ENCRYPTION_FAILED")?;
    let ciphertext = sender
        .seal(&plain, request.nonce.as_bytes())
        .map_err(|_| "RESPONSE_ENCRYPTION_FAILED")?;
    Ok(json!({"enc":STANDARD.encode(enc.to_bytes()),"ciphertext":STANDARD.encode(ciphertext)}))
}

// Application sealing remains opaque even to another version sharing the project's storage.
// The master must be locked to the approved binary in the OutLayer keystore.
pub fn seal_record(key: &str, plain: &[u8], master: &[u8; 32]) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(&derive(master, b"storage-aes256gcm")).unwrap();
    let mut nonce = [0u8; 12];
    getrandom::getrandom(&mut nonce).map_err(|_| "RANDOMNESS_UNAVAILABLE")?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plain,
                aad: key.as_bytes(),
            },
        )
        .map_err(|_| "STORAGE_SEAL_FAILED")?;
    Ok([b"RMS1".as_slice(), &nonce, &ciphertext].concat())
}
pub fn open_record(key: &str, bytes: &[u8], master: &[u8; 32]) -> Result<Vec<u8>> {
    if bytes.len() < 32 || &bytes[..4] != b"RMS1" {
        return Err("UNSEALED_STORAGE_REFUSED".into());
    }
    Aes256Gcm::new_from_slice(&derive(master, b"storage-aes256gcm"))
        .unwrap()
        .decrypt(
            Nonce::from_slice(&bytes[4..16]),
            Payload {
                msg: &bytes[16..],
                aad: key.as_bytes(),
            },
        )
        .map_err(|_| "STORAGE_SEAL_INVALID".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn records_are_bound_to_master_and_name() {
        let master = [7u8; 32];
        let sealed = seal_record("action:1", b"private", &master).unwrap();
        assert_eq!(
            open_record("action:1", &sealed, &master).unwrap(),
            b"private"
        );
        assert!(open_record("action:2", &sealed, &master).is_err());
        assert!(open_record("action:1", &sealed, &[8u8; 32]).is_err());
        let mut tampered = sealed;
        tampered[20] ^= 1;
        assert!(open_record("action:1", &tampered, &master).is_err());
        assert!(open_record("action:1", b"legacy plaintext", &master).is_err());
    }
}
