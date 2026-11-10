use crate::{get, json, number, string, Digest, Result, Sha256, Value};

pub const PHASES: [&str; 6] = [
    "proposed",
    "released",
    "cancelled",
    "settled",
    "failed",
    "uncertain",
];

pub fn key(publisher: &str, id: &str, phase: &str) -> String {
    format!("signal:{publisher}:{id}:{phase}")
}

pub fn validate(event: &Value) -> Result<()> {
    let id = string(event, "signalId")?;
    let phase = string(event, "phase")?;
    if id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit()) || !PHASES.contains(&phase) {
        return Err("SIGNAL_INVALID".into());
    }
    let created = number(&event["signalCreatedAt"])?;
    let expires = number(&event["signalExpiresAt"])?;
    if created == 0
        || expires <= created
        || expires - created > 120000
        || number(&event["at"])? < created
        || event["id"]
            != format!(
                "{:x}",
                Sha256::digest(format!("remora.signal.v1\n{id}\n{phase}").as_bytes())
            )
        || event["actionHash"]
            != format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&event["action"]).unwrap())
            )
    {
        return Err("SIGNAL_INVALID".into());
    }
    if phase == "settled"
        && event["settlementRef"]
            .as_str()
            .filter(|r| !r.is_empty() && r.len() <= 160)
            .is_none()
    {
        return Err("SIGNAL_SETTLEMENT_REQUIRED".into());
    }
    Ok(())
}

pub fn state(publisher: &str, id: &str, now_ms: u64) -> Result<Value> {
    let mut events = Vec::new();
    for phase in PHASES {
        if let Some(envelope) = get(&key(publisher, id, phase))? {
            events.push(envelope["body"].clone());
        }
    }
    summarize(&events, now_ms)
}

pub fn summarize(events: &[Value], now_ms: u64) -> Result<Value> {
    let proposal = events
        .iter()
        .find(|e| e["phase"] == "proposed")
        .ok_or("SIGNAL_NOT_FOUND")?;
    for event in events {
        validate(event)?;
        for field in [
            "signalId",
            "publisher",
            "activity",
            "execution",
            "actionHash",
            "signalCreatedAt",
            "signalExpiresAt",
        ] {
            if event[field] != proposal[field] {
                return Err("SIGNAL_IDENTITY_MISMATCH".into());
            }
        }
    }
    let has = |phase: &str| events.iter().any(|e| e["phase"] == phase);
    if has("cancelled") && has("released")
        || has("settled") && has("failed")
        || !has("released") && ["settled", "failed", "uncertain"].iter().any(|p| has(p))
    {
        return Err("SIGNAL_CONFLICT".into());
    }
    let phase = [
        "cancelled",
        "settled",
        "failed",
        "uncertain",
        "released",
        "proposed",
    ]
    .into_iter()
    .find(|p| has(p))
    .unwrap();
    let expired = now_ms >= number(&proposal["signalExpiresAt"])?
        && !["settled", "failed", "cancelled"].contains(&phase);
    Ok(
        json!({"signalId":proposal["signalId"],"publisher":proposal["publisher"],"activity":proposal["activity"],
        "actionHash":proposal["actionHash"],"signalCreatedAt":proposal["signalCreatedAt"],"signalExpiresAt":proposal["signalExpiresAt"],
        "phase":if expired {"expired"} else {phase}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(phase: &str) -> Value {
        let id = "a".repeat(64);
        let action = json!({"amount":"100","operation":"supply","token":"wrap.testnet"});
        json!({"signalId":id,"phase":phase,"id":format!("{:x}",Sha256::digest(format!("remora.signal.v1\n{id}\n{phase}"))),
          "publisher":"publisher","activity":"yield-reallocation","execution":"wallet","action":action,
          "actionHash":format!("{:x}",Sha256::digest(serde_json::to_vec(&action).unwrap())),"signalCreatedAt":1000,"signalExpiresAt":61000,"at":1001})
    }
    #[test]
    fn cancellation_is_immutable_and_late_proposals_cannot_roll_it_back() {
        assert_eq!(
            summarize(&[event("cancelled"), event("proposed")], 2000).unwrap()["phase"],
            "cancelled"
        );
        assert!(summarize(
            &[event("cancelled"), event("proposed"), event("released")],
            2000
        )
        .is_err());
        assert_eq!(
            summarize(&[event("proposed"), event("released")], 61000).unwrap()["phase"],
            "expired"
        );
        let mut forged = event("released");
        forged["actionHash"] = json!("bad");
        assert!(summarize(&[event("proposed"), forged], 2000).is_err());
    }
}
