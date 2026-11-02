// Callback tests from the audit: no MPC answer, however broken, may panic or freeze the contract.
// Golden case = the real MPC signature of the Base Sepolia deploy in evidence/signed_tx.txt.
use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const ADDR: &str = "0x985df6af31660653886e3b6a242d8f0e5380faf4";
const INIT: &str = "600a600c600039600a6000f3602a60005260206000f3";
const R: &str = "c82ea247999e197432c89e62fdb8395b960b091b7c5128cbd6f58b1278aef4c8";
const S: &str = "0fd87334c82dcab810a383fb049e9a28c8c50721ca503a578e4024356f7adca6";
const RAW: &str = "0x02f86e83014a3404830f424083d59f8083030d40808096600a600c600039600a6000f3602a60005260206000f3c080a0c82ea247999e197432c89e62fdb8395b960b091b7c5128cbd6f58b1278aef4c8a00fd87334c82dcab810a383fb049e9a28c8c50721ca503a578e4024356f7adca6";

fn ctx(pred: &str, height: u64) { ctx_at(pred, height, 0, vec![]) }

// height = block, secs = block time, input = raw call input (the code for propose_upgrade).
fn ctx_at(pred: &str, height: u64, secs: u64, input: Vec<u8>) { ctx_pay(pred, height, secs, input, 0) }

fn ctx_pay(pred: &str, height: u64, secs: u64, input: Vec<u8>, deposit_milli_near: u128) {
    let mut c = VMContextBuilder::new()
        .current_account_id("keyfree.testnet".parse().unwrap())
        .predecessor_account_id(pred.parse().unwrap())
        .block_height(height)
        .block_timestamp(secs * 1_000_000_000)
        .prepaid_gas(Gas::from_tgas(300))
        .attached_deposit(NearToken::from_millinear(deposit_milli_near))
        .build();
    c.input = input.into();
    testing_env!(c, cached(near_sdk::test_vm_config), cached(near_sdk::RuntimeFeesConfig::test));
}

// testing_env! builds the runtime's whole parameter set on every call; the property tests make 10^5 calls, so
// each thread builds it once and clones it.
fn cached<T: Clone + 'static>(make: fn() -> T) -> T {
    use std::any::{Any, TypeId};
    thread_local! { static MADE: std::cell::RefCell<std::collections::HashMap<TypeId, Box<dyn Any>>> = Default::default(); }
    MADE.with(|m| m.borrow_mut().entry(TypeId::of::<T>()).or_insert_with(|| Box::new(make())).downcast_ref::<T>().unwrap().clone())
}

fn pending() -> Pending {
    Pending { chain_id: 84532, nonce: 4, code_hash: hex::encode(env::keccak256_array(&hex::decode(INIT).unwrap())),
        gas_limit: 200_000, max_fee_per_gas: 14_000_000, max_priority_fee_per_gas: 1_000_000,
        init_code: hex::decode(INIT).unwrap(), salt: None, factory: None, since_block: 10 }
}

fn contract() -> Keyfree {
    ctx("keyfree.testnet", 10);
    let mut c = Keyfree::new("owner.testnet".parse().unwrap(), "agent.testnet".parse().unwrap(), "guardian.testnet".parse().unwrap(), "reserve.testnet".parse().unwrap(), "mpc.testnet".parse().unwrap(), "keyfree-1".into(), 3600, 1800);
    c.eth_address = Some(ADDR.into());
    c.allowed_code.insert(pending().code_hash);
    c.next_nonce.insert(84532, 4);
    c.pending = Some(pending());
    c
}

fn answer(r: &str, s: &str, v: u64) -> Result<Value, PromiseError> {
    Ok(json!({ "scheme": "Secp256k1", "big_r": { "affine_point": format!("02{r}") }, "s": { "scalar": s }, "recovery_id": v }))
}

fn high_s() -> String {
    let s: [u8; 32] = hex::decode(S).unwrap().try_into().unwrap();
    hex::encode(sub(SECP_N, s))
}

#[test]
fn golden_signature_gives_the_broadcast_tx() {
    let mut c = contract();
    assert_eq!(c.handle_signed(answer(R, S, 0)).as_deref(), Some(RAW));
    assert_eq!(c.get_next_nonce(84532), Some(5));
    assert!(c.pending.is_none() && c.stuck.is_none());
}

#[test]
fn high_s_is_flipped_to_the_same_tx() {
    let mut c = contract();
    assert_eq!(c.handle_signed(answer(R, &high_s(), 1)).as_deref(), Some(RAW));
}

#[test]
fn broken_answers_never_freeze_the_contract() {
    let bad: Vec<(&str, Result<Value, PromiseError>)> = vec![
        ("promise failed", Err(PromiseError::Failed)),
        ("empty object", Ok(json!({}))),
        ("empty R", Ok(json!({ "big_r": { "affine_point": "" }, "s": { "scalar": S }, "recovery_id": 0 }))),
        ("one-char R", Ok(json!({ "big_r": { "affine_point": "0" }, "s": { "scalar": S }, "recovery_id": 0 }))),
        ("non-hex R", answer("zz", S, 0)),
        ("short s", answer(R, "0fd8", 0)),
        ("recovery id 7", answer(R, S, 7)),
        ("s = 0", answer(R, &"00".repeat(32), 0)),
        ("s = n", answer(R, &hex::encode(SECP_N), 0)),
        ("wrong recovery id", answer(R, S, 1)),
        ("string instead of object", Ok(json!("signature"))),
    ];
    for (name, res) in bad {
        let mut c = contract();
        assert_eq!(c.handle_signed(res), None, "{name}");
        assert!(c.pending.is_none(), "{name}: pending cleared");
        assert_eq!(c.stuck.as_ref().map(|p| p.nonce), Some(4), "{name}: nonce stays bound");
        assert_eq!(c.get_next_nonce(84532), Some(4), "{name}: nonce not advanced");
    }
}

#[test]
fn signature_of_another_key_is_refused() {
    let mut c = contract();
    c.eth_address = Some("0x0000000000000000000000000000000000000001".into());
    assert_eq!(c.handle_signed(answer(R, S, 0)), None);
    assert!(c.stuck.is_some());
}

#[test]
fn answer_without_pending_is_ignored() {
    let mut c = contract();
    c.pending = None;
    assert_eq!(c.handle_signed(answer(R, S, 0)), None);
}

#[test]
#[should_panic(expected = "an earlier request did not finish")]
fn new_request_blocked_while_stuck() {
    let mut c = contract();
    c.handle_signed(Err(PromiseError::Failed));
    ctx("agent.testnet", 20);
    let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, None, None);
}

#[test]
fn retry_resigns_only_the_same_content() {
    let mut c = contract();
    c.handle_signed(Err(PromiseError::Failed));
    ctx("agent.testnet", 20);
    let _ = c.retry(20_000_000, 1_000_000);
    let p = c.pending.clone().unwrap();
    assert_eq!((p.nonce, p.init_code.clone(), p.salt.clone(), p.max_fee_per_gas), (4, pending().init_code, None, 20_000_000));
    assert!(c.stuck.is_none());
}

#[test]
#[should_panic(expected = "still waiting for the MPC")]
fn release_waits_for_the_timeout() {
    let mut c = contract();
    ctx("agent.testnet", 100);
    c.release();
}

#[test]
fn release_after_timeout_binds_the_nonce() {
    let mut c = contract();
    ctx("owner.testnet", 10 + RELEASE_AFTER_BLOCKS + 1);
    c.release();
    assert!(c.pending.is_none() && c.stuck.is_some());
}

#[test]
#[should_panic(expected = "only agent or owner")]
fn stranger_cannot_release() {
    let mut c = contract();
    ctx("stranger.testnet", 10_000);
    c.release();
}

#[test]
#[should_panic(expected = "only the contract account")]
fn stranger_cannot_reinit() {
    ctx("stranger.testnet", 10);
    Keyfree::new("x.testnet".parse().unwrap(), "y.testnet".parse().unwrap(), "g.testnet".parse().unwrap(), "r.testnet".parse().unwrap(), "mpc.testnet".parse().unwrap(), "p".into(), 0, 0);
}

#[test]
#[should_panic(expected = "must be different accounts")]
fn roles_must_be_different_accounts_at_init() {
    ctx("keyfree.testnet", 10);
    Keyfree::new("x.testnet".parse().unwrap(), "y.testnet".parse().unwrap(), "g.testnet".parse().unwrap(), "x.testnet".parse().unwrap(), "mpc.testnet".parse().unwrap(), "p".into(), 0, 0);
}

#[test]
fn derived_key_parsing_rejects_garbage() {
    assert_eq!(eth_address_of("ed25519:abc"), None);
    assert_eq!(eth_address_of("secp256k1:0OIl"), None);
    assert_eq!(eth_address_of("secp256k1:2"), None);
}

#[test]
fn strip_and_sub() {
    assert_eq!(strip(&[0, 0, 5, 0]), vec![5, 0]);
    let one = { let mut x = [0u8; 32]; x[31] = 1; x };
    let mut n_minus_1 = SECP_N; n_minus_1[31] -= 1;
    assert_eq!(sub(SECP_N, one), n_minus_1);
}

// Maintenance without keys: propose the code itself, wait, guardian may cancel, then only that code goes in.
const CODE: &[u8] = b"pretend this is the new wasm";

fn proposed() -> Keyfree {
    let mut c = contract();
    c.pending = None;
    ctx_pay("owner.testnet", 20, 1_000, CODE.to_vec(), 100);
    c.propose_upgrade();
    c
}

#[test]
#[should_panic(expected = "upgrade delay not over")]
fn upgrade_waits_for_the_delay() {
    let mut c = proposed();
    ctx_at("owner.testnet", 21, 1_000 + 3_599, CODE.to_vec());
    let _ = c.apply_upgrade();
}

// v10: the code is public for the whole delay and apply uses exactly the stored bytes.
#[test]
fn the_proposed_code_is_readable_during_the_delay() {
    let c = proposed();
    ctx_at("guardian.testnet", 21, 1_100, vec![]);
    let code: Vec<u8> = c.get_proposed_code().unwrap().into();
    assert_eq!(code, CODE);
    assert_eq!(c.proposed.as_ref().map(|p| p.0.clone()), Some(hex::encode(env::sha256_array(CODE))));
}

#[test]
fn apply_ignores_bytes_sent_at_apply_time() {
    let mut c = proposed();
    // the owner (or a thief with the owner key) tries to slip other bytes in at the last moment
    ctx_at("owner.testnet", 21, 1_000 + 3_600, b"other code".to_vec());
    let _ = c.apply_upgrade();
    let deployed: Vec<Vec<u8>> = near_sdk::test_utils::get_created_receipts().into_iter()
        .flat_map(|r| r.actions)
        .filter_map(|a| match a { near_sdk::mock::MockAction::DeployContract { code, .. } => Some(code), _ => None })
        .collect();
    assert_eq!(deployed, vec![CODE.to_vec()], "exactly the stored, public code goes in");
}

#[test]
#[should_panic(expected = "upgrade delay not over")]
fn a_new_proposal_starts_the_delay_again() {
    let mut c = proposed();
    ctx_pay("owner.testnet", 21, 3_000, b"other code".to_vec(), 100);
    c.propose_upgrade();
    assert_eq!(c.get_proposed_code().map(Vec::<u8>::from), Some(b"other code".to_vec()));
    ctx_at("owner.testnet", 22, 1_000 + 3_600, vec![]);
    let _ = c.apply_upgrade();
}

#[test]
#[should_panic(expected = "for the code storage")]
fn proposing_needs_a_deposit_for_the_code_storage() {
    let mut c = contract();
    ctx_at("owner.testnet", 20, 1_000, CODE.to_vec());
    c.propose_upgrade();
}

#[test]
#[should_panic(expected = "send the new wasm as the call input")]
fn proposing_needs_the_code() {
    let mut c = contract();
    ctx_pay("owner.testnet", 20, 1_000, vec![], 100);
    c.propose_upgrade();
}

#[test]
#[should_panic(expected = "only owner")]
fn guardian_cannot_propose_code() {
    let mut c = contract();
    ctx_pay("guardian.testnet", 20, 1_000, CODE.to_vec(), 100);
    c.propose_upgrade();
}

#[test]
fn cancel_removes_the_stored_code() {
    let mut c = proposed();
    ctx_at("guardian.testnet", 21, 1_100, vec![]);
    c.cancel_upgrade();
    assert!(c.get_proposed_code().is_none());
}

#[test]
#[should_panic(expected = "no upgrade proposed")]
fn guardian_cancel_stops_the_upgrade() {
    let mut c = proposed();
    ctx_at("guardian.testnet", 21, 1_100, vec![]);
    c.cancel_upgrade();
    ctx_at("owner.testnet", 22, 1_000 + 3_600, CODE.to_vec());
    let _ = c.apply_upgrade();
}

#[test]
#[should_panic(expected = "only owner")]
fn agent_cannot_upgrade() {
    let mut c = proposed();
    ctx_at("agent.testnet", 21, 1_000 + 3_600, CODE.to_vec());
    let _ = c.apply_upgrade();
}

// N17: apply keeps the proposal; only a migrate that really ran marks the upgrade done.
#[test]
fn apply_keeps_the_proposal_until_migrate_has_run() {
    let mut c = proposed();
    ctx_at("owner.testnet", 21, 1_000 + 3_600, vec![]);
    let _ = c.apply_upgrade();
    assert!(c.proposed.is_some() && c.get_proposed_code().is_some(), "a failed migrate leaves everything to retry");
}

#[test]
fn migrate_marks_the_upgrade_done() {
    let mut c = proposed();
    ctx_at("owner.testnet", 21, 1_000 + 3_600, vec![]);
    let _ = c.apply_upgrade();
    env::state_write(&c);
    ctx_at("keyfree.testnet", 22, 1_000 + 3_601, vec![]);
    let s = Keyfree::migrate();
    assert_eq!(s.version, 2);
    assert!(s.proposed.is_none() && s.get_proposed_code().is_none());
}

#[test]
#[should_panic(expected = "paused")]
fn guardian_pause_blocks_deploys() {
    let mut c = contract();
    c.pending = None;
    ctx("guardian.testnet", 20);
    c.pause();
    ctx("agent.testnet", 21);
    let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, None, None);
}

// Late answer: the request failed for us, but the MPC's signature for it leaked and may land.
#[test]
fn leaked_signature_and_retry_can_only_spend_the_nonce_on_the_same_deploy() {
    let mut c = contract();
    c.handle_signed(Err(PromiseError::Failed));
    let leaked = tx_of(c.stuck.as_ref().unwrap());
    ctx("agent.testnet", 20);
    let _ = c.retry(30_000_000, 2_000_000);
    let again = tx_of(c.pending.as_ref().unwrap());
    // same nonce, target and payload: whichever lands, the other becomes invalid; nothing else can use nonce 4
    assert_eq!((leaked.nonce, leaked.to, leaked.input.clone(), leaked.value), (again.nonce, again.to, again.input.clone(), again.value));
    assert_ne!(leaked.max_fee_per_gas, again.max_fee_per_gas);
    // the leaked one is exactly the golden tx that went to Base
    let raw = leaked.build_with_signature(&Signature { v: 0, r: strip(&hex::decode(R).unwrap()), s: strip(&hex::decode(S).unwrap()) });
    assert_eq!(format!("0x{}", hex::encode(raw)), RAW);
}

#[test]
fn proof_that_the_stuck_deploy_landed_moves_the_nonce_on() {
    let mut c = contract();
    c.handle_signed(Err(PromiseError::Failed));
    ctx("keyfree.testnet", 30);
    assert!(c.handle_stuck_confirmed(84532, 4, "ab".repeat(32), Ok(json!({ "payload_hash": "x" }))));
    assert!(c.stuck.is_none());
    assert_eq!(c.get_next_nonce(84532), Some(5));
}

#[test]
fn failed_or_stale_proof_keeps_it_stuck() {
    let mut c = contract();
    c.handle_signed(Err(PromiseError::Failed));
    ctx("keyfree.testnet", 30);
    assert!(!c.handle_stuck_confirmed(84532, 4, "ab".repeat(32), Err(PromiseError::Failed)));
    assert!(!c.handle_stuck_confirmed(84532, 3, "ab".repeat(32), Ok(json!({}))));
    assert_eq!(c.stuck.as_ref().map(|p| p.nonce), Some(4));
    assert_eq!(c.get_next_nonce(84532), Some(4));
}

// v6: never sign a gas limit the chain will refuse (that would leave a nonce gap forever).
#[test]
fn intrinsic_gas_matches_known_values() {
    let mut p = pending(); // plain creation, 22-byte init code
    let tx = tx_of(&p);
    let zeros = tx.input.iter().filter(|b| **b == 0).count() as u128;
    let tokens = zeros + 4 * (22 - zeros);
    assert_eq!(intrinsic_gas(&tx), 21_000 + 4 * tokens + 32_000 + 2);
    p.init_code = vec![0xff; 49_152];
    p.salt = Some(vec![1; 32]);
    p.factory = Some(vec![2; 20]);
    // 49 152 non-zero bytes dominate: the EIP-7623 floor (10 per token) wins, about 2 M gas
    assert!(intrinsic_gas(&tx_of(&p)) > 1_960_000);
}

#[test]
#[should_panic(expected = "gas limit below the intrinsic minimum")]
fn too_little_gas_is_refused_before_signing() {
    let mut c = contract();
    c.pending = None;
    ctx("agent.testnet", 20);
    let _ = c.request_deploy(84532, INIT.into(), 21_000, 14_000_000, 1_000_000, None, None);
}

#[test]
fn resign_keeps_nonce_and_content_and_never_moves_the_nonce_back() {
    let mut c = contract();
    c.pending = None;
    let code = hex::decode(INIT).unwrap();
    let mut code_hash = [0u8; 32];
    code_hash.copy_from_slice(&env::keccak256_array(&code));
    c.journal.insert(key(84532, 2), Entry { code_hash, salt: [7; 32], factory: [9; 20], addr: [0; 20], tx_hash: [1; 32], status: SIGNED });
    c.factories.insert(84532, vec![9; 20]);
    ctx("agent.testnet", 20);
    let _ = c.resign(84532, 2, INIT.into(), 300_000, 20_000_000, 1_000_000);
    let p = c.pending.clone().unwrap();
    assert_eq!((p.nonce, p.salt.clone(), p.factory.clone(), p.init_code.clone()), (2, Some(vec![7; 32]), Some(vec![9; 20]), code));
    // the MPC answer for it would not move next_nonce (4) back to 3: checked via the max() rule
    assert_eq!(c.get_next_nonce(84532), Some(4));
}

#[test]
#[should_panic(expected = "init code differs from the journal")]
fn resign_refuses_other_code() {
    let mut c = contract();
    c.pending = None;
    c.journal.insert(key(84532, 2), Entry { code_hash: [3; 32], salt: [7; 32], factory: [9; 20], addr: [0; 20], tx_hash: [1; 32], status: SIGNED });
    ctx("agent.testnet", 20);
    let _ = c.resign(84532, 2, INIT.into(), 300_000, 20_000_000, 1_000_000);
}

// v7: nonce accounting after the second audit (N3 nonce back, N4 foreign proof, N5 Latest).
const SALT: &str = "1111111111111111111111111111111111111111111111111111111111111111";

fn signed_line(c: &mut Keyfree, nonce: u64, status: u8) {
    let mut code_hash = [0u8; 32];
    code_hash.copy_from_slice(&env::keccak256_array(&hex::decode(INIT).unwrap()));
    c.journal.insert(key(84532, nonce), Entry { code_hash, salt: [7; 32], factory: [9; 20], addr: [5; 20], tx_hash: [1; 32], status });
    // the factory the line names is the chain's factory, as on a live policy
    if c.factories.get(&84532).is_none() { c.factories.insert(84532, vec![9; 20]); }
}

fn log_in() -> LogIn { LogIn { log_index: 0, transaction_index: 0, block_hash: "cd".repeat(32), block_number: 1 } }

#[test]
fn proof_of_an_old_stuck_nonce_never_moves_the_nonce_back() {
    let mut c = contract();
    c.pending = None;
    c.stuck = Some(Pending { nonce: 2, ..pending() });
    signed_line(&mut c, 2, REQUESTED);
    ctx("keyfree.testnet", 30);
    assert!(c.handle_stuck_confirmed(84532, 2, "ab".repeat(32), Ok(json!({}))));
    assert_eq!(c.get_next_nonce(84532), Some(4));
}

#[test]
fn failed_resign_leaves_the_signed_deploy_as_it_was() {
    let mut c = contract();
    c.pending = None;
    signed_line(&mut c, 2, SIGNED);
    ctx("agent.testnet", 20);
    let _ = c.resign(84532, 2, INIT.into(), 300_000, 20_000_000, 1_000_000);
    ctx("keyfree.testnet", 21);
    assert_eq!(c.handle_signed(Err(PromiseError::Failed)), None);
    assert!(c.pending.is_none() && c.stuck.is_none(), "a failed re-sign opens nothing");
    let e = c.journal.get(&key(84532, 2)).unwrap();
    assert_eq!((e.status, e.tx_hash), (SIGNED, [1; 32]));
}

#[test]
fn released_resign_does_not_become_stuck() {
    let mut c = contract();
    c.pending = None;
    signed_line(&mut c, 2, SIGNED);
    ctx("agent.testnet", 20);
    let _ = c.resign(84532, 2, INIT.into(), 300_000, 20_000_000, 1_000_000);
    ctx("agent.testnet", 20 + RELEASE_AFTER_BLOCKS + 1);
    c.release();
    assert!(c.pending.is_none() && c.stuck.is_none());
}

#[test]
#[should_panic(expected = "nonce already used on this chain")]
fn new_request_never_overwrites_a_used_nonce() {
    let mut c = contract();
    c.pending = None;
    signed_line(&mut c, 4, CONFIRMED);
    ctx("agent.testnet", 20);
    let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, None, None);
}

#[test]
#[should_panic(expected = "salt and code already used on this chain")]
fn same_salt_and_code_cannot_take_a_second_nonce() {
    let mut c = contract();
    c.pending = None;
    ctx("owner.testnet", 20);
    c.apply_rule_change(&RuleChange::SetFactory { chain_id: 84532, factory_hex: "09".repeat(20) });
    ctx("agent.testnet", 21);
    let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, Some(SALT.into()), Some(true));
    // pretend nonce 4 went through, then a bot repeats the same deploy
    c.pending = None;
    c.next_nonce.insert(84532, 5);
    ctx("agent.testnet", 22);
    let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, Some(SALT.into()), Some(true));
}

#[test]
fn same_salt_and_code_is_fine_on_another_chain() {
    let mut c = contract();
    c.pending = None;
    c.next_nonce.insert(421614, 4);
    ctx("owner.testnet", 20);
    c.apply_rule_change(&RuleChange::SetFactory { chain_id: 84532, factory_hex: "09".repeat(20) });
    c.apply_rule_change(&RuleChange::SetFactory { chain_id: 421614, factory_hex: "09".repeat(20) });
    ctx("agent.testnet", 21);
    let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, Some(SALT.into()), Some(true));
    c.pending = None;
    ctx("agent.testnet", 22);
    let _ = c.request_deploy(421614, INIT.into(), 200_000, 14_000_000, 1_000_000, Some(SALT.into()), Some(true));
    assert_eq!(c.pending.as_ref().map(|p| p.chain_id), Some(421614));
}

#[test]
#[should_panic(expected = "only agent or owner")]
fn stranger_cannot_confirm_stuck() {
    let mut c = contract();
    c.pending = None;
    c.stuck = Some(Pending { salt: Some(vec![7; 32]), factory: Some(vec![9; 20]), ..pending() });
    signed_line(&mut c, 4, REQUESTED);
    ctx("stranger.testnet", 12);
    let _ = c.confirm_stuck(SigIn { r: "ab".repeat(32), s: "cd".repeat(32), v: 0, gas_limit: None, max_fee_per_gas: None, max_priority_fee_per_gas: None }, log_in(), "Finalized".into());
}

#[test]
#[should_panic(expected = "a stuck request needs a Finalized block")]
fn confirm_stuck_refuses_latest() {
    let mut c = contract();
    c.pending = None;
    c.stuck = Some(Pending { salt: Some(vec![7; 32]), factory: Some(vec![9; 20]), ..pending() });
    signed_line(&mut c, 4, REQUESTED);
    ctx("agent.testnet", 12);
    let _ = c.confirm_stuck(SigIn { r: "ab".repeat(32), s: "cd".repeat(32), v: 0, gas_limit: None, max_fee_per_gas: None, max_priority_fee_per_gas: None }, log_in(), "Latest".into());
}

#[test]
#[should_panic(expected = "a stuck request needs a Finalized block")]
fn confirm_stuck_refuses_safe_too() {
    let mut c = contract();
    c.pending = None;
    c.stuck = Some(Pending { salt: Some(vec![7; 32]), factory: Some(vec![9; 20]), ..pending() });
    signed_line(&mut c, 4, REQUESTED);
    ctx("agent.testnet", 12);
    let _ = c.confirm_stuck(SigIn { r: "ab".repeat(32), s: "cd".repeat(32), v: 0, gas_limit: None, max_fee_per_gas: None, max_priority_fee_per_gas: None }, log_in(), "Safe".into());
}

// A stuck factory deploy whose signature (golden R, S) is made to recover to the policy's address.
fn stuck_and_signed() -> Keyfree {
    let mut c = contract();
    c.pending = None;
    let p = Pending { salt: Some(vec![7; 32]), factory: Some(vec![9; 20]), ..pending() };
    let hash = env::keccak256_array(&tx_of(&p).build_for_signing());
    let mut rs = [0u8; 64];
    rs[..32].copy_from_slice(&hex::decode(R).unwrap());
    rs[32..].copy_from_slice(&hex::decode(S).unwrap());
    let pk = env::ecrecover(&hash, &rs, 0, true).unwrap();
    c.eth_address = Some(format!("0x{}", hex::encode(&env::keccak256_array(&pk)[12..])));
    c.stuck = Some(p);
    signed_line(&mut c, 4, REQUESTED);
    c
}

fn golden_sig() -> SigIn { SigIn { r: R.into(), s: S.into(), v: 0, gas_limit: None, max_fee_per_gas: None, max_priority_fee_per_gas: None } }

#[test]
fn confirm_stuck_takes_the_tx_id_from_our_own_signature() {
    let mut c = stuck_and_signed();
    ctx("agent.testnet", 12);
    let _ = c.confirm_stuck(golden_sig(), log_in(), "Finalized".into());
    let p = c.stuck.clone().unwrap();
    let answer = json!({ "big_r": { "affine_point": format!("02{R}") }, "s": { "scalar": S }, "recovery_id": 0 });
    let raw = c.finish(&p, &answer).unwrap();
    let want = hex::encode(env::keccak256_array(&hex::decode(&raw[2..]).unwrap()));
    let asked: Vec<String> = near_sdk::test_utils::get_created_receipts().into_iter().flat_map(|r| r.actions)
        .filter_map(|a| match a { near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"verify_foreign_transaction".to_vec() => Some(String::from_utf8(args).unwrap()), _ => None })
        .collect();
    assert_eq!(asked.len(), 1);
    assert!(asked[0].contains(&want), "the Read MPC request names the tx id rebuilt from the signature");
}

#[test]
#[should_panic(expected = "not our signature of the stuck request")]
fn confirm_stuck_refuses_a_signature_of_other_content() {
    let mut c = stuck_and_signed();
    ctx("agent.testnet", 12);
    let _ = c.confirm_stuck(SigIn { gas_limit: Some(250_000), ..golden_sig() }, log_in(), "Finalized".into());
}

#[test]
#[should_panic(expected = "confirmation needs a Safe or Finalized block")]
fn confirm_refuses_latest() {
    let mut c = idle();
    signed_line(&mut c, 3, SIGNED);
    ctx("agent.testnet", 12);
    let _ = c.confirm(84532, 3, log_in(), "Latest".into());
}

#[test]
fn confirm_stuck_with_finalized_goes_to_read_mpc() {
    let mut c = stuck_and_signed();
    ctx("agent.testnet", 12);
    let _ = c.confirm_stuck(golden_sig(), log_in(), "Finalized".into());
}

// v8: roles (R2, R3, R3a, R5; N1). Delay in contract() is 3600 s.
fn acc(s: &str) -> AccountId { s.parse().unwrap() }

fn idle() -> Keyfree {
    let mut c = contract();
    c.pending = None;
    c
}

#[test]
fn stolen_guardian_cannot_freeze_the_contract_forever() {
    let mut c = idle();
    // the thief holds the guardian key: pause, kill every upgrade, try to block its own replacement
    ctx_at("guardian.testnet", 20, 1_000, vec![]);
    c.pause();
    ctx_at("owner.testnet", 21, 1_000, vec![]);
    c.propose_role(Role::Guardian, acc("guardian2.testnet"));
    ctx_at("reserve.testnet", 22, 1_010, vec![]);
    c.approve_role(acc("owner.testnet"));
    ctx_at("guardian.testnet", 23, 1_020, vec![]);
    c.cancel_role(acc("owner.testnet"));
    assert_eq!(c.role_changes.len(), 1, "one cancel is not enough");
    ctx_at("reserve.testnet", 24, 1_010 + 3_600, vec![]);
    c.apply_role(acc("owner.testnet"));
    assert_eq!(c.guardian, acc("guardian2.testnet"));
    // owner + reserve unpause; the old guardian is out
    ctx_at("owner.testnet", 25, 5_000, vec![]);
    c.unpause();
    ctx_at("reserve.testnet", 26, 5_000, vec![]);
    c.unpause();
    assert!(!c.paused);
}

#[test]
#[should_panic(expected = "only owner, guardian or reserve")]
fn replaced_guardian_cannot_pause_again() {
    let mut c = idle();
    ctx_at("owner.testnet", 21, 1_000, vec![]);
    c.propose_role(Role::Guardian, acc("guardian2.testnet"));
    ctx_at("reserve.testnet", 22, 1_000, vec![]);
    c.approve_role(acc("owner.testnet"));
    ctx_at("owner.testnet", 23, 4_600, vec![]);
    c.apply_role(acc("owner.testnet"));
    ctx_at("guardian.testnet", 24, 4_700, vec![]);
    c.pause();
}

#[test]
#[should_panic(expected = "needs 2 of 3 approvals")]
fn one_key_cannot_change_roles() {
    let mut c = idle();
    ctx_at("owner.testnet", 21, 1_000, vec![]);
    c.propose_role(Role::Guardian, acc("thief.testnet"));
    ctx_at("owner.testnet", 22, 100_000, vec![]);
    c.apply_role(acc("owner.testnet"));
}

#[test]
#[should_panic(expected = "role change delay not over")]
fn owner_and_guardian_together_cannot_skip_the_delay() {
    let mut c = idle();
    ctx_at("owner.testnet", 21, 1_000, vec![]);
    c.propose_role(Role::Reserve, acc("reserve2.testnet"));
    ctx_at("guardian.testnet", 22, 1_000, vec![]);
    c.approve_role(acc("owner.testnet"));
    ctx_at("guardian.testnet", 23, 1_000 + 3_599, vec![]);
    c.apply_role(acc("owner.testnet"));
}

#[test]
fn delay_starts_at_the_second_approval() {
    let mut c = idle();
    ctx_at("owner.testnet", 21, 1_000, vec![]);
    c.propose_role(Role::Reserve, acc("reserve2.testnet"));
    ctx_at("guardian.testnet", 22, 9_000, vec![]);
    c.approve_role(acc("owner.testnet"));
    assert_eq!(c.role_changes[0].ready_at, Some(9_000 + 3_600));
}

#[test]
fn two_of_three_cancel_a_role_change() {
    let mut c = idle();
    // a stolen guardian proposes to put the thief in as reserve; owner and reserve kill it
    ctx_at("guardian.testnet", 21, 1_000, vec![]);
    c.propose_role(Role::Reserve, acc("thief.testnet"));
    ctx_at("owner.testnet", 22, 1_000, vec![]);
    c.cancel_role(acc("guardian.testnet"));
    assert_eq!(c.role_changes.len(), 1);
    ctx_at("reserve.testnet", 23, 1_000, vec![]);
    c.cancel_role(acc("guardian.testnet"));
    assert!(c.role_changes.is_empty());
}

#[test]
#[should_panic(expected = "only agent or owner")]
fn any_council_member_revokes_the_agent_at_once() {
    let mut c = idle();
    ctx("reserve.testnet", 20);
    c.revoke_agent();
    ctx("agent.testnet", 21);
    let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, None, None);
}

#[test]
#[should_panic(expected = "no such role change")]
fn new_agent_is_cancelled_by_one_council_member() {
    let mut c = idle();
    ctx_at("owner.testnet", 21, 1_000, vec![]);
    c.propose_role(Role::Agent, acc("agent2.testnet"));
    ctx_at("guardian.testnet", 22, 1_100, vec![]);
    c.cancel_role(acc("owner.testnet"));
    ctx_at("owner.testnet", 23, 1_000 + 3_600, vec![]);
    c.apply_role(acc("owner.testnet"));
}

#[test]
fn new_agent_works_after_the_delay_and_the_old_one_does_not() {
    let mut c = idle();
    ctx_at("owner.testnet", 21, 1_000, vec![]);
    c.propose_role(Role::Agent, acc("agent2.testnet"));
    ctx_at("owner.testnet", 22, 1_000 + 3_600, vec![]);
    c.apply_role(acc("owner.testnet"));
    assert_eq!(c.agent, Some(acc("agent2.testnet")));
    ctx("agent2.testnet", 23);
    let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, None, None);
    assert!(c.pending.is_some());
}

#[test]
#[should_panic(expected = "only owner proposes a new agent")]
fn guardian_cannot_appoint_an_agent() {
    let mut c = idle();
    ctx("guardian.testnet", 20);
    c.propose_role(Role::Agent, acc("agent2.testnet"));
}

#[test]
#[should_panic(expected = "only owner, guardian or reserve")]
fn agent_cannot_touch_roles() {
    let mut c = idle();
    ctx("agent.testnet", 20);
    c.propose_role(Role::Owner, acc("agent.testnet"));
}

#[test]
#[should_panic(expected = "account already holds another role")]
fn one_account_cannot_hold_two_roles() {
    let mut c = idle();
    ctx("owner.testnet", 20);
    c.propose_role(Role::Guardian, acc("reserve.testnet"));
}

#[test]
fn one_unpause_vote_is_not_enough() {
    let mut c = idle();
    ctx("guardian.testnet", 20);
    c.pause();
    ctx("owner.testnet", 21);
    c.unpause();
    c.unpause(); // the same member twice still counts once
    assert!(c.paused);
    ctx("reserve.testnet", 22);
    c.unpause();
    assert!(!c.paused);
}

#[test]
#[should_panic(expected = "only owner, guardian or reserve")]
fn stranger_cannot_pause() {
    let mut c = idle();
    ctx("stranger.testnet", 20);
    c.pause();
}

#[test]
fn reserve_can_cancel_an_upgrade() {
    let mut c = proposed();
    ctx_at("reserve.testnet", 21, 1_100, vec![]);
    c.cancel_upgrade();
    assert!(c.proposed.is_none());
}

// v9: no side doors (N7, N8, N9; R9, R17, R18).
#[test]
#[should_panic(expected = "a salt needs the factory")]
fn salt_without_the_factory_is_refused() {
    let mut c = idle();
    ctx("agent.testnet", 20);
    let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, Some(SALT.into()), None);
}

#[test]
fn a_signed_plain_create_can_be_resigned() {
    let mut c = idle();
    let mut code_hash = [0u8; 32];
    code_hash.copy_from_slice(&env::keccak256_array(&hex::decode(INIT).unwrap()));
    c.journal.insert(key(84532, 3), Entry { code_hash, salt: [0; 32], factory: [0; 20], addr: [0; 20], tx_hash: [1; 32], status: SIGNED });
    ctx("agent.testnet", 20);
    let _ = c.resign(84532, 3, INIT.into(), 300_000, 20_000_000, 1_000_000);
    let p = c.pending.clone().unwrap();
    assert_eq!((p.nonce, p.salt.clone(), p.factory.clone()), (3, None, None));
    assert_eq!(tx_of(&p).to, None, "still a plain creation");
}

#[test]
#[should_panic(expected = "chain already allowed")]
fn owner_cannot_move_the_nonce_down_by_hand() {
    let mut c = idle();
    signed_line(&mut c, 3, SIGNED);
    ctx("owner.testnet", 20);
    c.propose_rule(RuleChange::AllowChain { chain_id: 84532, next_nonce: 3, min_fee_per_gas: 1_000_000 });
}

#[test]
#[should_panic(expected = "chain already allowed")]
fn a_chain_is_opened_only_once() {
    let mut c = idle();
    ctx("owner.testnet", 20);
    c.apply_rule_change(&RuleChange::AllowChain { chain_id: 421614, next_nonce: 0, min_fee_per_gas: 1_000_000 });
    assert_eq!(c.get_next_nonce(421614), Some(0));
    c.propose_rule(RuleChange::AllowChain { chain_id: 421614, next_nonce: 5, min_fee_per_gas: 1_000_000 });
}

#[test]
#[should_panic(expected = "a chain needs a fee floor above 0")]
fn a_chain_needs_a_fee_floor() {
    let mut c = idle();
    ctx("owner.testnet", 20);
    c.propose_rule(RuleChange::AllowChain { chain_id: 421614, next_nonce: 0, min_fee_per_gas: 0 });
}

#[test]
#[should_panic(expected = "fee below the floor 1000000")]
fn one_wei_fee_is_refused_before_signing() {
    let mut c = idle();
    c.fee_floor.insert(84532, 1_000_000);
    ctx("agent.testnet", 20);
    let _ = c.request_deploy(84532, INIT.into(), 200_000, 1, 1, None, None);
}

#[test]
#[should_panic(expected = "fee below the floor")]
fn resign_also_respects_the_floor() {
    let mut c = idle();
    c.fee_floor.insert(84532, 1_000_000);
    signed_line(&mut c, 2, SIGNED);
    ctx("agent.testnet", 20);
    let _ = c.resign(84532, 2, INIT.into(), 300_000, 999_999, 1);
}

#[test]
fn fee_at_the_floor_is_fine() {
    let mut c = idle();
    c.fee_floor.insert(84532, 1_000_000);
    ctx("agent.testnet", 20);
    let _ = c.request_deploy(84532, INIT.into(), 200_000, 1_000_000, 1, None, None);
    assert!(c.pending.is_some());
}

// Golden vectors (R10, R21; N14). Transactions: viem 2.57.11 serialized the same deploys offline
// (golden_vectors.mjs -> evidence/golden_rlp.json). Init code byte i = (i * 7 + 3) mod 256.
const GOLDEN_FACTORY: &str = "e744243604e31d7be8b76e0c8bdff4ec5f560ffd";

fn golden(nonce: u64, size: usize, factory: bool) -> Pending {
    let init_code: Vec<u8> = (0..size).map(|i| (i * 7 + 3) as u8).collect();
    Pending { chain_id: 84532, nonce, code_hash: hex::encode(env::keccak256_array(&init_code)), gas_limit: 3_000_000,
        max_fee_per_gas: 14_000_000, max_priority_fee_per_gas: 1_000_000, init_code,
        salt: factory.then(|| vec![0x11; 32]), factory: factory.then(|| hex::decode(GOLDEN_FACTORY).unwrap()), since_block: 0 }
}

fn check_golden(p: &Pending, data_keccak: &str, unsigned_len: usize, unsigned_keccak: &str, signed_keccak: &str) {
    let tx = tx_of(p);
    assert_eq!(hex::encode(env::keccak256_array(&tx.input)), data_keccak, "calldata (factory ABI) == viem");
    let unsigned = tx.build_for_signing();
    assert_eq!((unsigned.len(), hex::encode(env::keccak256_array(&unsigned))), (unsigned_len, unsigned_keccak.to_string()), "unsigned RLP == viem");
    let signed = tx.build_with_signature(&Signature { v: 0, r: strip(&hex::decode(R).unwrap()), s: strip(&hex::decode(S).unwrap()) });
    assert_eq!(hex::encode(env::keccak256_array(&signed)), signed_keccak, "signed RLP == viem");
}

#[test]
fn golden_rlp_plain_create_1k_matches_viem() {
    ctx("keyfree.testnet", 10);
    let p = golden(9, 1024, false);
    let data = hex::encode(env::keccak256_array(&p.init_code));
    check_golden(&p, &data, 1051, "0434fb5db70c77ae36a72ad26e8086b587fe3b9fd48bb7501c718806d6f57fa2", "aa349737f12f1a60cca85ebec84cfa500169c4d431fe2f2cf79b6187aea0800e");
}

#[test]
fn golden_rlp_factory_deploy_24k_matches_viem() {
    ctx("keyfree.testnet", 10);
    let p = golden(10, 24 * 1024, true);
    check_golden(&p, &json_case("factory_24k", "data_keccak"), 24723, "19b64afc236f88cda4400fbb4ed66d698442679eb4fc376cdd75901b7d258827", "c78d7f42273fff5aa27c9e6097a6f2cf67cc5f03b465ee1df8f869277760e4e2");
}

#[test]
fn golden_rlp_factory_deploy_48k_matches_viem() {
    ctx("keyfree.testnet", 10);
    let p = golden(11, 48 * 1024, true);
    check_golden(&p, &json_case("factory_48k", "data_keccak"), 49299, "949ae109cfb102c8a2654d04bb130a2be1c8111fa814ec61e0ecb29ca339bcd3", "821328a68dd957888595aadb3d7a3c2f9adfb4ee90af1e8e91106ae05f43ee56");
}

// The rest of a case straight from the viem file, so the test names its source.
fn json_case(name: &str, field: &str) -> String {
    let v: Value = near_sdk::serde_json::from_str(include_str!("../../evidence/golden_rlp.json")).unwrap();
    let c = v["cases"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap();
    c[field].as_str().unwrap().trim_start_matches("0x").to_string()
}

#[test]
fn golden_file_agrees_with_the_constants() {
    for (name, len, unsigned, signed) in [
        ("plain_1k", 1051, "0434fb5db70c77ae36a72ad26e8086b587fe3b9fd48bb7501c718806d6f57fa2", "aa349737f12f1a60cca85ebec84cfa500169c4d431fe2f2cf79b6187aea0800e"),
        ("factory_24k", 24723, "19b64afc236f88cda4400fbb4ed66d698442679eb4fc376cdd75901b7d258827", "c78d7f42273fff5aa27c9e6097a6f2cf67cc5f03b465ee1df8f869277760e4e2"),
        ("factory_48k", 49299, "949ae109cfb102c8a2654d04bb130a2be1c8111fa814ec61e0ecb29ca339bcd3", "821328a68dd957888595aadb3d7a3c2f9adfb4ee90af1e8e91106ae05f43ee56"),
    ] {
        assert_eq!(json_case(name, "unsigned_keccak"), unsigned, "{name}");
        assert_eq!(json_case(name, "signed_keccak"), signed, "{name}");
        let v: Value = near_sdk::serde_json::from_str(include_str!("../../evidence/golden_rlp.json")).unwrap();
        let c = v["cases"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap().clone();
        assert_eq!(c["unsigned_len"].as_u64(), Some(len), "{name}");
    }
}

// Journal: the real confirm of nonce 1 on Base Sepolia (evidence/spike5.log). Read MPC answered CONFIRMED to
// 0532a8f1…7771 and refused the forged log position (block number + 1) with hash 48abe25a…6040.
fn spike5_entry() -> (Entry, [u8; 32], [u8; 32]) {
    let h = |s: &str| -> Vec<u8> { hex::decode(s).unwrap() };
    let mut e = Entry { code_hash: [0; 32], salt: [0; 32], factory: [0; 20], addr: [0; 20], tx_hash: [0; 32], status: SIGNED };
    e.code_hash.copy_from_slice(&h("fb9fb2e46931e8f1035a5e589b31d7d69ea44e15806b1c71dfee37cebbbf6b16"));
    e.salt.copy_from_slice(&h("d65193273a95b04eb6734a4c42e4cbb9b1eb3a6a0d551caa258c6bd6a3623bf5"));
    e.factory.copy_from_slice(&h(GOLDEN_FACTORY));
    e.addr.copy_from_slice(&h("693344d03f64450b09e3a071720aa252fe00fd6b"));
    let mut tx = [0u8; 32]; tx.copy_from_slice(&h("9334ebfef002ccb72b030f76ced239724c61def23b0fc496c9f52427eb3cc6bb"));
    let mut bh = [0u8; 32]; bh.copy_from_slice(&h("224dc0ef1236a0233658c5ca04c80f68d98ace2daf1a5d089488c28c444bb9dc"));
    (e, tx, bh)
}

#[test]
fn golden_payload_hash_of_the_confirmed_base_deploy() {
    ctx("keyfree.testnet", 10);
    let (e, tx, bh) = spike5_entry();
    let log = LogIn { log_index: 0, transaction_index: 2, block_hash: String::new(), block_number: 50141591 };
    assert_eq!(hex::encode(env::sha256_array(&deployed_payload(6, &e, &tx, &log, &bh, 1))), "0532a8f181edbd7caa7b27c1341adcdbee3ff5ddc491d4c9899abe05fcaf7771");
}

#[test]
fn golden_payload_hash_of_the_forged_log_position() {
    ctx("keyfree.testnet", 10);
    let (e, tx, bh) = spike5_entry();
    let log = LogIn { log_index: 0, transaction_index: 2, block_hash: String::new(), block_number: 50141592 };
    assert_eq!(hex::encode(env::sha256_array(&deployed_payload(6, &e, &tx, &log, &bh, 1))), "48abe25a3e1e614ca649bfb1fb7fb2f9f9e48e700bc334ae09ca0a0223096040");
}

// v11: rules (R6, R3a). Widening waits rules_delay_sec (1800 s in contract()) and can be cancelled;
// narrowing is one council member, at once.
fn code_rule() -> RuleChange { RuleChange::AllowCode { code_hash: "ab".repeat(32) } }

#[test]
#[should_panic(expected = "rule delay not over")]
fn new_code_waits_for_the_rules_delay() {
    let mut c = idle();
    ctx_at("owner.testnet", 20, 1_000, vec![]);
    let id = c.propose_rule(code_rule());
    ctx_at("guardian.testnet", 21, 1_000 + 1_799, vec![]);
    c.apply_rule(id);
}

#[test]
fn new_code_is_allowed_after_the_delay() {
    let mut c = idle();
    ctx_at("owner.testnet", 20, 1_000, vec![]);
    let id = c.propose_rule(code_rule());
    assert!(!c.allowed_code.contains(&"ab".repeat(32)), "nothing changes at proposal time");
    ctx_at("reserve.testnet", 21, 1_000 + 1_800, vec![]);
    c.apply_rule(id);
    assert!(c.allowed_code.contains(&"ab".repeat(32)));
    assert!(c.rule_proposals.is_empty());
}

#[test]
#[should_panic(expected = "no such rule proposal")]
fn any_council_member_cancels_a_rule() {
    let mut c = idle();
    ctx_at("owner.testnet", 20, 1_000, vec![]);
    let id = c.propose_rule(code_rule());
    ctx_at("guardian.testnet", 21, 1_100, vec![]);
    c.cancel_rule(id);
    ctx_at("owner.testnet", 22, 1_000 + 1_800, vec![]);
    c.apply_rule(id);
}

#[test]
#[should_panic(expected = "only owner")]
fn agent_cannot_propose_rules() {
    let mut c = idle();
    ctx("agent.testnet", 20);
    c.propose_rule(code_rule());
}

#[test]
#[should_panic(expected = "only owner")]
fn guardian_cannot_propose_rules() {
    let mut c = idle();
    ctx("guardian.testnet", 20);
    c.propose_rule(code_rule());
}

#[test]
#[should_panic(expected = "code not on the allow list")]
fn removing_code_is_immediate() {
    let mut c = idle();
    ctx("reserve.testnet", 20);
    c.remove_code(pending().code_hash);
    ctx("agent.testnet", 21);
    let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, None, None);
}

#[test]
#[should_panic(expected = "only owner, guardian or reserve")]
fn stranger_cannot_narrow_rules() {
    let mut c = idle();
    ctx("stranger.testnet", 20);
    c.disable_chain(84532);
}

#[test]
#[should_panic(expected = "chain is disabled")]
fn disabled_chain_refuses_new_deploys() {
    let mut c = idle();
    ctx("guardian.testnet", 20);
    c.disable_chain(84532);
    ctx("agent.testnet", 21);
    let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, None, None);
}

#[test]
#[should_panic(expected = "chain already allowed")]
fn disabling_a_chain_cannot_be_used_to_reset_its_nonce() {
    let mut c = idle();
    ctx("guardian.testnet", 20);
    c.disable_chain(84532);
    assert_eq!(c.get_next_nonce(84532), Some(4), "the nonce stays");
    ctx("owner.testnet", 21);
    c.propose_rule(RuleChange::AllowChain { chain_id: 84532, next_nonce: 0, min_fee_per_gas: 1 });
}

#[test]
fn a_disabled_chain_comes_back_only_after_the_delay() {
    let mut c = idle();
    ctx_at("guardian.testnet", 20, 1_000, vec![]);
    c.disable_chain(84532);
    ctx_at("owner.testnet", 21, 1_000, vec![]);
    let id = c.propose_rule(RuleChange::EnableChain { chain_id: 84532 });
    ctx_at("owner.testnet", 22, 1_000 + 1_800, vec![]);
    c.apply_rule(id);
    ctx_at("agent.testnet", 23, 3_000, vec![]);
    let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, None, None);
    assert_eq!(c.pending.as_ref().map(|p| p.nonce), Some(4), "same nonce as before");
}

#[test]
#[should_panic(expected = "raising a cap is a rule proposal")]
fn caps_cannot_be_raised_at_once() {
    let mut c = idle();
    ctx("owner.testnet", 20);
    c.lower_limits(6_000_000, 50_000_000_000);
}

#[test]
fn caps_are_lowered_at_once_and_raised_by_proposal() {
    let mut c = idle();
    ctx_at("guardian.testnet", 20, 1_000, vec![]);
    c.lower_limits(1_000_000, 20_000_000_000);
    assert_eq!((c.max_gas_limit, c.max_fee_cap), (1_000_000, 20_000_000_000));
    // a 24 KB runtime needs about 4.9 M gas for the code deposit alone (N10)
    ctx_at("owner.testnet", 21, 1_000, vec![]);
    let id = c.propose_rule(RuleChange::SetLimits { max_gas_limit: 6_000_000, max_fee_cap: 50_000_000_000 });
    ctx_at("owner.testnet", 22, 1_000 + 1_800, vec![]);
    c.apply_rule(id);
    assert_eq!(c.max_gas_limit, 6_000_000);
}

#[test]
#[should_panic(expected = "too many open rule proposals")]
fn a_stolen_owner_key_cannot_fill_the_state_with_proposals() {
    let mut c = idle();
    ctx("owner.testnet", 20);
    for _ in 0..9 { c.propose_rule(code_rule()); }
}

#[test]
#[should_panic(expected = "chain already allowed")]
fn apply_checks_the_rule_again() {
    let mut c = idle();
    ctx_at("owner.testnet", 20, 1_000, vec![]);
    let a = c.propose_rule(RuleChange::AllowChain { chain_id: 421614, next_nonce: 0, min_fee_per_gas: 1 });
    let b = c.propose_rule(RuleChange::AllowChain { chain_id: 421614, next_nonce: 7, min_fee_per_gas: 1 });
    ctx_at("owner.testnet", 21, 1_000 + 1_800, vec![]);
    c.apply_rule(a);
    c.apply_rule(b);
}

#[test]
#[should_panic(expected = "factory must be a 20-byte address")]
fn a_bad_factory_is_refused_at_proposal() {
    let mut c = idle();
    ctx("owner.testnet", 20);
    c.propose_rule(RuleChange::SetFactory { chain_id: 84532, factory_hex: "0x1234".into() });
}

// v12: callbacks read the raw answer (R12, N13). The mock feeds the bytes the MPC would return.
fn ctx_answer(result: near_sdk::PromiseResult) {
    let c = VMContextBuilder::new()
        .current_account_id("keyfree.testnet".parse().unwrap())
        .predecessor_account_id("keyfree.testnet".parse().unwrap())
        .block_height(11)
        .prepaid_gas(Gas::from_tgas(300))
        .build();
    testing_env!(c, near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![result]);
}

fn raw(bytes: &[u8]) -> near_sdk::PromiseResult { near_sdk::PromiseResult::Successful(bytes.to_vec()) }

#[test]
fn raw_golden_answer_still_gives_the_broadcast_tx() {
    let mut c = contract();
    ctx_answer(raw(&near_sdk::serde_json::to_vec(&answer(R, S, 0).unwrap()).unwrap()));
    assert_eq!(c.on_signed().as_deref(), Some(RAW));
}

#[test]
fn odd_raw_answers_never_freeze_the_contract() {
    let cases: Vec<(&str, near_sdk::PromiseResult)> = vec![
        ("empty body", raw(b"")),
        ("not json", raw(b"\xff\x00signature")),
        ("half json", raw(b"{\"big_r\":")),
        ("json null", raw(b"null")),
        ("too long", raw(&vec![b' '; 20_000])),
        ("failed", near_sdk::PromiseResult::Failed),
    ];
    for (name, res) in cases {
        let mut c = contract();
        ctx_answer(res);
        assert_eq!(c.on_signed(), None, "{name}");
        assert!(c.pending.is_none(), "{name}: pending cleared");
        assert_eq!(c.stuck.as_ref().map(|p| p.nonce), Some(4), "{name}: nonce stays bound");
    }
}

#[test]
fn odd_raw_answer_does_not_confirm_the_journal() {
    let mut c = idle();
    signed_line(&mut c, 2, SIGNED);
    ctx_answer(raw(b"not json"));
    assert!(!c.on_confirmed(84532, 2));
    assert_eq!(c.journal.get(&key(84532, 2)).unwrap().status, SIGNED);
}

#[test]
fn odd_raw_answer_does_not_move_a_stuck_nonce() {
    let mut c = contract();
    c.handle_signed(Err(PromiseError::Failed));
    ctx_answer(raw(b""));
    assert!(!c.on_stuck_confirmed(84532, 4, "ab".repeat(32)));
    assert_eq!((c.stuck.as_ref().map(|p| p.nonce), c.get_next_nonce(84532)), (Some(4), Some(4)));
}

#[test]
fn odd_raw_answer_does_not_set_an_address() {
    let mut c = contract();
    c.eth_address = None;
    ctx_answer(raw(b"\x00\x01"));
    assert_eq!(c.on_derived(), None);
    assert!(c.eth_address.is_none());
}

// v13: retire (R29). DeleteAccount refuses more than 10 000 bytes of state, and a missing beneficiary
// loses the NEAR, so: 2 of 3 + full delay, final, sweep in portions, pay a council member who approved.
fn retire_proposed(c: &mut Keyfree) {
    ctx_at("owner.testnet", 20, 1_000, vec![]);
    c.propose_role(Role::Retire, acc("owner.testnet"));
    ctx_at("reserve.testnet", 21, 1_000, vec![]);
    c.approve_role(acc("owner.testnet"));
}

fn retired() -> Keyfree {
    let mut c = idle();
    retire_proposed(&mut c);
    ctx_at("guardian.testnet", 22, 1_000 + 3_600, vec![]);
    c.apply_role(acc("owner.testnet"));
    c
}

#[test]
#[should_panic(expected = "role change delay not over")]
fn retire_waits_the_full_delay() {
    let mut c = idle();
    retire_proposed(&mut c);
    ctx_at("guardian.testnet", 22, 1_000 + 3_599, vec![]);
    c.apply_role(acc("owner.testnet"));
}

#[test]
#[should_panic(expected = "needs 2 of 3 approvals")]
fn one_key_cannot_retire_the_policy() {
    let mut c = idle();
    ctx_at("owner.testnet", 20, 1_000, vec![]);
    c.propose_role(Role::Retire, acc("owner.testnet"));
    ctx_at("owner.testnet", 21, 100_000, vec![]);
    c.apply_role(acc("owner.testnet"));
}

#[test]
#[should_panic(expected = "the beneficiary must be a council member")]
fn the_beneficiary_is_a_council_member() {
    let mut c = idle();
    ctx("owner.testnet", 20);
    c.propose_role(Role::Retire, acc("exchange-deposit.testnet"));
}

#[test]
#[should_panic(expected = "the beneficiary must have approved the retirement")]
fn the_beneficiary_must_have_signed() {
    let mut c = idle();
    ctx_at("owner.testnet", 20, 1_000, vec![]);
    c.propose_role(Role::Retire, acc("guardian.testnet"));
    ctx_at("reserve.testnet", 21, 1_000, vec![]);
    c.approve_role(acc("owner.testnet"));
    ctx_at("owner.testnet", 22, 1_000 + 3_600, vec![]);
    c.apply_role(acc("owner.testnet"));
}

#[test]
fn one_cancel_does_not_stop_a_retirement_two_do() {
    let mut c = idle();
    retire_proposed(&mut c);
    ctx("guardian.testnet", 22);
    c.cancel_role(acc("owner.testnet"));
    assert_eq!(c.role_changes.len(), 1);
    ctx("reserve.testnet", 23);
    c.cancel_role(acc("owner.testnet"));
    assert!(c.role_changes.is_empty());
}

#[test]
fn retiring_is_final() {
    let c = retired();
    assert!(c.paused && c.retiring == Some(acc("owner.testnet")));
    ctx("owner.testnet", 30);
    for (name, r) in [
        ("unpause", std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let mut c = retired(); ctx("owner.testnet", 30); c.unpause(); }))),
        ("rule", std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let mut c = retired(); ctx("owner.testnet", 30); c.propose_rule(code_rule()); }))),
        ("upgrade", std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let mut c = retired(); ctx_pay("owner.testnet", 30, 9_000, CODE.to_vec(), 100); c.propose_upgrade(); }))),
        ("role", std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let mut c = retired(); ctx("owner.testnet", 30); c.propose_role(Role::Guardian, acc("g2.testnet")); }))),
        ("deploy", std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let mut c = retired(); ctx("agent.testnet", 30); let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, None, None); }))),
    ] {
        assert!(r.is_err(), "{name} must be refused while retiring");
    }
}

#[test]
#[should_panic(expected = "the policy is not retiring")]
fn sweep_only_after_the_decision() {
    let mut c = idle();
    ctx("owner.testnet", 20);
    c.sweep(10);
}

#[test]
#[should_panic(expected = "only owner, guardian or reserve")]
fn stranger_cannot_sweep() {
    let mut c = retired();
    ctx("stranger.testnet", 30);
    c.sweep(10);
}

#[test]
#[should_panic(expected = "sweep first")]
fn the_account_is_not_deleted_before_the_sweep() {
    let mut c = retired();
    ctx("owner.testnet", 30);
    let _ = c.finish_retire();
}

fn flush_all(c: &mut Keyfree) {
    c.journal.flush();
    c.used_salts.flush();
    c.next_nonce.flush();
    c.fee_floor.flush();
    c.factories.flush();
    c.allowed_code.flush();
    c.disabled_chains.flush();
    c.proxy_journal.flush();
    c.allowed_upgrades.flush();
    c.budgets.flush();
    c.spent.flush();
}

// The mock counts storage from a fake base (300 KB) reset by every new context, so the test measures
// bytes added and freed inside one context, plus the size of the main state that stays.
#[test]
fn sweep_empties_the_state_then_the_free_near_goes_to_the_beneficiary() {
    let mut c = idle();
    flush_all(&mut c);
    let base = env::storage_usage();
    for n in 0..200 { signed_line(&mut c, 100 + n, CONFIRMED); }
    for n in 0..200u64 { c.used_salts.insert(env::keccak256_array(&n.to_le_bytes()), n); }
    flush_all(&mut c);
    let added = env::storage_usage() - base;
    assert!(added > 10_000, "a busy policy is over the DeleteAccount limit: {added} bytes of collections");
    retire_proposed(&mut c);
    ctx_at("guardian.testnet", 22, 1_000 + 3_600, vec![]);
    c.apply_role(acc("owner.testnet"));
    ctx("guardian.testnet", 30);
    let before = env::storage_usage();
    let mut rounds = 0;
    while c.sweep(150) > 0 { rounds += 1; assert!(rounds < 10); }
    flush_all(&mut c);
    let freed = before - env::storage_usage();
    assert!(freed >= added, "sweep freed {freed} of {added} bytes");
    let main_state = near_sdk::borsh::to_vec(&c).unwrap().len();
    assert!(main_state < 5_000, "what stays is only the main state: {main_state} bytes");
    let locked = (env::storage_usage() as u128 + 1_000) * env::storage_byte_cost().as_yoctonear();
    let free = env::account_balance().as_yoctonear() - locked;
    let _ = c.finish_retire();
    let receipts = near_sdk::test_utils::get_created_receipts();
    assert!(receipts.iter().flat_map(|r| r.actions.iter()).all(|a| !matches!(a, near_sdk::mock::MockAction::DeleteAccount { .. })),
        "the account is never deleted: its name, and with it the EVM address, must never be free again");
    let paid: Vec<_> = receipts.iter().filter(|r| r.receiver_id == acc("owner.testnet"))
        .flat_map(|r| r.actions.iter())
        .filter_map(|a| match a { near_sdk::mock::MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()), _ => None })
        .collect();
    assert_eq!(paid.len(), 1, "the free NEAR goes to the beneficiary");
    assert_eq!(paid[0], free, "only what the storage does not need");
}

// Attack bench additions (attacks/catalog.json maps every attack to a test).
fn with_arg(arg: u8) -> Vec<u8> {
    let mut v = hex::decode(INIT).unwrap();
    v.extend([0u8; 31]);
    v.push(arg);
    v
}

#[test]
#[should_panic(expected = "code not on the allow list")]
fn other_constructor_arguments_are_other_code() {
    // the owner allowed the contract with argument 1 (say, the treasury); the agent asks for argument 2 (the attacker)
    let mut c = idle();
    c.allowed_code.insert(hex::encode(env::keccak256_array(&with_arg(1))));
    ctx("agent.testnet", 20);
    let _ = c.request_deploy(84532, hex::encode(with_arg(2)), 300_000, 14_000_000, 1_000_000, None, None);
}

#[test]
fn the_allowed_arguments_do_pass() {
    let mut c = idle();
    c.allowed_code.insert(hex::encode(env::keccak256_array(&with_arg(1))));
    ctx("agent.testnet", 20);
    let _ = c.request_deploy(84532, hex::encode(with_arg(1)), 300_000, 14_000_000, 1_000_000, None, None);
    assert!(c.pending.is_some());
}

#[test]
#[should_panic(expected = "gas limit over the cap")]
fn gas_over_the_cap_is_refused() {
    let mut c = idle();
    ctx("agent.testnet", 20);
    let _ = c.request_deploy(84532, INIT.into(), 3_000_001, 14_000_000, 1_000_000, None, None);
}

#[test]
#[should_panic(expected = "gas price over the cap")]
fn fee_over_the_cap_is_refused() {
    let mut c = idle();
    ctx("agent.testnet", 20);
    let _ = c.request_deploy(84532, INIT.into(), 300_000, 50_000_000_001, 1_000_000, None, None);
}

#[test]
#[should_panic(expected = "chain not allowed")]
fn a_chain_that_was_never_allowed_is_refused() {
    let mut c = idle();
    ctx("agent.testnet", 20);
    let _ = c.request_deploy(1, INIT.into(), 300_000, 14_000_000, 1_000_000, None, None);
}

#[test]
fn no_signed_transaction_ever_sends_value() {
    let mut c = idle();
    ctx("owner.testnet", 20);
    c.apply_rule_change(&RuleChange::SetFactory { chain_id: 84532, factory_hex: "09".repeat(20) });
    ctx("agent.testnet", 21);
    let _ = c.request_deploy(84532, INIT.into(), 300_000, 14_000_000, 1_000_000, None, None);
    assert_eq!(tx_of(c.pending.as_ref().unwrap()).value, 0, "plain creation");
    c.pending = None;
    c.next_nonce.insert(84532, 5);
    ctx("agent.testnet", 22);
    let _ = c.request_deploy(84532, INIT.into(), 300_000, 14_000_000, 1_000_000, Some(SALT.into()), Some(true));
    assert_eq!(tx_of(c.pending.as_ref().unwrap()).value, 0, "through the factory");
}

#[test]
#[should_panic(expected = "only owner")]
fn agent_cannot_propose_an_upgrade() {
    let mut c = idle();
    ctx_pay("agent.testnet", 20, 1_000, CODE.to_vec(), 100);
    c.propose_upgrade();
}

#[test]
#[should_panic(expected = "only agent or owner")]
fn stranger_cannot_request_a_deploy() {
    let mut c = idle();
    ctx("stranger.testnet", 20);
    let _ = c.request_deploy(84532, INIT.into(), 300_000, 14_000_000, 1_000_000, None, None);
}

#[test]
#[should_panic(expected = "code not on the allow list")]
fn code_that_was_never_allowed_is_refused() {
    let mut c = idle();
    ctx("agent.testnet", 20);
    let _ = c.request_deploy(84532, "6000".into(), 300_000, 14_000_000, 1_000_000, None, None);
}

// v14: proxy upgrades. The council allows one upgradeTo(implementation) on one proxy through the rules delay;
// the agent's request uses it up; the policy builds the call itself and Read MPC confirms the Upgraded log.
const PROXY: &str = "2222222222222222222222222222222222222222";
const IMPL_V2: &str = "3333333333333333333333333333333333333333";
const IMPL_V1: &str = "4444444444444444444444444444444444444444";
const IMPL_EVIL: &str = "5555555555555555555555555555555555555555";

fn upgrade_rule(implementation: &str) -> RuleChange {
    RuleChange::AllowProxyUpgrade { chain_id: 84532, proxy_hex: format!("0x{PROXY}"), implementation_hex: format!("0x{implementation}") }
}

// The council allowed proxy -> v2 (the rule ran its delay).
fn upgrade_allowed() -> Keyfree {
    let mut c = idle();
    ctx_at("owner.testnet", 20, 1_000, vec![]);
    let id = c.propose_rule(upgrade_rule(IMPL_V2));
    ctx_at("guardian.testnet", 21, 1_000 + 1_800, vec![]);
    c.apply_rule(id);
    c
}

fn request_upgrade(c: &mut Keyfree, implementation: &str) {
    ctx("agent.testnet", 30);
    let _ = c.request_proxy_upgrade(84532, PROXY.into(), implementation.into(), 100_000, 14_000_000, 1_000_000);
}

// A signature over the pending proxy upgrade that recovers to the policy's address: the golden R and s
// recover to some key for any hash, so the test makes that key the policy's.
fn sign_pending_as_the_policy(c: &mut Keyfree) {
    let hash = env::keccak256_array(&tx_of(c.pending.as_ref().unwrap()).build_for_signing());
    let mut rs = [0u8; 64];
    rs[..32].copy_from_slice(&hex::decode(R).unwrap());
    rs[32..].copy_from_slice(&hex::decode(S).unwrap());
    let pk = env::ecrecover(&hash, &rs, 0, true).unwrap();
    c.eth_address = Some(format!("0x{}", hex::encode(&env::keccak256_array(&pk)[12..])));
    assert!(c.handle_signed(answer(R, S, 0)).is_some());
}

#[test]
fn golden_rlp_proxy_upgrade_matches_viem() {
    ctx("keyfree.testnet", 10);
    let p = proxy_pending(84532, 12, &[0x22; 20], &[0x33; 20], 100_000, 14_000_000, 1_000_000);
    assert_eq!(format!("0x{}", hex::encode(&p.init_code)), format!("0x{}", json_case("proxy_upgrade", "data")), "upgradeTo calldata == viem");
    check_golden(&p, &json_case("proxy_upgrade", "data_keccak"), 80, &json_case("proxy_upgrade", "unsigned_keccak"), &json_case("proxy_upgrade", "signed_keccak"));
}

#[test]
#[should_panic(expected = "rule delay not over")]
fn a_proxy_upgrade_waits_for_the_rules_delay() {
    let mut c = idle();
    ctx_at("owner.testnet", 20, 1_000, vec![]);
    let id = c.propose_rule(upgrade_rule(IMPL_V2));
    ctx_at("owner.testnet", 21, 1_000 + 1_799, vec![]);
    c.apply_rule(id);
}

#[test]
fn the_allowed_upgrade_is_signed_as_a_call_built_by_the_policy() {
    let mut c = upgrade_allowed();
    request_upgrade(&mut c, IMPL_V2);
    let tx = tx_of(c.pending.as_ref().unwrap());
    assert_eq!(tx.to, Some(<[u8; 20]>::try_from(hex::decode(PROXY).unwrap()).unwrap()));
    assert_eq!(hex::encode(&tx.input), format!("3659cfe6{}{IMPL_V2}", "00".repeat(12)), "upgradeTo(v2), nothing else");
    assert_eq!((tx.value, tx.nonce), (0, 4));
    assert_eq!(c.get_entry(84532, 4).unwrap()["kind"], "proxy_upgrade");
}

#[test]
#[should_panic(expected = "proxy upgrade not on the allow list")]
fn another_implementation_is_refused() {
    let mut c = upgrade_allowed();
    request_upgrade(&mut c, IMPL_EVIL);
}

#[test]
#[should_panic(expected = "proxy upgrade not on the allow list")]
fn another_proxy_is_refused() {
    let mut c = upgrade_allowed();
    ctx("agent.testnet", 30);
    let _ = c.request_proxy_upgrade(84532, "66".repeat(20), IMPL_V2.into(), 100_000, 14_000_000, 1_000_000);
}

#[test]
#[should_panic(expected = "proxy upgrade not on the allow list")]
fn the_same_upgrade_cannot_be_signed_twice() {
    let mut c = upgrade_allowed();
    request_upgrade(&mut c, IMPL_V2);
    sign_pending_as_the_policy(&mut c);
    request_upgrade(&mut c, IMPL_V2);
}

#[test]
#[should_panic(expected = "proxy upgrade not on the allow list")]
fn going_back_to_the_old_version_needs_its_own_rule() {
    let mut c = upgrade_allowed();
    request_upgrade(&mut c, IMPL_V2);
    sign_pending_as_the_policy(&mut c);
    request_upgrade(&mut c, IMPL_V1);
}

#[test]
#[should_panic(expected = "only owner")]
fn the_agent_cannot_allow_an_upgrade() {
    let mut c = idle();
    ctx("agent.testnet", 20);
    c.propose_rule(upgrade_rule(IMPL_EVIL));
}

#[test]
#[should_panic(expected = "proxy upgrade not on the allow list")]
fn any_council_member_removes_an_allowed_upgrade_at_once() {
    let mut c = upgrade_allowed();
    ctx("reserve.testnet", 25);
    c.remove_proxy_upgrade(84532, PROXY.into(), IMPL_V2.into());
    request_upgrade(&mut c, IMPL_V2);
}

#[test]
#[should_panic(expected = "only agent or owner")]
fn a_stranger_cannot_request_a_proxy_upgrade() {
    let mut c = upgrade_allowed();
    ctx("stranger.testnet", 30);
    let _ = c.request_proxy_upgrade(84532, PROXY.into(), IMPL_V2.into(), 100_000, 14_000_000, 1_000_000);
}

#[test]
#[should_panic(expected = "paused")]
fn pause_also_stops_proxy_upgrades() {
    let mut c = upgrade_allowed();
    ctx("guardian.testnet", 25);
    c.pause();
    request_upgrade(&mut c, IMPL_V2);
}

#[test]
#[should_panic(expected = "proxy and implementation must be two real addresses")]
fn a_zero_implementation_is_refused_at_proposal() {
    let mut c = idle();
    ctx("owner.testnet", 20);
    c.propose_rule(upgrade_rule(&"00".repeat(20)));
}

#[test]
fn a_signed_proxy_upgrade_moves_the_nonce_and_its_journal_line() {
    let mut c = upgrade_allowed();
    request_upgrade(&mut c, IMPL_V2);
    sign_pending_as_the_policy(&mut c);
    assert_eq!(c.get_next_nonce(84532), Some(5));
    let e = c.get_entry(84532, 4).unwrap();
    assert_eq!((e["status"].as_str(), e["implementation"].as_str()), (Some("signed"), Some(format!("0x{IMPL_V2}").as_str())));
}

#[test]
#[should_panic(expected = "nonce already used on this chain")]
fn a_deploy_never_takes_the_nonce_of_a_proxy_upgrade() {
    let mut c = upgrade_allowed();
    request_upgrade(&mut c, IMPL_V2);
    c.pending = None; // as if the answer never came and the line stayed
    ctx("agent.testnet", 31);
    let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, None, None);
}

#[test]
fn a_failed_proxy_upgrade_stays_bound_and_retry_signs_the_same_call() {
    let mut c = upgrade_allowed();
    request_upgrade(&mut c, IMPL_V2);
    let first = tx_of(c.pending.as_ref().unwrap());
    c.handle_signed(Err(PromiseError::Failed));
    ctx("agent.testnet", 32);
    let _ = c.retry(20_000_000, 1_000_000);
    let again = tx_of(c.pending.as_ref().unwrap());
    assert_eq!((first.nonce, first.to, first.input.clone()), (again.nonce, again.to, again.input.clone()));
}

#[test]
fn resign_of_a_proxy_upgrade_keeps_the_call() {
    let mut c = upgrade_allowed();
    request_upgrade(&mut c, IMPL_V2);
    let first = tx_of(c.pending.as_ref().unwrap());
    sign_pending_as_the_policy(&mut c);
    ctx("agent.testnet", 33);
    let _ = c.resign_proxy_upgrade(84532, 4, 120_000, 30_000_000, 2_000_000);
    let again = tx_of(c.pending.as_ref().unwrap());
    assert_eq!((first.nonce, first.to, first.input.clone()), (again.nonce, again.to, again.input.clone()));
    assert_eq!(again.gas_limit, 120_000);
}

#[test]
#[should_panic(expected = "only a signed, unconfirmed proxy upgrade can be re-signed")]
fn a_requested_proxy_upgrade_cannot_be_resigned() {
    let mut c = upgrade_allowed();
    request_upgrade(&mut c, IMPL_V2);
    c.pending = None;
    ctx("agent.testnet", 33);
    let _ = c.resign_proxy_upgrade(84532, 4, 120_000, 30_000_000, 2_000_000);
}

#[test]
fn read_mpc_answer_confirms_the_proxy_upgrade() {
    let mut c = upgrade_allowed();
    request_upgrade(&mut c, IMPL_V2);
    sign_pending_as_the_policy(&mut c);
    ctx("agent.testnet", 34);
    let _ = c.confirm(84532, 4, log_in(), "Safe".into());
    ctx_answer(raw(b"{\"payload_hash\":\"x\"}"));
    assert!(c.on_confirmed(84532, 4));
    assert_eq!(c.get_entry(84532, 4).unwrap()["status"], "confirmed");
}

#[test]
fn the_upgraded_log_names_the_proxy_and_the_implementation() {
    ctx("keyfree.testnet", 10);
    let u = |imp: u8| ProxyEntry { proxy: [0x22; 20], implementation: [imp; 20], tx_hash: [1; 32], status: SIGNED };
    let l = log_in();
    let p = upgraded_payload(6, &u(0x33), &[1; 32], &l, &[0xcd; 32], 1);
    let has = |needle: &[u8]| p.windows(needle.len()).any(|w| w == needle);
    assert!(has(&[0x22; 20]) && has(&env::keccak256_array(b"Upgraded(address)")) && has(&topic(&[0x33; 20])));
    assert!(has(b"\x02\x00\x00\x000x"), "no data: the string \"0x\"");
    assert_ne!(env::sha256_array(&p), env::sha256_array(&upgraded_payload(6, &u(0x55), &[1; 32], &l, &[0xcd; 32], 1)), "another implementation, another hash");
}

// The live treasury upgrade on Base Sepolia (evidence/v14.log): Read MPC CONFIRMED expected hash 6d4522da…0f89 and
// refused the forged position (block number + 1) with a94b80b0…6c34.
fn live_upgrade() -> (ProxyEntry, [u8; 32], [u8; 32]) {
    let h = |s: &str| -> Vec<u8> { hex::decode(s).unwrap() };
    let mut u = ProxyEntry { proxy: [0; 20], implementation: [0; 20], tx_hash: [0; 32], status: SIGNED };
    u.proxy.copy_from_slice(&h("5319b76fda54f4144d6b134016f6415ad169dfaa"));
    u.implementation.copy_from_slice(&h("269bdae85a7864e882bdd97d61fc5bc084594060"));
    let mut tx = [0u8; 32]; tx.copy_from_slice(&h("d9673701797e62a2a4c4853bbc6574ceea5956f21ff0abcf0e6500caff2b1f25"));
    let mut bh = [0u8; 32]; bh.copy_from_slice(&h("34b322b5ebe297954f593718b1c52f316f3872588c1f95813e7f8aace4f3840d"));
    (u, tx, bh)
}

#[test]
fn golden_payload_hash_of_the_confirmed_treasury_upgrade() {
    ctx("keyfree.testnet", 10);
    let (u, tx, bh) = live_upgrade();
    let real = LogIn { log_index: 0, transaction_index: 2, block_hash: String::new(), block_number: 51962615 };
    assert_eq!(hex::encode(env::sha256_array(&upgraded_payload(6, &u, &tx, &real, &bh, 1))), "6d4522daea0ef726ccd5afefd0b18435d31b1714f82b6339e3b89e03c2e30f89");
    let forged = LogIn { block_number: 51962616, ..real };
    assert_eq!(hex::encode(env::sha256_array(&upgraded_payload(6, &u, &tx, &forged, &bh, 1))), "a94b80b0e5fcfd71f62023d7b546619e2f6395d190c7599c43e2742bfbe86c34");
}

#[test]
fn migrate_reads_the_v13_state() {
    let c = contract();
    let old = V13 {
        owner: c.owner, agent: c.agent, mpc: c.mpc, path: c.path, eth_address: c.eth_address, allowed_code: c.allowed_code,
        next_nonce: c.next_nonce, max_gas_limit: c.max_gas_limit, max_fee_cap: c.max_fee_cap, pending: None, stuck: c.stuck,
        factories: c.factories, journal: c.journal, guardian: c.guardian, upgrade_delay_sec: c.upgrade_delay_sec,
        proposed: Some(("ab".repeat(32), 5)), paused: c.paused, version: 3, used_salts: c.used_salts, fee_floor: c.fee_floor,
        reserve: c.reserve, role_changes: c.role_changes, unpause_votes: c.unpause_votes, proposed_code: c.proposed_code,
        rules_delay_sec: c.rules_delay_sec, rule_proposals: c.rule_proposals, next_rule_id: 7, disabled_chains: c.disabled_chains,
        retiring: None,
    };
    let mut old = old;
    old.allowed_code.flush();
    old.next_nonce.flush();
    env::state_write(&old);
    ctx("keyfree.testnet", 11);
    let mut s = Keyfree::migrate();
    assert_eq!((s.version, s.next_rule_id, s.proposed.clone()), (4, 7, None));
    assert_eq!((s.owner.as_str(), s.get_eth_address()), ("owner.testnet", Some(ADDR.to_string())));
    assert!(s.allowed_code.contains(&pending().code_hash) && s.allowed_upgrades.is_empty() && s.proxy_journal.is_empty());
    // and the new rule works on the migrated state
    ctx_at("owner.testnet", 20, 1_000, vec![]);
    let id = s.propose_rule(upgrade_rule(IMPL_V2));
    ctx_at("owner.testnet", 21, 1_000 + 1_800, vec![]);
    s.apply_rule(id);
    assert_eq!(s.allowed_upgrades.len(), 1);
}

#[test]
fn sweep_also_empties_the_proxy_upgrades() {
    let mut c = upgrade_allowed();
    request_upgrade(&mut c, IMPL_V2);
    sign_pending_as_the_policy(&mut c);
    ctx_at("owner.testnet", 40, 9_000, vec![]);
    let id = c.propose_rule(upgrade_rule(IMPL_V1));
    ctx_at("owner.testnet", 41, 9_000 + 1_800, vec![]);
    c.apply_rule(id);
    assert_eq!((c.proxy_journal.len(), c.allowed_upgrades.len()), (1, 1));
    retire_proposed(&mut c);
    ctx_at("guardian.testnet", 22, 1_000 + 3_600, vec![]);
    c.apply_role(acc("owner.testnet"));
    ctx("guardian.testnet", 50);
    while c.sweep(100) > 0 {}
    assert_eq!((c.proxy_journal.len(), c.allowed_upgrades.len()), (0, 0));
}

// v15: a daily budget per chain (R8). 200 000 gas x 14 gwei-ish fee = 2.8e12 wei at most per test deploy.
const ONE: u128 = 200_000 * 14_000_000;

fn budget_rule(wei: u128, txs: u32) -> RuleChange { RuleChange::SetBudget { chain_id: 84532, max_wei_per_day: wei, max_tx_per_day: txs } }

// The council set a budget for Base Sepolia (the rule ran its delay).
fn budgeted(wei: u128, txs: u32) -> Keyfree {
    let mut c = idle();
    ctx_at("owner.testnet", 20, 1_000, vec![]);
    let id = c.propose_rule(budget_rule(wei, txs));
    ctx_at("guardian.testnet", 21, 1_000 + 1_800, vec![]);
    c.apply_rule(id);
    c
}

// One signed deploy at `secs`: the request goes out, then the nonce moves on as after a signature.
fn spend(c: &mut Keyfree, secs: u64) {
    ctx_at("agent.testnet", 30, secs, vec![]);
    let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, None, None);
    let n = c.pending.take().unwrap().nonce;
    c.next_nonce.insert(84532, n + 1);
}

#[test]
fn without_a_budget_only_the_caps_apply() {
    let mut c = idle();
    for _ in 0..5 { spend(&mut c, 5_000); }
    assert!(c.get_budget(84532).is_none());
}

#[test]
#[should_panic(expected = "rule delay not over")]
fn a_budget_waits_for_the_rules_delay() {
    let mut c = idle();
    ctx_at("owner.testnet", 20, 1_000, vec![]);
    let id = c.propose_rule(budget_rule(ONE * 10, 10));
    ctx_at("owner.testnet", 21, 1_000 + 1_799, vec![]);
    c.apply_rule(id);
}

#[test]
#[should_panic(expected = "only owner")]
fn the_agent_cannot_set_a_budget() {
    let mut c = idle();
    ctx("agent.testnet", 20);
    c.propose_rule(budget_rule(ONE * 1_000, 1_000));
}

#[test]
#[should_panic(expected = "a budget must be above 0")]
fn a_zero_budget_is_refused_at_proposal() {
    let mut c = idle();
    ctx("owner.testnet", 20);
    c.propose_rule(budget_rule(ONE, 0));
}

#[test]
#[should_panic(expected = "daily limit on chain 84532")]
fn the_daily_transaction_limit_refuses_the_next_one() {
    let mut c = budgeted(ONE * 100, 2);
    spend(&mut c, 5_000);
    spend(&mut c, 5_000);
    spend(&mut c, 5_000);
}

#[test]
#[should_panic(expected = "daily gas budget on chain 84532")]
fn the_daily_gas_budget_counts_the_most_each_can_cost() {
    let mut c = budgeted(ONE * 2, 100);
    spend(&mut c, 5_000);
    spend(&mut c, 5_000);
    let b = c.get_budget(84532).unwrap();
    assert_eq!((b["used_wei_today"].as_str().unwrap(), b["used_tx_today"].as_u64().unwrap()), ((ONE * 2).to_string().as_str(), 2));
    spend(&mut c, 5_000);
}

#[test]
fn a_new_utc_day_starts_from_zero() {
    let mut c = budgeted(ONE, 1);
    spend(&mut c, 5_000);
    spend(&mut c, 86_400 + 5);
    assert_eq!(c.get_budget(84532).unwrap()["used_tx_today"], 1);
}

#[test]
#[should_panic(expected = "daily limit on chain 84532")]
fn a_preview_shows_the_refusal_too() {
    let mut c = budgeted(ONE, 1);
    spend(&mut c, 5_000);
    ctx_at("agent.testnet", 31, 5_000, vec![]);
    c.preview(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, None, None);
}

#[test]
#[should_panic(expected = "daily limit on chain 84532")]
fn a_retry_counts_against_the_budget() {
    let mut c = budgeted(ONE * 10, 1);
    ctx_at("agent.testnet", 30, 5_000, vec![]);
    let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, None, None);
    c.handle_signed(Err(PromiseError::Failed));
    ctx_at("agent.testnet", 31, 5_000, vec![]);
    let _ = c.retry(20_000_000, 1_000_000);
}

#[test]
#[should_panic(expected = "daily limit on chain 84532")]
fn proxy_upgrades_count_against_the_budget() {
    let mut c = upgrade_allowed();
    ctx_at("owner.testnet", 22, 3_000, vec![]);
    let id = c.propose_rule(budget_rule(ONE * 10, 1));
    ctx_at("owner.testnet", 23, 3_000 + 1_800, vec![]);
    c.apply_rule(id);
    spend(&mut c, 5_000);
    request_upgrade(&mut c, IMPL_V2);
}

#[test]
fn any_council_member_lowers_a_budget_at_once() {
    let mut c = budgeted(ONE * 10, 10);
    ctx("reserve.testnet", 40);
    c.lower_budget(84532, ONE, 1);
    let b = c.get_budget(84532).unwrap();
    assert_eq!((b["max_wei_per_day"].as_str().unwrap(), b["max_tx_per_day"].as_u64().unwrap()), (ONE.to_string().as_str(), 1));
}

#[test]
#[should_panic(expected = "raising a budget is a rule proposal")]
fn lower_budget_cannot_raise_it() {
    let mut c = budgeted(ONE * 10, 10);
    ctx("owner.testnet", 40);
    c.lower_budget(84532, ONE * 10, 11);
}

#[test]
#[should_panic(expected = "only owner, guardian or reserve")]
fn the_agent_cannot_lower_or_touch_a_budget() {
    let mut c = budgeted(ONE * 10, 10);
    ctx("agent.testnet", 40);
    c.lower_budget(84532, ONE, 1);
}

#[test]
fn migrate_reads_the_v14_layout() {
    let mut c = idle();
    flush_all(&mut c);
    let codes = c.allowed_code.len();
    let old = V14 {
        owner: c.owner, agent: c.agent, mpc: c.mpc, path: c.path, eth_address: c.eth_address, allowed_code: c.allowed_code,
        next_nonce: c.next_nonce, max_gas_limit: c.max_gas_limit, max_fee_cap: c.max_fee_cap, pending: c.pending, stuck: c.stuck,
        factories: c.factories, journal: c.journal, guardian: c.guardian, upgrade_delay_sec: c.upgrade_delay_sec, proposed: c.proposed,
        paused: c.paused, version: 3, used_salts: c.used_salts, fee_floor: c.fee_floor, reserve: c.reserve, role_changes: c.role_changes,
        unpause_votes: c.unpause_votes, proposed_code: c.proposed_code, rules_delay_sec: c.rules_delay_sec, rule_proposals: c.rule_proposals,
        next_rule_id: c.next_rule_id, disabled_chains: c.disabled_chains, retiring: c.retiring, allowed_upgrades: c.allowed_upgrades,
        proxy_journal: c.proxy_journal,
    };
    env::state_write(&old);
    ctx("keyfree.testnet", 50);
    let s = Keyfree::migrate();
    assert_eq!((s.version, s.allowed_code.len(), s.next_nonce.get(&84532).copied()), (4, codes, Some(4)));
    assert!(s.budgets.is_empty() && s.get_budget(84532).is_none());
}

// v16: review findings X4 and X10.
#[test]
#[should_panic(expected = "code not on the allow list")]
fn retry_stops_when_the_code_was_removed() {
    let mut c = contract();
    c.handle_signed(Err(PromiseError::Failed));
    signed_line(&mut c, 4, REQUESTED);
    ctx("guardian.testnet", 20);
    c.remove_code(pending().code_hash);
    ctx("agent.testnet", 21);
    let _ = c.retry(20_000_000, 1_000_000);
}

#[test]
#[should_panic(expected = "chain disabled")]
fn retry_stops_when_the_chain_was_disabled() {
    let mut c = contract();
    c.handle_signed(Err(PromiseError::Failed));
    ctx("reserve.testnet", 20);
    c.disable_chain(84532);
    ctx("agent.testnet", 21);
    let _ = c.retry(20_000_000, 1_000_000);
}

#[test]
#[should_panic(expected = "gas limit over the cap")]
fn retry_stops_when_the_gas_cap_was_lowered() {
    let mut c = contract();
    c.handle_signed(Err(PromiseError::Failed));
    ctx("guardian.testnet", 20);
    c.lower_limits(100_000, 50_000_000_000);
    ctx("agent.testnet", 21);
    let _ = c.retry(20_000_000, 1_000_000);
}

#[test]
#[should_panic(expected = "code not on the allow list")]
fn resign_stops_when_the_code_was_removed() {
    let mut c = idle();
    c.journal.insert(key(84532, 3), Entry { code_hash: env::keccak256_array(&hex::decode(INIT).unwrap()), salt: [0; 32], factory: [0; 20], addr: [0; 20], tx_hash: [1; 32], status: SIGNED });
    ctx("owner.testnet", 20);
    c.remove_code(pending().code_hash);
    ctx("agent.testnet", 21);
    let _ = c.resign(84532, 3, INIT.into(), 200_000, 20_000_000, 1_000_000);
}

#[test]
fn get_open_names_the_chain() {
    let c = contract();
    assert_eq!(c.get_open()["chain_id"], 84532);
    assert_eq!(c.get_open()["pending"], 4);
}

// Property tests (P4): thousands of random sequences checked against invariants. A fixed-seed generator makes a
// failure replay exactly; no new dependencies (xorshift and catch_unwind), the policy code is unchanged.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 { let mut x = self.0; x ^= x << 13; x ^= x >> 7; x ^= x << 17; self.0 = x; x }
    fn below(&mut self, n: u64) -> u64 { self.next() % n }
    fn pick<T: Copy>(&mut self, xs: &[T]) -> T { xs[self.below(xs.len() as u64) as usize] }
}

// One call as the runtime sees it: a panic is a refused call.
fn attempt(f: impl FnOnce()) -> bool { std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_ok() }

const PEOPLE: [&str; 9] = ["owner.testnet", "guardian.testnet", "reserve.testnet", "agent.testnet", "stranger.testnet", "x.testnet", "y.testnet", "z.testnet", "w.testnet"];
const ROLES: [Role; 5] = [Role::Owner, Role::Guardian, Role::Reserve, Role::Agent, Role::Retire];

// One random role action by `caller` at time `t`; proposers are council members, so changes can get far.
fn role_action(c: &mut Keyfree, rng: &mut Rng, caller: &str, t: u64) -> bool {
    ctx_at(caller, 20, t, vec![]);
    let (role, who, proposer) = (rng.pick(&ROLES), acc(rng.pick(&PEOPLE)), acc(rng.pick(&PEOPLE[..3])));
    match rng.below(7) {
        0 => attempt(|| c.propose_role(role, who)),
        1 => attempt(|| c.approve_role(proposer)),
        2 => attempt(|| c.cancel_role(proposer)),
        3 => attempt(|| c.apply_role(proposer)),
        4 => attempt(|| c.pause()),
        5 => attempt(|| c.unpause()),
        _ => attempt(|| c.revoke_agent()),
    }
}

fn roles_distinct(c: &Keyfree) {
    let mut held = vec![&c.owner, &c.guardian, &c.reserve];
    if let Some(a) = &c.agent { held.push(a); }
    for i in 0..held.len() { for j in i + 1..held.len() { assert_ne!(held[i], held[j], "one account holds two roles"); } }
}

#[test]
fn prop_one_stolen_council_key_never_changes_the_council() {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut taken = 0;
    for thief in ["owner.testnet", "guardian.testnet", "reserve.testnet"] {
        for _ in 0..1_000 {
            let mut c = idle();
            let council = (c.owner.clone(), c.guardian.clone(), c.reserve.clone());
            let mut t = 1_000;
            for _ in 0..40 {
                t += rng.below(2 * c.upgrade_delay_sec);
                // the thief, or anyone outside the council
                let caller = if rng.below(2) == 0 { thief } else { rng.pick(&PEOPLE[3..]) };
                let was_paused = c.paused;
                if role_action(&mut c, &mut rng, caller, t) { taken += 1; }
                assert_eq!((c.owner.clone(), c.guardian.clone(), c.reserve.clone()), council, "{thief} alone changed the council");
                assert!(c.retiring.is_none(), "{thief} alone retired the policy");
                assert!(!was_paused || c.paused, "{thief} alone unpaused");
                roles_distinct(&c);
            }
        }
    }
    assert!(taken > 10_000, "the sequences must do things, not only get refused ({taken} taken)");
    println!("property: 3000 sequences of 40 actions by one council key and outsiders, {taken} actions taken, the council never changed");
}

type RoleHolders = (AccountId, AccountId, AccountId, Option<AccountId>, Option<AccountId>);

#[test]
fn prop_role_changes_wait_the_full_delay_after_the_last_approval() {
    let mut rng = Rng(0xd1b5_4a32_d192_ed03);
    let mut changed = 0;
    for _ in 0..5_000 {
        let mut c = idle();
        let delay = c.upgrade_delay_sec;
        // (proposer, role, account, the time the change got all the approvals it needs)
        let mut ready: Vec<(AccountId, Role, AccountId, u64)> = vec![];
        let mut t = 1_000;
        for _ in 0..80 {
            t += rng.below(delay);
            let caller = rng.pick(&PEOPLE);
            let snap = c.role_changes.clone();
            let before: RoleHolders = (c.owner.clone(), c.guardian.clone(), c.reserve.clone(), c.retiring.clone(), c.agent.clone());
            role_action(&mut c, &mut rng, caller, t);
            let after: RoleHolders = (c.owner.clone(), c.guardian.clone(), c.reserve.clone(), c.retiring.clone(), c.agent.clone());
            let made = if after.0 != before.0 { Some((Role::Owner, after.0.clone())) }
                else if after.1 != before.1 { Some((Role::Guardian, after.1.clone())) }
                else if after.2 != before.2 { Some((Role::Reserve, after.2.clone())) }
                else if after.3 != before.3 { after.3.clone().map(|a| (Role::Retire, a)) }
                else if after.4 != before.4 { after.4.clone().map(|a| (Role::Agent, a)) } // revoking the agent is a brake: no delay
                else { None };
            if let Some((role, account)) = made {
                // Several council members may propose the same change; one of them must have been due.
                let council = |a: &AccountId| *a == before.0 || *a == before.1 || *a == before.2;
                let due = snap.iter().filter(|r| r.role == role && r.account == account).any(|ch| {
                    let at = ready.iter().find(|r| r.0 == ch.proposer && r.1 == role && r.2 == account).map(|r| r.3);
                    at.is_some_and(|at| t >= at + delay) && (role == Role::Agent || ch.approvals.iter().filter(|a| council(a)).count() >= 2)
                });
                assert!(due, "{role:?} = {account} applied at {t} without a proposal that had its approvals and the full {delay} s delay");
                changed += 1;
            }
            ready.retain(|r| c.role_changes.iter().any(|x| x.proposer == r.0 && x.role == r.1 && x.account == r.2 && x.ready_at.is_some()));
            for x in &c.role_changes {
                if x.ready_at.is_some() && !ready.iter().any(|r| r.0 == x.proposer && r.1 == x.role && r.2 == x.account) {
                    ready.push((x.proposer.clone(), x.role, x.account.clone(), t));
                }
            }
            roles_distinct(&c);
        }
    }
    assert!(changed > 400, "the sequences must change roles often enough to mean something ({changed} changes)");
    println!("property: 5000 sequences of 80 actions by everyone, {changed} role changes, each after its approvals and the full delay");
}

// Gas limits and fees from tiny to absurd, to reach every branch and every overflow.
fn amount(rng: &mut Rng) -> u128 {
    match rng.below(6) {
        0 => rng.below(3) as u128,
        1 => rng.below(10_000_000) as u128,
        2 => rng.below(100_000_000_000) as u128,
        3 => rng.next() as u128,
        4 => u128::MAX - rng.below(2) as u128,
        _ => (rng.next() as u128) << 64 | rng.next() as u128,
    }
}

#[test]
fn prop_daily_budget_is_never_exceeded_and_refuses_only_when_it_must() {
    let mut rng = Rng(0x2545_f491_4f6c_dd1d);
    let (mut signed, mut refused) = (0, 0);
    for _ in 0..2_000 {
        let mut c = idle();
        let max_wei = if rng.below(5) == 0 { u128::MAX } else { rng.below(1_000_000_000_000_000_000) as u128 + 1 };
        let max_tx = rng.below(12) as u32 + 1;
        c.budgets.insert(84532, Budget { max_wei_per_day: max_wei, max_tx_per_day: max_tx });
        let mut t = rng.below(10_000_000_000);
        let (mut day, mut wei, mut txs) = (t / 86_400, 0u128, 0u32);
        for _ in 0..30 {
            t += rng.below(4 * 3_600); // a new UTC day now and then
            if t / 86_400 != day { (day, wei, txs) = (t / 86_400, 0, 0); }
            ctx_at("agent.testnet", 20, t, vec![]);
            let p = Pending { gas_limit: amount(&mut rng), max_fee_per_gas: amount(&mut rng), ..pending() };
            // the most a transaction can cost (2^128 - 1 wei at most), and whether today's total still fits
            let cost = p.gas_limit.saturating_mul(p.max_fee_per_gas);
            let fits = txs < max_tx && wei.checked_add(cost).is_some_and(|w| w <= max_wei);
            let got = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.spent_after(&p)));
            assert_eq!(got.is_ok(), fits, "budget {max_wei} wei / {max_tx} tx, used {wei} / {txs}, this one {cost}");
            if let Ok(Some(s)) = got { c.spent.insert(84532, s); wei += cost; txs += 1; signed += 1; } else { refused += 1; }
            let b = c.get_budget(84532).unwrap();
            assert_eq!((b["used_wei_today"].as_str().unwrap().parse::<u128>().unwrap(), b["used_tx_today"].as_u64().unwrap() as u32), (wei, txs), "get_budget agrees");
            assert!(wei <= max_wei && txs <= max_tx);
        }
    }
    assert!(signed > 5_000 && refused > 5_000, "both outcomes often ({signed} signed, {refused} refused)");
    println!("property: 2000 budgets x 30 requests, {signed} counted and {refused} refused, each exactly as the budget says");
}

// 400 random transactions serialized by viem (random_vectors.mjs -> evidence/random_txs.json): nonces, gas and fees
// at every RLP length boundary up to 2^128 - 1, chain ids up to 2^64 - 1, code of 0..1100 bytes, all three kinds.
#[test]
fn random_transactions_encode_like_viem() {
    ctx("keyfree.testnet", 10);
    let v: Value = near_sdk::serde_json::from_str(include_str!("../../evidence/random_txs.json")).unwrap();
    let n = |c: &Value, f: &str| c[f].as_str().unwrap().parse::<u128>().unwrap();
    let h = |c: &Value, f: &str| hex::decode(c[f].as_str().unwrap().trim_start_matches("0x")).unwrap();
    let cases = v["cases"].as_array().unwrap();
    for (i, c) in cases.iter().enumerate() {
        let init: Vec<u8> = c["init_seed"].as_str().map(|s| {
            let seed: u64 = s.parse().unwrap();
            (0..c["init_len"].as_u64().unwrap()).map(|j| (seed.wrapping_add(j.wrapping_mul(0x9e37_79b9_7f4a_7c15)) >> 56) as u8).collect()
        }).unwrap_or_default();
        let mut p = Pending { chain_id: n(c, "chain_id") as u64, nonce: n(c, "nonce") as u64, code_hash: String::new(), gas_limit: n(c, "gas_limit"),
            max_fee_per_gas: n(c, "max_fee_per_gas"), max_priority_fee_per_gas: n(c, "max_priority_fee_per_gas"), init_code: init, salt: None, factory: None, since_block: 0 };
        match c["kind"].as_str().unwrap() {
            "plain" => {}
            "factory" => { p.salt = Some(h(c, "salt")); p.factory = Some(h(c, "to")); }
            _ => {
                let (to, imp): ([u8; 20], [u8; 20]) = (h(c, "to").try_into().unwrap(), h(c, "implementation").try_into().unwrap());
                p = proxy_pending(p.chain_id, p.nonce, &to, &imp, p.gas_limit, p.max_fee_per_gas, p.max_priority_fee_per_gas);
            }
        }
        let tx = tx_of(&p);
        assert_eq!(format!("0x{}", hex::encode(env::keccak256_array(&tx.build_for_signing()))), c["unsigned_keccak"].as_str().unwrap(), "case {i}: unsigned");
        let sig = Signature { v: c["y_parity"].as_u64().unwrap(), r: strip(&h(c, "r")), s: strip(&h(c, "s")) };
        assert_eq!(format!("0x{}", hex::encode(env::keccak256_array(&tx.build_with_signature(&sig)))), c["signed_keccak"].as_str().unwrap(), "case {i}: signed");
    }
    assert_eq!(cases.len(), 400);
}
