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

// height = block, secs = block time, input = raw call input (the code for apply_upgrade).
fn ctx_at(pred: &str, height: u64, secs: u64, input: Vec<u8>) {
    let mut c = VMContextBuilder::new()
        .current_account_id("keyfree.testnet".parse().unwrap())
        .predecessor_account_id(pred.parse().unwrap())
        .block_height(height)
        .block_timestamp(secs * 1_000_000_000)
        .prepaid_gas(Gas::from_tgas(300))
        .build();
    c.input = input.into();
    testing_env!(c);
}

fn pending() -> Pending {
    Pending { chain_id: 84532, nonce: 4, code_hash: hex::encode(env::keccak256_array(&hex::decode(INIT).unwrap())),
        gas_limit: 200_000, max_fee_per_gas: 14_000_000, max_priority_fee_per_gas: 1_000_000,
        init_code: hex::decode(INIT).unwrap(), salt: None, factory: None, since_block: 10 }
}

fn contract() -> Keyfree {
    ctx("keyfree.testnet", 10);
    let mut c = Keyfree::new("owner.testnet".parse().unwrap(), "agent.testnet".parse().unwrap(), "guardian.testnet".parse().unwrap(), "reserve.testnet".parse().unwrap(), "mpc.testnet".parse().unwrap(), "keyfree-1".into(), 3600);
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
    assert_eq!(c.on_signed(answer(R, S, 0)).as_deref(), Some(RAW));
    assert_eq!(c.get_next_nonce(84532), Some(5));
    assert!(c.pending.is_none() && c.stuck.is_none());
}

#[test]
fn high_s_is_flipped_to_the_same_tx() {
    let mut c = contract();
    assert_eq!(c.on_signed(answer(R, &high_s(), 1)).as_deref(), Some(RAW));
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
        assert_eq!(c.on_signed(res), None, "{name}");
        assert!(c.pending.is_none(), "{name}: pending cleared");
        assert_eq!(c.stuck.as_ref().map(|p| p.nonce), Some(4), "{name}: nonce stays bound");
        assert_eq!(c.get_next_nonce(84532), Some(4), "{name}: nonce not advanced");
    }
}

#[test]
fn signature_of_another_key_is_refused() {
    let mut c = contract();
    c.eth_address = Some("0x0000000000000000000000000000000000000001".into());
    assert_eq!(c.on_signed(answer(R, S, 0)), None);
    assert!(c.stuck.is_some());
}

#[test]
fn answer_without_pending_is_ignored() {
    let mut c = contract();
    c.pending = None;
    assert_eq!(c.on_signed(answer(R, S, 0)), None);
}

#[test]
#[should_panic(expected = "an earlier request did not finish")]
fn new_request_blocked_while_stuck() {
    let mut c = contract();
    c.on_signed(Err(PromiseError::Failed));
    ctx("agent.testnet", 20);
    c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, None, None);
}

#[test]
fn retry_resigns_only_the_same_content() {
    let mut c = contract();
    c.on_signed(Err(PromiseError::Failed));
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
    Keyfree::new("x.testnet".parse().unwrap(), "y.testnet".parse().unwrap(), "g.testnet".parse().unwrap(), "r.testnet".parse().unwrap(), "mpc.testnet".parse().unwrap(), "p".into(), 0);
}

#[test]
#[should_panic(expected = "must be different accounts")]
fn roles_must_be_different_accounts_at_init() {
    ctx("keyfree.testnet", 10);
    Keyfree::new("x.testnet".parse().unwrap(), "y.testnet".parse().unwrap(), "g.testnet".parse().unwrap(), "x.testnet".parse().unwrap(), "mpc.testnet".parse().unwrap(), "p".into(), 0);
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

// Maintenance without keys: propose a hash, wait, guardian may cancel, then only that code goes in.
const CODE: &[u8] = b"pretend this is the new wasm";

fn proposed() -> Keyfree {
    let mut c = contract();
    c.pending = None;
    ctx_at("owner.testnet", 20, 1_000, vec![]);
    c.propose_upgrade(hex::encode(env::sha256_array(CODE)));
    c
}

#[test]
#[should_panic(expected = "upgrade delay not over")]
fn upgrade_waits_for_the_delay() {
    let mut c = proposed();
    ctx_at("owner.testnet", 21, 1_000 + 3_599, CODE.to_vec());
    let _ = c.apply_upgrade();
}

#[test]
#[should_panic(expected = "code does not match the proposed hash")]
fn upgrade_takes_only_the_proposed_code() {
    let mut c = proposed();
    ctx_at("owner.testnet", 21, 1_000 + 3_600, b"other code".to_vec());
    let _ = c.apply_upgrade();
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

#[test]
fn upgrade_after_the_delay_with_the_right_code() {
    let mut c = proposed();
    ctx_at("owner.testnet", 21, 1_000 + 3_600, CODE.to_vec());
    let _ = c.apply_upgrade();
    assert!(c.proposed.is_none());
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
    c.on_signed(Err(PromiseError::Failed));
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
    c.on_signed(Err(PromiseError::Failed));
    ctx("keyfree.testnet", 30);
    assert!(c.on_stuck_confirmed(84532, 4, "ab".repeat(32), Ok(json!({ "payload_hash": "x" }))));
    assert!(c.stuck.is_none());
    assert_eq!(c.get_next_nonce(84532), Some(5));
}

#[test]
fn failed_or_stale_proof_keeps_it_stuck() {
    let mut c = contract();
    c.on_signed(Err(PromiseError::Failed));
    ctx("keyfree.testnet", 30);
    assert!(!c.on_stuck_confirmed(84532, 4, "ab".repeat(32), Err(PromiseError::Failed)));
    assert!(!c.on_stuck_confirmed(84532, 3, "ab".repeat(32), Ok(json!({}))));
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

// v7: nonce accounting after the second audit (Н3 nonce back, Н4 foreign proof, Н5 Latest).
const SALT: &str = "1111111111111111111111111111111111111111111111111111111111111111";

fn signed_line(c: &mut Keyfree, nonce: u64, status: u8) {
    let mut code_hash = [0u8; 32];
    code_hash.copy_from_slice(&env::keccak256_array(&hex::decode(INIT).unwrap()));
    c.journal.insert(key(84532, nonce), Entry { code_hash, salt: [7; 32], factory: [9; 20], addr: [5; 20], tx_hash: [1; 32], status });
}

fn log_in() -> LogIn { LogIn { log_index: 0, transaction_index: 0, block_hash: "cd".repeat(32), block_number: 1 } }

#[test]
fn proof_of_an_old_stuck_nonce_never_moves_the_nonce_back() {
    let mut c = contract();
    c.pending = None;
    c.stuck = Some(Pending { nonce: 2, ..pending() });
    signed_line(&mut c, 2, REQUESTED);
    ctx("keyfree.testnet", 30);
    assert!(c.on_stuck_confirmed(84532, 2, "ab".repeat(32), Ok(json!({}))));
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
    assert_eq!(c.on_signed(Err(PromiseError::Failed)), None);
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
    c.set_factory(84532, "09".repeat(20));
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
    c.set_factory(84532, "09".repeat(20));
    c.set_factory(421614, "09".repeat(20));
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
    let _ = c.confirm_stuck("ab".repeat(32), log_in(), "Safe".into());
}

#[test]
#[should_panic(expected = "a stuck request needs Safe or Finalized")]
fn confirm_stuck_refuses_latest() {
    let mut c = contract();
    c.pending = None;
    c.stuck = Some(Pending { salt: Some(vec![7; 32]), factory: Some(vec![9; 20]), ..pending() });
    signed_line(&mut c, 4, REQUESTED);
    ctx("agent.testnet", 12);
    let _ = c.confirm_stuck("ab".repeat(32), log_in(), "Latest".into());
}

#[test]
fn confirm_stuck_with_safe_goes_to_read_mpc() {
    let mut c = contract();
    c.pending = None;
    c.stuck = Some(Pending { salt: Some(vec![7; 32]), factory: Some(vec![9; 20]), ..pending() });
    signed_line(&mut c, 4, REQUESTED);
    ctx("agent.testnet", 12);
    let _ = c.confirm_stuck("ab".repeat(32), log_in(), "Safe".into());
}

// v8: roles (spec R2, R3, R3a, R5; audit v2 Н1). Delay in contract() is 3600 s.
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

// v9: no side doors (audit v2 Н7, Н8, Н9; spec R9, R17, R18).
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
    c.allow_chain(84532, 3, 1_000_000);
}

#[test]
#[should_panic(expected = "chain already allowed")]
fn a_chain_is_opened_only_once() {
    let mut c = idle();
    ctx("owner.testnet", 20);
    c.allow_chain(421614, 0, 1_000_000);
    assert_eq!(c.get_next_nonce(421614), Some(0));
    c.allow_chain(421614, 5, 1_000_000);
}

#[test]
#[should_panic(expected = "a chain needs a fee floor above 0")]
fn a_chain_needs_a_fee_floor() {
    let mut c = idle();
    ctx("owner.testnet", 20);
    c.allow_chain(421614, 0, 0);
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
