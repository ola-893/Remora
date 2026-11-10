use near_sdk::{
    collections::UnorderedMap,
    env,
    json_types::{Base64VecU8, U64},
    near, require, AccountId, CurveType, NearToken, PanicOnDefault, Promise, PublicKey,
};

const HEARTBEAT_TTL_SECONDS: u64 = 120;

#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub struct Publisher {
    pub id: String,
    pub origin: String,
    pub public_key: PublicKey,
    pub owner_id: AccountId,
    pub last_seen: U64,
    pub active: bool,
}

#[near(serializers = [json])]
pub struct PublisherPage {
    pub publishers: Vec<Publisher>,
    pub next_index: Option<U64>,
    pub observed_at: U64,
    pub heartbeat_ttl_seconds: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    publishers: UnorderedMap<String, Publisher>,
}

#[near]
impl Registry {
    #[init]
    pub fn new() -> Self {
        Self {
            publishers: UnorderedMap::new(b"p"),
        }
    }

    #[payable]
    pub fn register(
        &mut self,
        id: String,
        origin: String,
        public_key: PublicKey,
        expires_at: U64,
        signature: Base64VecU8,
    ) -> Publisher {
        require!(
            env::predecessor_account_id() == env::signer_account_id(),
            "DIRECT_OWNER_REQUIRED"
        );
        require!(
            public_key.curve_type() == CurveType::ED25519,
            "ED25519_REQUIRED"
        );
        let key_text = String::from(&public_key);
        let expected = format!("ap_{}", hex(&env::sha256(key_text.as_bytes())));
        require!(id == expected, "PUBLISHER_KEY_MISMATCH");
        require!(valid_origin(&origin), "HTTPS_ORIGIN_REQUIRED");
        let now = env::block_timestamp() / 1_000_000_000;
        require!(
            expires_at.0 > now && expires_at.0 <= now + 300,
            "REGISTRATION_EXPIRED"
        );
        let owner_id = env::predecessor_account_id();
        let message = format!(
            "remora.registry.register.v1\n{}\n{}\n{}\n{}\n{}",
            env::current_account_id(),
            owner_id,
            id,
            origin,
            expires_at.0
        );
        let sig: [u8; 64] = signature.0.try_into().expect("INVALID_SIGNATURE_LENGTH");
        let key: [u8; 32] = public_key.as_bytes()[1..]
            .try_into()
            .expect("INVALID_PUBLIC_KEY");
        require!(
            env::ed25519_verify(&sig, message.as_bytes(), &key),
            "INVALID_FEED_SIGNATURE"
        );
        let before = env::storage_usage();
        let publisher = Publisher {
            id: id.clone(),
            origin,
            public_key,
            owner_id: owner_id.clone(),
            last_seen: U64(now),
            active: false,
        };
        self.publishers.insert(&id, &publisher);
        let cost = env::storage_byte_cost().as_yoctonear()
            * env::storage_usage().saturating_sub(before) as u128;
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= cost, "REGISTRY_STORAGE_DEPOSIT_REQUIRED");
        if deposit > cost {
            Promise::new(owner_id).transfer(NearToken::from_yoctonear(deposit - cost));
        }
        publisher
    }

    pub fn heartbeat(&mut self, id: String) -> Publisher {
        let mut publisher = self.authorized(&id);
        publisher.last_seen = U64(env::block_timestamp() / 1_000_000_000);
        publisher.active = true;
        self.publishers.insert(&id, &publisher);
        publisher
    }

    pub fn stop(&mut self, id: String) -> Publisher {
        let mut publisher = self.authorized(&id);
        publisher.active = false;
        self.publishers.insert(&id, &publisher);
        publisher
    }

    pub fn get_publisher(&self, id: String) -> Option<Publisher> {
        self.publishers.get(&id)
    }

    pub fn list_publishers(&self, from_index: Option<U64>, limit: Option<u32>) -> PublisherPage {
        let start = from_index.unwrap_or(U64(0)).0.min(self.publishers.len());
        let end = (start + u64::from(limit.unwrap_or(50).clamp(1, 100))).min(self.publishers.len());
        let publishers = (start..end)
            .map(|i| self.publishers.values_as_vector().get(i).unwrap())
            .collect();
        PublisherPage {
            publishers,
            next_index: (end < self.publishers.len()).then_some(U64(end)),
            observed_at: U64(env::block_timestamp() / 1_000_000_000),
            heartbeat_ttl_seconds: HEARTBEAT_TTL_SECONDS,
        }
    }
}

impl Registry {
    fn authorized(&self, id: &String) -> Publisher {
        let publisher = self.publishers.get(id).expect("PUBLISHER_NOT_REGISTERED");
        require!(
            env::predecessor_account_id() == publisher.owner_id,
            "PUBLISHER_OWNER_REQUIRED"
        );
        require!(
            env::signer_account_id() == publisher.owner_id
                && env::signer_account_pk() == publisher.public_key,
            "PUBLISHER_KEY_REQUIRED"
        );
        publisher
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn valid_origin(origin: &str) -> bool {
    let host = origin.strip_prefix("https://").unwrap_or("");
    !host.is_empty()
        && origin.len() <= 250
        && host
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-:".contains(&c))
        && !host.starts_with('.')
        && !host.ends_with('.')
}
