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
// v3: deploys go through the owner's own CREATE2 factory (only our address may call it, so a planned
// address cannot be taken first), and a journal entry per nonce is confirmed by NEAR Read MPC from the
// factory's Deployed log (a reverted deploy leaves no log), bound with expected_payload_hash.
// v4: no keys are needed for maintenance. The owner proposes a new code hash, a public delay runs, the
// guardian can cancel, then the contract deploys the matching code onto itself (same account, so the
// same ETH address). Pause is immediate (safe direction); unpause only by the owner.
// v5: a late MPC answer can leak a valid signature for a stuck request and that tx may land. Then the
// factory's Deployed log for that exact request (unique salt + code, only our address can call the
// factory, and every signed variant of it carries the same nonce) proves the nonce was used:
// confirm_stuck clears the request and moves the nonce on.
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
// Journal entry status.
const REQUESTED: u8 = 0;
const SIGNED: u8 = 1;
const CONFIRMED: u8 = 2;

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
    pub factory: Option<Vec<u8>>,
    pub since_block: u64,
}

// One journal line per (chain, nonce). Fixed size, created when the request is made, so callbacks only
// overwrite it and never need more storage (a storage shortfall in a callback would roll it back).
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Entry {
    pub code_hash: [u8; 32],
    pub salt: [u8; 32],
    pub factory: [u8; 20],
    pub addr: [u8; 20],
    pub tx_hash: [u8; 32],
    pub status: u8,
}

// Where the Deployed log sits, as the agent read it from the chain. The contract fixes everything it
// knows (tx hash, factory, address, code hash, salt); the MPC checks the rest via expected_payload_hash.
#[near(serializers = [json])]
pub struct LogIn {
    pub log_index: u64,
    pub transaction_index: u64,
    pub block_hash: String,
    pub block_number: u64,
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
    factories: LookupMap<u64, Vec<u8>>,
    journal: LookupMap<String, Entry>,
    guardian: AccountId,
    upgrade_delay_sec: u64,
    proposed: Option<(String, u64)>,
    paused: bool,
    version: u32,
}

#[near]
impl Keyfree {
    // ignore_state lets the spike account start over; only the account itself may call it, and once
    // its keys are deleted nobody can.
    #[init(ignore_state)]
    pub fn new(owner: AccountId, agent: AccountId, guardian: AccountId, mpc: AccountId, path: String, upgrade_delay_sec: u64) -> Self {
        require!(env::predecessor_account_id() == env::current_account_id(), "only the contract account");
        require!(owner != agent, "owner and agent must be different accounts");
        Self {
            owner, agent, mpc, path,
            eth_address: None,
            allowed_code: IterableSet::new(b"c3".to_vec()),
            next_nonce: LookupMap::new(b"n3".to_vec()),
            max_gas_limit: 3_000_000,
            max_fee_cap: 50_000_000_000,
            pending: None,
            stuck: None,
            factories: LookupMap::new(b"f3".to_vec()),
            journal: LookupMap::new(b"j3".to_vec()),
            guardian,
            upgrade_delay_sec,
            proposed: None,
            paused: false,
            version: 1,
        }
    }

    // Maintenance without keys. 1) owner publishes the sha256 of the new code;
    pub fn propose_upgrade(&mut self, code_sha256: String) {
        self.only_owner();
        let ready_at = env::block_timestamp() / 1_000_000_000 + self.upgrade_delay_sec;
        env::log_str(&format!("keyfree: upgrade to code sha256 {code_sha256} proposed, ready at unix {ready_at}"));
        self.proposed = Some((code_sha256.to_lowercase(), ready_at));
    }

    // 2) during the delay the guardian (or the owner) may cancel;
    pub fn cancel_upgrade(&mut self) {
        require!(env::predecessor_account_id() == self.guardian || env::predecessor_account_id() == self.owner, "only guardian or owner");
        self.proposed = None;
        env::log_str("keyfree: upgrade cancelled");
    }

    // 3) after the delay the owner sends the code itself (raw bytes as the call input) and the contract
    // deploys it onto its own account and runs migrate. Nothing else can change the code.
    pub fn apply_upgrade(&mut self) -> Promise {
        self.only_owner();
        require!(self.pending.is_none(), "a request is being signed");
        let (hash, ready_at) = self.proposed.clone().unwrap_or_else(|| env::panic_str("no upgrade proposed"));
        require!(env::block_timestamp() / 1_000_000_000 >= ready_at, "upgrade delay not over");
        let code = env::input().unwrap_or_default();
        require!(hex::encode(env::sha256_array(&code)) == hash, "code does not match the proposed hash");
        self.proposed = None;
        env::log_str(&format!("keyfree: applying upgrade {hash}"));
        Promise::new(env::current_account_id())
            .deploy_contract(code)
            .function_call("migrate", b"{}".to_vec(), NearToken::from_yoctonear(0), Gas::from_tgas(30))
    }

    // Runs right after the self-deploy; same state layout, so it only bumps the version.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let mut s: Self = env::state_read().unwrap_or_else(|| env::panic_str("no state"));
        s.version += 1;
        env::log_str(&format!("keyfree: migrated to version {}", s.version));
        s
    }

    pub fn pause(&mut self) {
        require!(env::predecessor_account_id() == self.guardian || env::predecessor_account_id() == self.owner, "only guardian or owner");
        self.paused = true;
    }
    pub fn unpause(&mut self) {
        self.only_owner();
        self.paused = false;
    }

    pub fn get_status(&self) -> Value {
        json!({ "build": option_env!("KF_BUILD").unwrap_or("dev"), "version": self.version, "paused": self.paused, "proposed": self.proposed, "upgrade_delay_sec": self.upgrade_delay_sec, "guardian": self.guardian })
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

    // The owner's factory on a chain (deployed keyless through this contract first).
    pub fn set_factory(&mut self, chain_id: u64, factory_hex: String) {
        self.only_owner();
        let f = hex::decode(factory_hex.trim_start_matches("0x")).unwrap_or_default();
        require!(f.len() == 20, "factory must be a 20-byte address");
        self.factories.insert(chain_id, f);
    }

    // The bytes the contract would sign, so tests can compare its encoding with viem.
    pub fn preview(&self, chain_id: u64, init_code_hex: String, gas_limit: u128, max_fee_per_gas: u128, max_priority_fee_per_gas: u128, salt_hex: Option<String>, via_factory: Option<bool>) -> Value {
        let p = self.check(chain_id, &init_code_hex, gas_limit, max_fee_per_gas, max_priority_fee_per_gas, salt_hex, via_factory.unwrap_or(false));
        let unsigned = tx_of(&p).build_for_signing();
        json!({ "unsigned": format!("0x{}", hex::encode(&unsigned)), "hash": hex::encode(env::keccak256_array(&unsigned)), "nonce": p.nonce, "expected_address": expected_address(&p) })
    }

    pub fn request_deploy(&mut self, chain_id: u64, init_code_hex: String, gas_limit: u128, max_fee_per_gas: u128, max_priority_fee_per_gas: u128, salt_hex: Option<String>, via_factory: Option<bool>) -> Promise {
        self.only_agent_or_owner();
        require!(!self.paused, "paused");
        require!(self.eth_address.is_some(), "address not derived yet, call setup");
        require!(self.pending.is_none(), "another request is being signed");
        require!(self.stuck.is_none(), "an earlier request did not finish: retry it or wait for release");
        let p = self.check(chain_id, &init_code_hex, gas_limit, max_fee_per_gas, max_priority_fee_per_gas, salt_hex, via_factory.unwrap_or(false));
        // Reserve the journal line now; the callback only overwrites it.
        let mut salt = [0u8; 32];
        if let Some(x) = &p.salt { salt.copy_from_slice(x); }
        let mut factory = [0u8; 20];
        if let Some(f) = &p.factory { factory.copy_from_slice(f); }
        let mut addr = [0u8; 20];
        if let Some(a) = expected_address(&p) { addr.copy_from_slice(&hex::decode(&a[2..]).unwrap_or_else(|_| vec![0; 20])); }
        let mut code_hash = [0u8; 32];
        code_hash.copy_from_slice(&hex::decode(&p.code_hash).unwrap_or_else(|_| vec![0; 32]));
        self.journal.insert(key(p.chain_id, p.nonce), Entry { code_hash, salt, factory, addr, tx_hash: [0u8; 32], status: REQUESTED });
        self.sign(p)
    }

    // Re-sign the stuck request: same chain, nonce, code and salt; only the gas prices may change.
    pub fn retry(&mut self, max_fee_per_gas: u128, max_priority_fee_per_gas: u128) -> Promise {
        self.only_agent_or_owner();
        require!(!self.paused, "paused");
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
                let tx_hash = env::keccak256_array(&hex::decode(&raw_hex[2..]).unwrap_or_default());
                if let Some(mut e) = self.journal.get(&key(p.chain_id, p.nonce)).cloned() {
                    e.tx_hash = tx_hash;
                    e.status = SIGNED;
                    self.journal.insert(key(p.chain_id, p.nonce), e);
                }
                env::log_str(&format!("keyfree: signed chain {} nonce {} tx 0x{}", p.chain_id, p.nonce, hex::encode(tx_hash)));
                Some(raw_hex)
            }
            Err(reason) => {
                env::log_str(&format!("keyfree: not signed ({reason}); nonce {} stays bound to this deploy", p.nonce));
                self.stuck = Some(p);
                None
            }
        }
    }

    // Ask NEAR Read MPC to confirm a factory deploy from its Deployed log. Anyone may call: the
    // contract binds the tx hash, factory, new address, code hash and salt itself; the caller only
    // says where the log sits (block, position), and the MPC must find exactly that log there.
    #[payable]
    pub fn confirm(&mut self, chain_id: u64, nonce: u64, log: LogIn, finality: String) -> Promise {
        let e = self.journal.get(&key(chain_id, nonce)).cloned().unwrap_or_else(|| env::panic_str("no such deploy"));
        require!(e.status == SIGNED, "deploy is not waiting for confirmation");
        self.read_mpc(chain_id, &e, e.tx_hash, &log, &finality)
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(10)).on_confirmed(chain_id, nonce))
    }

    // A stuck request whose late signature landed anyway: the agent points at the tx, the MPC must find
    // our Deployed log in it. Then the nonce is spent on exactly this content and can move on.
    #[payable]
    pub fn confirm_stuck(&mut self, tx_hash: String, log: LogIn, finality: String) -> Promise {
        let p = self.stuck.clone().unwrap_or_else(|| env::panic_str("nothing stuck"));
        let e = self.journal.get(&key(p.chain_id, p.nonce)).cloned().unwrap_or_else(|| env::panic_str("no journal line"));
        let tx: [u8; 32] = hex::decode(tx_hash.trim_start_matches("0x")).ok().and_then(|b| b.try_into().ok()).unwrap_or_else(|| env::panic_str("bad tx hash"));
        self.read_mpc(p.chain_id, &e, tx, &log, &finality)
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(10)).on_stuck_confirmed(p.chain_id, p.nonce, hex::encode(tx)))
    }

    #[private]
    pub fn on_stuck_confirmed(&mut self, chain_id: u64, nonce: u64, tx_hash: String, #[callback_result] res: Result<Value, PromiseError>) -> bool {
        // Never panic here either.
        let still = self.stuck.as_ref().map(|p| (p.chain_id, p.nonce)) == Some((chain_id, nonce));
        let ok = res.is_ok() && still;
        if ok {
            self.stuck = None;
            self.next_nonce.insert(chain_id, nonce + 1);
            if let Some(mut e) = self.journal.get(&key(chain_id, nonce)).cloned() {
                if let Some(t) = hex::decode(&tx_hash).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()) { e.tx_hash = t; }
                e.status = CONFIRMED;
                self.journal.insert(key(chain_id, nonce), e);
            }
        }
        env::log_str(&format!("keyfree: stuck chain {chain_id} nonce {nonce} {}", if ok { "proved landed by Read MPC, nonce moves on" } else { "not proved, stays stuck" }));
        ok
    }

    fn read_mpc(&self, chain_id: u64, e: &Entry, tx_hash: [u8; 32], log: &LogIn, finality: &str) -> Promise {
        require!(e.factory != [0u8; 20], "only factory deploys can be confirmed");
        let fin = match finality { "Latest" => 0u8, "Safe" => 1, "Finalized" => 2, _ => env::panic_str("finality must be Latest, Safe or Finalized") };
        let (chain_name, variant) = chain_variant(chain_id).unwrap_or_else(|| env::panic_str("Read MPC does not cover this chain"));
        let block_hash: [u8; 32] = hex::decode(log.block_hash.trim_start_matches("0x")).ok().and_then(|b| b.try_into().ok()).unwrap_or_else(|| env::panic_str("bad block hash"));
        let expected = hex::encode(env::sha256_array(&deployed_payload(variant, e, &tx_hash, log, &block_hash, fin)));
        let mut req = near_sdk::serde_json::Map::new();
        req.insert(chain_name.into(), json!({ "tx_id": hex::encode(tx_hash), "extractors": [{ "Log": { "log_index": log.log_index } }], "finality": finality }));
        let args = json!({ "request": { "request": req, "domain_id": 3, "payload_version": 1, "expected_payload_hash": expected } });
        env::log_str(&format!("keyfree: Read MPC chain {chain_id} tx 0x{} expected {expected}", hex::encode(tx_hash)));
        Promise::new(self.mpc.clone())
            .function_call("verify_foreign_transaction", args.to_string().into_bytes(), NearToken::from_yoctonear(1), Gas::from_tgas(100))
    }

    #[private]
    pub fn on_confirmed(&mut self, chain_id: u64, nonce: u64, #[callback_result] res: Result<Value, PromiseError>) -> bool {
        // The MPC contract already matched its answer to expected_payload_hash; never panic here.
        let ok = res.is_ok();
        if let (true, Some(mut e)) = (ok, self.journal.get(&key(chain_id, nonce)).cloned()) {
            e.status = CONFIRMED;
            self.journal.insert(key(chain_id, nonce), e);
        }
        env::log_str(&format!("keyfree: chain {chain_id} nonce {nonce} {}", if ok { "CONFIRMED by Read MPC" } else { "not confirmed (timeout or mismatch), can retry" }));
        ok
    }

    pub fn get_entry(&self, chain_id: u64, nonce: u64) -> Option<Value> {
        self.journal.get(&key(chain_id, nonce)).map(|e| {
            let status = ["requested", "signed", "confirmed"].get(e.status as usize).copied().unwrap_or("?");
            json!({
            "status": status,
            "tx_hash": format!("0x{}", hex::encode(e.tx_hash)), "address": format!("0x{}", hex::encode(e.addr)),
            "factory": format!("0x{}", hex::encode(e.factory)), "code_hash": hex::encode(e.code_hash), "salt": format!("0x{}", hex::encode(e.salt)) })
        })
    }

    pub fn get_eth_address(&self) -> Option<String> { self.eth_address.clone() }
    pub fn get_next_nonce(&self, chain_id: u64) -> Option<u64> { self.next_nonce.get(&chain_id).copied() }
    pub fn get_open(&self) -> Value { json!({ "pending": self.pending.as_ref().map(|p| p.nonce), "stuck": self.stuck.as_ref().map(|p| p.nonce) }) }

    fn sign(&mut self, mut p: Pending) -> Promise {
        p.since_block = env::block_height();
        let hash = env::keccak256_array(&tx_of(&p).build_for_signing());
        env::log_str(&format!("keyfree: signing chain {} nonce {} code {} expected {:?} hash {}", p.chain_id, p.nonce, p.code_hash, expected_address(&p), hex::encode(hash)));
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

    fn check(&self, chain_id: u64, init_code_hex: &str, gas_limit: u128, max_fee_per_gas: u128, max_priority_fee_per_gas: u128, salt_hex: Option<String>, via_factory: bool) -> Pending {
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
        let factory = if via_factory {
            require!(salt.is_some(), "factory deploys need a salt");
            Some(self.factories.get(&chain_id).cloned().unwrap_or_else(|| env::panic_str("no factory on this chain")))
        } else { None };
        Pending { chain_id, nonce, code_hash, gas_limit, max_fee_per_gas, max_priority_fee_per_gas, init_code, salt, factory, since_block: 0 }
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
    let (to, input) = match (&p.factory, &p.salt) {
        (Some(f), Some(salt)) => {
            let mut to = [0u8; 20];
            to.copy_from_slice(f);
            (Some(to), factory_call(salt, &p.init_code))
        }
        (_, Some(salt)) => (Some(CREATE2_PROXY), [salt.as_slice(), p.init_code.as_slice()].concat()),
        _ => (None, p.init_code.clone()),
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

// Address CREATE2 will give the new contract: keccak(0xff ++ deployer ++ salt ++ keccak(init))[12..],
// where the deployer is our factory or the shared proxy. Plain CREATE is not predicted here.
fn expected_address(p: &Pending) -> Option<String> {
    let salt = p.salt.as_ref()?;
    let deployer: &[u8] = p.factory.as_deref().unwrap_or(&CREATE2_PROXY);
    let pre = [&[0xffu8][..], deployer, salt, &env::keccak256_array(&p.init_code)].concat();
    Some(format!("0x{}", hex::encode(&env::keccak256_array(&pre)[12..])))
}

// ABI call KeyfreeFactory.deploy(bytes32 salt, bytes initCode).
fn factory_call(salt: &[u8], init: &[u8]) -> Vec<u8> {
    let mut out = env::keccak256_array(b"deploy(bytes32,bytes)")[..4].to_vec();
    out.extend_from_slice(salt);
    out.extend_from_slice(&word(0x40));
    out.extend_from_slice(&word(init.len() as u64));
    out.extend_from_slice(init);
    out.resize(out.len() + (32 - init.len() % 32) % 32, 0);
    out
}

fn word(n: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&n.to_be_bytes());
    w
}

fn key(chain_id: u64, nonce: u64) -> String { format!("{chain_id}:{nonce}") }

// Read MPC names and borsh variant indexes (near/mpc ForeignChainRpcRequest). Testnet MPC reads the test networks.
fn chain_variant(chain_id: u64) -> Option<(&'static str, u8)> {
    match chain_id {
        8453 | 84532 => Some(("Base", 6)),
        42161 | 421614 => Some(("Arbitrum", 7)),
        _ => None,
    }
}

// borsh(ForeignTxSignPayload::V1 { request: <chain>(EvmRpcRequest { tx, [Log{i}], finality }),
//                                  values: [Evm(Log(EvmLog { .. }))] }); its sha256 is the payload hash.
fn deployed_payload(variant: u8, e: &Entry, tx_hash: &[u8; 32], log: &LogIn, block_hash: &[u8; 32], finality: u8) -> Vec<u8> {
    let mut addr_topic = [0u8; 32];
    addr_topic[12..].copy_from_slice(&e.addr);
    let topics = [env::keccak256_array(b"Deployed(address,bytes32,bytes32)"), addr_topic, e.code_hash];
    let data = format!("0x{}", hex::encode(e.salt));
    let mut b = vec![0u8, variant];
    b.extend_from_slice(tx_hash);
    b.extend_from_slice(&1u32.to_le_bytes());
    b.push(1);
    b.extend_from_slice(&log.log_index.to_le_bytes());
    b.push(finality);
    b.extend_from_slice(&1u32.to_le_bytes());
    b.extend_from_slice(&[1u8, 1u8]);
    b.push(0); // removed = false
    b.extend_from_slice(&log.log_index.to_le_bytes());
    b.extend_from_slice(&log.transaction_index.to_le_bytes());
    b.extend_from_slice(tx_hash);
    b.extend_from_slice(block_hash);
    b.extend_from_slice(&log.block_number.to_le_bytes());
    b.extend_from_slice(&e.factory);
    b.extend_from_slice(&(data.len() as u32).to_le_bytes());
    b.extend_from_slice(data.as_bytes());
    b.extend_from_slice(&(topics.len() as u32).to_le_bytes());
    for t in topics { b.extend_from_slice(&t); }
    b
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
