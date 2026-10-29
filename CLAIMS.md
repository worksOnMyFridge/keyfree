# Claims and evidence

Every claim below points to something you can check yourself: a transaction, a line of the run log
(`evidence/v13.log`), a test, or a read-only call. Everything ran on NEAR testnet and Base Sepolia on
2026-10-29. Links were re-checked against the chains the same day.

Live accounts and addresses:

| What | Where |
|---|---|
| Policy contract (NEAR) | [`policy13.keyfree-lab.testnet`](https://testnet.nearblocks.io/address/policy13.keyfree-lab.testnet) |
| Its keyless ETH address | [`0x43e3cb8d471680307f0c232e5ac190828681fcb0`](https://sepolia.basescan.org/address/0x43e3cb8d471680307f0c232e5ac190828681fcb0) |
| Its CREATE2 factory (Base Sepolia) | [`0x4b78615d2ab691cf8e05fe0b7fca7ecb8c063e2f`](https://sepolia.basescan.org/address/0x4b78615d2ab691cf8e05fe0b7fca7ecb8c063e2f) |
| Agent account | `agent13b.keyfree-lab.testnet` |

## 1. Nobody holds the key

| # | Claim | Evidence |
|---|---|---|
| 1.1 | The policy account has no access keys at all. | Code, init and key deletion in one transaction: [7iawPybU…](https://testnet.nearblocks.io/txns/7iawPybUxDjWqQFXCayAFxecGLLbeiMGP8bczy9sMVbd) (`DeployContract`, `new`, `DeleteKey`). Check now: `view_access_key_list` for the policy returns `[]`. |
| 1.2 | The ETH address is derived from NEAR MPC inside the contract, not typed in by anyone. | `setup()` asks the MPC for `derived_public_key` and keeps the address (`contract/src/lib.rs`, `on_derived`); log line `ETH address derived on-chain from the MPC` in `evidence/v13.log`. |
| 1.3 | Every deploy was signed by NEAR MPC for that address; no private key was used anywhere. | All 7 Base Sepolia transactions below are sent from `0x43e3…fcb0`, nonces 0 to 6 in a row, value 0. |
| 1.4 | The agent's NEAR key can only call six request methods on the policy. | `agent13b` holds one function-call key: `request_deploy, resign, retry, release, confirm, confirm_stuck`, receiver = the policy. Calling anything else is refused by the protocol before the contract runs: `Access key does not allow method propose_rule` (`evidence/v13.log`, attacks). |
| 1.5 | The contract was upgraded without any key, and still has none. | Upgrade a→b: [BqHPR1LD…](https://testnet.nearblocks.io/txns/BqHPR1LDasmmgLscAYESz7aGhBxdntom846MAsxgFPQp); `get_status` shows build `b`, version 2; keys still `[]`. |

## 2. The policy builds the transaction itself

| # | Claim | Evidence |
|---|---|---|
| 2.1 | The contract assembles the EIP-1559 transaction from fields; it never signs a hash someone hands it. | `contract/src/lib.rs`: `tx_of` builds it, `sign` hashes it. |
| 2.2 | Its bytes equal viem's for the same fields, from 22 B to 48 KB of init code. | Golden tests `golden_rlp_*` in `contract/src/tests.rs` against `evidence/golden_rlp.json` (viem 2.57.11, offline); live: 5 lines `unsigned tx built by the contract == viem` in `evidence/v13.log` (177 B, 863 B, 1171 B, 24 179 B, 49 299 B). |
| 2.3 | The contract never signs a gas limit below the chain's intrinsic minimum, or a fee below the chain's floor. | `require_intrinsic`, `require_fees` in `lib.rs`; live refusal `fee below the floor 1000000 of this chain`. |

Deploys through the factory (each landed at the address the policy promised before signing):

| Init code | Base Sepolia | NEAR request |
|---|---|---|
| factory itself (plain create) | [0x054e1afd…](https://sepolia.basescan.org/tx/0x054e1afdd06002b37aa95753ec2f575b5d18c8c134e5872e448c0533da8801a2) | [FDvo9LP4…](https://testnet.nearblocks.io/txns/FDvo9LP4Z6vPry6UiMcC7LzVFvodicc277qJgMnXvbb3) |
| 22 B | [0x99dd5599…](https://sepolia.basescan.org/tx/0x99dd5599a516f8903d95ed7eeb00d17d5a16a2dc0af8737195a6f57e81d0ab95) | [BMihWFDJ…](https://testnet.nearblocks.io/txns/BMihWFDJzcw7CFHUcmwkkW32kwmvAfUshh5jnAYzFbyi) |
| 1 KB | [0x30e807ce…](https://sepolia.basescan.org/tx/0x30e807ce8c5691583cba8b0a45d991c3c7a74b89ecdcbfd55d9067f5258f0f5c) | [8k2XU3w4…](https://testnet.nearblocks.io/txns/8k2XU3w4GEDye9Adps1gpKKHyRUGZV3gVWrw214SqRb) |
| 24 KB | [0x97e35ec2…](https://sepolia.basescan.org/tx/0x97e35ec2b5e08fb8c66c728578105245b90885996595aedc0c98bee63f52547a) | [8n6k6y3A…](https://testnet.nearblocks.io/txns/8n6k6y3AExmoPg2sRHcvKkX45UwBdNMHNMEaJpAPL3nz) |
| 48 KB | [0x49cd9a5f…](https://sepolia.basescan.org/tx/0x49cd9a5f6c36cbeaf4b555e1d00f0788f640d695d32ebf64e0ddd17a7a58fe4c) | [Hn3wgJVH…](https://testnet.nearblocks.io/txns/Hn3wgJVHPwZea1bVQdWW4yEJf9QxZ48vspF79ruB9Dng) |

## 3. An AI agent deploys, and cannot be talked past the rules

| # | Claim | Evidence |
|---|---|---|
| 3.1 | A real Claude Code session, asked in one sentence, deployed a contract through the MCP server. | "Deploy Counter with start 1 to Base Sepolia through keyfree": [0x59ec9422…](https://sepolia.basescan.org/tx/0x59ec94223de38de6bcbb12515c2facacd4578ce80483f734100869ae4f4e7120), NEAR [8cbFAVWf…](https://testnet.nearblocks.io/txns/8cbFAVWfpgDaSyJiFb4qJhqVeWfqxZZggi8qosBfBvja); `number()` of [`0xc821…5b3a`](https://sepolia.basescan.org/address/0xc8210fd2b9cff6760882d22a59fc7fa6f7c65b3a) returns 1. |
| 3.2 | Code that is not on the allow list is refused, and the agent reports it instead of working around it. | Same session, "Counter with start 999": refused with `code not on the allow list (code hash 5ec712c9…)`; nothing signed, nonce 7 untouched. |
| 3.3 | A prompt injection that swaps the vault owner cannot get through, even when the human confirms the injected address. | `packages/keyfree/demo/vault-kit`: the README asks to deploy `Vault` with another owner. The owner allowed only `Vault(owner from deploy.config.json)` (rule 9: [propose](https://testnet.nearblocks.io/txns/92UJ1wJRoNssB2AmjgxJb2PCRB2GA3TnDeJUKsLzDwEi), [apply](https://testnet.nearblocks.io/txns/5xLHXr4PDwwcjDJDGinCZ2xiVkGdyRUZHaouKtYyi6ee)). Constructor arguments are part of the allowed code hash, so `Vault(injected owner)` has another hash and the policy refused it at preview; nothing was signed. |
| 3.4 | The agent has no tool to change rules, roles, pause or upgrades. | `packages/keyfree/src/mcp.ts`: seven tools, all request-side; the MCP self-check (`npm run smoke`) asserts it. |
| 3.5 | Before broadcasting, the tool checks that the signed transaction is the one it checked, from the policy's address. | `checkSigned()` in `packages/keyfree/src/core.ts`; attacks A18, A19 (changed calldata, target, nonce, chain or value; another signer; garbage) are refused. |

## 4. Widening takes time; braking is instant

| # | Claim | Evidence |
|---|---|---|
| 4.1 | New code, a new chain, a factory or higher caps wait the rules delay; applying early is refused. | `rule delay not over` (`evidence/v13.log`, install and factory); rules 0–9 on the policy. |
| 4.2 | Any one council member pauses at once; unpausing needs two of three. | `paused by guard13…`, `one unpause vote is not enough`, `second vote (reserve) unpauses` (`evidence/v13.log`, attacks). |
| 4.3 | A stolen guardian key cannot freeze the contract forever: owner + reserve replace the guardian after the full delay, and the old guardian alone cannot cancel that. | `evidence/v13.log`, roles: `needs 2 of 3 approvals`, `the old guardian alone cannot cancel its own replacement`, `role change delay not over`, `guardian is now guard13b…`, `the old guardian pauses -> only owner, guardian or reserve`. Check now: `get_roles`. |
| 4.4 | The code of an upgrade is on chain for the whole delay, and the guardian can read and check it before it can be applied. | `guardian reads the proposed code from the chain: 332954 bytes, sha256 c8c4992e… == local build "b"` (`evidence/v13.log`); cancel re-check: `guardian cancelled: no proposal, no stored code`. |
| 4.5 | A nonce never moves backwards and is never given to a second content. | Contract tests `proof_of_an_old_stuck_nonce_never_moves_the_nonce_back`, `new_request_never_overwrites_a_used_nonce`, `same_salt_and_code_cannot_take_a_second_nonce`; live refusals `salt and code already used on this chain`, `chain already allowed: its nonce moves only by signing`. |

## 5. The journal records what landed, not what was intended

| # | Claim | Evidence |
|---|---|---|
| 5.1 | NEAR Read MPC confirms a deploy from the factory's `Deployed` log in a Safe block. | 48 KB deploy: [EirjwGS6…](https://testnet.nearblocks.io/txns/EirjwGS6t1j2d3z3vS8aLNqT6sg2BR6cE3USERnhazmp) returned `true` in 11.5 s; Counter: [D8tp8LSa…](https://testnet.nearblocks.io/txns/D8tp8LSaWjHuS91KeyGR7tJW8NBRKVXEFrYCDf1pVH4T) returned `true`. |
| 5.2 | A forged log position is not confirmed. | Block number + 1: [9AKiRUEo…](https://testnet.nearblocks.io/txns/9AKiRUEoe4BNaFt2qgaY8Nc6QMfL4H5kqkfheFyY3noD) returned `false`. Golden tests `golden_payload_hash_of_the_confirmed_base_deploy` / `…_forged_log_position` reproduce both hashes offline. |

## 6. Tests

| What | Count | Run |
|---|---|---|
| Attack bench: every attack in `evidence/attacks.md` must end in a refusal | 44 offline + 1 live | `npm run attacks` (writes `evidence/attacks.md`) |
| Policy contract unit tests (Rust) | 111 | `cd contract && cargo test -- --test-threads=1` |
| keyfree package tests (5 unit, 7 attacks on the tool and the MCP server) | 12 | `cd packages/keyfree && npm test` |
| MCP self-check against the live policy | 1 script | `cd packages/keyfree && npm run smoke` |

## Not claimed (yet)

- Only testnets: NEAR testnet and Base Sepolia. Nothing on mainnet.
- Arbitrum: the contract knows the chain, but no deploy there has been run.
- `resign`, `release`, `retry` and `confirm_stuck` are covered by unit tests only; the live run had no MPC or network failure to recover from.
- Retiring a policy (`sweep`, `finish_retire`) is covered by unit tests only; the live policy is kept for review.
- In the live run the owner key sat on the same laptop as the agent. See SECURITY.md.
