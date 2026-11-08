# Sandbox run

Run: `.github/workflows/sandbox.yml` (or `npm run test:sandbox` with POLICY_WASM and MOCK_WASM).

The policy's wasm (sha256 `72edd42bc4f18be81824ab7697ac74f885ede59d8c393325513b3cdb8f6db14c`, 385621 bytes) in a local nearcore sandbox 2.13.4,
next to a stand-in MPC contract (`sandbox/mock-mpc`). Real accounts and keys, gas, storage, promises and callbacks.

## Who may call what

Each method called by each account on a fresh policy. ✓ = past the role check (it may still refuse for
another reason), – = refused for the caller's role.

| Method | stranger | agent | guardian | reserve | owner |
|---|---|---|---|---|---|
| `new` | – | – | – | – | – |
| `migrate (private)` | – | – | – | – | – |
| `on_derived (private)` | – | – | – | – | – |
| `on_signed (private)` | – | – | – | – | – |
| `on_confirmed (private)` | – | – | – | – | – |
| `on_stuck_confirmed (private)` | – | – | – | – | – |
| `propose_role (guardian, reserve, owner, retire)` | – | – | ✓ | ✓ | ✓ |
| `propose_role (a new agent)` | – | – | – | – | ✓ |
| `approve_role` | – | – | ✓ | ✓ | ✓ |
| `cancel_role` | – | – | ✓ | ✓ | ✓ |
| `apply_role` | – | – | ✓ | ✓ | ✓ |
| `sweep` | – | – | ✓ | ✓ | ✓ |
| `finish_retire` | – | – | ✓ | ✓ | ✓ |
| `propose_upgrade` | – | – | – | – | ✓ |
| `cancel_upgrade` | – | – | ✓ | ✓ | ✓ |
| `apply_upgrade` | – | – | – | – | ✓ |
| `pause` | – | – | ✓ | ✓ | ✓ |
| `unpause` | – | – | ✓ | ✓ | ✓ |
| `setup` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `propose_rule` | – | – | – | – | ✓ |
| `cancel_rule` | – | – | ✓ | ✓ | ✓ |
| `apply_rule` | – | – | ✓ | ✓ | ✓ |
| `remove_code` | – | – | ✓ | ✓ | ✓ |
| `disable_chain` | – | – | ✓ | ✓ | ✓ |
| `remove_factory` | – | – | ✓ | ✓ | ✓ |
| `remove_proxy_upgrade` | – | – | ✓ | ✓ | ✓ |
| `lower_limits` | – | – | ✓ | ✓ | ✓ |
| `lower_budget` | – | – | ✓ | ✓ | ✓ |
| `request_deploy` | – | ✓ | – | – | ✓ |
| `request_proxy_upgrade` | – | ✓ | – | – | ✓ |
| `resign` | – | ✓ | – | – | ✓ |
| `resign_proxy_upgrade` | – | ✓ | – | – | ✓ |
| `retry` | – | ✓ | – | – | ✓ |
| `release` | – | ✓ | – | – | ✓ |
| `confirm` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `confirm_stuck` | – | ✓ | – | – | ✓ |
| `revoke_agent` | – | – | ✓ | ✓ | ✓ |

Read-only methods, callable by anyone without a transaction: `get_roles`, `get_status`, `get_rules`, `get_budget`, `get_proposed_code`, `get_entry`, `get_eth_address`, `get_next_nonce`, `get_open`, `preview`, `preview_proxy_upgrade`.

## Checks

- installed policy.sandbox in one transaction: 0 access keys, code hash = the wasm under test, build v20; init again refused for every account
- access matrix: 37 rows x 5 accounts as real transactions, 11 read-only methods; every role check as designed (table above)
- setup (anyone may call it): the policy derived 0x8a711a19d8cb5f0bd71702a7769bdcaa30a1ad77 for (its own account, keyfree-1); a second setup is refused
- rules: 5 proposed by the owner; refused for agent and guardian, refused before the delay, applied by the guardian after it; a budget of 12345678901234567891 wei reads back exactly
- a chain opened without a budget: preview and the agent's request refused with no daily budget on chain 11155111; the MPC was not asked, the nonce did not move, no journal line
- plain deploy by the agent's function-call key: signed tx == preview == viem, low s, recovers to 0x8a711a19d8cb5f0bd71702a7769bdcaa30a1ad77; nonce 0 -> 1; journal line "signed" with the tx hash
- factory deploy: expected address == viem CREATE2, tx goes to the factory with deploy(salt, code); the same salt+code is refused a second nonce; a failed Read MPC answer leaves "signed", a good one gives "confirmed" for the tx hash the policy signed
- MPC answers panic, garbage, not_json, huge, other_key (a failure, garbage, not JSON, 20 KB, another key's signature): no callback panicked, nonce 2 stayed bound to the same deploy, a new request was refused meanwhile; a high-s answer is flipped and the retry signs exactly the previewed deploy
- proxy upgrade: the signed tx is upgradeTo(implementation) to the allowed proxy, nonce 3; the same upgrade is refused a second time
- roles: revoked by the reserve at once; a new agent proposed by the owner (the guardian may not), refused before the 6 s delay, applied after it; the new agent signs (nonce 4), the old one is refused
- budget: 10 signatures counted today (failed attempts and retries included) with 16200000000000000 wei of worst-case gas; the reserve lowered the limit to 10 at once and the 11th was refused, in preview too; raising it at once was refused
- upgrade: a wasm without migrate was proposed and applied after the delay: the batch failed, the old code (same hash) and the proposal stayed (N17); a guardian cancelled it; the policy's own wasm then upgraded it with no key: version 2, journal and rules kept, still 0 keys
- retirement: beneficiary must be a council member; 1 of 3 refused, applied after the delay with 2 of 3; then requests and rules are refused, the state swept to 0, 16847 milliNEAR went to the guardian, the account stays with its code and 0 keys
- late MPC answer (yield and resume, like the real contract): while it waited, another request and release were refused; a pause in between stopped new requests, and the answer that came after the pause still gave the previewed transaction, nonce 0 -> 1
- no MPC answer: after a 260-block fast-forward, the request was parked on nonce 0 by the runtime's yield timeout (no signature, nonce unmoved), a new request was refused, and retry then signed exactly the previewed deploy
- two requests sent at once (agent and owner): 1 signed with nonces 0, 1 refused as "another request is being signed"; never one nonce twice
- storage: a policy with 3.96 NEAR could not store a 49 152-byte request (LackBalanceForState): nothing changed and the MPC was never asked; 1 NEAR sent by a stranger, and the same request was signed (83.8 Tgas); 49 153 bytes is refused
- the real tool on this contract, with a local EVM node failing on purpose: no MPC answer (retry waits, then releases and re-signs, the contract naming its fee floor on the way); a refused broadcast of a deploy (a new deploy stopped, other code refused with no signature spent, resign lands the promised 0x68a23f85ed7b5628c2a4f3d921a2b62d6bb1131d); the same for a proxy upgrade (resign_proxy_upgrade). All on the same nonces.

## Gas

| Call | Tgas burnt |
|---|---|
| request_deploy + MPC sign + on_signed (factory, plain create, 836 bytes) | 20.1 |
| request_deploy + MPC sign + on_signed (Counter through the factory) | 20.1 |
| confirm + Read MPC + on_confirmed | 6.8 |
| propose_upgrade (385621 bytes as the call input) | 47.3 |
| apply_upgrade (deploy itself + migrate, one batch) | 56.1 |
| propose_upgrade of the stand-in | 23.4 |
| finish_retire (transfer of the free NEAR) | 2.7 |
| request_deploy + MPC sign + on_signed (the largest allowed code, 49 152 bytes) | 83.8 |
