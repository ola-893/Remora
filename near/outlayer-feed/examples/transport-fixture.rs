// Interoperability fixture only. This fixed test key is never used by the worker.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{self, Read};
type Result<T> = std::result::Result<T, String>;
fn string<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str().ok_or("MISSING_STRING".into())
}
fn number(v: &Value) -> Result<u64> {
    v.as_u64().ok_or("INVALID_NUMBER".into())
}
#[allow(dead_code)]
#[path = "../src/transport.rs"]
mod transport;
fn main() {
    let mut text = String::new();
    io::stdin().read_to_string(&mut text).unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    let result = if v["publicKey"] == true {
        Ok(transport::public_key(&[7; 32]))
    } else {
        transport::open(&v["envelope"], &[7; 32], v["now"].as_u64().unwrap())
            .and_then(|r| transport::respond(&r, json!({"received":r.input})))
    };
    println!("{}", result.unwrap_or_else(|error| json!({"error":error})));
}
