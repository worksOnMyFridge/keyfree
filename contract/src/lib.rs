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
// v6: a signed tx the chain refuses (gas below the intrinsic minimum, fee too low) would leave a nonce
// gap forever. The contract now refuses gas limits below the intrinsic minimum (EIP-2028/3860/7623), and
// resign() re-signs a signed factory deploy with the SAME nonce and content, only gas/fees change.
// v7 after the second audit (security_audit_v2_2026-10-25.md, Н3-Н5): next_nonce never moves back; a
// failed or released re-sign opens nothing (the signed line stays as it was); a new request never takes a
// nonce that already has a journal line; one (salt, code) pair binds to one nonce per chain, so a Deployed
// log can prove only its own nonce; confirm_stuck is for the agent or owner and needs Safe or Finalized.
// State layout changed (used_salts): deploy fresh, no migrate from v6.
// v8 roles (spec R2, R3, R3a, R5; audit v2 Н1): owner, guardian and reserve form a council of three,
// plus an agent. Brakes are immediate and need one council member: pause, revoke the agent. Everything
// that widens rights waits the full delay and cannot be shortened, even by two members together:
// a new owner/guardian/reserve needs 2 of 3 approvals (cancel too: 2 of 3, so a stolen guardian cannot
// block its own replacement); a new agent is proposed by the owner and any council member may cancel it.
// Unpause needs 2 of 3 votes. All four roles are different accounts.
// v9 no side doors (audit v2 Н7-Н9; spec R9, R17, R18): a salt only goes through our own factory (the
// shared CREATE2 proxy is gone, a planned address cannot be taken first); allow_chain only opens a new
// chain, so the nonce never moves by hand; each chain has a fee floor; resign works for any signed line,
// a plain creation too.
// v10 the guardian sees the code it may veto (audit v2 Н6, spec R26): the owner puts the new wasm itself
// into the contract state when proposing (storage paid by the attached deposit), the delay starts only
// then, anyone can read the bytes and check their sha256 against a build of the published commit, and
// apply_upgrade deploys exactly the stored bytes. A Global Contract would also publish the code, but it
// burns its storage NEAR for good; state storage is only staked.
use near_sdk::serde_json::{json, Value};
use near_sdk::json_types::Base64VecU8;
use near_sdk::store::{IterableSet, LazyOption, LookupMap};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};
use omni_transaction::evm::types::Signature;
use omni_transaction::evm::EVMTransaction;

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

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Role { Owner, Guardian, Reserve, Agent }

// One open change per proposer (so at most three, and a stolen key cannot fill the slots of others).
#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub struct RoleChange {
    pub role: Role,
    pub account: AccountId,
    pub proposer: AccountId,
    pub approvals: Vec<AccountId>,
    pub cancels: Vec<AccountId>,
    // Set when enough approvals are in: the delay starts only then.
    pub ready_at: Option<u64>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Keyfree {
    owner: AccountId,
    agent: Option<AccountId>,
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
    // Also the delay for role changes.
    upgrade_delay_sec: u64,
    proposed: Option<(String, u64)>,
    paused: bool,
    version: u32,
    // keccak(chain ‖ salt ‖ code hash) -> the nonce that salted deploy is bound to.
    used_salts: LookupMap<[u8; 32], u64>,
    // Lowest max_fee_per_gas per chain, set when the chain is opened.
    fee_floor: LookupMap<u64, u128>,
    reserve: AccountId,
    role_changes: Vec<RoleChange>,
    unpause_votes: Vec<AccountId>,
    // The proposed wasm, kept apart from the main state so ordinary calls never load it.
    proposed_code: LazyOption<Vec<u8>>,
}

#[near]
impl Keyfree {
    // ignore_state lets the spike account start over; only the account itself may call it, and once
    // its keys are deleted nobody can.
    #[init(ignore_state)]
    pub fn new(owner: AccountId, agent: AccountId, guardian: AccountId, reserve: AccountId, mpc: AccountId, path: String, upgrade_delay_sec: u64) -> Self {
        require!(env::predecessor_account_id() == env::current_account_id(), "only the contract account");
        let all = [&owner, &agent, &guardian, &reserve];
        for i in 0..all.len() {
            for j in i + 1..all.len() { require!(all[i] != all[j], "owner, agent, guardian and reserve must be different accounts"); }
        }
        Self {
            owner, agent: Some(agent), mpc, path,
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
            used_salts: LookupMap::new(b"s3".to_vec()),
            fee_floor: LookupMap::new(b"p3".to_vec()),
            reserve,
            role_changes: vec![],
            unpause_votes: vec![],
            proposed_code: LazyOption::new(b"u3".to_vec(), None),
        }
    }

    // Roles. 1) a council member proposes (the owner alone for a new agent); replaces their own open one.
    pub fn propose_role(&mut self, role: Role, account: AccountId) {
        let me = self.only_council();
        if role == Role::Agent { require!(me == self.owner, "only owner proposes a new agent"); }
        self.require_free(role, &account);
        self.role_changes.retain(|c| c.proposer != me);
        let ready_at = (need(role) == 1).then(|| now() + self.upgrade_delay_sec);
        env::log_str(&format!("keyfree: {me} proposes {role:?} = {account}, ready at {ready_at:?}"));
        self.role_changes.push(RoleChange { role, account, proposer: me.clone(), approvals: vec![me], cancels: vec![], ready_at });
    }

    // 2) a second council member approves; the full delay starts now.
    pub fn approve_role(&mut self, proposer: AccountId) {
        let me = self.only_council();
        let delay = self.upgrade_delay_sec;
        let c = self.role_changes.iter_mut().find(|c| c.proposer == proposer).unwrap_or_else(|| env::panic_str("no such role change"));
        require!(c.role != Role::Agent, "a new agent needs no approval");
        require!(!c.approvals.contains(&me), "already approved");
        c.approvals.push(me);
        if c.ready_at.is_none() { c.ready_at = Some(now() + delay); }
        env::log_str(&format!("keyfree: {:?} = {} approved 2 of 3, ready at {:?}", c.role, c.account, c.ready_at));
    }

    // During the delay: the proposer may withdraw; a new agent is stopped by any council member;
    // an owner/guardian/reserve change only by 2 of 3, so one stolen key cannot keep its role.
    pub fn cancel_role(&mut self, proposer: AccountId) {
        let me = self.only_council();
        let i = self.role_changes.iter().position(|c| c.proposer == proposer).unwrap_or_else(|| env::panic_str("no such role change"));
        let c = &mut self.role_changes[i];
        if !c.cancels.contains(&me) { c.cancels.push(me.clone()); }
        let gone = me == proposer || c.role == Role::Agent || c.cancels.len() >= 2;
        env::log_str(&format!("keyfree: {me} cancels {:?} = {}{}", c.role, c.account, if gone { ", cancelled" } else { ", needs a second cancel" }));
        if gone { self.role_changes.remove(i); }
    }

    // 3) after the delay a council member applies it. Approvals are recounted against the current council.
    pub fn apply_role(&mut self, proposer: AccountId) {
        self.only_council();
        let c = self.role_changes.iter().find(|c| c.proposer == proposer).cloned().unwrap_or_else(|| env::panic_str("no such role change"));
        let ready_at = c.ready_at.unwrap_or_else(|| env::panic_str("needs 2 of 3 approvals"));
        require!(now() >= ready_at, "role change delay not over");
        if c.role == Role::Agent { require!(c.proposer == self.owner, "the proposer is no longer the owner"); }
        require!(c.approvals.iter().filter(|a| self.is_council(a)).count() >= need(c.role), "needs 2 of 3 approvals");
        self.require_free(c.role, &c.account);
        match c.role {
            Role::Owner => self.owner = c.account.clone(),
            Role::Guardian => self.guardian = c.account.clone(),
            Role::Reserve => self.reserve = c.account.clone(),
            Role::Agent => self.agent = Some(c.account.clone()),
        }
        // Approvals and votes were given by the old council: start over.
        self.role_changes.clear();
        self.unpause_votes.clear();
        env::log_str(&format!("keyfree: {:?} is now {}", c.role, c.account));
    }

    // Brake: any council member removes the agent at once.
    pub fn revoke_agent(&mut self) {
        let me = self.only_council();
        self.agent = None;
        env::log_str(&format!("keyfree: agent revoked by {me}"));
    }

    pub fn get_roles(&self) -> Value {
        json!({ "owner": self.owner, "guardian": self.guardian, "reserve": self.reserve, "agent": self.agent,
            "role_changes": self.role_changes, "unpause_votes": self.unpause_votes })
    }

    // Maintenance without keys. 1) the owner sends the new code itself (raw bytes as the call input) and
    // pays its storage; it is public from now on and the delay starts. A new proposal replaces the old one
    // and starts the delay again.
    #[payable]
    pub fn propose_upgrade(&mut self) {
        self.only_owner();
        let code = env::input().unwrap_or_default();
        require!(!code.is_empty(), "send the new wasm as the call input");
        let before = env::storage_usage();
        self.proposed_code.set(Some(code.clone()));
        self.proposed_code.flush();
        let grown = env::storage_usage().saturating_sub(before) as u128;
        let cost = grown * env::storage_byte_cost().as_yoctonear();
        require!(env::attached_deposit().as_yoctonear() >= cost, format!("attach at least {cost} yoctoNEAR for the code storage"));
        let hash = hex::encode(env::sha256_array(&code));
        let ready_at = now() + self.upgrade_delay_sec;
        env::log_str(&format!("keyfree: upgrade to code sha256 {hash} ({} bytes, readable now) proposed, ready at unix {ready_at}", code.len()));
        self.proposed = Some((hash, ready_at));
    }

    // 2) during the delay anyone can read the code; any council member may cancel;
    pub fn cancel_upgrade(&mut self) {
        self.only_council();
        self.proposed = None;
        self.proposed_code.set(None);
        env::log_str("keyfree: upgrade cancelled");
    }

    pub fn get_proposed_code(&self) -> Option<Base64VecU8> {
        self.proposed_code.get().clone().map(Base64VecU8::from)
    }

    // 3) after the delay the owner applies it: the contract deploys exactly the stored bytes onto its own
    // account and runs migrate. Nothing else can change the code.
    pub fn apply_upgrade(&mut self) -> Promise {
        self.only_owner();
        require!(self.pending.is_none(), "a request is being signed");
        let (hash, ready_at) = self.proposed.clone().unwrap_or_else(|| env::panic_str("no upgrade proposed"));
        require!(now() >= ready_at, "upgrade delay not over");
        let code = self.proposed_code.take().unwrap_or_else(|| env::panic_str("no code stored"));
        require!(hex::encode(env::sha256_array(&code)) == hash, "stored code does not match the proposed hash");
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

    // Pause is a brake: one council member, at once. Unpause needs 2 of 3 votes.
    pub fn pause(&mut self) {
        let me = self.only_council();
        self.paused = true;
        self.unpause_votes.clear();
        env::log_str(&format!("keyfree: paused by {me}"));
    }
    pub fn unpause(&mut self) {
        let me = self.only_council();
        require!(self.paused, "not paused");
        if !self.unpause_votes.contains(&me) { self.unpause_votes.push(me); }
        if self.unpause_votes.len() >= 2 {
            self.paused = false;
            self.unpause_votes.clear();
            env::log_str("keyfree: unpaused by 2 of 3");
        } else {
            env::log_str("keyfree: unpause needs a second vote");
        }
    }

    pub fn get_status(&self) -> Value {
        json!({ "build": option_env!("KF_BUILD").unwrap_or("dev"), "version": self.version, "paused": self.paused, "proposed": self.proposed, "upgrade_delay_sec": self.upgrade_delay_sec, "guardian": self.guardian, "reserve": self.reserve })
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
    // Opens a new chain once: its current nonce (the address's nonce there) and its fee floor. After that the
    // nonce moves only by signing, resign or proof, never by hand (two contents on one nonce, Н8).
    pub fn allow_chain(&mut self, chain_id: u64, next_nonce: u64, min_fee_per_gas: u128) {
        self.only_owner();
        require!(self.next_nonce.get(&chain_id).is_none(), "chain already allowed: its nonce moves only by signing");
        require!(min_fee_per_gas > 0, "a chain needs a fee floor above 0");
        self.next_nonce.insert(chain_id, next_nonce);
        self.fee_floor.insert(chain_id, min_fee_per_gas);
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
        json!({ "unsigned": format!("0x{}", hex::encode(&unsigned)), "hash": hex::encode(env::keccak256_array(&unsigned)), "nonce": p.nonce, "expected_address": expected_address(&p), "min_gas": intrinsic_gas(&tx_of(&p)) })
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
        if let Some(s) = &p.salt { self.used_salts.insert(salt_key(p.chain_id, s, &code_hash), p.nonce); }
        self.sign(p)
    }

    // Re-sign the stuck request: same chain, nonce, code and salt; only the gas prices may change.
    // Re-sign a deploy the chain did not take: same chain, nonce, factory, salt and code (checked against
    // the journal), new gas limit and fees. Whichever variant lands, the others become invalid.
    pub fn resign(&mut self, chain_id: u64, nonce: u64, init_code_hex: String, gas_limit: u128, max_fee_per_gas: u128, max_priority_fee_per_gas: u128) -> Promise {
        self.only_agent_or_owner();
        require!(!self.paused, "paused");
        require!(self.pending.is_none() && self.stuck.is_none(), "a request is open");
        let e = self.journal.get(&key(chain_id, nonce)).cloned().unwrap_or_else(|| env::panic_str("no such deploy"));
        require!(e.status == SIGNED, "only a signed, unconfirmed deploy can be re-signed");
        let init_code = hex::decode(init_code_hex.trim_start_matches("0x")).unwrap_or_else(|_| env::panic_str("init code must be hex"));
        require!(env::keccak256_array(&init_code) == e.code_hash, "init code differs from the journal");
        require!(gas_limit <= self.max_gas_limit, "gas limit over the cap");
        self.require_fees(chain_id, max_fee_per_gas, max_priority_fee_per_gas);
        // A salt exists only with the factory, so factory == 0 means a plain creation.
        let factory_deploy = e.factory != [0u8; 20];
        let p = Pending { chain_id, nonce, code_hash: hex::encode(e.code_hash), gas_limit, max_fee_per_gas, max_priority_fee_per_gas,
            init_code, salt: factory_deploy.then(|| e.salt.to_vec()), factory: factory_deploy.then(|| e.factory.to_vec()), since_block: 0 };
        require_intrinsic(&p);
        self.sign(p)
    }

    pub fn retry(&mut self, max_fee_per_gas: u128, max_priority_fee_per_gas: u128) -> Promise {
        self.only_agent_or_owner();
        require!(!self.paused, "paused");
        require!(self.pending.is_none(), "another request is being signed");
        let mut p = self.stuck.take().expect("nothing to retry");
        self.require_fees(p.chain_id, max_fee_per_gas, max_priority_fee_per_gas);
        p.max_fee_per_gas = max_fee_per_gas;
        p.max_priority_fee_per_gas = max_priority_fee_per_gas;
        self.sign(p)
    }

    // If the callback never ran (e.g. ran out of gas), move the request to `stuck` after the timeout.
    pub fn release(&mut self) {
        self.only_agent_or_owner();
        let p = self.pending.as_ref().expect("nothing pending");
        require!(env::block_height() > p.since_block + RELEASE_AFTER_BLOCKS, "still waiting for the MPC");
        let p = self.pending.take().unwrap();
        self.park(p, "released after the MPC timeout");
    }

    // A request that got no signature: a new deploy stays bound to its nonce (`stuck`); a re-sign of an
    // already signed line opens nothing, because that line keeps its nonce and content anyway.
    fn park(&mut self, p: Pending, why: &str) {
        let resign = self.journal.get(&key(p.chain_id, p.nonce)).map(|e| e.status) == Some(SIGNED);
        if resign {
            env::log_str(&format!("keyfree: re-sign of nonce {} {why}; the signed deploy stays as it was", p.nonce));
        } else {
            env::log_str(&format!("keyfree: nonce {} {why}; it stays bound to this deploy", p.nonce));
            self.stuck = Some(p);
        }
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
                let next = self.next_nonce.get(&p.chain_id).copied().unwrap_or(0).max(p.nonce + 1);
                self.next_nonce.insert(p.chain_id, next);
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
                self.park(p, &format!("not signed ({reason})"));
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
    // our Deployed log in it. Then the nonce is spent on exactly this content and can move on. This moves
    // the nonce, so only the agent or owner may ask, and a Latest block (may still vanish) is not enough.
    #[payable]
    pub fn confirm_stuck(&mut self, tx_hash: String, log: LogIn, finality: String) -> Promise {
        self.only_agent_or_owner();
        require!(finality == "Safe" || finality == "Finalized", "a stuck request needs Safe or Finalized");
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
            let next = self.next_nonce.get(&chain_id).copied().unwrap_or(0).max(nonce + 1);
            self.next_nonce.insert(chain_id, next);
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
        let p = env::predecessor_account_id();
        require!(Some(&p) == self.agent.as_ref() || p == self.owner, "only agent or owner");
    }
    // A fee under the chain's floor would be signed but never mined: the nonce would wait forever.
    fn require_fees(&self, chain_id: u64, max_fee_per_gas: u128, max_priority_fee_per_gas: u128) {
        require!(max_fee_per_gas <= self.max_fee_cap && max_priority_fee_per_gas <= max_fee_per_gas, "gas price over the cap");
        let floor = self.fee_floor.get(&chain_id).copied().unwrap_or(0);
        if max_fee_per_gas < floor { env::panic_str(&format!("fee below the floor {floor} of this chain")); }
    }
    fn is_council(&self, a: &AccountId) -> bool {
        *a == self.owner || *a == self.guardian || *a == self.reserve
    }
    fn only_council(&self) -> AccountId {
        let p = env::predecessor_account_id();
        require!(self.is_council(&p), "only owner, guardian or reserve");
        p
    }
    // The new holder of `role` must not hold any other role (R5).
    fn require_free(&self, role: Role, account: &AccountId) {
        let held = [(Role::Owner, Some(&self.owner)), (Role::Guardian, Some(&self.guardian)), (Role::Reserve, Some(&self.reserve)), (Role::Agent, self.agent.as_ref())];
        for (r, a) in held {
            if r != role && a == Some(account) { env::panic_str("account already holds another role"); }
        }
    }

    fn check(&self, chain_id: u64, init_code_hex: &str, gas_limit: u128, max_fee_per_gas: u128, max_priority_fee_per_gas: u128, salt_hex: Option<String>, via_factory: bool) -> Pending {
        let nonce = *self.next_nonce.get(&chain_id).unwrap_or_else(|| env::panic_str("chain not allowed"));
        // A journal line means this nonce was already given to a deploy: never sign another content on it.
        require!(self.journal.get(&key(chain_id, nonce)).is_none(), "nonce already used on this chain: re-sync the nonce");
        let init_code = hex::decode(init_code_hex.trim_start_matches("0x")).unwrap_or_else(|_| env::panic_str("init code must be hex"));
        require!(init_code.len() <= MAX_INIT_CODE, "init code too large");
        let code_hash = hex::encode(env::keccak256_array(&init_code));
        require!(self.allowed_code.contains(&code_hash), "code not on the allow list");
        require!(gas_limit <= self.max_gas_limit, "gas limit over the cap");
        self.require_fees(chain_id, max_fee_per_gas, max_priority_fee_per_gas);
        require!(salt_hex.is_none() || via_factory, "a salt needs the factory (no shared CREATE2 proxy)");
        let salt = salt_hex.map(|h| {
            let b = hex::decode(h.trim_start_matches("0x")).unwrap_or_else(|_| env::panic_str("salt must be hex"));
            require!(b.len() == 32, "salt must be 32 bytes");
            b
        });
        // The Deployed log has no nonce in it, so a (salt, code) pair must never be given a second nonce:
        // otherwise the log of the first deploy could "prove" the second one (Н4).
        if let Some(s) = &salt {
            let mut h = [0u8; 32];
            h.copy_from_slice(&hex::decode(&code_hash).unwrap_or_else(|_| vec![0; 32]));
            require!(!self.used_salts.contains_key(&salt_key(chain_id, s, &h)), "salt and code already used on this chain");
        }
        let factory = if via_factory {
            require!(salt.is_some(), "factory deploys need a salt");
            Some(self.factories.get(&chain_id).cloned().unwrap_or_else(|| env::panic_str("no factory on this chain")))
        } else { None };
        let p = Pending { chain_id, nonce, code_hash, gas_limit, max_fee_per_gas, max_priority_fee_per_gas, init_code, salt, factory, since_block: 0 };
        require_intrinsic(&p);
        p
    }
}

// "secp256k1:<base58 of x||y>" -> lowercase 0x ETH address.
fn eth_address_of(key: &str) -> Option<String> {
    let raw = bs58::decode(key.strip_prefix("secp256k1:")?).into_vec().ok()?;
    if raw.len() != 64 { return None; }
    Some(format!("0x{}", hex::encode(&env::keccak256_array(&raw)[12..])))
}

fn tx_of(p: &Pending) -> EVMTransaction {
    // Plain creation (to = none) or CREATE2 through our factory; no value is ever sent (A1: no transfers).
    let (to, input) = match (&p.factory, &p.salt) {
        (Some(f), Some(salt)) => {
            let mut to = [0u8; 20];
            to.copy_from_slice(f);
            (Some(to), factory_call(salt, &p.init_code))
        }
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

// Gas a transaction pays before any code runs (Prague): calldata tokens = zero bytes + 4 x non-zero bytes;
// standard = 21000 + 4 x tokens (+ 32000 + 2 per 32-byte word for a creation), floor = 21000 + 10 x tokens.
// A gas limit below max(standard, floor) is refused by every node, so such a tx must never be signed.
fn intrinsic_gas(tx: &EVMTransaction) -> u128 {
    let zeros = tx.input.iter().filter(|b| **b == 0).count() as u128;
    let tokens = zeros + 4 * (tx.input.len() as u128 - zeros);
    let create = if tx.to.is_none() { 32_000 + 2 * ((tx.input.len() as u128 + 31) / 32) } else { 0 };
    (21_000 + 4 * tokens + create).max(21_000 + 10 * tokens)
}

fn require_intrinsic(p: &Pending) {
    let min = intrinsic_gas(&tx_of(p));
    if p.gas_limit < min { env::panic_str(&format!("gas limit below the intrinsic minimum {min}")); }
}

// Address CREATE2 will give the new contract: keccak(0xff ++ deployer ++ salt ++ keccak(init))[12..],
// where the deployer is our factory. Plain CREATE is not predicted here.
fn expected_address(p: &Pending) -> Option<String> {
    let salt = p.salt.as_ref()?;
    let deployer: &[u8] = p.factory.as_deref()?;
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

fn now() -> u64 { env::block_timestamp() / 1_000_000_000 }

// Approvals a role change needs: a new agent is the owner's call (cancellable), the council needs 2 of 3.
fn need(role: Role) -> usize { if role == Role::Agent { 1 } else { 2 } }

fn salt_key(chain_id: u64, salt: &[u8], code_hash: &[u8; 32]) -> [u8; 32] {
    env::keccak256_array(&[&chain_id.to_le_bytes()[..], salt, code_hash].concat())
}

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
