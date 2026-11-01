# Security reviews

Three security reviews were done by separate AI reviewer sessions that had no part in writing the code: two
on 2026-10-25, and a third on 2026-11-01 against catalogs of current attack techniques (108 items, with
sources). Each one read the code, ran its own probe tests and listed findings with a way to break them. This
page lists every finding, what was changed, and the test that now shows the fix. **This is not a
professional audit.**

Status words: **fixed** (changed, with a test), **partly** (the dangerous part is fixed, something is left),
**open** (not changed yet), **by design** (kept on purpose, explained).

Tests are in [`contract/src/tests.rs`](contract/src/tests.rs); run them with
`(cd contract && cargo test -- --test-threads=1)`. Versions are in [`contract/CHANGELOG.md`](contract/CHANGELOG.md).

## Third review (code version v15, 2026-11-01): X1..X12

Method: two research sessions built catalogs of current attack techniques from primary sources
([contracts, NEAR, MPC, EVM: C1..C59](audit/attack_catalog_contracts.md);
[AI agents and MCP: G1..G49](audit/attack_catalog_agents.md)). A third session that had not seen the code
before checked every item against the repository at commit `c553d87`, read-only toward the chains, and
proved or disproved each suspicion with probe tests. Fixed in v16 and in the `keyfree` tool.

| Id | Finding | Severity | Status | Fix and tests |
|---|---|---|---|---|
| X1 | Retiring deleted the policy account. Its parent account could then create it again; NEAR MPC derives the EVM key from the account name and path alone, so the new account would sign for the same EVM address, the admin of the treasury proxies and the only caller of the factories | High | fixed (v16) | `finish_retire` sends the free NEAR to the beneficiary and keeps the account, keyless and retired for good, so its name is never free. The storage stake of the code stays locked. `sweep_empties_the_state_then_the_free_near_goes_to_the_beneficiary` asserts no `DeleteAccount` |
| X2 | `confirm_stuck` took the tx hash from the caller and bound only the log, so a look-alike log of another transaction (the proxy constructor's `Upgraded`) could move a stuck nonce | Medium | fixed (v16) | The caller hands over the signature as it appeared on chain; the contract checks it is its own signature over exactly the stuck content, rebuilds the signed transaction and uses its hash. `confirm_stuck_takes_the_tx_id_from_our_own_signature`, `confirm_stuck_refuses_a_signature_of_other_content` |
| X3 | The tool loaded the key of whatever account `keyfree.json` named; a cloned project naming the owner made the MCP server sign as the owner | Medium | fixed (tool) | Before signing, the tool checks on chain that its key is a function-call key on the policy for request methods only, and refuses otherwise (checked live: the agent's key is accepted, the owner's full-access key refused before any call) |
| X4 | `retry` and `resign` ignored the brakes: removed code, a disabled chain, a removed or changed factory, a lowered gas cap | Low | fixed (v16) | One check for every new signature. `retry_stops_when_the_code_was_removed`, `retry_stops_when_the_chain_was_disabled`, `retry_stops_when_the_gas_cap_was_lowered`, `resign_stops_when_the_code_was_removed` |
| X5 | The daily budget counts signatures, not spending: signatures never broadcast still count, a UTC day lets two days' budget meet around midnight, and Base's L1 data fee is outside gas x fee | Low | by design | Counting signatures errs on the strict side (an unbroadcast signature can still land). The midnight window and the L1 fee are stated in SECURITY.md |
| X6 | `confirm` accepted a `Latest` block and `confirm_stuck` moved the nonce on `Safe`, which an L2 can still reorg | Low | fixed (v16) | `confirm` needs Safe or Finalized; `confirm_stuck` needs Finalized. `confirm_refuses_latest`, `confirm_stuck_refuses_latest`, `confirm_stuck_refuses_safe_too` |
| X7 | Error text from outside (RPC messages, revert strings) reached the model and the terminal unfiltered | Low | fixed (tool) | Control, ANSI and bidi characters are stripped from every error the tool shows |
| X8 | The agent's key has no gas allowance, so it has no spending fuse of its own | Low | by design | A key with an allowance stops for good once spent (seen in the v13 run); the daily budget is the fuse. Stated in README |
| X9 | A salt chosen by the agent is public and could carry data out | Info | by design | The tool draws salts at random; the policy cannot tell a random salt from a chosen one |
| X10 | `retry` took the chain from the caller, so a wrong chain was signed and then not broadcast | Info | fixed (v16, tool) | `get_open` names the chain; the tool takes it from there. `get_open_names_the_chain` |
| X11 | CI ran install scripts and had no dependency audit | Info | fixed | `npm ci --ignore-scripts`; an `audit` job runs `cargo audit` and `npm audit`. Its first run found 4 advisories (crypto-bigint, zstd, zstd-safe), all in near-sdk's test-only VM; they are ignored with reasons in `contract/.cargo/audit.toml`, and CI checks on every run that none of these crates is in the contract's dependency tree |
| X12 | Test and attack counts in the docs were stale | Info | fixed | Updated |

Checked and not an issue: every signed payload is `keccak(0x02 ‖ rlp(...))`, so it cannot be an EIP-7702
authorization (`0x05`), an EIP-191/712 message (`0x19`) or a transaction of another chain; the v13, v14 and
v15 state layouts never parse as one another; a late MPC answer that lands on a newer request fails the
signature check and only parks it; the ordinary `confirm` binds the policy's own tx hash, emitter, topics,
data and position; no narrowing method widens anything for zero, `u128::MAX` or a chain never opened.

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
| N10 | Gas caps were constants, too low for a real 24 KB contract, and there was no daily budget | Medium-low | fixed (v11, v15) | Caps are a rule: lowered at once, raised only through the delay (`caps_are_lowered_at_once_and_raised_by_proposal`, `caps_cannot_be_raised_at_once`); the live policy allows 10 M gas, enough for the code deposit of a 24 KB runtime (about 4.9 M). v15 adds a daily budget per chain, gas and transaction count, re-signs included (`the_daily_gas_budget_counts_the_most_each_can_cost`, `the_daily_transaction_limit_refuses_the_next_one`, `a_retry_counts_against_the_budget`, `proxy_upgrades_count_against_the_budget`, `lower_budget_cannot_raise_it`). The per-transaction caps stay global, not per chain |
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
| F6 | No daily budget, one cap for all chains | fixed for the budget (v15, per chain); the per-transaction caps stay global (N10) |
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

- The changes of v16 themselves were made after the third review and are covered by the tests named above.
- The `keyfree` tool beyond its own tests and the review's probes.

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
