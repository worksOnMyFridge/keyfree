# Attack bench

Run: `npm run attacks` (offline). 2026-10-29.

**53 of 53 attacks refused offline, 1 more refused live by the NEAR protocol.**

Contract attacks run the real policy code on near-sdk's mocked chain; tool attacks run the built keyfree package. "Seen live" points to the testnet run.

## The agent, or a prompt injection that steers it

| # | Attack | Result | Refusal | Test | Seen live |
|---|---|---|---|---|---|
| A1 | deploy code the owner never allowed | refused | code not on the allow list | `code_that_was_never_allowed_is_refused` | v13 attacks; Claude Code Counter(999) |
| A2 | same contract, other constructor arguments (swap the vault owner) | refused | code not on the allow list | `other_constructor_arguments_are_other_code` | vault-kit, Claude Code |
| A3 | use a salt without our factory (shared CREATE2 proxy: someone takes the address first) | refused | a salt needs the factory | `salt_without_the_factory_is_refused` | v13 attacks |
| A4 | repeat a salt + code on a new nonce (make an old Deployed log prove a new nonce) | refused | salt and code already used on this chain | `same_salt_and_code_cannot_take_a_second_nonce` | v13 attacks |
| A5 | gas below the intrinsic minimum (signed, never mined, the nonce queue blocks) | refused | gas limit below the intrinsic minimum | `too_little_gas_is_refused_before_signing` |  |
| A6 | fee of 1 wei (signed, never mined) | refused | fee below the floor | `one_wei_fee_is_refused_before_signing` | v13 attacks |
| A7 | gas over the cap (burn the address's ETH) | refused | gas limit over the cap | `gas_over_the_cap_is_refused` |  |
| A8 | fee over the cap | refused | gas price over the cap | `fee_over_the_cap_is_refused` |  |
| A9 | a chain the owner never allowed | refused | chain not allowed | `a_chain_that_was_never_allowed_is_refused` |  |
| A10 | a chain a council member disabled | refused | chain is disabled | `disabled_chain_refuses_new_deploys` |  |
| A11 | deploy while the policy is paused | refused | paused | `guardian_pause_blocks_deploys` | v13 attacks |
| A12 | move money: a deploy that sends value | refused | value is always 0 (the contract cannot build anything else) | `no_signed_transaction_ever_sends_value` |  |
| A13 | widen the rules | refused | only owner | `agent_cannot_propose_rules` | v13 attacks: the agent's key cannot even call it |
| A14 | make itself owner or guardian | refused | only owner, guardian or reserve | `agent_cannot_touch_roles` |  |
| A15 | propose new code for the policy itself | refused | only owner | `agent_cannot_propose_an_upgrade` |  |
| A16 | call any non-request method with the agent's NEAR key | refused live (protocol) | Access key does not allow method (NEAR protocol, before the contract runs) | live only | v13 attacks |
| A17 | find an owner tool in MCP, or pass a private key to a tool | refused | no such tool; unknown argument rejected | tool: 1 test |  |
| A18 | get another transaction broadcast than the one checked (calldata, target, nonce, chain or value changed) | refused | not the one that was checked | tool: 3 tests |  |
| A19 | get a transaction signed by another key broadcast, or garbage | refused | not by the policy's address / does not parse | tool: 2 tests |  |
| A20 | upgrade the treasury proxy to an implementation the council never allowed (one that pays someone else) | refused | proxy upgrade not on the allow list | `another_implementation_is_refused` |  |
| A21 | use an allowed implementation on another proxy | refused | proxy upgrade not on the allow list | `another_proxy_is_refused` |  |
| A22 | sign the same allowed upgrade a second time | refused | proxy upgrade not on the allow list (the allowance is used up) | `the_same_upgrade_cannot_be_signed_twice` |  |
| A23 | roll the treasury back to its old version | refused | proxy upgrade not on the allow list | `going_back_to_the_old_version_needs_its_own_rule` |  |
| A24 | allow an upgrade itself | refused | only owner | `the_agent_cannot_allow_an_upgrade` |  |
| A25 | get a signed upgrade to another implementation broadcast | refused | not the one that was checked | tool: 1 test |  |
| A26 | give the nonce of a proxy upgrade to a deploy | refused | nonce already used on this chain | `a_deploy_never_takes_the_nonce_of_a_proxy_upgrade` |  |

## A thief with one or two council keys

| # | Attack | Result | Refusal | Test | Seen live |
|---|---|---|---|---|---|
| K1 | stolen guardian pauses and cancels forever | refused | owner + reserve replace it after the delay; its own cancel is not enough | `stolen_guardian_cannot_freeze_the_contract_forever` | v13 roles |
| K2 | one key changes a role | refused | needs 2 of 3 approvals | `one_key_cannot_change_roles` | v13 roles |
| K3 | two keys together skip the delay | refused | role change delay not over | `owner_and_guardian_together_cannot_skip_the_delay` | v13 roles |
| K4 | stolen owner allows its own code at once | refused | rule delay not over | `new_code_waits_for_the_rules_delay` | v13 install, factory |
| K5 | stolen owner raises the caps at once | refused | raising a cap is a rule proposal | `caps_cannot_be_raised_at_once` | v13 attacks |
| K6 | stolen owner swaps the policy code at once | refused | upgrade delay not over | `upgrade_waits_for_the_delay` | v13 upgrade |
| K7 | stolen owner sends other bytes at apply time than it proposed | refused | only the stored, public code is deployed | `apply_ignores_bytes_sent_at_apply_time` |  |
| K8 | stolen owner moves a nonce down (two contents on one nonce) | refused | chain already allowed: its nonce moves only by signing | `owner_cannot_move_the_nonce_down_by_hand` | v13 attacks |
| K9 | disable a chain, then open it again with a lower nonce | refused | chain already allowed | `disabling_a_chain_cannot_be_used_to_reset_its_nonce` |  |
| K10 | fill the state with proposals | refused | too many open rule proposals | `a_stolen_owner_key_cannot_fill_the_state_with_proposals` |  |
| K11 | one key retires the policy and takes its NEAR | refused | needs 2 of 3 approvals | `one_key_cannot_retire_the_policy` |  |
| K12 | retire to an outside account | refused | the beneficiary must be a council member | `the_beneficiary_is_a_council_member` |  |
| K13 | one key unpauses alone | refused | needs a second vote | `one_unpause_vote_is_not_enough` | v13 attacks |
| K14 | stolen owner allows a treasury upgrade to its own implementation at once | refused | rule delay not over | `a_proxy_upgrade_waits_for_the_rules_delay` |  |

## A stranger with no role

| # | Attack | Result | Refusal | Test | Seen live |
|---|---|---|---|---|---|
| S1 | re-initialise the policy with own roles | refused | only the contract account | `stranger_cannot_reinit` |  |
| S2 | request a deploy | refused | only agent or owner | `stranger_cannot_request_a_deploy` |  |
| S3 | pause it | refused | only owner, guardian or reserve | `stranger_cannot_pause` | v13 attacks |
| S4 | move a stuck nonce with a proof | refused | only agent or owner | `stranger_cannot_confirm_stuck` |  |
| S5 | empty a retiring policy's state | refused | only owner, guardian or reserve | `stranger_cannot_sweep` |  |
| S6 | request a proxy upgrade | refused | only agent or owner | `a_stranger_cannot_request_a_proxy_upgrade` |  |

## A broken or hostile MPC answer, or a lying chain

| # | Attack | Result | Refusal | Test | Seen live |
|---|---|---|---|---|---|
| M1 | 11 kinds of broken signing answers | refused | request parked, nonce bound, nothing frozen | `broken_answers_never_freeze_the_contract` |  |
| M2 | empty, non-JSON, null or oversized raw answer | refused | request parked, no panic | `odd_raw_answers_never_freeze_the_contract` |  |
| M3 | a valid signature of another key | refused | signature recovers to another address | `signature_of_another_key_is_refused` |  |
| M4 | a late answer leaks a signature for a timed-out request | refused | that nonce can only carry the same deploy | `leaked_signature_and_retry_can_only_spend_the_nonce_on_the_same_deploy` |  |
| M5 | a proof for an old nonce moves the nonce back | refused | next nonce never goes down | `proof_of_an_old_stuck_nonce_never_moves_the_nonce_back` |  |
| M6 | prove a stuck deploy from a block that can still vanish | refused | a stuck request needs Safe or Finalized | `confirm_stuck_refuses_latest` | v13 attacks |
| M7 | a forged log position for the journal | refused | other payload hash: Read MPC does not confirm | `golden_payload_hash_of_the_forged_log_position` | v13 confirm: Read MPC answered false |
| M8 | a new request overwrites a used journal line | refused | nonce already used on this chain | `new_request_never_overwrites_a_used_nonce` |  |
