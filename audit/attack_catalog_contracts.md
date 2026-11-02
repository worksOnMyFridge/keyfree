# Attack catalog: keyless NEAR contract + Chain Signatures + EVM CREATE2/ERC-1967 (as of 2026-11-01)

Scope: a keyless NEAR contract (near-sdk 5.29) that builds EIP-1559 txs, gets them signed by the NEAR MPC (`v1.signer-prod.testnet`), checks EVM events through Read MPC (`verify_foreign_transaction`), and controls a CREATE2 factory plus an ERC-1967 treasury on Base Sepolia and Ethereum Sepolia. This is a research checklist, not a code review.

Legend:
- Severity is what the issue would be **in this system** if present: Critical / High / Medium / Low / Info.
- **unverified** means the claim, or the part of it that is marked, is my inference or comes from a secondary or repost source. It is not confirmed by a primary source.
- Each item lists 1-2 sources. Docs URLs are the official NEAR, Optimism, Ethereum, OpenZeppelin and OWASP pages unless noted.

---

## A. NEAR contract pitfalls

1. **C1 Unguarded callback or resume entry point.** If a callback (MPC sign result, Read MPC result) or a public resume-style method lacks `#[private]` or a caller check, anyone can call it with fabricated "success" bytes.
   - Test: call every callback/settle method from a foreign account and from the agent key with crafted payloads. Each call must be rejected before it touches any state.
   - Severity: Critical
   - Sources: https://docs.near.org/smart-contracts/security/callbacks , https://docs.near.org/smart-contracts/anatomy/yield-resume

2. **C2 No automatic rollback across receipts.** State written before the `sign` / `verify_foreign_transaction` call (reserved nonce, budget spent, pending entry) persists if the MPC call fails. Only the callback can undo it.
   - Test: in sandbox, point the signer at a mock that fails, times out or returns garbage. Afterwards check the nonce, the daily budget and the pending map. Each must be restored or marked "stuck" deterministically.
   - Severity: High
   - Sources: https://docs.near.org/smart-contracts/security/cross-contract-calls/callback-panics , https://docs.near.org/smart-contracts/anatomy/crosscontract

3. **C3 Callback out-of-gas.** "Never panics" does not cover running out of gas. If the callback runs out of gas, its own state changes revert and the request stays pending forever with its nonce reserved.
   - Test: measure the callback's worst-case gas (ecrecover, plus RLP of the maximum-size init code, plus logs). Assert that the statically reserved callback gas is at least that plus a margin. Call the entry method with the minimum prepaid gas that still passes and confirm that the callback completes.
   - Severity: High
   - Sources: https://docs.near.org/smart-contracts/security/checklist , https://docs.near.org/smart-contracts/security/cross-contract-calls/callback-panics

4. **C4 Interleaving between request and callback (NEAR-style reentrancy).** Other public methods can run while a sign request is pending: narrowing rules, a council change, retire, release, or a second request for the same chain.
   - Test: open a request. Before the callback lands, run `release`, `resign`, narrowing, role change and `retire` in turn. The callback must re-check current rules and bind to (request id, chain, nonce, tx hash), and it must settle exactly once.
   - Severity: High
   - Source: https://docs.near.org/smart-contracts/security/checklist

5. **C5 Promise result parsing.** The callback receives a raw promise result. It must handle all of these without panicking or misreading: `Failed`, empty, malformed or oversized output, and a schema change after an MPC contract upgrade (`domain_id`, a new signature encoding).
   - Test: unit tests with `testing_env!` that inject each result variant, plus fuzzing of the byte parser. Assert there is no state corruption and no false "signed" status.
   - Severity: Medium
   - Sources: https://docs.near.org/smart-contracts/security/callbacks , https://docs.near.org/chain-abstraction/chain-signatures

6. **C6 Yield timeout semantics.** A yielded promise times out after about 200 blocks and the callback receives `PromiseError`. A yield cannot be resumed twice. Pending state must be cleaned up on both the success and the timeout path, without panicking.
   - Test: force a timeout in sandbox. Assert cleanup and that exactly one retry path is open.
   - Severity: Medium
   - Source: https://docs.near.org/smart-contracts/anatomy/yield-resume

7. **C7 Storage-staking bricking of a keyless account.** Pending requests, the proposal queue and the allow lists grow state. If the balance falls below the storage stake, every state-writing call fails. With no keys, the only fix is someone sending NEAR in.
   - Test: compute the bytes per pending item times the maximum allowed. Assert hard caps on pending requests and proposals and a reserved storage buffer. Simulate many small writes in sandbox.
   - Severity: High
   - Sources: https://docs.near.org/smart-contracts/security/storage , https://docs.near.org/protocol/storage/storage-staking

8. **C8 Function-call key allowance drain.** Gas spent through the agent's function-call key is paid from the contract's own balance up to the allowance, and the allowance is unlimited if omitted. A stolen key can burn that budget with failing calls and can push the account toward C7.
   - Test: inspect the access key: allowance finite and non-zero, receiver = self, exactly 8 methods. Spam failing calls in sandbox and measure the drain against the storage reserve.
   - Severity: Medium
   - Sources: https://docs.near.org/protocol/accounts-contracts/access-keys , https://nomicon.io/DataStructures/AccessKey

9. **C9 Privileged methods reachable with a function-call key.** Function-call keys cannot attach NEAR, so requiring 1 yoctoNEAR (`assert_one_yocto`) on owner, guardian and council methods makes them unreachable through any function-call key.
   - Test: sign each privileged method with the agent key and with a 0 deposit. Every call must fail.
   - Severity: Medium
   - Sources: https://docs.near.org/smart-contracts/security/checklist , https://docs.near.org/protocol/accounts-contracts/access-keys

10. **C10 `predecessor` vs `signer` confusion.** Authorizing on `signer_account_id` lets any contract that the owner or agent interacts with relay privileged calls.
    - Test: call privileged and agent methods through an intermediary contract, in a transaction signed by the role account. The call must be rejected.
    - Severity: High
    - Source: https://docs.near.org/smart-contracts/security/checklist

11. **C11 Borsh layout break on self-upgrade.** New code that cannot deserialize `STATE` panics on every call. On a keyless account nobody can redeploy, so the contract is permanently bricked.
    - Test: in sandbox, deploy v(n), fill its state, then run the full upgrade with `migrate` to v(n+1). Also test a missing `migrate`, a failing `migrate`, and an old-layout enum variant. Confirm that `DeployContract` and `migrate` run as one batch, so a failure reverts both.
    - Severity: Critical
    - Sources: https://docs.near.org/smart-contracts/anatomy/serialization , https://docs.near.org/smart-contracts/anatomy/crosscontract

12. **C12 Staged wasm rejected by the runtime.** If the toolchain emits wasm features the NEAR VM does not accept, the deploy action fails and the upgrade path breaks.
    - Test: deploy the exact staged bytes to a scratch sandbox or testnet account before the delay ends. Build only with the pinned cargo-near reproducible image.
    - Severity: Medium
    - Status: **unverified** (specific feature list not confirmed)
    - Source: https://docs.near.org/smart-contracts/anatomy/reproducible-builds

13. **C13 Bait-and-switch on staged code.** If the staged code can be replaced after review or during the delay, the code that executes differs from the code that was approved. This is the same pattern as the Tornado Cash governance takeover of May 2023, where the approved proposal address was redeployed with new code.
    - Test: stage A and start the delay, then try to restage B. The delay must restart, and the upgrade must check `sha256(code) == approved_hash` at execution time.
    - Severity: High
    - Sources: https://rekt.news/tornado-gov-rekt , https://www.halborn.com/blog/post/explained-the-tornado-cash-hack-may-2023

14. **C14 DeleteAccount pitfalls and account-ID re-registration.**
    - If the beneficiary does not exist, the balance bounces after the account is gone and is lost to validators.
    - More important: the MPC-derived EVM address is a function of the NEAR account ID. If the contract account is deleted and the same ID is later re-created by someone else, that party controls the treasury proxy admin and the only allowed factory caller. **unverified inference, not stated in a source.**
    - The claim that large-state accounts cannot be deleted is also **unverified**.
    - Test: retire checks that the beneficiary exists. Before DeleteAccount, the EVM-side admin and factory ownership must be moved or renounced. Document who can re-create the ID: a sub-account can only be re-created by its parent.
    - Severity: Critical
    - Sources: https://docs.near.org/protocol/network/token-loss , https://docs.near.org/chain-abstraction/chain-signatures

15. **C15 Integer overflow in budget and fee math.** `gas_limit * max_fee` in u128, daily budget accumulation and delay arithmetic can overflow if release builds lack `overflow-checks = true` or checked arithmetic.
    - Test: check `[profile.release]` in Cargo.toml. Run property tests at `u64::MAX` and `u128::MAX` boundaries.
    - Severity: Medium
    - Source: https://docs.near.org/smart-contracts/security/checklist

16. **C16 JSON integer precision.** u64/u128 values sent as JSON numbers lose precision above 2^53 in JavaScript clients (CLI, MCP, frontends). Caps, fees and nonces must be `U64`/`U128` strings.
    - Test: send 2^53+1 and very large fees through the CLI/MCP path and compare the value stored on-chain.
    - Severity: Medium
    - Sources: https://docs.near.org/smart-contracts/anatomy/serialization

17. **C17 Timestamp and window assumptions.** `block_timestamp` is in nanoseconds. Daily budget windows and public delays built on it can suffer unit mix-ups (ms vs ns), off-by-one at the day rollover, and small producer-controlled drift.
    - Test: unit tests at each window boundary (t-1, t, t+1 ns) for the budget reset and for delay expiry.
    - Severity: Low
    - Status: drift magnitude **unverified**
    - Source: https://docs.near.org/smart-contracts/security/checklist

18. **C18 Unbounded inputs.** Long allow lists, init-code blobs, upgrade lists, derivation strings and duplicate entries cause gas or storage DoS.
    - Test: call every method with maximum-size inputs and with duplicate list entries. Assert length limits and dedupe before any write.
    - Severity: Medium
    - Source: https://docs.near.org/smart-contracts/security/checklist

## B. Chain Signatures / MPC

19. **C19 Arbitrary-hash signing.** The MPC signs whatever 32-byte payload the predecessor submits for its derived key. If any path lets a caller influence the hash beyond the allowed fields, the attacker can obtain other signatures from the derived key: an EIP-7702 authorization (`keccak(0x05||rlp(...))`), an EIP-712 permit, a legacy tx, or a tx for another chain.
    - Test: confirm the only input to `sign` is `keccak(0x02 || rlp(fields))` computed in-contract from validated fields. Fuzz the field builder: no input may produce a different type prefix or an unexpected RLP shape.
    - Severity: Critical
    - Sources: https://docs.near.org/chain-abstraction/chain-signatures , https://eips.ethereum.org/EIPS/eip-7702

20. **C20 Cross-chain replay.** One derived key serves every EVM chain. Replay protection is only the `chain_id` inside the EIP-1559 payload. The NEAR docs warn about chains whose payloads are not network-bound (the Wintermute/Optimism 2022 loss was a pre-EIP-155 replay).
    - Test: assert the RLP `chain_id` equals the rule key used for the nonce, factory and budget lookup. Try chain A's rules with chain B's id; it must fail.
    - Severity: High
    - Sources: https://docs.near.org/chain-abstraction/chain-signatures , https://slowmist.medium.com/slowmist-key-to-the-theft-of-20-million-op-tokens-transaction-replay-490baaf45f26

21. **C21 Derivation-path design and collisions.** The key is derived from (account, path, MPC root key). Problems arise if the path is user-controlled, if it differs between the code path and the off-chain address computation, or if a reused path is shared with another purpose.
    - Test: the path is a constant, or comes from a closed enum. Recompute the derived address off-chain with the MPC public key and compare it with what ecrecover returns.
    - Severity: Medium
    - Status: string-concatenation collision specifics **unverified**
    - Source: https://docs.near.org/chain-abstraction/chain-signatures

22. **C22 High-s malleability and recovery id.** Ethereum txs require low-s (EIP-2). The MPC returns (R, s, recovery_id), which must be normalized or rejected and mapped to the right `y_parity`. NEAR's `env::ecrecover` has a malleability flag that must be set.
    - Test: feed the high-s twin of a valid signature: reject. Feed a flipped recovery id: reject or recover to a different address.
    - Severity: Medium
    - Sources: https://eips.ethereum.org/EIPS/eip-2 , https://docs.rs/near-sdk/latest/near_sdk/env/fn.ecrecover.html

23. **C23 "Timed out" does not mean "not signed".** After a 200-block timeout, MPC nodes may still finish and expose the signature, for example in a failed respond transaction. If `resign` for the same nonce changes anything beyond fees (`to`, data, value), two valid conflicting txs can exist. **unverified inference.**
    - Test: re-signing at a given nonce may only bump fees and must keep identical to/data/value. Otherwise burn the nonce first. On testnet, inspect the MPC respond txs after a timeout.
    - Severity: High
    - Source: https://docs.near.org/smart-contracts/anatomy/yield-resume

24. **C24 Signed tx as a bearer instrument.** The returned raw tx is public in the NEAR receipt outcome, and anyone can broadcast it at any time until that nonce is consumed. The Solana parallel is Drift (April 2026), where pre-signed durable-nonce transactions stayed valid indefinitely. Narrowing rules does not revoke txs that are already signed.
    - Test: list all signed-but-unconsumed nonces per chain. Confirm that a narrowing step also burns or replaces outstanding nonces when needed.
    - Severity: High
    - Source: https://blocksec.com/blog/drift-protocol-incident-multisig-governance-compromise-via-durable-nonce-exploitation

25. **C25 MPC liveness and governance trust.** A threshold quorum of MPC operators can sign for any derived key. Participants change through `vote_new_parameters`. An MPC outage leaves requests stuck. The testnet signer's guarantees may differ from mainnet.
    - Reported state: mainnet 11-of-17 and fully inside Intel TDX TEEs (Oct 2026). **unverified**, repost source.
    - Test: document this trust assumption in SECURITY. Check that every flow survives a long MPC outage with no funds or permissions locked.
    - Severity: Medium (systemic)
    - Sources: https://docs.near.org/chain-abstraction/chain-signatures , https://youmind.com/landing/x-viral-articles/near-chain-signatures-tee-verification

26. **C26 MPC node-level residual risk.** The Trail of Bits review (2025-03) found 15 issues, 7 of them Medium, including P2P identity misbinding, unvalidated participant IDs, DB nonce reuse and unpinned CI actions. Later reviews cover PedPop+, CKD, Robust ECDSA (2026-02) and Foreign Transaction Validation (2026-06). None of the finding titles covers contract-level request/response matching.
    - Test: read the 2026-02 and 2026-06 reports for open items affecting `sign` and `verify_foreign_transaction`.
    - Severity: Info
    - Sources: https://trailofbits.com/library/near-one-mpc-chain-signatures/ , https://github.com/near/mpc/tree/main/audits

27. **C27 MPC interface drift.** The MPC contract keeps evolving (`domain_id`, new foreign-chain variants). An upgrade can change `sign` arguments, deposit or response encoding and break requests silently.
    - Test: a pinned integration test against the live `v1.signer-prod.testnet`, run in CI. The callback rejects unknown shapes into "stuck" state, never into "signed".
    - Severity: Medium
    - Sources: https://github.com/near/mpc/pull/3154 , https://docs.near.org/chain-abstraction/chain-signatures

28. **C28 Sign-cost spam.** Each `sign` call costs gas and a deposit, paid by the contract because function-call keys cannot attach deposits. An agent or stolen key looping requests drains the balance.
    - Test: a per-day request-count cap independent of the gas budget. Measure the cost per request on testnet.
    - Severity: Medium
    - Status: deposit amount **unverified**
    - Source: https://docs.near.org/protocol/accounts-contracts/access-keys

## C. Foreign-chain verification (Read MPC)

29. **C29 Insufficient finality.** The EVM finality options are `Latest`, `Safe` and `Finalized`. On OP-stack (Base), `unsafe` can be reorged by the sequencer and `safe` can be demoted by an L1 reorg. `finalized` comes about 20-30 minutes later.
    - Test: assert every request uses `Finalized`. Assert that nothing irreversible (rule change, state release) happens on lower finality.
    - Severity: High
    - Sources: https://docs.optimism.io/stack/transactions/transaction-finality , https://deepwiki.com/near/mpc/2.7-foreign-chain-transaction-verification

30. **C30 Event spoofing and weak log binding.** Anyone can emit a `Deployed(...)` or `Upgraded(address)` event from their own contract. The proof must bind chain, tx hash, log index, emitter address (factory or proxy), topic0 and data.
    - Test: deploy a contract that emits an identical event and submit its tx. It must be rejected because the emitter does not match. Also try the right tx with a wrong log index.
    - Severity: Critical
    - Sources: https://deepwiki.com/near/mpc/2.7-foreign-chain-transaction-verification (EvmLog extractor at index) , https://github.com/near/mpc/tree/main/audits (2026-06 Foreign Transaction Validation review)

31. **C31 Expected-payload-hash mismatch.** The contract must recompute the expected payload hash from its own request plus the expected values, and accept only a result delivered by the MPC contract through a private callback.
    - Test: mutate one byte of each expected field (address, implementation, salt, chain); verification must fail. Call the verify callback directly; it must be rejected (C1).
    - Severity: High
    - Source: https://deepwiki.com/near/mpc/2.7-foreign-chain-transaction-verification

32. **C32 Receipt status ignored.** "Tx exists" is not "tx succeeded". The binding must cover status = 1 or rely on the log only appearing in a successful receipt. Also check the case where the event comes from a call that later reverted.
    - Test: submit a reverted deploy or upgrade tx hash. It must be rejected.
    - Severity: Medium
    - Status: exact extractor semantics **unverified**
    - Source: https://deepwiki.com/near/mpc/2.7-foreign-chain-transaction-verification

33. **C33 RPC-provider trust.** The nodes reportedly query a whitelisted quorum of RPC providers (at least 3 of 5). Colluding or compromised providers could feed false receipts. Verification is only as strong as that quorum plus the MPC threshold.
    - Test: document as a trust assumption. Optionally cross-check high-value confirmations off-chain.
    - Severity: Medium
    - Status: **unverified** (repost source)
    - Source: https://youmind.com/landing/x-viral-articles/near-chain-signatures-tee-verification

34. **C34 Testnet halts and non-finality.** Holesky went about 2 weeks without finality (Feb 2025), and Sepolia produced empty blocks after Pectra (Mar 2025). `Finalized` may never arrive, so pending verifications must expire safely.
    - Test: simulate a verification that never completes. Assert no funds, nonces or permissions stay locked and retry works.
    - Severity: Low
    - Sources: https://www.theblock.co/amp/post/345622/ethereums-holesky-testnet-regains-finality-after-weeks-of-disruption-amid-pectra-testing , https://ethereum-magicians.org/t/client-testing-call-28-march-10th-2025/23107

## D. EVM side

35. **C35 CREATE2 front-running and address squatting.** If a factory is callable by anyone, or the salt is not bound to the caller, an attacker pre-deploys at the predicted address. The result is DoS or foreign code at the expected address.
    - Test: call the factory from a random EOA; it must revert. Confirm the salt is bound to the caller or the factory is owner-only.
    - Severity: High
    - Source: https://scs.owasp.org/SCWE/SCSVS-ARCH/SCWE-051/

36. **C36 "Same address on every chain" assumption.** A factory address valid on chain A may be empty or attacker-deployed on chain B. Wintermute lost 20M OP in 2022 because its Safe existed only on mainnet and the deployment was replayed on Optimism.
    - Test: run `eth_getCode` on every configured factory and proxy per chain, compare runtime hashes against expected, and re-check after any rules change.
    - Severity: High
    - Sources: https://rekt.news/wintermute-rekt , https://slowmist.medium.com/slowmist-key-to-the-theft-of-20-million-op-tokens-transaction-replay-490baaf45f26

37. **C37 Metamorphic code behind an allowed init-code hash.** An allowed init-code hash pins the runtime code only if the init code is self-contained. A loader that copies code from storage or another contract, or a same-transaction SELFDESTRUCT-and-redeploy (still possible after EIP-6780), breaks that link.
    - Test: disassemble each allowed init code and look for EXTCODECOPY, CALL or DELEGATECALL used to fetch code. After deploy, verify `keccak(runtime)` against the expected value.
    - Severity: Medium
    - Sources: https://eips.ethereum.org/EIPS/eip-6780 , https://rekt.news/tornado-gov-rekt

38. **C38 Uninitialized implementation or initializer front-run.** A new implementation deployed via the factory, or a proxy upgraded without init, can be initialized by anyone. Wormhole paid a $10M bounty for an uninitialized UUPS implementation that could be selfdestructed.
    - Test: for each allowed implementation, call `initialize` from a random EOA on both the implementation and the proxy; both must revert. Require `_disableInitializers()` in the constructor.
    - Severity: High
    - Sources: https://immunefi.com/blog/bug-fix-reviews/wormhole-uninitialized-proxy-bugfix-review/ , https://scs.owasp.org/sctop10/SC10-ProxyAndUpgradeabilityVulnerabilities/

39. **C39 Storage-layout collision on upgrade.** Reordered or inserted variables, changed inheritance order, missing `__gap`, or an OpenZeppelin major-version jump corrupt treasury state.
    - Test: run the OZ Upgrades validation or a storage-layout diff for every pair in the exact-upgrade allow list before adding it.
    - Severity: High
    - Sources: https://scs.owasp.org/sctop10/SC10-ProxyAndUpgradeabilityVulnerabilities/ , https://forum.openzeppelin.com/t/emergency-uups-proxy-contract-not-working-after-using-zeppelin-upgradeable-v5-0-0/41076

40. **C40 `upgradeTo` selector mismatch or clash.** OZ v5.0 UUPS exposes only `upgradeToAndCall`. If the proxy forwards unknown selectors, a signed `upgradeTo` may hit the implementation's fallback and silently do nothing. Proxy-level admin selectors can also clash with implementation selectors.
    - Test: on a fork, execute the signed `upgradeTo`. Assert that the ERC-1967 implementation slot changed and `Upgraded` was emitted. Diff the proxy and implementation selector sets for clashes.
    - Severity: Medium
    - Sources: https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/proxy/utils/UUPSUpgradeable.sol , https://forum.openzeppelin.com/t/problem-with-uups-proxy-upgrade-uupsunauthorizedcallcontext-error-when-using-upgradetoandcall-in-openzeppelin-5-0-0/39181

41. **C41 Upgrade to a non-contract or wrong contract.** Setting the implementation to an EOA, to a not-yet-deployed CREATE2 address, or to a non-UUPS contract bricks the treasury. In UUPS, losing the upgrade function is permanent.
    - Test: before signing, confirm the target implementation has code on that chain (Read MPC `Deployed` proof or an off-chain check) and passes the proxiable check. Try an EOA target on a fork.
    - Severity: High
    - Source: https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/proxy/utils/UUPSUpgradeable.sol

42. **C42 SELFDESTRUCT or arbitrary DELEGATECALL in an implementation.** After EIP-6780, SELFDESTRUCT in proxy context no longer deletes code unless the contract was created in the same tx, but it still sweeps ETH. An arbitrary DELEGATECALL lets anything overwrite the admin slot.
    - Test: scan allowed implementation bytecode for SELFDESTRUCT and for DELEGATECALL to a non-constant target.
    - Severity: Medium
    - Source: https://eips.ethereum.org/EIPS/eip-6780

43. **C43 EIP-7702 on a keyless derived EOA.** The derived address is an ordinary EOA to Ethereum. One MPC-signed authorization (type-4 tx or the `0x05` hash) attaches code to it. The delegation persists even if the tx reverts and increments the nonce. A `chain_id = 0` authorization is valid on every chain. Separately, `tx.origin` and EXTCODESIZE "EOA-only" checks in the treasury or factory are no longer reliable.
    - Test: the builder emits only type `0x02`. Monitor `eth_getCode(derived)` per chain and alert if it is non-empty. Grep the EVM code for `tx.origin` and `extcodesize` gates.
    - Severity: High
    - Sources: https://eips.ethereum.org/EIPS/eip-7702 , https://docs.chainstack.com/docs/ethereum-eip-7702-tutorial

44. **C44 Nonce gaps and stuck transactions.** The contract-side nonce can drift from the chain nonce: a signed tx is never broadcast, n+1 is broadcast before n, or an external tx consumes a nonce. A replacement needs about a 10% bump on both `maxFeePerGas` and `maxPriorityFeePerGas`, and fee caps may forbid that bump.
    - Test: on testnet, sign n and n+1, broadcast only n+1, then run the release/resign flow. Assert the fee caps leave at least 10% headroom for a replacement.
    - Severity: Medium
    - Sources: https://reth.rs/docs/src/reth_transaction_pool/config.rs.html , https://github.com/trufflesuite/ganache/discussions/1664

45. **C45 EIP-1559 fee-field pitfalls.**
    - `maxPriorityFeePerGas > maxFeePerGas` is invalid.
    - `maxFee` below a rising base fee (up to +12.5% per block) is never included.
    - A priority fee of 0 may starve on busy chains.
    - Test: unit-test the validator rejects priority > max. Simulate a base-fee spike and confirm the stuck path (C44) is reachable.
    - Severity: Low
    - Source: https://eips.ethereum.org/EIPS/eip-1559

46. **C46 OP-stack fees outside the gas budget.** On Base, the total fee is the L2 fee plus the L1 data fee plus the operator fee. A budget computed as `gas_limit * maxFee` understates real spend. Since Jovian, a configurable minimum base fee and the DA footprint also push the base fee up.
    - Test: compare the contract's budget accounting with actual receipt costs (including the `l1Fee` field) on Base Sepolia. Cap init-code size, since it drives the L1 data fee.
    - Severity: Medium
    - Sources: https://docs.optimism.io/chain-operators/guides/management/transaction-fees-101 , https://specs.optimism.io/protocol/jovian/exec-engine.html

47. **C47 EIP-7825 per-tx gas cap of 2^24 (Fusaka).** A tx signed with a gas limit above 16,777,216 is invalid, which leaves a dead nonce if the contract counts it as sent.
    - Test: the rules reject a gas limit above 2^24 on every chain. Request 2^24+1; it must be rejected before `sign`.
    - Severity: Low
    - Source: https://blog.ethereum.org/2025/10/21/fusaka-gascap-update

48. **C48 Calldata floor (EIP-7623) and init-code limit (EIP-3860).** A deploy tx with large init code must have a gas limit of at least 21000 plus the floor cost of its calldata tokens. The floor applies after execution, so a too-low limit runs out of gas after an otherwise successful execution, consuming the nonce and the budget.
    - Test: for each allowed init code, compute the intrinsic gas plus the floor and assert the minimum gas limit enforced by the rules is above it. Also check the size is within 49152 bytes.
    - Severity: Medium
    - Sources: https://eips.ethereum.org/EIPS/eip-7623 , https://eips.ethereum.org/EIPS/eip-3860

49. **C49 Glamsterdam state-growth repricing (EIP-8037/8038).** Creating state (deployed bytecode, new slots, new accounts) moves to a separate, higher "state gas" meter. Fixed gas caps for deploys and first writes may become too low.
    - Status: on Platåberget devnet since Aug 2026. Public-testnet timing is not confirmed by EF; Alchemy says Sepolia activated (**unverified**).
    - Test: run the deploy and upgrade flows on the Glamsterdam devnet. Make sure the per-chain gas caps can be raised through the normal widening path.
    - Severity: Medium
    - Sources: https://blog.ethereum.org/2026/08/24/glamsterdam-repricing-testing , https://www.alchemy.com/blog/glamsterdam-ethereum-upgrade

## E. Governance, timelock, multisig

50. **C50 Widening disguised as narrowing (timelock bypass).** Some changes classed as "narrowing" actually widen what can be signed, so they skip the public delay. Examples: replacing a hash (remove plus add), changing the factory or proxy address, lowering the delay, raising a cap through a different field, removing a chain and then re-adding it.
    - Test: enumerate every rule mutation. Property test: any change that enlarges the set of signable txs must wait the delay. The delay value itself may only grow immediately, never shrink immediately.
    - Severity: Critical
    - Sources: https://blocksec.com/blog/drift-protocol-incident-multisig-governance-compromise-via-durable-nonce-exploitation , https://codehawks.cyfrin.io/c/2025-12-multisig-timelock/s/21

51. **C51 Signer device compromise and blind signing.** In Bybit (Feb 2025, $1.4-1.5B), Radiant (Oct 2024, about $50M, 3-of-11) and WazirX (Jul 2024, about $230M), signers approved what a compromised UI or device showed. Malware swapped the payload, and hardware wallets blind-signed.
    - Test: every council action is shown by an independent decoder (CLI on a second machine) with method, args and code sha256. Signers verify on their own device. Run a drill with a deliberately altered payload.
    - Severity: High
    - Sources: https://www.bleepingcomputer.com/news/security/lazarus-hacked-bybit-via-a-breached-safe-wallet-developer-machine/ , https://rekt.news/radiant-capital-rekt2

52. **C52 Long-lived approvals.** Votes or approvals that never expire, or that survive a council membership change, let an attacker collect them over time and execute when it suits them. Drift (Apr 2026, about $280M) shows the pattern: 2-of-5, zero timelock, months of social engineering.
    - Test: cast a vote, rotate a member, and assert the pending votes are cleared. Confirm votes carry an expiry. Confirm there is no transient lower-threshold state during role migrations.
    - Severity: High
    - Sources: https://blocksec.com/blog/drift-protocol-incident-multisig-governance-compromise-via-durable-nonce-exploitation , https://en.wikipedia.org/wiki/2024_WazirX_hack

53. **C53 Proposal spam and cancel griefing.** One role can flood the proposal queue (state growth, C7) or repeatedly cancel legitimate widenings, which is a liveness attack. Also check whether a low-privilege role can cancel or veto at all.
    - Test: cap open proposals per role. Write down which roles can cancel and confirm a cancel cannot be repeated to block a 2-of-3 decision forever.
    - Severity: Medium
    - Source: https://arxiv.org/pdf/2406.15071

54. **C54 Delay without watchers.** A public delay protects only if someone sees the proposal and can narrow, cancel or retire before it lands. NEAR's checklist calls for alerting on failed callbacks and unusual activity.
    - Test: an alert fires on every widening proposal and every staged code hash. Run a guardian-veto drill within the delay window.
    - Severity: Medium
    - Sources: https://docs.near.org/smart-contracts/security/checklist , https://blocksec.com/blog/drift-protocol-incident-multisig-governance-compromise-via-durable-nonce-exploitation

## F. Supply chain and build

55. **C55 Non-reproducible upgrade artifact.** If the wasm staged for self-upgrade cannot be rebuilt bit-for-bit from a tagged source, reviewers approve a hash they cannot tie to code. NEP-330 and cargo-near pin the Docker image by digest and expose `contract_source_metadata`.
    - Test: rebuild from the tag in the pinned image. Compare `sha256` with the stored-code hash and with the deployed `code_hash`.
    - Severity: High
    - Sources: https://github.com/near/NEPs/blob/master/neps/nep-0330.md , https://docs.near.org/smart-contracts/anatomy/reproducible-builds

56. **C56 Malicious crate.** In 2025, `faster_log` and `async_println` typosquatted `fast_log` and stole Ethereum and Solana keys at runtime. The CLI/MCP host holds the agent's function-call key.
    - Test: commit `Cargo.lock`, run `cargo deny` / `cargo audit`, and review every new or renamed dependency. Run the CLI with the key in an OS keystore, not a plaintext file.
    - Severity: High
    - Source: https://blog.rust-lang.org/2025/09/24/crates.io-malicious-crates-fasterlog-and-asyncprintln

57. **C57 npm worm (Shai-Hulud, Sep 2025, v2 Nov 2025).** It stole npm, GitHub and CI tokens from developer machines and CI and republished itself. It is relevant to EVM tooling (hardhat, viem, ethers) and any JS MCP server.
    - Test: use lockfiles and `npm ci --ignore-scripts`, keep no long-lived publish tokens, check for Shai-Hulud IOCs (a `Shai-Hulud` repo, unknown workflows).
    - Severity: High
    - Sources: https://dev.to/xygenisecurity/shai-hulud-the-npm-packages-worm-explained-2p2i , https://www.upwind.io/?p=14565

58. **C58 Hijacked or unpinned CI actions.** tj-actions/changed-files (CVE-2025-30066, Mar 2025) had its tags repointed to a commit that leaked secrets into logs. Trail of Bits flagged unpinned actions even in the NEAR MPC repo.
    - Test: pin every action by commit SHA, use a minimal `GITHUB_TOKEN`, and keep no keys in CI (the contract is keyless; the agent key never goes to CI).
    - Severity: Medium
    - Sources: https://thehackernews.com/2025/03/github-action-compromise-puts-cicd.html , https://trailofbits.com/library/near-one-mpc-chain-signatures/

59. **C59 Agent-key exposure on the operator host.** The 8-method function-call key lives wherever the agent runs. A compromise gives the attacker every agent request within the rules, plus the allowance drain (C8). A rotation path is needed that does not depend on a full-access key.
    - Test: confirm the council can remove and add the agent key on-chain. Confirm key file permissions and storage. Rehearse the rotation.
    - Severity: Medium
    - Status: design-specific, **unverified** against an external source
    - Sources: https://docs.near.org/protocol/accounts-contracts/access-keys , https://www.zellic.io/blog/near-protocol-bug (context: protocol-level DoS bugs exist even in NEAR's networking layer)

---

### Test these first (highest severity for this design)
C19 arbitrary-hash signing, C30 event spoofing, C50 widening-as-narrowing, C11 borsh brick, C14 account-ID re-registration, C1 unguarded callbacks, C3 callback out-of-gas, C23/C24 timed-out and bearer signatures, C43 EIP-7702, C38/C41 proxy init and upgrade target.

### Gaps (could not confirm from a primary source)
- The official near/mpc `foreign-chain` spec file could not be fetched (rate-limited and 404). Finality and log-binding details come from DeepWiki summaries and PR #3154.
- The TEE, 11-of-17 and RPC 3-of-5 claims come only from reposts of an Oct 2026 NEAR announcement.
- The Glamsterdam public-testnet date is not confirmed by EF.
- No Zellic or Halborn audit of NEAR Chain Signatures was found. The audits found are Trail of Bits (x4), plus a 2026-06 Foreign Transaction Validation review, and Hacken (2025-02) for Sig.Network's EVM-side contract, which is a different product.
