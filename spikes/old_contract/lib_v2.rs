// Spike S12 (Keyfree): the contract itself builds an EIP-1559 contract-creation transaction from
// fields, checks it against owner rules (allowed code hash, allowed chain, gas caps, own nonce),
// asks the NEAR MPC signer for a signature over its own build and returns the signed raw tx.
// No caller-supplied hash is ever signed (attack A2), chain id is inside the signature (A4).
// v2 after the independent audit (security_audit_2026-10-25.md):
// - the ETH address is derived on-chain from the MPC, never taken from a caller;
// - the signing callback never panics, so a bad MPC answer cannot freeze the contract;
// - a nonce stays bound to one content: after a failed or late answer only the same deploy can be
//   re-signed (fees may change), so two different transactions never share a nonce;
// - a request stuck longer than the MPC timeout can be released by the owner or the agent.
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};
use omni_transaction::evm::types::Signature;
use omni_transaction::evm::EVMTransaction;

// Deterministic deployment proxy (same address on every EVM chain): input = salt ++ init code.
const CREATE2_PROXY: [u8; 20] = [0x4e, 0x59, 0xb4, 0x48, 0x47, 0xb3, 0x79, 0x57, 0x85, 0x88, 0x92, 0x0c, 0xa7, 0x8f, 0xbf, 0x26, 0xc0, 0xb4, 0x95, 0x6c];
const SECP_N: [u8; 32] = hex_lit("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const SECP_HALF_N: [u8; 32] = hex_lit("7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0");
// EIP-3860 limit on init code; also keeps the callback inside its gas budget.
const MAX_INIT_CODE: usize = 49_152;
// MPC yield timeout is 200 blocks; after this many blocks a pending request may be released.
const RELEASE_AFTER_BLOCKS: u64 = 250;

const fn hex_lit(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = (nib(b[2 * i]) << 4) | nib(b[2 * i + 1]);
        i += 1;
    }
    out
}
const fn nib(c: u8) -> u8 {
    if c >= b'a' { c - b'a' + 10 } else { c - b'0' }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub struct Pending {
    pub chain_id: u64,
    pub nonce: u64,
    pub code_hash: String,
    pub gas_limit: u128,
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
    pub init_code: Vec<u8>,
    pub salt: Option<Vec<u8>>,
    pub since_block: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Keyfree {
    owner: AccountId,
    agent: AccountId,
    mpc: AccountId,
    path: String,
    eth_address: Option<String>,
    allowed_code: IterableSet<String>,
    next_nonce: LookupMap<u64, u64>,
    max_gas_limit: u128,
    max_fee_cap: u128,
    pending: Option<Pending>,
    stuck: Option<Pending>,
}

#[near]
impl Keyfree {
    // ignore_state lets the spike account start over; only the account itself may call it, and once
    // its keys are deleted nobody can.
    #[init(ignore_state)]
    pub fn new(owner: AccountId, agent: AccountId, mpc: AccountId, path: String) -> Self {
        require!(env::predecessor_account_id() == env::current_account_id(), "only the contract account");
        require!(owner != agent, "owner and agent must be different accounts");
        Self {
            owner, agent, mpc, path,
            eth_address: None,
            allowed_code: IterableSet::new(b"c2".to_vec()),
            next_nonce: LookupMap::new(b"n2".to_vec()),
            max_gas_limit: 3_000_000,
            max_fee_cap: 50_000_000_000,
            pending: None,
            stuck: None,
        }
    }

    // Ask the MPC which secp256k1 key belongs to (this contract, path) and keep its ETH address.
    pub fn setup(&mut self) -> Promise {
        require!(self.eth_address.is_none(), "address already set");
        let args = json!({ "path": self.path, "predecessor": env::current_account_id(), "domain_id": 0 });
        Promise::new(self.mpc.clone())
            .function_call("derived_public_key", args.to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(10))
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(10)).on_derived())
    }

    #[private]
    pub fn on_derived(&mut self, #[callback_result] res: Result<String, PromiseError>) -> Option<String> {
        let addr = res.ok().and_then(|k| eth_address_of(&k));
        match &addr {
            Some(a) => { env::log_str(&format!("keyfree: derived address {a}")); self.eth_address = addr.clone(); }
            None => env::log_str("keyfree: could not derive the address"),
        }
        addr
    }

    // Owner rules. The real project puts a delay and a guardian veto on these (A5/A6).
    pub fn allow_code(&mut self, code_hash: String) {
        self.only_owner();
        self.allowed_code.insert(code_hash.to_lowercase());
    }
    pub fn allow_chain(&mut self, chain_id: u64, next_nonce: u64) {
        self.only_owner();
        require!(self.pending.is_none() && self.stuck.is_none(), "a request is open");
        self.next_nonce.insert(chain_id, next_nonce);
    }

    // The bytes the contract would sign, so tests can compare its encoding with viem.
    pub fn preview(&self, chain_id: u64, init_code_hex: String, gas_limit: u128, max_fee_per_gas: u128, max_priority_fee_per_gas: u128, salt_hex: Option<String>) -> Value {
        let p = self.check(chain_id, &init_code_hex, gas_limit, max_fee_per_gas, max_priority_fee_per_gas, salt_hex);
        let unsigned = tx_of(&p).build_for_signing();
        json!({ "unsigned": format!("0x{}", hex::encode(&unsigned)), "hash": hex::encode(env::keccak256_array(&unsigned)), "nonce": p.nonce, "create2_address": create2_address(&p) })
    }

    pub fn request_deploy(&mut self, chain_id: u64, init_code_hex: String, gas_limit: u128, max_fee_per_gas: u128, max_priority_fee_per_gas: u128, salt_hex: Option<String>) -> Promise {
        self.only_agent_or_owner();
        require!(self.eth_address.is_some(), "address not derived yet, call setup");
        require!(self.pending.is_none(), "another request is being signed");
        require!(self.stuck.is_none(), "an earlier request did not finish: retry it or wait for release");
        let p = self.check(chain_id, &init_code_hex, gas_limit, max_fee_per_gas, max_priority_fee_per_gas, salt_hex);
        self.sign(p)
    }

    // Re-sign the stuck request: same chain, nonce, code and salt; only the gas prices may change.
    pub fn retry(&mut self, max_fee_per_gas: u128, max_priority_fee_per_gas: u128) -> Promise {
        self.only_agent_or_owner();
        require!(self.pending.is_none(), "another request is being signed");
        let mut p = self.stuck.take().expect("nothing to retry");
        require!(max_fee_per_gas <= self.max_fee_cap && max_priority_fee_per_gas <= max_fee_per_gas, "gas price over the cap");
        p.max_fee_per_gas = max_fee_per_gas;
        p.max_priority_fee_per_gas = max_priority_fee_per_gas;
        self.sign(p)
    }

    // If the callback never ran (e.g. ran out of gas), move the request to `stuck` after the timeout.
    pub fn release(&mut self) {
        self.only_agent_or_owner();
        let p = self.pending.as_ref().expect("nothing pending");
        require!(env::block_height() > p.since_block + RELEASE_AFTER_BLOCKS, "still waiting for the MPC");
        self.stuck = self.pending.take();
        env::log_str("keyfree: pending request released, only the same deploy can be re-signed");
    }

    #[private]
    pub fn on_signed(&mut self, #[callback_result] res: Result<Value, PromiseError>) -> Option<String> {
        // Never panic here: a panic would roll back `pending.take()` and freeze the contract.
        let Some(p) = self.pending.take() else { env::log_str("keyfree: answer without a pending request"); return None; };
        let outcome = match res {
            Ok(sig) => self.finish(&p, &sig),
            Err(_) => Err("MPC did not answer in time".to_string()),
        };
        match outcome {
            Ok(raw_hex) => {
                self.next_nonce.insert(p.chain_id, p.nonce + 1);
                env::log_str(&format!("keyfree: signed chain {} nonce {} tx {}", p.chain_id, p.nonce, hex::encode(env::keccak256_array(&hex::decode(&raw_hex[2..]).unwrap_or_default()))));
                Some(raw_hex)
            }
            Err(reason) => {
                env::log_str(&format!("keyfree: not signed ({reason}); nonce {} stays bound to this deploy", p.nonce));
                self.stuck = Some(p);
                None
            }
        }
    }

    pub fn get_eth_address(&self) -> Option<String> { self.eth_address.clone() }
    pub fn get_next_nonce(&self, chain_id: u64) -> Option<u64> { self.next_nonce.get(&chain_id).copied() }
    pub fn get_open(&self) -> Value { json!({ "pending": self.pending.as_ref().map(|p| p.nonce), "stuck": self.stuck.as_ref().map(|p| p.nonce) }) }

    fn sign(&mut self, mut p: Pending) -> Promise {
        p.since_block = env::block_height();
        let hash = env::keccak256_array(&tx_of(&p).build_for_signing());
        env::log_str(&format!("keyfree: signing chain {} nonce {} code {} create2 {:?} hash {}", p.chain_id, p.nonce, p.code_hash, create2_address(&p), hex::encode(hash)));
        self.pending = Some(p);
        let args = json!({ "request": { "payload_v2": { "Ecdsa": hex::encode(hash) }, "path": self.path, "domain_id": 0 } });
        Promise::new(self.mpc.clone())
            .function_call("sign", args.to_string().into_bytes(), NearToken::from_yoctonear(1), Gas::from_tgas(100))
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(50)).on_signed())
    }

    // Turn an MPC answer into a signed raw transaction, or say why not. Never panics.
    fn finish(&self, p: &Pending, sig: &Value) -> Result<String, String> {
        let r = sig["big_r"]["affine_point"].as_str().and_then(|s| s.get(2..)).and_then(|s| hex::decode(s).ok())
            .filter(|b| b.len() == 32).ok_or("bad R")?;
        let mut s: [u8; 32] = sig["s"]["scalar"].as_str().and_then(|s| hex::decode(s).ok())
            .and_then(|b| b.try_into().ok()).ok_or("bad s")?;
        let mut v = sig["recovery_id"].as_u64().filter(|v| *v <= 1).ok_or("bad recovery id")? as u8;
        if s == [0u8; 32] || s >= SECP_N { return Err("s out of range".into()); }
        // Ethereum accepts only low-s signatures (EIP-2); flip a high s and its recovery id.
        if s > SECP_HALF_N { s = sub(SECP_N, s); v ^= 1; }
        let tx = tx_of(p);
        let hash = env::keccak256_array(&tx.build_for_signing());
        let mut rs = [0u8; 64];
        rs[..32].copy_from_slice(&r);
        rs[32..].copy_from_slice(&s);
        // The signature must belong to our derived address before we hand it out.
        let pk = env::ecrecover(&hash, &rs, v, true).ok_or("signature does not recover")?;
        let addr = format!("0x{}", hex::encode(&env::keccak256_array(&pk)[12..]));
        if Some(&addr) != self.eth_address.as_ref() { return Err(format!("signature recovers to {addr}")); }
        let raw = tx.build_with_signature(&Signature { v: v as u64, r: strip(&r), s: strip(&s) });
        Ok(format!("0x{}", hex::encode(raw)))
    }

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only owner");
    }
    fn only_agent_or_owner(&self) {
        require!(env::predecessor_account_id() == self.agent || env::predecessor_account_id() == self.owner, "only agent or owner");
    }

    fn check(&self, chain_id: u64, init_code_hex: &str, gas_limit: u128, max_fee_per_gas: u128, max_priority_fee_per_gas: u128, salt_hex: Option<String>) -> Pending {
        let nonce = *self.next_nonce.get(&chain_id).unwrap_or_else(|| env::panic_str("chain not allowed"));
        let init_code = hex::decode(init_code_hex.trim_start_matches("0x")).unwrap_or_else(|_| env::panic_str("init code must be hex"));
        require!(init_code.len() <= MAX_INIT_CODE, "init code too large");
        let code_hash = hex::encode(env::keccak256_array(&init_code));
        require!(self.allowed_code.contains(&code_hash), "code not on the allow list");
        require!(gas_limit <= self.max_gas_limit, "gas limit over the cap");
        require!(max_fee_per_gas <= self.max_fee_cap && max_priority_fee_per_gas <= max_fee_per_gas, "gas price over the cap");
        let salt = salt_hex.map(|h| {
            let b = hex::decode(h.trim_start_matches("0x")).unwrap_or_else(|_| env::panic_str("salt must be hex"));
            require!(b.len() == 32, "salt must be 32 bytes");
            b
        });
        Pending { chain_id, nonce, code_hash, gas_limit, max_fee_per_gas, max_priority_fee_per_gas, init_code, salt, since_block: 0 }
    }
}

// "secp256k1:<base58 of x||y>" -> lowercase 0x ETH address.
fn eth_address_of(key: &str) -> Option<String> {
    let raw = bs58::decode(key.strip_prefix("secp256k1:")?).into_vec().ok()?;
    if raw.len() != 64 { return None; }
    Some(format!("0x{}", hex::encode(&env::keccak256_array(&raw)[12..])))
}

fn tx_of(p: &Pending) -> EVMTransaction {
    // Plain creation (to = none) or CREATE2 through the proxy; no value is ever sent (A1: no transfers).
    let (to, input) = match &p.salt {
        None => (None, p.init_code.clone()),
        Some(salt) => (Some(CREATE2_PROXY), [salt.as_slice(), p.init_code.as_slice()].concat()),
    };
    EVMTransaction {
        chain_id: p.chain_id,
        nonce: p.nonce,
        to,
        value: 0,
        input,
        gas_limit: p.gas_limit,
        max_fee_per_gas: p.max_fee_per_gas,
        max_priority_fee_per_gas: p.max_priority_fee_per_gas,
        access_list: vec![],
    }
}

// Address the CREATE2 proxy will give the new contract: keccak(0xff ++ proxy ++ salt ++ keccak(init))[12..].
fn create2_address(p: &Pending) -> Option<String> {
    let salt = p.salt.as_ref()?;
    let pre = [&[0xffu8][..], &CREATE2_PROXY, salt, &env::keccak256_array(&p.init_code)].concat();
    Some(format!("0x{}", hex::encode(&env::keccak256_array(&pre)[12..])))
}

// RLP integers must not carry leading zero bytes; omni-transaction appends r and s as raw bytes.
fn strip(b: &[u8]) -> Vec<u8> {
    let i = b.iter().position(|&x| x != 0).unwrap_or(b.len());
    b[i..].to_vec()
}

fn sub(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut d = a[i] as i16 - b[i] as i16 - borrow;
        borrow = if d < 0 { d += 256; 1 } else { 0 };
        out[i] = d as u8;
    }
    out
}

#[cfg(test)]
mod tests;
