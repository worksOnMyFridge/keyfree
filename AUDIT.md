# Security reviews

Two security reviews were done on 2026-10-25 by separate AI reviewer sessions that had no part in writing
the code. Each one read the contract, ran its own probe tests (kept in [`audit/`](audit/)) and listed
findings with a way to break them. This page lists every finding, what was changed, and the test that now
shows the fix. **This is not a professional audit**, and the newest code (retire in v13, proxy upgrades in
v14) has not had an independent review yet.

Status words: **fixed** (changed, with a test), **partly** (the dangerous part is fixed, something is left),
**open** (not changed yet), **by design** (kept on purpose, explained).

Tests are in [`contract/src/tests.rs`](contract/src/tests.rs); run them with
`(cd contract && cargo test -- --test-threads=1)`. Versions are in [`contract/CHANGELOG.md`](contract/CHANGELOG.md).

## Second review (code version v6): N1..N17

| Id | Finding | Severity | Status | Fix and tests |
|---|---|---|---|---|
| N1 | The owner, guardian and agent could not be replaced, so a stolen guardian key could pause the policy and cancel every upgrade forever | High | fixed (v8) | A council of three. Replacing owner, guardian or reserve needs 2 of 3 and the full delay, cancelling it also 2 of 3. `stolen_guardian_cannot_freeze_the_contract_forever`, `replaced_guardian_cannot_pause_again`, `one_key_cannot_change_roles` |
| N2 | "No key" is not the whole story: the owner plus the upgrade delay is a key with a timer | High | by design | No key, but there is power, and the docs say exactly how much: 2 of 3 members plus the delay, or the owner plus the delay while the other two stay silent ([SECURITY.md](SECURITY.md)). Widening can never be sped up, any member may cancel it, and the proposed code is readable during the delay (N6). The testnet demo uses 60 s and 180 s delays; real use needs hours or days |
| N3 | `next_nonce` could move back after a failed re-sign, and the next request overwrote a confirmed journal line | Medium | fixed (v7) | `max()` on every path, a failed re-sign leaves the line as it was, a new request never takes a nonce that has a journal line. `proof_of_an_old_stuck_nonce_never_moves_the_nonce_back`, `failed_resign_leaves_the_signed_deploy_as_it_was`, `new_request_never_overwrites_a_used_nonce` |
| N4 | `confirm_stuck` could take the log of an older deploy with the same salt and code, and anyone could call it | Medium | fixed (v7) | One (salt, code) pair binds to one nonce per chain; only the agent or the owner may call. `same_salt_and_code_cannot_take_a_second_nonce`, `stranger_cannot_confirm_stuck` |
| N5 | `confirm_stuck` accepted a Latest block, which can still vanish | Medium-low | fixed (v7) | Safe or Finalized only. `confirm_stuck_refuses_latest`, `confirm_stuck_with_safe_goes_to_read_mpc` |
| N6 | The guardian could veto an upgrade but could not read the code it was voting on | Medium | fixed (v10) | The owner stores the new wasm in the contract state when proposing; the delay starts then; `apply_upgrade` deploys exactly those bytes. `the_proposed_code_is_readable_during_the_delay`, `apply_ignores_bytes_sent_at_apply_time`. Live: the guardian compared the sha256 before the v14 upgrade ([`evidence/v14.log`](evidence/v14.log)) |
| N7 | A salted deploy could still go through the shared CREATE2 proxy, where anyone can take the address first | Medium | fixed (v9) | A salt goes only through the council's factory. `salt_without_the_factory_is_refused` |
| N8 | `allow_chain` could move a nonce down at once, the one way to get two different transactions on one nonce | Medium | fixed (v9, v11) | A chain is opened once; the nonce moves only by signing, re-signing or proof. `owner_cannot_move_the_nonce_down_by_hand`, `a_chain_is_opened_only_once`, `disabling_a_chain_cannot_be_used_to_reset_its_nonce` |
| N9 | No fee floor (1 wei was signed), and a plain CREATE could not be re-signed | Medium-low | fixed (v9) | A fee floor per chain, `resign` for any signed line. `one_wei_fee_is_refused_before_signing`, `a_signed_plain_create_can_be_resigned`, `resign_also_respects_the_floor` |
| N10 | Gas caps were constants, too low for a real 24 KB contract, and there was no daily budget | Medium-low | partly | Caps are a rule now: lowered at once, raised only through the delay (`caps_are_lowered_at_once_and_raised_by_proposal`, `caps_cannot_be_raised_at_once`); the live policy allows 10 M gas, enough for the code deposit of a 24 KB runtime (about 4.9 M). **Open:** caps per chain and a daily budget |
| N11 | Arbitrum was never tried, and its gas rules add an L1 data cost | Low | open | No deploy on Arbitrum has been run. The README does not claim it |
| N12 | The journal keeps only the hash of the latest variant after a re-sign; if an earlier variant lands, `confirm` cannot find it | Low | open | Nonces stay correct (one content per nonce); only that journal line stays "signed" |
| N13 | A callback macro could still panic on a non-JSON MPC answer, outside the callback body | Low | fixed (v12) | Callbacks read the answer as raw bytes. `odd_raw_answers_never_freeze_the_contract`, `odd_raw_answer_does_not_confirm_the_journal`, `odd_raw_answer_does_not_move_a_stuck_nonce` |
| N14 | Evidence was incomplete: missing logs, no unit tests for long transactions or for the Read MPC payload hash | Low | fixed | Golden tests against viem and against the payload hash Read MPC accepted live: `golden_rlp_plain_create_1k_matches_viem`, `golden_rlp_factory_deploy_24k_matches_viem`, `golden_rlp_factory_deploy_48k_matches_viem`, `golden_payload_hash_of_the_confirmed_base_deploy`. Live runs are logged in [`evidence/`](evidence/) |
| N15 | The owner, agent and guardian keys sat on one laptop | Low-medium | partly | The agent has a function-call key limited to the request methods. **Open:** in the testnet demo the three council keys are still on one machine; for real use they belong on separate devices or with separate people |
| N16 | Small access issues: unused deposits, no way to remove code at once, MPC account fixed | Low | partly | `remove_code` is immediate (`removing_code_is_immediate`). `confirm` stays payable because the Read MPC call needs 1 yoctoNEAR. **Open:** the MPC account and its domains are set at install and change only with an upgrade |
| N17 | `apply_upgrade` dropped the proposal even if `migrate` failed, costing another full delay | Low | fixed (v13) | The proposal is cleared only by a `migrate` that ran. `apply_keeps_the_proposal_until_migrate_has_run`, `migrate_marks_the_upgrade_done` |

## First review (code version v1/v2): F1..F20

| Id | Finding | Status now |
|---|---|---|
| F1 | A full-access key on the policy account | fixed (v2): 0 keys, deleted in the install transaction |
| F2 | A panic in the signing callback locks the contract forever | fixed (v2, v12): `broken_answers_never_freeze_the_contract`, `odd_raw_answers_never_freeze_the_contract` |
| F3 | An allowed code hash is a seal the owner cannot check | partly: the hash covers the code and its constructor arguments (`other_constructor_arguments_are_other_code`), and the MCP tool `keyfree_code_hash` computes it from your build artifact; the contract stores only the hash |
| F4 | A signed transaction is public and can be broadcast by anyone | by design: the contract stores only its hash; broadcasting is not a new signature |
| F5 | A timeout does not mean "not signed": two transactions could share a nonce | fixed (v2, v7): `leaked_signature_and_retry_can_only_spend_the_nonce_on_the_same_deploy`, `retry_resigns_only_the_same_content` |
| F6 | No daily budget, one cap for all chains | partly: see N10 |
| F7 | A Read MPC receipt does not prove the deploy succeeded | fixed (v3): our factory emits `Deployed` only on success, and the payload hash binds factory, address, code hash and salt |
| F8 | The agent is the owner; no pause, no role changes | fixed (v8): see N1 |
| F9 | CREATE2 through a shared proxy: the address can be taken first | fixed (v9): see N7 |
| F10 | Nonce drift: no fee floor, `allow_chain` in any direction | fixed (v9): see N8, N9 |
| F11 | The ETH address is entered by hand | fixed (v2): derived on chain from the MPC; `signature_of_another_key_is_refused` |
| F12 | Storage growth, or a callback without NEAR, locks the contract | fixed (v2): the journal line is created at request time and only overwritten in the callback |
| F13 | Contract calls (`upgradeTo`) are not designed | done (v14): one call kind, proxy upgrades by allowance; `the_allowed_upgrade_is_signed_as_a_call_built_by_the_policy`, `no_signed_transaction_ever_sends_value` |
| F14 | Finalized blocks take hours | Safe is used for confirmation; moving a nonce needs Safe or Finalized (N5) |
| F15 | Trust in the MPC network and its governance | by design: stated in [SECURITY.md](SECURITY.md), "What is trusted" |
| F16 | The long RLP branch is unverified | fixed: golden tests for 1 KB, 24 KB and 48 KB (N14) |
| F17 | Supply chain: the RPC and the tool | partly: the tool compares the policy's bytes with viem before anything is signed; dependency versions are pinned. The RPC is still trusted for fees and receipts |
| F18 | The borsh layout of the Read MPC payload is hard-coded | partly: a golden test on a pair Read MPC accepted live (`golden_payload_hash_of_the_confirmed_base_deploy`); it has to be rechecked when the MPC changes its format |
| F19 | u128 values travel as bare JSON numbers | open (low): gas limits and fees in use stay far below 2^53 |
| F20 | Small things: payable methods, no `remove_code`, `allow_chain` does two jobs | fixed (v9, v11), see N16 |

## Not reviewed yet

- Retire (v13): `retire_*`, `sweep`, `finish_retire`. Unit tests only, never run live (it deletes the policy).
- Proxy upgrades (v14): unit tests plus two live runs on Base Sepolia ([CLAIMS 7](CLAIMS.md#7-a-treasury-upgrade-only-the-one-the-council-allowed)), no independent review.
- The `keyfree` tool (`packages/keyfree`) beyond its own 13 tests.

## Requirements referred to in the code (R-ids)

| Id | Requirement |
|---|---|
| R1 | The policy account has 0 keys after install: deploy, init and DeleteKey in one transaction |
| R2 | Three roles (owner, guardian, reserve) plus an agent; replacing owner, guardian or reserve needs 2 of 3 and the delay |
| R3 | Any council member pauses at once; unpausing needs 2 of 3 |
| R3a | The emergency path is the brake only: nothing that widens power can be sped up, even by two members together |
| R5 | Owner, agent, guardian and reserve are different accounts |
| R6 | Widening a rule waits the delay and any member may cancel; narrowing is immediate |
| R9 | A chain is a fixed set: chain id, factory, derivation path; no shared CREATE2 proxy |
| R10 | The contract builds the EIP-1559 transaction itself and never signs a hash it is given |
| R12 | A signing callback never panics; the MPC answer is read as raw bytes |
| R17 | Any signed but unconfirmed line can be re-signed, a plain CREATE too |
| R18 | The nonce is never moved down by hand |
| R21 | Confirmation through Read MPC: our factory's `Deployed` log, payload hash computed in the contract |
| R29 | Retire: 2 of 3 and the delay, then the contract deletes its own account |
