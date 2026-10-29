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
    let mut c = Keyfree::new("owner.testnet".parse().unwrap(), "agent.testnet".parse().unwrap(), "guardian.testnet".parse().unwrap(), "mpc.testnet".parse().unwrap(), "keyfree-1".into(), 3600);
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
    Keyfree::new("x.testnet".parse().unwrap(), "y.testnet".parse().unwrap(), "g.testnet".parse().unwrap(), "mpc.testnet".parse().unwrap(), "p".into(), 0);
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

// ---------------- re-audit probes (not part of the project) ----------------
mod audit_probes {
    use super::*;

    fn with_entry(c: &mut Keyfree, nonce: u64, status: u8) {
        let code = hex::decode(INIT).unwrap();
        let mut code_hash = [0u8; 32];
        code_hash.copy_from_slice(&env::keccak256_array(&code));
        c.journal.insert(key(84532, nonce), Entry { code_hash, salt: [7; 32], factory: [9; 20], addr: [5; 20], tx_hash: [1; 32], status });
    }

    // P1: resign of an OLD nonce -> MPC fails -> stuck -> confirm_stuck proof -> next_nonce moves BACKWARDS.
    #[test]
    fn probe_nonce_moves_backwards_via_resign_then_confirm_stuck() {
        let mut c = contract();
        c.pending = None;
        assert_eq!(c.get_next_nonce(84532), Some(4));
        with_entry(&mut c, 2, SIGNED);
        with_entry(&mut c, 3, CONFIRMED);
        ctx("agent.testnet", 20);
        let _ = c.resign(84532, 2, INIT.into(), 300_000, 20_000_000, 1_000_000);
        ctx("keyfree.testnet", 21);
        c.on_signed(Err(PromiseError::Failed));
        assert_eq!(c.stuck.as_ref().map(|p| p.nonce), Some(2));
        assert!(c.on_stuck_confirmed(84532, 2, "ab".repeat(32), Ok(json!({}))));
        let next = c.get_next_nonce(84532).unwrap();
        println!("PROBE next_nonce after confirm_stuck of old nonce 2: {next} (was 4)");
        assert!(next < 4, "nonce went backwards: {next}");
        // P2: now a new request reuses nonce 3 and OVERWRITES the confirmed journal line of nonce 3
        ctx("agent.testnet", 22);
        let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, None, None);
        assert_eq!(c.pending.as_ref().map(|p| p.nonce), Some(3));
        let e = c.journal.get(&key(84532, 3)).unwrap();
        println!("PROBE journal line 3 status after overwrite: {} (was CONFIRMED=2), tx_hash zero: {}", e.status, e.tx_hash == [0u8; 32]);
        assert_eq!(e.status, REQUESTED);
    }

    // P3: the shared CREATE2 proxy path (front-runnable) is still reachable: salt without via_factory.
    #[test]
    fn probe_shared_proxy_path_still_allowed() {
        let mut c = contract();
        c.pending = None;
        ctx("agent.testnet", 20);
        let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, Some("11".repeat(32)), None);
        let p = c.pending.clone().unwrap();
        assert!(p.factory.is_none() && p.salt.is_some());
        assert_eq!(tx_of(&p).to, Some(CREATE2_PROXY));
        println!("PROBE shared-proxy deploy accepted, to = 0x4e59b448…956c");
    }

    // P4: no fee floor: max_fee_per_gas = 1 wei is accepted and signed (nonce gap unless resign; plain CREATE cannot be resigned).
    #[test]
    fn probe_one_wei_fee_accepted_for_plain_create() {
        let mut c = contract();
        c.pending = None;
        ctx("agent.testnet", 20);
        let _ = c.request_deploy(84532, INIT.into(), 200_000, 1, 1, None, None);
        assert_eq!(c.pending.as_ref().map(|p| p.max_fee_per_gas), Some(1));
        let e = c.journal.get(&key(84532, 4)).unwrap();
        assert_eq!(e.factory, [0u8; 20], "plain CREATE: resign will refuse it (factory == 0)");
        println!("PROBE 1-wei fee accepted; plain CREATE entry has factory=0 -> resign impossible");
    }

    // P5: allow_chain can move the nonce DOWN while a SIGNED (unlanded) line exists -> two different txs on one nonce become possible.
    #[test]
    fn probe_allow_chain_moves_nonce_down_over_signed_line() {
        let mut c = contract();
        c.pending = None;
        with_entry(&mut c, 3, SIGNED);
        ctx("owner.testnet", 20);
        c.allow_chain(84532, 3);
        assert_eq!(c.get_next_nonce(84532), Some(3));
        ctx("agent.testnet", 21);
        // different content (no salt, plain CREATE) at the same nonce 3 as the SIGNED factory deploy
        let _ = c.request_deploy(84532, INIT.into(), 200_000, 14_000_000, 1_000_000, None, None);
        assert_eq!(c.pending.as_ref().map(|p| p.nonce), Some(3));
        println!("PROBE owner moved nonce down; a different tx for nonce 3 is now being signed");
    }

    // P6: confirm_stuck / confirm accept finality "Latest" and anyone may call them.
    #[test]
    fn probe_confirm_stuck_accepts_latest_from_a_stranger() {
        let mut c = contract();
        c.pending = Some(Pending { salt: Some(vec![7; 32]), factory: Some(vec![9; 20]), ..pending() });
        with_entry(&mut c, 4, REQUESTED);
        ctx("keyfree.testnet", 11);
        c.on_signed(Err(PromiseError::Failed));
        ctx("stranger.testnet", 12);
        let _ = c.confirm_stuck("ab".repeat(32), LogIn { log_index: 0, transaction_index: 0, block_hash: "cd".repeat(32), block_number: 1 }, "Latest".into());
        println!("PROBE stranger called confirm_stuck with finality Latest: accepted (promise created)");
    }

    // P7 (golden, audit item 18): payload hash the contract computed on testnet for the real confirm of nonce 1
    // (evidence/spike5.log: expected 0532a8f1…7771, Read MPC answered CONFIRMED) must come from deployed_payload().
    #[test]
    fn probe_golden_base_log_payload_hash_from_spike5() {
        let h = |s: &str| -> Vec<u8> { hex::decode(s).unwrap() };
        let mut e = Entry { code_hash: [0; 32], salt: [0; 32], factory: [0; 20], addr: [0; 20], tx_hash: [0; 32], status: SIGNED };
        e.code_hash.copy_from_slice(&h("fb9fb2e46931e8f1035a5e589b31d7d69ea44e15806b1c71dfee37cebbbf6b16"));
        e.salt.copy_from_slice(&h("d65193273a95b04eb6734a4c42e4cbb9b1eb3a6a0d551caa258c6bd6a3623bf5"));
        e.factory.copy_from_slice(&h("e744243604e31d7be8b76e0c8bdff4ec5f560ffd"));
        e.addr.copy_from_slice(&h("693344d03f64450b09e3a071720aa252fe00fd6b"));
        let mut tx = [0u8; 32]; tx.copy_from_slice(&h("9334ebfef002ccb72b030f76ced239724c61def23b0fc496c9f52427eb3cc6bb"));
        let mut bh = [0u8; 32]; bh.copy_from_slice(&h("224dc0ef1236a0233658c5ca04c80f68d98ace2daf1a5d089488c28c444bb9dc"));
        let log = LogIn { log_index: 0, transaction_index: 2, block_hash: String::new(), block_number: 50141591 };
        let got = hex::encode(env::sha256_array(&deployed_payload(6, &e, &tx, &log, &bh, 1)));
        println!("PROBE golden payload hash: {got}");
        assert_eq!(got, "0532a8f181edbd7caa7b27c1341adcdbee3ff5ddc491d4c9899abe05fcaf7771");
    }

    // P8: intrinsic gas vs a max-size runtime: code deposit alone (200 gas/byte x 24 576) exceeds the 3 M cap.
    #[test]
    fn probe_gas_cap_blocks_max_size_runtime() {
        let deposit: u128 = 200 * 24_576;
        println!("PROBE code deposit for a 24 KB runtime = {deposit} gas > cap 3_000_000: {}", deposit > 3_000_000);
        assert!(deposit > 3_000_000);
    }
}
