use near_sdk::{
    collections::{LookupMap, UnorderedMap},
    env, ext_contract,
    json_types::{Base64VecU8, U128, U64},
    near, require, AccountId, CurveType, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, PublicKey,
};

const DOMAIN: &str = "agentpay.near.v1";
const MAX_PERMIT_SECONDS: u64 = 120;
const MAX_SESSIONS: u64 = 1000;

#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub struct Policy {
    pub budget: U128,
    pub max_deposit: U128,
    pub max_rate: U128,
    pub max_duration_seconds: u32,
    pub recipients: Vec<AccountId>,
}

// Field order is part of the signing protocol. Integers use decimal strings
// except duration_seconds. See near/lib/permit.mjs for the identical serializer.
#[derive(Clone)]
#[near(serializers = [json])]
pub struct Permit {
    pub domain: String,
    pub vault_id: AccountId,
    pub agent_id: AccountId,
    pub action: String,
    pub session_id: String,
    pub recipient_id: AccountId,
    pub rate: U128,
    pub duration_seconds: u32,
    pub quote_hash: String,
    pub nonce: U64,
    pub expires_at: U64,
}

#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub struct Stream {
    pub session_id: String,
    pub recipient_id: AccountId,
    pub quote_hash: String,
    pub deposit: U128,
    pub rate: U128,
    pub duration_seconds: u32,
    pub started_at: U64,
    pub closed_at: Option<U64>,
    pub earned: U128,
    pub refunded: U128,
}

#[near(serializers = [borsh])]
pub struct Payout {
    receiver_id: AccountId,
    amount: u128,
    owner_withdrawal: bool,
}

#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub struct DecisionRoot {
    pub sequence: U64,
    pub root: String,
    pub recorded_at: U64,
}

#[near(serializers = [json])]
pub struct VaultView {
    pub version: String,
    pub owner_id: AccountId,
    pub token_id: AccountId,
    pub agent_id: AccountId,
    pub agent_key: PublicKey,
    pub policy_key: PublicKey,
    pub policy: Policy,
    pub available: U128,
    pub spent: U128,
    pub reserved: U128,
    pub claimable_total: U128,
    pub pending_total: U128,
    pub next_nonce: U64,
    pub active_session: Option<String>,
    pub paused: bool,
    pub now: U64,
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner_id: AccountId,
    token_id: AccountId,
    agent_id: AccountId,
    agent_key: PublicKey,
    policy_key: PublicKey,
    policy: Policy,
    available: u128,
    spent: u128,
    claimable_total: u128,
    pending_total: u128,
    next_nonce: u64,
    next_payout: u64,
    active_session: Option<String>,
    paused: bool,
    streams: UnorderedMap<String, Stream>,
    claims: LookupMap<AccountId, u128>,
    payouts: LookupMap<u64, Payout>,
    decisions: UnorderedMap<u64, DecisionRoot>,
    decision_roots: LookupMap<String, bool>,
}

#[near]
impl Vault {
    #[init]
    pub fn new(
        owner_id: AccountId,
        token_id: AccountId,
        agent_id: AccountId,
        agent_key: PublicKey,
        policy_key: PublicKey,
        policy: Policy,
    ) -> Self {
        // Initialize either with the vault key, or atomically while its owner creates this subaccount.
        require!(
            env::predecessor_account_id() == env::current_account_id()
                || (env::predecessor_account_id() == owner_id
                    && env::current_account_id().as_str().ends_with(&format!(".{}", owner_id))),
            "OWNER_OR_SELF_INIT_ONLY"
        );
        require!(
            owner_id != env::current_account_id(),
            "SEPARATE_OWNER_REQUIRED"
        );
        require!(
            agent_id != owner_id && agent_id != env::current_account_id(),
            "SEPARATE_AGENT_REQUIRED"
        );
        require!(
            agent_key.curve_type() == CurveType::ED25519
                && policy_key.curve_type() == CurveType::ED25519,
            "ED25519_REQUIRED"
        );
        require!(agent_key != policy_key, "SEPARATE_POLICY_KEY_REQUIRED");
        Self::validate_policy(&policy, 0);
        Self {
            owner_id,
            token_id,
            agent_id,
            agent_key,
            policy_key,
            policy,
            available: 0,
            spent: 0,
            claimable_total: 0,
            pending_total: 0,
            next_nonce: 0,
            next_payout: 0,
            active_session: None,
            paused: false,
            streams: UnorderedMap::new(b"s"),
            claims: LookupMap::new(b"c"),
            payouts: LookupMap::new(b"p"),
            decisions: UnorderedMap::new(b"d"),
            decision_roots: LookupMap::new(b"r"),
        }
    }

    // NEP-141 callback: only the configured token may credit owner deposits.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token_id, "TOKEN_ONLY");
        require!(sender_id == self.owner_id, "OWNER_DEPOSIT_ONLY");
        require!(msg == "fund" && amount.0 > 0, "INVALID_FUNDING");
        self.available = self
            .available
            .checked_add(amount.0)
            .expect("BALANCE_OVERFLOW");
        Self::event("funded", near_sdk::serde_json::json!({"amount": amount}));
        PromiseOrValue::Value(U128(0))
    }

    pub fn open_stream(&mut self, permit: Permit, signature: Base64VecU8) -> Stream {
        self.assert_agent();
        require!(!self.paused, "PAUSED");
        self.verify_permit(&permit, &signature, "OPEN");
        require!(self.active_session.is_none(), "ACTIVE_STREAM");
        require!(self.streams.len() < MAX_SESSIONS, "SESSION_STORAGE_LIMIT");
        require!(
            self.streams.get(&permit.session_id).is_none(),
            "SESSION_REPLAY"
        );
        require!(
            self.policy.recipients.contains(&permit.recipient_id),
            "RECIPIENT_DENIED"
        );
        require!(
            self.policy.max_duration_seconds == 0
                || (permit.duration_seconds > 0
                    && permit.duration_seconds <= self.policy.max_duration_seconds),
            "DURATION_LIMIT"
        );
        require!(
            permit.rate.0 > 0 && permit.rate.0 <= self.policy.max_rate.0,
            "RATE_LIMIT"
        );
        let deposit = if permit.duration_seconds == 0 {
            self.policy.max_deposit.0
        } else {
            permit.rate.0.checked_mul(permit.duration_seconds as u128).expect("AMOUNT_OVERFLOW")
        };
        require!(deposit <= self.policy.max_deposit.0, "DEPOSIT_LIMIT");
        require!(
            self.spent.checked_add(deposit).expect("BUDGET_OVERFLOW") <= self.policy.budget.0,
            "BUDGET_LIMIT"
        );
        require!(deposit <= self.available, "INSUFFICIENT_FUNDS");
        let stream = Stream {
            session_id: permit.session_id.clone(),
            recipient_id: permit.recipient_id,
            quote_hash: permit.quote_hash,
            deposit: U128(deposit),
            rate: permit.rate,
            duration_seconds: permit.duration_seconds,
            started_at: U64(Self::now()),
            closed_at: None,
            earned: U128(0),
            refunded: U128(0),
        };
        self.available -= deposit;
        self.next_nonce = self.next_nonce.checked_add(1).expect("NONCE_OVERFLOW");
        self.active_session = Some(stream.session_id.clone());
        self.streams.insert(&stream.session_id, &stream);
        Self::event("opened", near_sdk::serde_json::to_value(&stream).unwrap());
        stream
    }

    pub fn close_stream(&mut self, permit: Permit, signature: Base64VecU8) -> Stream {
        self.assert_agent();
        self.verify_permit(&permit, &signature, "CLOSE");
        let stream = self
            .streams
            .get(&permit.session_id)
            .expect("UNKNOWN_SESSION");
        require!(
            stream.recipient_id == permit.recipient_id
                && stream.rate.0 == permit.rate.0
                && stream.duration_seconds == permit.duration_seconds
                && stream.quote_hash == permit.quote_hash,
            "INTENT_MISMATCH"
        );
        self.next_nonce = self.next_nonce.checked_add(1).expect("NONCE_OVERFLOW");
        self.finish(&permit.session_id)
    }

    // Owner recovery always remains available, including while paused or without a worker.
    pub fn recovery_close(&mut self, session_id: String) -> Stream {
        self.assert_owner();
        self.finish(&session_id)
    }

    // Anyone can settle a completed term or an exhausted prepaid balance.
    pub fn settle_expired(&mut self, session_id: String) -> Stream {
        let stream = self.streams.get(&session_id).expect("UNKNOWN_SESSION");
        require!(
            (stream.duration_seconds > 0
                && Self::now() >= stream.started_at.0 + stream.duration_seconds as u64)
                || Self::earned_at(&stream, Self::now()) == stream.deposit.0,
            "NOT_EXPIRED"
        );
        self.finish(&session_id)
    }

    // Stream accounting is separate from external token transfers. Failed payouts
    // restore the exact claim; they cannot reopen a stream or earn funds twice.
    pub fn withdraw_earned(&mut self, session_id: String) -> Promise {
        let mut stream = self.streams.get(&session_id).expect("UNKNOWN_SESSION");
        require!(
            env::predecessor_account_id() == stream.recipient_id,
            "PROVIDER_ONLY"
        );
        require!(stream.closed_at.is_none(), "ALREADY_CLOSED");
        let earned = Self::earned_at(&stream, Self::now());
        self.credit_earnings(&stream.recipient_id, earned - stream.earned.0);
        stream.earned = U128(earned);
        self.streams.insert(&session_id, &stream);
        self.claim()
    }

    pub fn claim(&mut self) -> Promise {
        let receiver_id = env::predecessor_account_id();
        let amount = self.claims.get(&receiver_id).unwrap_or(0);
        require!(amount > 0, "NOTHING_TO_CLAIM");
        self.claims.remove(&receiver_id);
        self.claimable_total -= amount;
        self.payout(receiver_id, amount, false)
    }

    pub fn top_up_stream(&mut self, session_id: String, amount: U128) -> Stream {
        self.assert_owner();
        require!(self.active_session.as_ref() == Some(&session_id), "STREAM_NOT_ACTIVE");
        let mut stream = self.streams.get(&session_id).expect("UNKNOWN_SESSION");
        require!(stream.duration_seconds == 0 && stream.closed_at.is_none(), "OPEN_ENDED_STREAM_REQUIRED");
        let earned = Self::earned_at(&stream, Self::now());
        require!(earned < stream.deposit.0, "STREAM_FUNDS_EXHAUSTED");
        let deposit = stream.deposit.0.checked_add(amount.0).expect("AMOUNT_OVERFLOW");
        require!(amount.0 > 0 && amount.0 <= self.available, "INSUFFICIENT_FUNDS");
        require!(deposit - earned <= self.policy.max_deposit.0, "DEPOSIT_LIMIT");
        require!(self.spent.checked_add(deposit - stream.earned.0).expect("BUDGET_OVERFLOW") <= self.policy.budget.0, "BUDGET_LIMIT");
        self.credit_earnings(&stream.recipient_id, earned - stream.earned.0);
        stream.earned = U128(earned);
        stream.deposit = U128(deposit);
        self.available -= amount.0;
        self.streams.insert(&session_id, &stream);
        Self::event("stream_topped_up", near_sdk::serde_json::json!({"session_id": session_id, "amount": amount}));
        stream
    }

    pub fn withdraw_available(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(
            amount.0 > 0 && amount.0 <= self.available,
            "INSUFFICIENT_AVAILABLE"
        );
        self.available -= amount.0;
        self.payout(self.owner_id.clone(), amount.0, true)
    }

    #[private]
    pub fn on_payout(
        &mut self,
        payout_id: U64,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        let payout = self.payouts.remove(&payout_id.0).expect("UNKNOWN_PAYOUT");
        self.pending_total -= payout.amount;
        let success = result.is_ok();
        if !success {
            if payout.owner_withdrawal {
                self.available += payout.amount;
            } else {
                let claim = self.claims.get(&payout.receiver_id).unwrap_or(0);
                self.claims
                    .insert(&payout.receiver_id, &(claim + payout.amount));
                self.claimable_total += payout.amount;
            }
        }
        Self::event(
            "payout",
            near_sdk::serde_json::json!({"payout_id": payout_id, "receiver_id": payout.receiver_id,
            "amount": U128(payout.amount), "success": success}),
        );
        success
    }

    pub fn configure(&mut self, policy: Policy) {
        self.assert_owner();
        require!(self.active_session.is_none(), "ACTIVE_STREAM");
        Self::validate_policy(&policy, self.spent);
        self.policy = policy;
        // Invalidate any approvals issued under the previous configuration.
        self.next_nonce = self.next_nonce.checked_add(1).expect("NONCE_OVERFLOW");
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    pub fn rotate_authorities(
        &mut self,
        agent_id: AccountId,
        agent_key: PublicKey,
        policy_key: PublicKey,
    ) {
        self.assert_owner();
        require!(self.active_session.is_none(), "ACTIVE_STREAM");
        require!(
            agent_id != self.owner_id && agent_id != env::current_account_id(),
            "SEPARATE_AGENT_REQUIRED"
        );
        require!(
            agent_key.curve_type() == CurveType::ED25519
                && policy_key.curve_type() == CurveType::ED25519,
            "ED25519_REQUIRED"
        );
        require!(agent_key != policy_key, "SEPARATE_POLICY_KEY_REQUIRED");
        self.agent_id = agent_id;
        self.agent_key = agent_key;
        self.policy_key = policy_key;
        self.next_nonce = self.next_nonce.checked_add(1).expect("NONCE_OVERFLOW");
    }

    pub fn get_vault(&self) -> VaultView {
        let reserved = self
            .active_session
            .as_ref()
            .map(|id| {
                let stream = self.streams.get(id).unwrap();
                stream.deposit.0 - stream.earned.0
            })
            .unwrap_or(0);
        VaultView {
            version: "2.2.0".into(),
            owner_id: self.owner_id.clone(),
            token_id: self.token_id.clone(),
            agent_id: self.agent_id.clone(),
            agent_key: self.agent_key.clone(),
            policy_key: self.policy_key.clone(),
            policy: self.policy.clone(),
            available: U128(self.available),
            spent: U128(self.spent),
            reserved: U128(reserved),
            claimable_total: U128(self.claimable_total),
            pending_total: U128(self.pending_total),
            next_nonce: U64(self.next_nonce),
            active_session: self.active_session.clone(),
            paused: self.paused,
            now: U64(Self::now()),
        }
    }

    pub fn get_stream(&self, session_id: String) -> Option<Stream> {
        self.streams.get(&session_id)
    }
    pub fn get_claim(&self, account_id: AccountId) -> U128 {
        U128(self.claims.get(&account_id).unwrap_or(0))
    }
    // Audit only: an owner-anchored digest does not authorize a payment.
    pub fn anchor_decision(&mut self, root: String) -> DecisionRoot {
        self.assert_owner();
        require!(
            root.len() == 64 && root.bytes().all(|b| b.is_ascii_hexdigit()),
            "INVALID_ROOT"
        );
        require!(self.decision_roots.get(&root).is_none(), "DUPLICATE_ROOT");
        require!(self.decisions.len() < 1000, "AUDIT_STORAGE_LIMIT");
        let sequence = self.decisions.len() + 1;
        let record = DecisionRoot {
            sequence: U64(sequence),
            root: root.clone(),
            recorded_at: U64(Self::now()),
        };
        self.decisions.insert(&sequence, &record);
        self.decision_roots.insert(&root, &true);
        Self::event(
            "decision_anchored",
            near_sdk::serde_json::to_value(&record).unwrap(),
        );
        record
    }
    pub fn get_decision(&self, sequence: U64) -> Option<DecisionRoot> {
        self.decisions.get(&sequence.0)
    }
    pub fn list_streams(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Stream> {
        self.streams
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(20).min(100) as usize)
            .collect()
    }
}

impl Vault {
    fn now() -> u64 {
        env::block_timestamp() / 1_000_000_000
    }
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "OWNER_ONLY");
    }
    fn assert_agent(&self) {
        require!(
            env::predecessor_account_id() == self.agent_id
                && env::signer_account_id() == self.agent_id
                && env::signer_account_pk() == self.agent_key,
            "AGENT_ONLY"
        );
    }
    fn validate_policy(policy: &Policy, spent: u128) {
        require!(
            policy.budget.0 >= spent
                && policy.max_deposit.0 > 0
                && policy.max_deposit.0 <= policy.budget.0,
            "INVALID_BUDGET"
        );
        require!(
            policy.max_rate.0 > 0,
            "INVALID_RATE_OR_DURATION"
        );
        require!(
            !policy.recipients.is_empty() && policy.recipients.len() <= 32,
            "INVALID_RECIPIENTS"
        );
    }
    fn verify_permit(&self, permit: &Permit, signature: &Base64VecU8, action: &str) {
        require!(
            permit.domain == DOMAIN
                && permit.vault_id == env::current_account_id()
                && permit.agent_id == self.agent_id
                && permit.action == action,
            "PERMIT_DOMAIN"
        );
        require!(permit.nonce.0 == self.next_nonce, "PERMIT_NONCE");
        let now = Self::now();
        require!(
            permit.expires_at.0 >= now && permit.expires_at.0 <= now + MAX_PERMIT_SECONDS,
            "PERMIT_EXPIRED"
        );
        require!(
            !permit.session_id.is_empty()
                && permit.session_id.len() <= 64
                && permit
                    .session_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "INVALID_SESSION"
        );
        require!(
            permit.quote_hash.len() == 64
                && permit.quote_hash.bytes().all(|b| b.is_ascii_hexdigit()),
            "INVALID_QUOTE_HASH"
        );
        let sig: [u8; 64] = signature
            .0
            .as_slice()
            .try_into()
            .expect("INVALID_SIGNATURE_LENGTH");
        let key: [u8; 32] = self.policy_key.as_bytes()[1..].try_into().unwrap();
        let bytes = near_sdk::serde_json::to_vec(permit).unwrap();
        require!(
            env::ed25519_verify(&sig, &bytes, &key),
            "INVALID_POLICY_SIGNATURE"
        );
    }
    fn earned_at(stream: &Stream, now: u64) -> u128 {
        let mut elapsed = now.saturating_sub(stream.started_at.0);
        if stream.duration_seconds > 0 {
            elapsed = elapsed.min(stream.duration_seconds as u64);
        }
        stream.rate.0.saturating_mul(elapsed as u128).min(stream.deposit.0)
    }

    fn finish(&mut self, session_id: &String) -> Stream {
        require!(
            self.active_session.as_ref() == Some(session_id),
            "STREAM_NOT_ACTIVE"
        );
        let mut stream = self.streams.get(session_id).expect("UNKNOWN_SESSION");
        require!(stream.closed_at.is_none(), "ALREADY_CLOSED");
        let now = Self::now();
        let earned = Self::earned_at(&stream, now);
        let refund = stream.deposit.0 - earned;
        stream.closed_at = Some(U64(now));
        self.credit_earnings(&stream.recipient_id, earned - stream.earned.0);
        stream.earned = U128(earned);
        stream.refunded = U128(refund);
        self.available += refund;
        self.active_session = None;
        self.streams.insert(session_id, &stream);
        Self::event("closed", near_sdk::serde_json::to_value(&stream).unwrap());
        stream
    }
    fn credit_earnings(&mut self, recipient_id: &AccountId, amount: u128) {
        if amount > 0 {
            self.spent += amount;
            let previous = self.claims.get(recipient_id).unwrap_or(0);
            self.claims.insert(recipient_id, &(previous + amount));
            self.claimable_total += amount;
        }
    }

    fn payout(&mut self, receiver_id: AccountId, amount: u128, owner_withdrawal: bool) -> Promise {
        let id = self.next_payout;
        self.next_payout = id.checked_add(1).expect("PAYOUT_OVERFLOW");
        self.pending_total += amount;
        self.payouts.insert(
            &id,
            &Payout {
                receiver_id: receiver_id.clone(),
                amount,
                owner_withdrawal,
            },
        );
        ext_ft::ext(self.token_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(20))
            .ft_transfer(receiver_id, U128(amount), Some("AgentPay payout".into()))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .on_payout(U64(id)),
            )
    }
    fn event(event: &str, data: near_sdk::serde_json::Value) {
        env::log_str(&format!(
            "EVENT_JSON:{}",
            near_sdk::serde_json::json!({"standard":"agentpay", "version":"1.0.0", "event":event, "data":[data]})
        ));
    }
}
