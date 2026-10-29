// Spike S12 (Keyfree): the contract itself builds an EIP-1559 contract-creation transaction from
// fields, checks it against owner rules (allowed code hash, allowed chain, gas caps, own nonce),
// asks the NEAR MPC signer for a signature over its own build and returns the signed raw tx.
// No caller-supplied hash is ever signed (attack A2), chain id is inside the signature (A4).
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};
use omni_transaction::evm::types::Signature;
use omni_transaction::evm::EVMTransaction;

// Deterministic deployment proxy (same address on every EVM chain): input = salt ++ init code.
const CREATE2_PROXY: [u8; 20] = [0x4e, 0x59, 0xb4, 0x48, 0x47, 0xb3, 0x79, 0x57, 0x85, 0x88, 0x92, 0x0c, 0xa7, 0x8f, 0xbf, 0x26, 0xc0, 0xb4, 0x95, 0x6c];
const SECP_N: [u8; 32] = hex_lit("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const SECP_HALF_N: [u8; 32] = hex_lit("7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0");

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
#[derive(Clone)]
pub struct Pending {
    pub chain_id: u64,
    pub nonce: u64,
    pub code_hash: String,
    pub gas_limit: u128,
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
    pub init_code: Vec<u8>,
    pub salt: Option<Vec<u8>>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Keyfree {
    owner: AccountId,
    agent: AccountId,
    mpc: AccountId,
    path: String,
    eth_address: String,
    allowed_code: IterableSet<String>,
    next_nonce: LookupMap<u64, u64>,
    max_gas_limit: u128,
    max_fee_cap: u128,
    pending: Option<Pending>,
    last_signed: Option<String>,
}

#[near]
impl Keyfree {
    #[init]
    pub fn new(owner: AccountId, agent: AccountId, mpc: AccountId, path: String, eth_address: String) -> Self {
        Self {
            owner, agent, mpc, path,
            eth_address: eth_address.to_lowercase(),
            allowed_code: IterableSet::new(b"c"),
            next_nonce: LookupMap::new(b"n"),
            max_gas_limit: 3_000_000,
            max_fee_cap: 50_000_000_000,
            pending: None,
            last_signed: None,
        }
    }

    // Owner rules. The real project puts a delay and a guardian veto on these (A5/A6).
    pub fn allow_code(&mut self, code_hash: String) {
        self.only_owner();
        self.allowed_code.insert(code_hash.to_lowercase());
    }
    pub fn allow_chain(&mut self, chain_id: u64, next_nonce: u64) {
        self.only_owner();
        self.next_nonce.insert(chain_id, next_nonce);
    }

    // The bytes the contract would sign, so tests can compare its encoding with viem.
    pub fn preview(&self, chain_id: u64, init_code_hex: String, gas_limit: u128, max_fee_per_gas: u128, max_priority_fee_per_gas: u128, salt_hex: Option<String>) -> Value {
        let p = self.check(chain_id, &init_code_hex, gas_limit, max_fee_per_gas, max_priority_fee_per_gas, salt_hex);
        let unsigned = tx_of(&p).build_for_signing();
        json!({ "unsigned": format!("0x{}", hex::encode(&unsigned)), "hash": hex::encode(env::keccak256_array(&unsigned)), "nonce": p.nonce, "create2_address": create2_address(&p) })
    }

    #[payable]
    pub fn request_deploy(&mut self, chain_id: u64, init_code_hex: String, gas_limit: u128, max_fee_per_gas: u128, max_priority_fee_per_gas: u128, salt_hex: Option<String>) -> Promise {
        require!(env::predecessor_account_id() == self.agent || env::predecessor_account_id() == self.owner, "only agent or owner");
        require!(self.pending.is_none(), "another request is being signed");
        let p = self.check(chain_id, &init_code_hex, gas_limit, max_fee_per_gas, max_priority_fee_per_gas, salt_hex);
        let hash = env::keccak256_array(&tx_of(&p).build_for_signing());
        env::log_str(&format!("keyfree: signing chain {} nonce {} code {} create2 {:?} hash {}", p.chain_id, p.nonce, p.code_hash, create2_address(&p), hex::encode(hash)));
        self.pending = Some(p);
        let args = json!({ "request": { "payload_v2": { "Ecdsa": hex::encode(hash) }, "path": self.path, "domain_id": 0 } });
        Promise::new(self.mpc.clone())
            .function_call("sign", args.to_string().into_bytes(), NearToken::from_yoctonear(1), Gas::from_tgas(100))
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(20)).on_signed())
    }

    #[private]
    pub fn on_signed(&mut self, #[callback_result] res: Result<Value, PromiseError>) -> Option<String> {
        let p = self.pending.take().expect("no pending request");
        let sig = match res {
            Ok(v) => v,
            Err(_) => { env::log_str("keyfree: MPC did not sign, nonce kept"); return None; }
        };
        let r = hex::decode(&sig["big_r"]["affine_point"].as_str().unwrap_or_default()[2..]).expect("bad R");
        let mut s: [u8; 32] = hex::decode(sig["s"]["scalar"].as_str().unwrap_or_default()).expect("bad s").try_into().expect("s len");
        let mut v = sig["recovery_id"].as_u64().expect("bad recovery id") as u8;
        // Ethereum accepts only low-s signatures (EIP-2); flip a high s and its recovery id.
        let high_s = s > SECP_HALF_N;
        if high_s { s = sub(SECP_N, s); v ^= 1; }
        let tx = tx_of(&p);
        let hash = env::keccak256_array(&tx.build_for_signing());
        let mut rs = [0u8; 64];
        rs[..32].copy_from_slice(&r);
        rs[32..].copy_from_slice(&s);
        // Check the signature really belongs to our derived address before handing it out.
        let pk = env::ecrecover(&hash, &rs, v, true).expect("ecrecover failed");
        let addr = format!("0x{}", hex::encode(&env::keccak256_array(&pk)[12..]));
        require!(addr == self.eth_address, "signature recovers to a different address");
        let raw = tx.build_with_signature(&Signature { v: v as u64, r: strip(&r), s: strip(&s) });
        let raw_hex = format!("0x{}", hex::encode(raw));
        self.next_nonce.insert(p.chain_id, p.nonce + 1);
        env::log_str(&format!("keyfree: signed chain {} nonce {} high_s_flipped {} from {}", p.chain_id, p.nonce, high_s, addr));
        self.last_signed = Some(raw_hex.clone());
        Some(raw_hex)
    }

    pub fn get_last_signed(&self) -> Option<String> { self.last_signed.clone() }
    pub fn get_next_nonce(&self, chain_id: u64) -> Option<u64> { self.next_nonce.get(&chain_id).copied() }
    pub fn get_eth_address(&self) -> String { self.eth_address.clone() }

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only owner");
    }

    fn check(&self, chain_id: u64, init_code_hex: &str, gas_limit: u128, max_fee_per_gas: u128, max_priority_fee_per_gas: u128, salt_hex: Option<String>) -> Pending {
        let nonce = *self.next_nonce.get(&chain_id).expect("chain not allowed");
        let init_code = hex::decode(init_code_hex.trim_start_matches("0x")).expect("init code must be hex");
        let code_hash = hex::encode(env::keccak256_array(&init_code));
        require!(self.allowed_code.contains(&code_hash), "code not on the allow list");
        require!(gas_limit <= self.max_gas_limit, "gas limit over the cap");
        require!(max_fee_per_gas <= self.max_fee_cap && max_priority_fee_per_gas <= max_fee_per_gas, "gas price over the cap");
        let salt = salt_hex.map(|h| {
            let b = hex::decode(h.trim_start_matches("0x")).expect("salt must be hex");
            require!(b.len() == 32, "salt must be 32 bytes");
            b
        });
        Pending { chain_id, nonce, code_hash, gas_limit, max_fee_per_gas, max_priority_fee_per_gas, init_code, salt }
    }
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
mod tests {
    use super::*;

    #[test]
    fn strip_and_sub() {
        assert_eq!(strip(&[0, 0, 5, 0]), vec![5, 0]);
        let one = { let mut x = [0u8; 32]; x[31] = 1; x };
        let mut n_minus_1 = SECP_N; n_minus_1[31] -= 1;
        assert_eq!(sub(SECP_N, one), n_minus_1);
        assert!(SECP_HALF_N < SECP_N);
    }
}
