# Security reviews

Five security reviews were done by separate AI reviewer sessions that had no part in writing the code: two
on 2026-10-25, a third on 2026-11-01 against catalogs of current attack techniques (108 items, with
sources), a fourth on 2026-11-03 by another model, Claude Fable 5.1, and a fifth on 2026-11-06 that attacked
the whole lifecycle: install, setup, the alarm, CI and what happens after a deploy. Each one read the code, ran its own probe tests and listed findings with a way to break them. This
page lists every finding, what was changed, and the test that now shows the fix. **This is not a
professional audit.**

Status words: **fixed** (changed, with a test), **partly** (the dangerous part is fixed, something is left),
**open** (not changed yet), **by design** (kept on purpose, explained).

Tests are in [`contract/src/tests.rs`](contract/src/tests.rs); run them with
`(cd contract && cargo test -- --test-threads=1)`. Versions are in [`contract/CHANGELOG.md`](contract/CHANGELOG.md).

## Fifth review (code version v18, 2026-11-06): Z1..Z12

Method: a red-team session with no part in the code attacked the lifecycle before, during and after Keyfree runs,
proving each finding with a probe test or the exact lines. Read-only toward the chains. Its report, with what it
checked and found safe and what it did not cover: [`audit/review_2026-11-06.md`](audit/review_2026-11-06.md). The
contract changes are v19.

| Id | Finding | Severity | Status | What changed / test |
|---|---|---|---|---|
| Z1 | Setup made the guardian's and the reserve's keys next to the agent (2 of 3), files not limited to the user; the "keys on this machine" warning looked in one place only | High | fixed (tool, setup) | `setup/policy.mjs` makes no council key unless `"demo_council_here": true` (a quick testnet trial, with a warning); the guardian and the reserve must already exist, made on other devices. Key files are written 0600 and the policy's temporary key file is removed after install. `keyfree status` and `setup check` name every council key found next to the agent: `~/.near-credentials`, `KEYFREE_COUNCIL_KEY`, `*_key.json` in the working folder and its `setup/`. Test: "Z1: council keys next to the agent are found by account name". The demo policies' own council keys still sit on the laptop that ran them; SECURITY.md says so |
| Z2 | The alarm ran hourly against minute-long demo delays, could be late or switched off, and told one person | Medium | partly | `watch` runs every 15 minutes, can post to every council member (`KEYFREE_ALERT_WEBHOOK`), separates "a widening waits" from "the policy could not be read", and states its limits. `setup` warns on delays under an hour. The demo policies keep 60 s and 180 s delays for testing; no schedule protects those |
| Z3 | No view named the MPC or the path, so a look-alike MPC chosen at install could hold a key while the policy shows 0 keys | Medium | fixed (v19, tool) | `get_config` returns the MPC account and the path. `keyfree status` and `setup check` compare the account with the network's MPC and the policy's address with the one that MPC derives; `setup install` refuses another MPC. Tests: `the_config_names_the_mpc_and_the_path`, "Z3: status names the MPC and checks the policy's address against it", "Z3: the EVM address of an MPC key". Both live policies checked: their addresses are the ones `v1.signer-prod.testnet` derives |
| Z4 | Only the intrinsic gas was checked, so a transaction certain to revert could be signed and use up a one-time upgrade or a CREATE2 address | Low-medium | fixed (v19) | A floor per kind on top of the intrinsic gas: 28 000 for `upgradeTo` (about 50 000 in all; a real one used 32 679), CREATE2's 32 000 plus 8 per word for a factory deploy. The previews report the floor and the tool already takes the larger of it and the estimate. Tests: `an_upgrade_at_the_intrinsic_minimum_is_refused`, `an_upgrade_at_the_floor_has_room_for_a_real_upgrade`, `a_salted_deploy_under_the_create2_cost_is_refused`, `the_preview_reports_the_floor_it_enforces`. A plain creation's code deposit is still not known to the contract |
| Z5 | Applying one role change cleared all others, including an approved replacement of a stolen key | Low | fixed (v19) | Only the applied change is removed; approvals are recounted at apply time against the council of that moment. Tests: `applying_one_role_change_keeps_the_approved_replacement_of_a_stolen_key`, `an_approval_from_a_replaced_member_no_longer_counts` |
| Z6 | A pause did not stop an approved widening from being applied | Low | fixed (v19) | A paused policy applies no rule and no upgrade; replacing a council member still works, so the honest two can remove a thief who keeps pausing. Tests: `a_paused_policy_applies_no_rule`, `a_paused_policy_applies_no_upgrade`, `a_member_can_be_replaced_while_paused` |
| Z7 | The CI example ran this repository at `main` and claimed more protection from an environment than it gives | Low | fixed | The example pins a commit of this repository and says to allow deployments from `main` only with a required reviewer |
| Z8 | The MCP tools took a salt chosen by the model | Low | fixed (tool) | The salt is drawn by the tool; `keyfree_deploy` and `keyfree_preview` reject a `salt` argument (the CLI still takes one from a human). Test: "Z8 and Z9: the MCP tools take no salt and no artifact outside the project" |
| Z9 | The model could probe any file through the artifact path and read its first characters in an error | Info | fixed (tool) | MCP artifacts must be inside the folder the server runs in; a file that is not an artifact gives a plain message without its content. Tests: the same, and "Z9: a file that is not an artifact gives a plain message" |
| Z10 | An upgrade is allowed by address; the CLI accepted an address with no code | Low | partly (tool) | `keyfree rules allow-upgrade` refuses an address with no code and prints the code hash there now. The contract still binds the address, and the explorer does not show the implementation's code |
| Z11 | Funds sent to the policy's address can never leave | Info | by design, stated | SECURITY.md, "Money sent to the policy's address" |
| Z12 | Three documentation mistakes | Info | fixed | R29 below, the package README and the watch workflow corrected |

**Checked again after v19.** A separate session verified each fix against the code, the tests (186 and 83) and the
live policies (both v19, 0 keys, `get_config` and the MPC-derived address as claimed). It confirmed Z4, Z5, Z6, Z7,
Z8 and Z12 and found three gaps, now closed:

| Id | Gap | Status | What changed / test |
|---|---|---|---|
| Z3b | `keyfree status` took the MPC to trust from `mpc_account` in keyfree.json, the file an attacker of Z3 would write; a failed `get_config` read as "older than v19" | fixed (tool) | The network's MPC is fixed in the tool; `mpc_account` only adds a warning; a failed read is said as such. Test: "Z3: status names the MPC..." (look-alike named in keyfree.json) |
| Z9b | `keyfree_retry` took any path; "not found" and "outside the project" gave different answers, so a model could learn which paths exist | fixed (tool) | `keyfree_retry` goes through the same check; one answer for both. Test: "Z8 and Z9..." (retry, a missing file, a file outside) |
| Z5b | After a member was replaced, an old role change kept its past `ready_at`, so one approval from the new member made it ready at once (and stale changes kept the alarm firing) | fixed (v20, live) | When the council changes, changes proposed by a member who left go, approvals and cancels of members who left are dropped, and a change below 2 of 3 starts its delay again when approved. Tests: `an_old_change_does_not_become_ready_at_once_after_the_council_changes`, `the_restarted_delay_holds`, `a_cancel_from_a_member_who_left_no_longer_counts`, `a_change_proposed_by_a_replaced_member_goes_with_it` |
| Z1b | The council-key scan missed key files next to the agent's keyfree.json when the agent runs elsewhere | fixed (tool) | The folder of `KEYFREE_CONFIG` and its `setup/` are scanned too. A key in an OS keychain or under another file name is not found: SECURITY.md says to keep council keys off that machine |

## Fourth review (code version v17, 2026-11-03): Y1..Y5

Method: a session on another model, with a clean clone and no keys, read the code and formed its own view before
reading these documents, then proved each suspicion with a probe test. Read-only toward the chains. Its report,
with what it tried and could not break and what it did not cover: [`audit/review_2026-11-03.md`](audit/review_2026-11-03.md).

| Id | Finding | Severity | Status | What changed / test |
|---|---|---|---|---|
| Y1 | A `confirm` and a re-sign of one line can overlap. A late signature turned a confirmed line back into signed, naming a transaction that can never land; a failed or released re-sign made a landed nonce stuck, which holds every chain. The agent could do this alone | Medium | fixed (v18) | The answer of a re-sign changes nothing on a confirmed line and opens nothing. Checked here on the way: when the proof answered last, the line named the re-sign and not the transaction proved; now it names the one proved. `a_late_signature_does_not_overwrite_a_confirmed_line`, `a_signature_answered_first_does_not_take_the_confirmed_transactions_place`, `a_failed_resign_after_confirmation_opens_nothing`, `a_released_resign_after_confirmation_opens_nothing`, `a_failed_confirmation_changes_nothing_while_a_resign_runs` |
| Y2 | A stuck request blocks all chains; with a brake on what it needs, `retry` is refused and only a widening through the delay gets out | Medium | by design, stated | A stuck slot per chain would change the layout and the tool's calls for a case that needs an MPC failure and a brake together; pausing stops signing without it. SECURITY.md, "One stuck request". `a_braked_stuck_request_cannot_be_retried`, `a_stuck_request_holds_new_requests_on_every_chain` |
| Y3 | No brake recalls an issued signature; removing a proxy upgrade is moot after the request; a held-back signature holds later nonces | Medium | by design, stated | The reviewer proposed a council brake that burns the nonce with a self-transfer. Not added: it would be a second kind of content on a nonce and a new signing path, and whoever holds the signature can see it coming on NEAR and land first, so it promises more than it gives. SECURITY.md, "A signature cannot be recalled". `no_brake_recalls_a_proxy_upgrade_already_requested` |
| Y4 | A chain whose nonce is ahead of the policy's can be repaired only by an upgrade; the tool said "tell the council" as if the council had a method | Low | by design, stated | The nonce never moves by hand (R18). The tool's message and SECURITY.md say what the way out is |
| Y5 | The explorer's "Source commit" is what the wasm says about itself, and `setup` compares with a number in this repository, not a rebuild | Info | fixed | The page compares the account's code hash with the hash of the reproducible build and says so; the README's wording says what `setup` checks |

## Verification pass (code version v16, 2026-11-01): V1..V7

Method: the product taken apart plane by plane after the reviews. A newcomer follows the README from a clean
copy; an outsider installs a policy of their own from nothing; the live wasm runs in a local nearcore node
([`evidence/sandbox.md`](evidence/sandbox.md)) with an access matrix of all 47 methods, every flow, faults of
the MPC and of the policy's own balance; property tests run thousands of random action sequences; 400 random
transactions are compared with viem.

| Id | Finding | Severity | Status | What changed / test |
|---|---|---|---|---|
| V1 | A chain opened without a `SetBudget` rule has no daily limit, only the per-transaction caps | Low | fixed (v17) | A chain without a budget signs nothing: every signing path and both previews refuse until the budget's rule has passed. No default amount: the council states the number. `a_chain_without_a_budget_signs_no_deploy` and five more for the other paths, `a_new_chain_signs_only_after_its_budget_rule`, `migrate_keeps_budgets_and_a_chain_without_one_stays_silent` |
| V2 | With a budget of 2^128 - 1 wei, a day whose total would pass 2^128 is refused by the overflow check, not by the budget message | Info | by design | The request is refused either way (fail closed). Found by the property test's model: `prop_daily_budget_is_never_exceeded_and_refuses_only_when_it_must` |
| V3 | The tool ignored a misspelled flag, sent council calls with missing numbers to the chain (gas spent on a refusal), rounded wei amounts above 2^53 in what it showed the council, and gave refusals and errors the same exit code | Low | fixed | Arguments checked before signing, exact integers both ways, exit code 2 for a refusal; seen live: a rule of `12345678901234567891` wei was shown as `…567000` (the rule was cancelled). 23 command-line tests in `packages/keyfree/test/cli.test.mjs` |
| V4 | There was no way for someone else to install a policy on the live code: the old scripts installed a laptop build of v13 and upgraded it step by step | Low | fixed | `setup/policy.mjs` takes the wasm from the live policy, checks it against the reproducible build's sha256 and installs it keyless; run by a fresh testnet account with no link to this one |
| V5 | A signature request already at the MPC is completed after a pause | Info | by design | A pause stops new requests; a signature once asked for may come back, like one that already left. Now tested in the sandbox: a pause between the request and a late answer, and the answer still gives the previewed transaction |
| V6 | Real-runtime limits were never measured | Info | done | In nearcore: a request with the largest allowed code (49 152 bytes) costs 83.5 Tgas end to end; a policy short of NEAR for that storage refuses with `LackBalanceForState` before the MPC is asked, and a top-up from anyone fixes it; a wasm without `migrate` cannot be applied and leaves the old code and the proposal (N17) |
| V7 | u128 amounts from the tool were bare JSON numbers (F19) | Low | fixed | The tool writes and reads integers exactly; the contract's views give u128 amounts as strings |

## Network faults (tool, 2026-11-03): V8..V13

Method: the real CLI and MCP server against two local nodes that fail on purpose
([`test/faults.test.mjs`](packages/keyfree/test/faults.test.mjs), 41 cases), then the real networks behind a proxy that breaks them
([`evidence/tool_faults_live.log`](evidence/tool_faults_live.log)). First measured on the old tool: most of the cases failed. No contract change.

| Id | Finding | Severity | Status | What changed / test |
|---|---|---|---|---|
| V8 | Signed, then the broadcast failed: dead end. The nonce was used on NEAR, nothing on chain, `retry` said "nothing is stuck" and the tool had no way to the contract's `resign`; every later deploy would wait behind the gap for ever | Medium | fixed | `retry` covers it (`resign`, `resign_proxy_upgrade`), same content only, fee above a pending transaction's; ran live with the real MPC. New work is stopped before signing while a gap exists |
| V9 | An RPC address with an API key went into error messages, and through MCP to the model | Medium | fixed | Messages show only the host; every fault test checks the output for it |
| V10 | The NEAR answer to a request lost by a node (it happened on the real testnet) lost the signature; another attempt spent the day's budget. near-api-js would also re-sign under a new nonce on a nonce error, which could run a call twice | Medium | fixed | The tool signs first, knows the hash, and looks the outcome up; a new nonce only when that transaction did not run |
| V11 | A silent NEAR node held the tool for minutes; one node was a single point of failure (two public testnet nodes went down during this pass) | Low | fixed | Timeouts on every request, `near_rpc_fallbacks` and `rpc_fallbacks` |
| V12 | Wasted signatures: a node of another chain burnt a nonce, gas over the cap was signed and would fail on chain, a stuck nonce already used was re-signed | Low | fixed | Each is stopped before signing, with a plain message |
| V13 | A retry's transaction was compared only with itself; the policy's status view died with the EVM node; a fee estimate above 2^53 went on rounded; nonsense from a node surfaced as a JavaScript error | Low | fixed | The retry is compared with the journal line; `status` marks the balance unknown; the fee is refused; the answers are checked |

## Explorer page (2026-11-03): V14..V17

Method: the page in real browsers against stubbed nodes that fail or lie ([`explorer/explorer.test.mjs`](explorer/explorer.test.mjs)), measured on the old page first (9 of 25 passed), then through the real nodes. The `explorer` workflow runs it in Chromium, Firefox and WebKit.

| Id | Finding | Severity | Status | What changed / test |
|---|---|---|---|---|
| V14 | The page stated guesses as facts when a node failed: a network error was shown as "Refused by the policy", a failed read of the budget as "none set: per-transaction caps only", a failed journal line was dropped silently; with keys on the account the note still said "There is none" | Medium | fixed | A refusal and "no node answered" are separate; what could not be read is marked unknown; the note follows the count |
| V15 | One NEAR node: when it failed, panels stayed on "loading…" for ever; a budget lowered to zero (a brake) stopped the page on a division | Medium | fixed | Three NEAR nodes and two per EVM chain, a timeout on each, a banner, a "Read again" button; a zero budget is shown |
| V16 | Numbers: integers above 2^53 went through JavaScript numbers, a small amount was shown as 0.000000 ETH | Low | fixed | Exact integers in, amounts never shown as zero, the exact wei in a tooltip |
| V17 | A `contract_source_metadata` link was made clickable whatever its scheme; on a phone the budget and the journal's links sat in a sideways-scrolling column nobody sees, and one row was cut off | Low | fixed | Only https links; on a phone a table becomes labelled lines; a Content-Security-Policy on the page |

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
| F19 | u128 values travel as bare JSON numbers | fixed in the tool (V7): exact integers both ways; the contract's views give u128 as strings |
| F20 | Small things: payable methods, no `remove_code`, `allow_chain` does two jobs | fixed (v9, v11), see N16 |

## Not reviewed yet

- The changes of v16 themselves were made after the third review; they are covered by the tests named above and
  by the verification pass (V1..V7), which was not done by an independent reviewer.
- v17 was seen by the fourth review, v18 (Y1) by the fifth, which found it correct. v19 (Z3..Z6) came after the
  fifth review: covered by the tests named above, the sandbox (17 of 17) and the live checks (CLAIMS 9.9), and
  checked afterwards by a separate session ("Checked again after v19" above). v20 (Z5b) came out of that check: it is
  covered by the tests named there, the sandbox (17 of 17) and CLAIMS 9.10; no independent reviewer has seen it.
- The fourth review did not run the nearcore sandbox, a rebuild of the wasm or the page in a browser, and read the
  Read MPC payload's encoding only through the authors' golden tests.

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
| R29 | Retire: 2 of 3 and the delay, then the state is swept and the NEAR goes to a council member who approved; the account is not deleted, so its name and EVM address can never be taken again (X1) |
