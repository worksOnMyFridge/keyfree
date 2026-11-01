// Keyfree policy: a NEAR contract with no access keys that deploys and upgrades EVM contracts for an AI
// agent under rules a council of three people sets. NEAR MPC signs for the contract's own derived address,
// so no private key for that address exists anywhere.
//
// What it does
// - Builds every EVM transaction itself (EIP-1559) from fields and signs only its own build, never a hash
//   a caller supplies. The chain id is inside the signature, so a signature for one chain fits no other.
// - Deploys only init code whose keccak (the code together with its constructor arguments) is on the allow
//   list, on allowed chains, within gas and fee caps. Salted deploys go only through the council's own
//   CREATE2 factory, which accepts calls from this contract's address alone.
// - Besides deploys it signs exactly one call: upgradeTo(implementation) on an ERC-1967 proxy whose admin is
//   this contract's address, once per allowance (chain, proxy, implementation).
// - Derives its ETH address on chain from the MPC (derived_public_key) and checks every signature against
//   it (ecrecover, low-s).
// - Keeps one content per nonce: after a failed or late MPC answer only the same request can be re-signed
//   (fees may change); next_nonce never moves back and never moves by hand.
// - Journal: a line per nonce, confirmed by NEAR Read MPC from the factory's Deployed log or the proxy's
//   Upgraded log in a Safe or Finalized block, bound with an expected payload hash computed here.
// - Callbacks read the MPC answer as raw bytes and never panic, so no answer can freeze the contract.
// - A daily budget per chain (R8): the most gas it may commit in one UTC day (gas limit x max fee of every
//   signature, re-signs included) and how many transactions it signs; nothing is given back.
//
// Who can do what
// - agent: a function-call key on the request methods only (request_deploy, request_proxy_upgrade,
//   resign, resign_proxy_upgrade, retry, release, confirm, confirm_stuck).
// - council (owner, guardian, reserve; all different accounts): brakes are immediate and need one member:
//   pause, revoke the agent, narrow a rule. Everything that widens power waits a public delay that nobody
//   can shorten: allow code, a chain, a factory, higher caps or budgets, a proxy upgrade (rules_delay_sec, any
//   member may cancel); a new agent (the owner proposes, any member may cancel); a new owner, guardian or
//   reserve (2 of 3, cancel 2 of 3); unpause (2 of 3 votes).
// - Self-upgrade without keys: the owner stores the new wasm in the state, anyone can read it and compare
//   its sha256 with a build of the published source, any member may cancel during upgrade_delay_sec, then
//   the contract deploys exactly those bytes onto itself and runs migrate.
// - Retire: 2 of 3 and the full delay, then paused for good; sweep() empties the state in portions and
//   finish_retire() deletes the account, sending its NEAR to a council member who approved.
//
// Why the checks exist (the attack bench is attacks/)
// - A caller-supplied hash could be any transaction on any chain: the contract signs only its own build.
// - A prompt-injected agent asks for other code or other constructor arguments: the allow list holds the
//   hash of the whole init code, so Vault(another owner) is other code and is refused before signing.
// - Someone takes a planned CREATE2 address first: the factory accepts only this contract's address.
// - Two contents on one nonce would let a late signature land instead of the intended one: one content
//   per nonce, and a re-sign keeps the content.
// - A stolen council key can brake at once and nothing more; widening waits the delay, and the other two
//   members can cancel it.
// - A forged journal line: Read MPC reads the log on the EVM chain itself; the payload hash is computed
//   here, and the tx id comes from the contract's own signature, not from the agent.
//
// State and migration
// - Everything that grows is iterable, so retiring can empty it (DeleteAccount needs at most 10 000 bytes
//   of state).
// - migrate reads the current layout or an older one (v14, v13); new fields go at the end of the struct.
//
// Finding ids in comments (N1..N17) refer to the second security review in AUDIT.md, requirement ids
// (R1..R29) to the requirement list there. The version history is contract/CHANGELOG.md.
// Tests: src/tests.rs (cargo test -- --test-threads=1); golden vectors: golden_vectors.mjs.
//
// Limits: testnets only so far, and no professional audit yet.
// See SECURITY.md, "Known limits".
use near_sdk::borsh::BorshDeserialize;
use near_sdk::serde_json::{json, Value};
use near_sdk::json_types::Base64VecU8;
use near_sdk::store::{IterableMap, IterableSet, LazyOption};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};
use omni_transaction::evm::types::Signature;
use omni_transaction::evm::EVMTransaction;

const SECP_N: [u8; 32] = hex_lit("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const SECP_HALF_N: [u8; 32] = hex_lit("7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0");
// EIP-3860 limit on init code; also keeps the callback inside its gas budget.
const MAX_INIT_CODE: usize = 49_152;
// Longest callback answer we read; an MPC signature or a Read MPC answer is well under 1 KB.
const MAX_CALLBACK_BYTES: usize = 16 * 1024;
// Open rule proposals at once (bounds the state a stolen owner key can fill).
const MAX_RULE_PROPOSALS: usize = 8;
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
    // For a proxy upgrade: the calldata the contract built (and code_hash is its keccak).
    pub init_code: Vec<u8>,
    pub salt: Option<Vec<u8>>,
    // The transaction's `to`: our factory (with a salt) or, without a salt, the proxy being upgraded.
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

// Journal line of a proxy upgrade, same rules as Entry (fixed size, made at request time).
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct ProxyEntry {
    pub proxy: [u8; 20],
    pub implementation: [u8; 20],
    pub tx_hash: [u8; 32],
    pub status: u8,
}

// Daily spend per chain (R8): how much gas the policy may commit on one chain in one UTC day, counted as
// gas_limit x max_fee_per_gas of every transaction it signs (the most each can cost, re-signs included),
// and how many transactions it signs. A chain without a budget has only the per-transaction caps.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Budget {
    pub max_wei_per_day: u128,
    pub max_tx_per_day: u32,
}

// What a chain used on its current UTC day. Nothing is given back: a signature, once out, may land.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Spent {
    pub day: u64,
    pub wei: u128,
    pub txs: u32,
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

// Retire is not a role: it is the council decision to retire the policy (R29), and its `account` is the
// beneficiary of the account's NEAR. It goes through the same 2 of 3 + full delay + 2 of 3 cancel.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Role { Owner, Guardian, Reserve, Agent, Retire }

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

// A rule change that widens what the agent may do. Narrowing has its own immediate methods.
#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum RuleChange {
    AllowCode { code_hash: String },
    AllowChain { chain_id: u64, next_nonce: u64, min_fee_per_gas: u128 },
    EnableChain { chain_id: u64 },
    SetFactory { chain_id: u64, factory_hex: String },
    SetLimits { max_gas_limit: u128, max_fee_cap: u128 },
    // One upgradeTo(implementation) on one proxy, used up by the request.
    AllowProxyUpgrade { chain_id: u64, proxy_hex: String, implementation_hex: String },
    // A chain's daily budget (R8). Lowering one is a brake: lower_budget, at once.
    SetBudget { chain_id: u64, max_wei_per_day: u128, max_tx_per_day: u32 },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub struct RuleProposal {
    pub id: u32,
    pub change: RuleChange,
    pub ready_at: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Keyfree {
    owner: AccountId,
    agent: Option<AccountId>,
    mpc: AccountId,
    path: String,
    eth_address: Option<String>,
    // Everything that grows is iterable, so retiring can empty it (DeleteAccount needs <= 10 000 bytes).
    allowed_code: IterableSet<String>,
    next_nonce: IterableMap<u64, u64>,
    max_gas_limit: u128,
    max_fee_cap: u128,
    pending: Option<Pending>,
    stuck: Option<Pending>,
    factories: IterableMap<u64, Vec<u8>>,
    journal: IterableMap<String, Entry>,
    guardian: AccountId,
    // Also the delay for role changes.
    upgrade_delay_sec: u64,
    proposed: Option<(String, u64)>,
    paused: bool,
    version: u32,
    // keccak(chain ‖ salt ‖ code hash) -> the nonce that salted deploy is bound to.
    used_salts: IterableMap<[u8; 32], u64>,
    // Lowest max_fee_per_gas per chain, set when the chain is opened.
    fee_floor: IterableMap<u64, u128>,
    reserve: AccountId,
    role_changes: Vec<RoleChange>,
    unpause_votes: Vec<AccountId>,
    // The proposed wasm, kept apart from the main state so ordinary calls never load it.
    proposed_code: LazyOption<Vec<u8>>,
    rules_delay_sec: u64,
    rule_proposals: Vec<RuleProposal>,
    next_rule_id: u32,
    disabled_chains: IterableSet<u64>,
    // Set once retiring starts (R29): the beneficiary of the account's NEAR. There is no way back.
    retiring: Option<AccountId>,
    // v14. Allowed proxy upgrades as "chain:0xproxy:0ximplementation".
    allowed_upgrades: IterableSet<String>,
    // Journal lines of proxy upgrades, keyed like the deploy journal: a nonce is in at most one of the two.
    proxy_journal: IterableMap<String, ProxyEntry>,
    // v15. Daily budgets per chain and what each chain used today (R8).
    budgets: IterableMap<u64, Budget>,
    spent: IterableMap<u64, Spent>,
}

// The state as v14 wrote it, read once by migrate.
#[near(serializers = [borsh])]
pub struct V14 {
    owner: AccountId,
    agent: Option<AccountId>,
    mpc: AccountId,
    path: String,
    eth_address: Option<String>,
    allowed_code: IterableSet<String>,
    next_nonce: IterableMap<u64, u64>,
    max_gas_limit: u128,
    max_fee_cap: u128,
    pending: Option<Pending>,
    stuck: Option<Pending>,
    factories: IterableMap<u64, Vec<u8>>,
    journal: IterableMap<String, Entry>,
    guardian: AccountId,
    upgrade_delay_sec: u64,
    proposed: Option<(String, u64)>,
    paused: bool,
    version: u32,
    used_salts: IterableMap<[u8; 32], u64>,
    fee_floor: IterableMap<u64, u128>,
    reserve: AccountId,
    role_changes: Vec<RoleChange>,
    unpause_votes: Vec<AccountId>,
    proposed_code: LazyOption<Vec<u8>>,
    rules_delay_sec: u64,
    rule_proposals: Vec<RuleProposal>,
    next_rule_id: u32,
    disabled_chains: IterableSet<u64>,
    retiring: Option<AccountId>,
    allowed_upgrades: IterableSet<String>,
    proxy_journal: IterableMap<String, ProxyEntry>,
}

impl From<V14> for Keyfree {
    fn from(o: V14) -> Self {
        Self {
            owner: o.owner, agent: o.agent, mpc: o.mpc, path: o.path, eth_address: o.eth_address,
            allowed_code: o.allowed_code, next_nonce: o.next_nonce, max_gas_limit: o.max_gas_limit, max_fee_cap: o.max_fee_cap,
            pending: o.pending, stuck: o.stuck, factories: o.factories, journal: o.journal, guardian: o.guardian,
            upgrade_delay_sec: o.upgrade_delay_sec, proposed: o.proposed, paused: o.paused, version: o.version,
            used_salts: o.used_salts, fee_floor: o.fee_floor, reserve: o.reserve, role_changes: o.role_changes,
            unpause_votes: o.unpause_votes, proposed_code: o.proposed_code, rules_delay_sec: o.rules_delay_sec,
            rule_proposals: o.rule_proposals, next_rule_id: o.next_rule_id, disabled_chains: o.disabled_chains,
            retiring: o.retiring, allowed_upgrades: o.allowed_upgrades, proxy_journal: o.proxy_journal,
            budgets: IterableMap::new(b"b5".to_vec()),
            spent: IterableMap::new(b"w5".to_vec()),
        }
    }
}

// The state as v13 wrote it, read once by migrate.
#[near(serializers = [borsh])]
pub struct V13 {
    owner: AccountId,
    agent: Option<AccountId>,
    mpc: AccountId,
    path: String,
    eth_address: Option<String>,
    allowed_code: IterableSet<String>,
    next_nonce: IterableMap<u64, u64>,
    max_gas_limit: u128,
    max_fee_cap: u128,
    pending: Option<Pending>,
    stuck: Option<Pending>,
    factories: IterableMap<u64, Vec<u8>>,
    journal: IterableMap<String, Entry>,
    guardian: AccountId,
    upgrade_delay_sec: u64,
    proposed: Option<(String, u64)>,
    paused: bool,
    version: u32,
    used_salts: IterableMap<[u8; 32], u64>,
    fee_floor: IterableMap<u64, u128>,
    reserve: AccountId,
    role_changes: Vec<RoleChange>,
    unpause_votes: Vec<AccountId>,
    proposed_code: LazyOption<Vec<u8>>,
    rules_delay_sec: u64,
    rule_proposals: Vec<RuleProposal>,
    next_rule_id: u32,
    disabled_chains: IterableSet<u64>,
    retiring: Option<AccountId>,
}

impl From<V13> for Keyfree {
    fn from(o: V13) -> Self {
        Self {
            owner: o.owner, agent: o.agent, mpc: o.mpc, path: o.path, eth_address: o.eth_address,
            allowed_code: o.allowed_code, next_nonce: o.next_nonce, max_gas_limit: o.max_gas_limit, max_fee_cap: o.max_fee_cap,
            pending: o.pending, stuck: o.stuck, factories: o.factories, journal: o.journal, guardian: o.guardian,
            upgrade_delay_sec: o.upgrade_delay_sec, proposed: o.proposed, paused: o.paused, version: o.version,
            used_salts: o.used_salts, fee_floor: o.fee_floor, reserve: o.reserve, role_changes: o.role_changes,
            unpause_votes: o.unpause_votes, proposed_code: o.proposed_code, rules_delay_sec: o.rules_delay_sec,
            rule_proposals: o.rule_proposals, next_rule_id: o.next_rule_id, disabled_chains: o.disabled_chains,
            retiring: o.retiring,
            allowed_upgrades: IterableSet::new(b"a4".to_vec()),
            proxy_journal: IterableMap::new(b"k4".to_vec()),
            budgets: IterableMap::new(b"b5".to_vec()),
            spent: IterableMap::new(b"w5".to_vec()),
        }
    }
}

#[near]
impl Keyfree {
    // ignore_state lets a test account start over; only the account itself may call it, and once
    // its keys are deleted nobody can.
    #[init(ignore_state)]
    pub fn new(owner: AccountId, agent: AccountId, guardian: AccountId, reserve: AccountId, mpc: AccountId, path: String, upgrade_delay_sec: u64, rules_delay_sec: u64) -> Self {
        require!(env::predecessor_account_id() == env::current_account_id(), "only the contract account");
        let all = [&owner, &agent, &guardian, &reserve];
        for i in 0..all.len() {
            for j in i + 1..all.len() { require!(all[i] != all[j], "owner, agent, guardian and reserve must be different accounts"); }
        }
        Self {
            owner, agent: Some(agent), mpc, path,
            eth_address: None,
            allowed_code: IterableSet::new(b"c3".to_vec()),
            next_nonce: IterableMap::new(b"n3".to_vec()),
            max_gas_limit: 3_000_000,
            max_fee_cap: 50_000_000_000,
            pending: None,
            stuck: None,
            factories: IterableMap::new(b"f3".to_vec()),
            journal: IterableMap::new(b"j3".to_vec()),
            guardian,
            upgrade_delay_sec,
            proposed: None,
            paused: false,
            version: 1,
            used_salts: IterableMap::new(b"s3".to_vec()),
            fee_floor: IterableMap::new(b"p3".to_vec()),
            reserve,
            role_changes: vec![],
            unpause_votes: vec![],
            proposed_code: LazyOption::new(b"u3".to_vec(), None),
            rules_delay_sec,
            rule_proposals: vec![],
            next_rule_id: 0,
            disabled_chains: IterableSet::new(b"d3".to_vec()),
            retiring: None,
            allowed_upgrades: IterableSet::new(b"a4".to_vec()),
            proxy_journal: IterableMap::new(b"k4".to_vec()),
            budgets: IterableMap::new(b"b5".to_vec()),
            spent: IterableMap::new(b"w5".to_vec()),
        }
    }

    // Roles. 1) a council member proposes (the owner alone for a new agent); replaces their own open one.
    pub fn propose_role(&mut self, role: Role, account: AccountId) {
        let me = self.only_council();
        self.not_retiring();
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
            Role::Retire => {
                // The NEAR goes to an account that signed this decision, so it surely exists: a deleted
                // account's balance sent to a missing beneficiary is lost.
                require!(c.approvals.contains(&c.account), "the beneficiary must have approved the retirement");
                require!(self.pending.is_none(), "a request is being signed");
                self.retiring = Some(c.account.clone());
                self.paused = true;
                self.proposed = None;
                self.rule_proposals.clear();
            }
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
            "role_changes": self.role_changes, "unpause_votes": self.unpause_votes, "retiring": self.retiring })
    }

    // Retiring (R29), after the council decision (Role::Retire) ran its delay. 1) empty the state in
    // portions; DeleteAccount refuses an account with more than 10 000 bytes of state. Returns what is left.
    pub fn sweep(&mut self, limit: u32) -> u32 {
        self.only_council();
        require!(self.retiring.is_some(), "the policy is not retiring");
        let mut budget = limit as usize;
        macro_rules! drain_map {
            ($m:expr) => {{
                let keys: Vec<_> = $m.keys().take(budget).cloned().collect();
                budget -= keys.len();
                for k in keys { $m.remove(&k); }
            }};
        }
        macro_rules! drain_set {
            ($s:expr) => {{
                let items: Vec<_> = $s.iter().take(budget).cloned().collect();
                budget -= items.len();
                for x in items { $s.remove(&x); }
            }};
        }
        drain_map!(self.journal);
        drain_map!(self.proxy_journal);
        drain_map!(self.used_salts);
        drain_map!(self.next_nonce);
        drain_map!(self.fee_floor);
        drain_map!(self.factories);
        drain_set!(self.allowed_code);
        drain_set!(self.allowed_upgrades);
        drain_set!(self.disabled_chains);
        drain_map!(self.budgets);
        drain_map!(self.spent);
        let _ = budget;
        self.proposed_code.set(None);
        let left = self.left_to_sweep();
        env::log_str(&format!("keyfree: swept, {left} entries left"));
        left
    }

    // 2) when the state is empty, delete the account; its NEAR goes to the beneficiary.
    pub fn finish_retire(&mut self) -> Promise {
        self.only_council();
        let to = self.retiring.clone().unwrap_or_else(|| env::panic_str("the policy is not retiring"));
        require!(self.left_to_sweep() == 0, "sweep first");
        env::log_str(&format!("keyfree: retiring, account deleted, NEAR to {to}"));
        Promise::new(env::current_account_id()).delete_account(to)
    }

    // Maintenance without keys. 1) the owner sends the new code itself (raw bytes as the call input) and
    // pays its storage; it is public from now on and the delay starts. A new proposal replaces the old one
    // and starts the delay again.
    #[payable]
    pub fn propose_upgrade(&mut self) {
        self.only_owner();
        self.not_retiring();
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
    // account and runs migrate. Nothing else can change the code. The proposal stays until migrate has run:
    // deploy + migrate is one atomic batch, so if migrate fails the old code and the proposal are both
    // still there and nothing has to wait a second delay (N17).
    pub fn apply_upgrade(&mut self) -> Promise {
        self.only_owner();
        self.not_retiring();
        require!(self.pending.is_none(), "a request is being signed");
        let (hash, ready_at) = self.proposed.clone().unwrap_or_else(|| env::panic_str("no upgrade proposed"));
        require!(now() >= ready_at, "upgrade delay not over");
        let code = self.proposed_code.get().clone().unwrap_or_else(|| env::panic_str("no code stored"));
        require!(hex::encode(env::sha256_array(&code)) == hash, "stored code does not match the proposed hash");
        env::log_str(&format!("keyfree: applying upgrade {hash}"));
        Promise::new(env::current_account_id())
            .deploy_contract(code)
            .function_call("migrate", b"{}".to_vec(), NearToken::from_yoctonear(0), Gas::from_tgas(30))
    }

    // Runs right after the self-deploy, in the same batch. Every future version's migrate must clear the
    // proposal and the stored code: that is how a successful upgrade is marked done. Reads this layout or
    // an older one (each older layout is shorter, so the bytes of one never parse as another).
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let raw = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("no state"));
        let mut s = Self::try_from_slice(&raw)
            .or_else(|_| V14::try_from_slice(&raw).map(Self::from))
            .or_else(|_| V13::try_from_slice(&raw).map(Self::from))
            .unwrap_or_else(|_| env::panic_str("unknown state layout"));
        s.version += 1;
        s.proposed = None;
        s.proposed_code.set(None);
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
        self.not_retiring();
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
        self.not_retiring();
        require!(self.eth_address.is_none(), "address already set");
        let args = json!({ "path": self.path, "predecessor": env::current_account_id(), "domain_id": 0 });
        Promise::new(self.mpc.clone())
            .function_call("derived_public_key", args.to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(10))
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(10)).on_derived())
    }

    #[private]
    pub fn on_derived(&mut self) -> Option<String> {
        let addr = callback_json().ok().and_then(|k| k.as_str().and_then(eth_address_of));
        match &addr {
            Some(a) => { env::log_str(&format!("keyfree: derived address {a}")); self.eth_address = addr.clone(); }
            None => env::log_str("keyfree: could not derive the address"),
        }
        addr
    }

    // Rules (A5/A6, R6). Widening: 1) the owner proposes, the rules delay runs;
    pub fn propose_rule(&mut self, change: RuleChange) -> u32 {
        self.only_owner();
        self.not_retiring();
        self.validate_rule(&change);
        require!(self.rule_proposals.len() < MAX_RULE_PROPOSALS, "too many open rule proposals");
        let id = self.next_rule_id;
        self.next_rule_id += 1;
        let ready_at = now() + self.rules_delay_sec;
        env::log_str(&format!("keyfree: rule {id} proposed: {change:?}, ready at unix {ready_at}"));
        self.rule_proposals.push(RuleProposal { id, change, ready_at });
        id
    }

    // 2) during the delay any council member may cancel it;
    pub fn cancel_rule(&mut self, id: u32) {
        let me = self.only_council();
        let i = self.rule_proposals.iter().position(|r| r.id == id).unwrap_or_else(|| env::panic_str("no such rule proposal"));
        self.rule_proposals.remove(i);
        env::log_str(&format!("keyfree: rule {id} cancelled by {me}"));
    }

    // 3) after the delay a council member applies it (checked again against the state of now).
    pub fn apply_rule(&mut self, id: u32) {
        self.only_council();
        self.not_retiring();
        let i = self.rule_proposals.iter().position(|r| r.id == id).unwrap_or_else(|| env::panic_str("no such rule proposal"));
        require!(now() >= self.rule_proposals[i].ready_at, "rule delay not over");
        let r = self.rule_proposals.remove(i);
        self.validate_rule(&r.change);
        self.apply_rule_change(&r.change);
        env::log_str(&format!("keyfree: rule {id} applied: {:?}", r.change));
    }

    // Narrowing is a brake: one council member, at once.
    pub fn remove_code(&mut self, code_hash: String) {
        let me = self.only_council();
        self.allowed_code.remove(&code_hash.to_lowercase());
        env::log_str(&format!("keyfree: code {code_hash} removed by {me}"));
    }
    // New deploys on the chain stop; signed lines can still be re-signed or confirmed. The nonce stays.
    pub fn disable_chain(&mut self, chain_id: u64) {
        let me = self.only_council();
        self.disabled_chains.insert(chain_id);
        env::log_str(&format!("keyfree: chain {chain_id} disabled by {me}"));
    }
    pub fn remove_factory(&mut self, chain_id: u64) {
        let me = self.only_council();
        self.factories.remove(&chain_id);
        env::log_str(&format!("keyfree: factory on chain {chain_id} removed by {me}"));
    }
    pub fn remove_proxy_upgrade(&mut self, chain_id: u64, proxy_hex: String, implementation_hex: String) {
        let me = self.only_council();
        let k = upgrade_key(chain_id, &addr20(&proxy_hex, "proxy"), &addr20(&implementation_hex, "implementation"));
        self.allowed_upgrades.remove(&k);
        env::log_str(&format!("keyfree: proxy upgrade {k} removed by {me}"));
    }
    pub fn lower_limits(&mut self, max_gas_limit: u128, max_fee_cap: u128) {
        let me = self.only_council();
        require!(max_gas_limit <= self.max_gas_limit && max_fee_cap <= self.max_fee_cap, "raising a cap is a rule proposal");
        self.max_gas_limit = max_gas_limit;
        self.max_fee_cap = max_fee_cap;
        env::log_str(&format!("keyfree: caps lowered to gas {max_gas_limit}, fee {max_fee_cap} by {me}"));
    }

    // A brake: lower a chain's daily budget at once. Raising it is a rule proposal (SetBudget).
    pub fn lower_budget(&mut self, chain_id: u64, max_wei_per_day: u128, max_tx_per_day: u32) {
        let me = self.only_council();
        let b = self.budgets.get(&chain_id).copied().unwrap_or_else(|| env::panic_str("no budget on this chain: setting one is a rule proposal"));
        require!(max_wei_per_day <= b.max_wei_per_day && max_tx_per_day <= b.max_tx_per_day, "raising a budget is a rule proposal");
        self.budgets.insert(chain_id, Budget { max_wei_per_day, max_tx_per_day });
        env::log_str(&format!("keyfree: budget on chain {chain_id} lowered to {max_wei_per_day} wei and {max_tx_per_day} transactions a day by {me}"));
    }

    // A chain's budget and what it used today (UTC); u128 amounts as strings.
    pub fn get_budget(&self, chain_id: u64) -> Option<Value> {
        let b = self.budgets.get(&chain_id)?;
        let day = now() / 86_400;
        let s = self.spent.get(&chain_id).copied().filter(|s| s.day == day).unwrap_or(Spent { day, wei: 0, txs: 0 });
        Some(json!({ "max_wei_per_day": b.max_wei_per_day.to_string(), "max_tx_per_day": b.max_tx_per_day,
            "used_wei_today": s.wei.to_string(), "used_tx_today": s.txs, "day_ends_at": (day + 1) * 86_400 }))
    }

    pub fn get_rules(&self) -> Value {
        json!({ "allowed_code": self.allowed_code.iter().collect::<Vec<_>>(), "allowed_proxy_upgrades": self.allowed_upgrades.iter().collect::<Vec<_>>(),
            "budgets": self.budgets.iter().map(|(c, b)| json!({ "chain_id": c, "max_wei_per_day": b.max_wei_per_day.to_string(), "max_tx_per_day": b.max_tx_per_day })).collect::<Vec<_>>(),
            "max_gas_limit": self.max_gas_limit.to_string(),
            "max_fee_cap": self.max_fee_cap.to_string(), "rules_delay_sec": self.rules_delay_sec, "proposals": self.rule_proposals })
    }

    // The bytes the contract would sign, so tests can compare its encoding with viem.
    pub fn preview(&self, chain_id: u64, init_code_hex: String, gas_limit: u128, max_fee_per_gas: u128, max_priority_fee_per_gas: u128, salt_hex: Option<String>, via_factory: Option<bool>) -> Value {
        let p = self.check(chain_id, &init_code_hex, gas_limit, max_fee_per_gas, max_priority_fee_per_gas, salt_hex, via_factory.unwrap_or(false));
        self.spent_after(&p);
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

    // The bytes the contract would sign for a proxy upgrade.
    pub fn preview_proxy_upgrade(&self, chain_id: u64, proxy_hex: String, implementation_hex: String, gas_limit: u128, max_fee_per_gas: u128, max_priority_fee_per_gas: u128) -> Value {
        let p = self.check_proxy_upgrade(chain_id, &proxy_hex, &implementation_hex, gas_limit, max_fee_per_gas, max_priority_fee_per_gas);
        self.spent_after(&p);
        let unsigned = tx_of(&p).build_for_signing();
        json!({ "unsigned": format!("0x{}", hex::encode(&unsigned)), "hash": hex::encode(env::keccak256_array(&unsigned)), "nonce": p.nonce,
            "to": format!("0x{}", hex::encode(p.factory.as_deref().unwrap_or_default())), "data": format!("0x{}", hex::encode(&p.init_code)), "min_gas": intrinsic_gas(&tx_of(&p)) })
    }

    // The agent asks for one allowed upgradeTo. The allowance is used up here, so whatever happens next the
    // same call cannot be signed twice, and going back to an older version needs its own rule.
    pub fn request_proxy_upgrade(&mut self, chain_id: u64, proxy_hex: String, implementation_hex: String, gas_limit: u128, max_fee_per_gas: u128, max_priority_fee_per_gas: u128) -> Promise {
        self.only_agent_or_owner();
        require!(!self.paused, "paused");
        require!(self.eth_address.is_some(), "address not derived yet, call setup");
        require!(self.pending.is_none(), "another request is being signed");
        require!(self.stuck.is_none(), "an earlier request did not finish: retry it or wait for release");
        let p = self.check_proxy_upgrade(chain_id, &proxy_hex, &implementation_hex, gas_limit, max_fee_per_gas, max_priority_fee_per_gas);
        let (proxy, implementation) = (addr20(&proxy_hex, "proxy"), addr20(&implementation_hex, "implementation"));
        self.allowed_upgrades.remove(&upgrade_key(chain_id, &proxy, &implementation));
        self.proxy_journal.insert(key(p.chain_id, p.nonce), ProxyEntry { proxy, implementation, tx_hash: [0u8; 32], status: REQUESTED });
        self.sign(p)
    }

    // Like resign for deploys: same chain, nonce, proxy and implementation (from the journal), new gas and fees.
    pub fn resign_proxy_upgrade(&mut self, chain_id: u64, nonce: u64, gas_limit: u128, max_fee_per_gas: u128, max_priority_fee_per_gas: u128) -> Promise {
        self.only_agent_or_owner();
        require!(!self.paused, "paused");
        require!(self.pending.is_none() && self.stuck.is_none(), "a request is open");
        let e = self.proxy_journal.get(&key(chain_id, nonce)).cloned().unwrap_or_else(|| env::panic_str("no such proxy upgrade"));
        require!(e.status == SIGNED, "only a signed, unconfirmed proxy upgrade can be re-signed");
        require!(gas_limit <= self.max_gas_limit, "gas limit over the cap");
        self.require_fees(chain_id, max_fee_per_gas, max_priority_fee_per_gas);
        let p = proxy_pending(chain_id, nonce, &e.proxy, &e.implementation, gas_limit, max_fee_per_gas, max_priority_fee_per_gas);
        require_intrinsic(&p);
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
        let resign = self.line(&key(p.chain_id, p.nonce)).map(|(s, _)| s) == Some(SIGNED);
        if resign {
            env::log_str(&format!("keyfree: re-sign of nonce {} {why}; the signed deploy stays as it was", p.nonce));
        } else {
            env::log_str(&format!("keyfree: nonce {} {why}; it stays bound to this deploy", p.nonce));
            self.stuck = Some(p);
        }
    }

    #[private]
    pub fn on_signed(&mut self) -> Option<String> {
        let res = callback_json();
        self.handle_signed(res)
    }

    fn handle_signed(&mut self, res: Result<Value, PromiseError>) -> Option<String> {
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
                self.set_line(&key(p.chain_id, p.nonce), Some(tx_hash), SIGNED);
                env::log_str(&format!("keyfree: signed chain {} nonce {} tx 0x{}", p.chain_id, p.nonce, hex::encode(tx_hash)));
                Some(raw_hex)
            }
            Err(reason) => {
                self.park(p, &format!("not signed ({reason})"));
                None
            }
        }
    }

    // Ask NEAR Read MPC to confirm a factory deploy from its Deployed log, or a proxy upgrade from the proxy's
    // Upgraded log. Anyone may call: the contract binds the tx hash, emitter and topics itself; the caller
    // only says where the log sits (block, position), and the MPC must find exactly that log there.
    #[payable]
    pub fn confirm(&mut self, chain_id: u64, nonce: u64, log: LogIn, finality: String) -> Promise {
        self.not_retiring();
        let k = key(chain_id, nonce);
        let (status, tx_hash) = self.line(&k).unwrap_or_else(|| env::panic_str("no such deploy"));
        require!(status == SIGNED, "deploy is not waiting for confirmation");
        self.read_mpc(chain_id, &k, tx_hash, &log, &finality)
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(10)).on_confirmed(chain_id, nonce))
    }

    // A stuck request whose late signature landed anyway: the agent points at the tx, the MPC must find
    // our Deployed log in it. Then the nonce is spent on exactly this content and can move on. This moves
    // the nonce, so only the agent or owner may ask, and a Latest block (may still vanish) is not enough.
    #[payable]
    pub fn confirm_stuck(&mut self, tx_hash: String, log: LogIn, finality: String) -> Promise {
        self.only_agent_or_owner();
        self.not_retiring();
        require!(finality == "Safe" || finality == "Finalized", "a stuck request needs Safe or Finalized");
        let p = self.stuck.clone().unwrap_or_else(|| env::panic_str("nothing stuck"));
        let k = key(p.chain_id, p.nonce);
        require!(self.line(&k).is_some(), "no journal line");
        let tx: [u8; 32] = hex::decode(tx_hash.trim_start_matches("0x")).ok().and_then(|b| b.try_into().ok()).unwrap_or_else(|| env::panic_str("bad tx hash"));
        self.read_mpc(p.chain_id, &k, tx, &log, &finality)
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(10)).on_stuck_confirmed(p.chain_id, p.nonce, hex::encode(tx)))
    }

    #[private]
    pub fn on_stuck_confirmed(&mut self, chain_id: u64, nonce: u64, tx_hash: String) -> bool {
        let res = callback_json();
        self.handle_stuck_confirmed(chain_id, nonce, tx_hash, res)
    }

    fn handle_stuck_confirmed(&mut self, chain_id: u64, nonce: u64, tx_hash: String, res: Result<Value, PromiseError>) -> bool {
        // Never panic here either.
        let still = self.stuck.as_ref().map(|p| (p.chain_id, p.nonce)) == Some((chain_id, nonce));
        let ok = res.is_ok() && still;
        if ok {
            self.stuck = None;
            let next = self.next_nonce.get(&chain_id).copied().unwrap_or(0).max(nonce + 1);
            self.next_nonce.insert(chain_id, next);
            let t = hex::decode(&tx_hash).ok().and_then(|b| <[u8; 32]>::try_from(b).ok());
            self.set_line(&key(chain_id, nonce), t, CONFIRMED);
        }
        env::log_str(&format!("keyfree: stuck chain {chain_id} nonce {nonce} {}", if ok { "proved landed by Read MPC, nonce moves on" } else { "not proved, stays stuck" }));
        ok
    }

    fn read_mpc(&self, chain_id: u64, k: &str, tx_hash: [u8; 32], log: &LogIn, finality: &str) -> Promise {
        let fin = match finality { "Latest" => 0u8, "Safe" => 1, "Finalized" => 2, _ => env::panic_str("finality must be Latest, Safe or Finalized") };
        let (chain_name, variant) = chain_variant(chain_id).unwrap_or_else(|| env::panic_str("Read MPC does not cover this chain"));
        let block_hash: [u8; 32] = hex::decode(log.block_hash.trim_start_matches("0x")).ok().and_then(|b| b.try_into().ok()).unwrap_or_else(|| env::panic_str("bad block hash"));
        let payload = if let Some(e) = self.journal.get(k) {
            require!(e.factory != [0u8; 20], "only factory deploys can be confirmed");
            deployed_payload(variant, e, &tx_hash, log, &block_hash, fin)
        } else {
            let u = self.proxy_journal.get(k).unwrap_or_else(|| env::panic_str("no such deploy"));
            upgraded_payload(variant, u, &tx_hash, log, &block_hash, fin)
        };
        let expected = hex::encode(env::sha256_array(&payload));
        let mut req = near_sdk::serde_json::Map::new();
        req.insert(chain_name.into(), json!({ "tx_id": hex::encode(tx_hash), "extractors": [{ "Log": { "log_index": log.log_index } }], "finality": finality }));
        let args = json!({ "request": { "request": req, "domain_id": 3, "payload_version": 1, "expected_payload_hash": expected } });
        env::log_str(&format!("keyfree: Read MPC chain {chain_id} tx 0x{} expected {expected}", hex::encode(tx_hash)));
        Promise::new(self.mpc.clone())
            .function_call("verify_foreign_transaction", args.to_string().into_bytes(), NearToken::from_yoctonear(1), Gas::from_tgas(100))
    }

    #[private]
    pub fn on_confirmed(&mut self, chain_id: u64, nonce: u64) -> bool {
        // The MPC contract already matched its answer to expected_payload_hash; never panic here.
        let ok = callback_json().is_ok();
        if ok { self.set_line(&key(chain_id, nonce), None, CONFIRMED); }
        env::log_str(&format!("keyfree: chain {chain_id} nonce {nonce} {}", if ok { "CONFIRMED by Read MPC" } else { "not confirmed (timeout or mismatch), can retry" }));
        ok
    }

    pub fn get_entry(&self, chain_id: u64, nonce: u64) -> Option<Value> {
        let name = |s: u8| ["requested", "signed", "confirmed"].get(s as usize).copied().unwrap_or("?");
        let k = key(chain_id, nonce);
        if let Some(u) = self.proxy_journal.get(&k) {
            return Some(json!({ "kind": "proxy_upgrade", "status": name(u.status), "tx_hash": format!("0x{}", hex::encode(u.tx_hash)),
                "proxy": format!("0x{}", hex::encode(u.proxy)), "implementation": format!("0x{}", hex::encode(u.implementation)) }));
        }
        self.journal.get(&k).map(|e| json!({
            "kind": "deploy", "status": name(e.status),
            "tx_hash": format!("0x{}", hex::encode(e.tx_hash)), "address": format!("0x{}", hex::encode(e.addr)),
            "factory": format!("0x{}", hex::encode(e.factory)), "code_hash": hex::encode(e.code_hash), "salt": format!("0x{}", hex::encode(e.salt)) }))
    }

    pub fn get_eth_address(&self) -> Option<String> { self.eth_address.clone() }
    pub fn get_next_nonce(&self, chain_id: u64) -> Option<u64> { self.next_nonce.get(&chain_id).copied() }
    pub fn get_open(&self) -> Value { json!({ "pending": self.pending.as_ref().map(|p| p.nonce), "stuck": self.stuck.as_ref().map(|p| p.nonce) }) }

    // What the chain will have used today once this transaction is signed, or a refusal (R8). Every signature
    // counts, a re-sign too: any of them may land, and the budget is about what can be spent.
    fn spent_after(&self, p: &Pending) -> Option<Spent> {
        let b = self.budgets.get(&p.chain_id).copied()?;
        let day = now() / 86_400;
        let s = self.spent.get(&p.chain_id).copied().filter(|s| s.day == day).unwrap_or(Spent { day, wei: 0, txs: 0 });
        let cost = p.gas_limit.saturating_mul(p.max_fee_per_gas);
        if s.txs >= b.max_tx_per_day {
            env::panic_str(&format!("daily limit on chain {}: {} transactions today, until the next UTC day", p.chain_id, b.max_tx_per_day));
        }
        if s.wei.saturating_add(cost) > b.max_wei_per_day {
            env::panic_str(&format!("daily gas budget on chain {}: {} of {} wei used today, this one may cost {}", p.chain_id, s.wei, b.max_wei_per_day, cost));
        }
        Some(Spent { day, wei: s.wei + cost, txs: s.txs + 1 })
    }

    fn sign(&mut self, mut p: Pending) -> Promise {
        if let Some(s) = self.spent_after(&p) { self.spent.insert(p.chain_id, s); }
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
    fn validate_rule(&self, change: &RuleChange) {
        match change {
            RuleChange::AllowCode { code_hash } => {
                require!(code_hash.len() == 64 && hex::decode(code_hash).is_ok(), "code hash must be 32 bytes of hex");
            }
            // Opens a new chain once: its current nonce (the address's nonce there) and its fee floor. After
            // that the nonce moves only by signing, resign or proof, never by hand (two contents on one nonce, N8).
            RuleChange::AllowChain { chain_id, min_fee_per_gas, .. } => {
                require!(self.next_nonce.get(chain_id).is_none(), "chain already allowed: its nonce moves only by signing");
                require!(*min_fee_per_gas > 0, "a chain needs a fee floor above 0");
            }
            RuleChange::EnableChain { chain_id } => require!(self.disabled_chains.contains(chain_id), "chain is not disabled"),
            // The owner's factory on a chain (deployed keyless through this contract first).
            RuleChange::SetFactory { factory_hex, .. } => {
                require!(hex::decode(factory_hex.trim_start_matches("0x")).map(|f| f.len()) == Ok(20), "factory must be a 20-byte address");
            }
            RuleChange::SetLimits { max_gas_limit, max_fee_cap } => require!(*max_gas_limit > 0 && *max_fee_cap > 0, "caps must be above 0"),
            RuleChange::AllowProxyUpgrade { proxy_hex, implementation_hex, .. } => {
                let (proxy, implementation) = (addr20(proxy_hex, "proxy"), addr20(implementation_hex, "implementation"));
                require!(proxy != [0u8; 20] && implementation != [0u8; 20] && proxy != implementation, "proxy and implementation must be two real addresses");
            }
            // Zero would stop the chain: that is disable_chain, a brake.
            RuleChange::SetBudget { max_wei_per_day, max_tx_per_day, .. } => require!(*max_wei_per_day > 0 && *max_tx_per_day > 0, "a budget must be above 0"),
        }
    }

    fn apply_rule_change(&mut self, change: &RuleChange) {
        match change {
            RuleChange::AllowCode { code_hash } => { self.allowed_code.insert(code_hash.to_lowercase()); }
            RuleChange::AllowChain { chain_id, next_nonce, min_fee_per_gas } => {
                self.next_nonce.insert(*chain_id, *next_nonce);
                self.fee_floor.insert(*chain_id, *min_fee_per_gas);
            }
            RuleChange::EnableChain { chain_id } => { self.disabled_chains.remove(chain_id); }
            RuleChange::SetFactory { chain_id, factory_hex } => {
                self.factories.insert(*chain_id, hex::decode(factory_hex.trim_start_matches("0x")).unwrap_or_default());
            }
            RuleChange::SetLimits { max_gas_limit, max_fee_cap } => {
                self.max_gas_limit = *max_gas_limit;
                self.max_fee_cap = *max_fee_cap;
            }
            RuleChange::AllowProxyUpgrade { chain_id, proxy_hex, implementation_hex } => {
                self.allowed_upgrades.insert(upgrade_key(*chain_id, &addr20(proxy_hex, "proxy"), &addr20(implementation_hex, "implementation")));
            }
            RuleChange::SetBudget { chain_id, max_wei_per_day, max_tx_per_day } => {
                self.budgets.insert(*chain_id, Budget { max_wei_per_day: *max_wei_per_day, max_tx_per_day: *max_tx_per_day });
            }
        }
    }

    // A nonce's journal line, deploy or proxy upgrade: (status, tx hash).
    fn line(&self, k: &str) -> Option<(u8, [u8; 32])> {
        self.journal.get(k).map(|e| (e.status, e.tx_hash)).or_else(|| self.proxy_journal.get(k).map(|u| (u.status, u.tx_hash)))
    }
    fn set_line(&mut self, k: &str, tx_hash: Option<[u8; 32]>, status: u8) {
        if let Some(mut e) = self.journal.get(k).cloned() {
            if let Some(t) = tx_hash { e.tx_hash = t; }
            e.status = status;
            self.journal.insert(k.to_string(), e);
        } else if let Some(mut u) = self.proxy_journal.get(k).cloned() {
            if let Some(t) = tx_hash { u.tx_hash = t; }
            u.status = status;
            self.proxy_journal.insert(k.to_string(), u);
        }
    }
    fn left_to_sweep(&self) -> u32 {
        self.journal.len() + self.proxy_journal.len() + self.used_salts.len() + self.next_nonce.len() + self.fee_floor.len()
            + self.factories.len() + self.allowed_code.len() + self.allowed_upgrades.len() + self.disabled_chains.len()
            + self.budgets.len() + self.spent.len()
    }

    fn check_proxy_upgrade(&self, chain_id: u64, proxy_hex: &str, implementation_hex: &str, gas_limit: u128, max_fee_per_gas: u128, max_priority_fee_per_gas: u128) -> Pending {
        let nonce = *self.next_nonce.get(&chain_id).unwrap_or_else(|| env::panic_str("chain not allowed"));
        require!(!self.disabled_chains.contains(&chain_id), "chain is disabled");
        require!(self.line(&key(chain_id, nonce)).is_none(), "nonce already used on this chain: re-sync the nonce");
        let (proxy, implementation) = (addr20(proxy_hex, "proxy"), addr20(implementation_hex, "implementation"));
        require!(self.allowed_upgrades.contains(&upgrade_key(chain_id, &proxy, &implementation)), "proxy upgrade not on the allow list");
        require!(gas_limit <= self.max_gas_limit, "gas limit over the cap");
        self.require_fees(chain_id, max_fee_per_gas, max_priority_fee_per_gas);
        let p = proxy_pending(chain_id, nonce, &proxy, &implementation, gas_limit, max_fee_per_gas, max_priority_fee_per_gas);
        require_intrinsic(&p);
        p
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
    fn not_retiring(&self) {
        require!(self.retiring.is_none(), "the policy is retiring");
    }
    // The new holder of `role` must not hold any other role (R5). A retirement pays a council member.
    fn require_free(&self, role: Role, account: &AccountId) {
        if role == Role::Retire {
            require!(self.is_council(account), "the beneficiary must be a council member");
            return;
        }
        let held = [(Role::Owner, Some(&self.owner)), (Role::Guardian, Some(&self.guardian)), (Role::Reserve, Some(&self.reserve)), (Role::Agent, self.agent.as_ref())];
        for (r, a) in held {
            if r != role && a == Some(account) { env::panic_str("account already holds another role"); }
        }
    }

    fn check(&self, chain_id: u64, init_code_hex: &str, gas_limit: u128, max_fee_per_gas: u128, max_priority_fee_per_gas: u128, salt_hex: Option<String>, via_factory: bool) -> Pending {
        let nonce = *self.next_nonce.get(&chain_id).unwrap_or_else(|| env::panic_str("chain not allowed"));
        require!(!self.disabled_chains.contains(&chain_id), "chain is disabled");
        // A journal line means this nonce was already given to a deploy: never sign another content on it.
        require!(self.line(&key(chain_id, nonce)).is_none(), "nonce already used on this chain: re-sync the nonce");
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
        // otherwise the log of the first deploy could "prove" the second one (N4).
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
    // Plain creation (to = none), CREATE2 through our factory, or upgradeTo on a proxy (to = the proxy, the
    // calldata built by proxy_pending); no value is ever sent (A1: no transfers).
    let to20 = |f: &[u8]| { let mut to = [0u8; 20]; to.copy_from_slice(f); to };
    let (to, input) = match (&p.factory, &p.salt) {
        (Some(f), Some(salt)) => (Some(to20(f)), factory_call(salt, &p.init_code)),
        (Some(f), None) => (Some(to20(f)), p.init_code.clone()),
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

// ABI call upgradeTo(address implementation), the only call the policy ever signs.
fn upgrade_call(implementation: &[u8; 20]) -> Vec<u8> {
    let mut out = env::keccak256_array(b"upgradeTo(address)")[..4].to_vec();
    out.extend_from_slice(&[0u8; 12]);
    out.extend_from_slice(implementation);
    out
}

fn proxy_pending(chain_id: u64, nonce: u64, proxy: &[u8; 20], implementation: &[u8; 20], gas_limit: u128, max_fee_per_gas: u128, max_priority_fee_per_gas: u128) -> Pending {
    let input = upgrade_call(implementation);
    Pending { chain_id, nonce, code_hash: hex::encode(env::keccak256_array(&input)), gas_limit, max_fee_per_gas, max_priority_fee_per_gas,
        init_code: input, salt: None, factory: Some(proxy.to_vec()), since_block: 0 }
}

fn addr20(h: &str, what: &str) -> [u8; 20] {
    hex::decode(h.trim_start_matches("0x")).ok().and_then(|b| b.try_into().ok())
        .unwrap_or_else(|| env::panic_str(&format!("{what} must be a 20-byte address")))
}

fn upgrade_key(chain_id: u64, proxy: &[u8; 20], implementation: &[u8; 20]) -> String {
    format!("{chain_id}:0x{}:0x{}", hex::encode(proxy), hex::encode(implementation))
}

fn word(n: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&n.to_be_bytes());
    w
}

fn key(chain_id: u64, nonce: u64) -> String { format!("{chain_id}:{nonce}") }

fn now() -> u64 { env::block_timestamp() / 1_000_000_000 }

// The answer a callback got, read by hand (R12, N13). With #[callback_result] near-sdk parses
// the JSON in its generated wrapper and panics on an empty or non-JSON answer before our code runs, which
// would roll the callback back. Here every odd answer (failed, too long, empty, not JSON) is just an error.
fn callback_json() -> Result<Value, PromiseError> {
    if env::promise_results_count() != 1 { return Err(PromiseError::Failed); }
    let bytes = env::promise_result_checked(0, MAX_CALLBACK_BYTES)?;
    near_sdk::serde_json::from_slice(&bytes).map_err(|_| {
        env::log_str(&format!("keyfree: callback answer is not JSON ({} bytes)", bytes.len()));
        PromiseError::Failed
    })
}

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
    let topics = [env::keccak256_array(b"Deployed(address,bytes32,bytes32)"), topic(&e.addr), e.code_hash];
    log_payload(variant, tx_hash, log, block_hash, finality, &e.factory, &e.salt, &topics)
}

// ERC-1967 Upgraded(address indexed implementation), emitted by the proxy, no data.
fn upgraded_payload(variant: u8, u: &ProxyEntry, tx_hash: &[u8; 32], log: &LogIn, block_hash: &[u8; 32], finality: u8) -> Vec<u8> {
    let topics = [env::keccak256_array(b"Upgraded(address)"), topic(&u.implementation)];
    log_payload(variant, tx_hash, log, block_hash, finality, &u.proxy, &[], &topics)
}

fn topic(a: &[u8; 20]) -> [u8; 32] {
    let mut t = [0u8; 32];
    t[12..].copy_from_slice(a);
    t
}

fn log_payload(variant: u8, tx_hash: &[u8; 32], log: &LogIn, block_hash: &[u8; 32], finality: u8, emitter: &[u8; 20], data: &[u8], topics: &[[u8; 32]]) -> Vec<u8> {
    let data = format!("0x{}", hex::encode(data));
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
    b.extend_from_slice(emitter);
    b.extend_from_slice(&(data.len() as u32).to_le_bytes());
    b.extend_from_slice(data.as_bytes());
    b.extend_from_slice(&(topics.len() as u32).to_le_bytes());
    for t in topics { b.extend_from_slice(t); }
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
