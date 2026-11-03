# Claims and evidence

Every claim below points to something you can check yourself: a transaction, a line of the run log
(`evidence/v13.log`, `evidence/v14.log`, `evidence/ethereum.log`), a test, or a read-only call. Everything
ran on NEAR testnet and Base Sepolia on 2026-10-29, and on Ethereum Sepolia on 2026-11-01. `npm run check:claims`
checks every link here against the chains, every quoted log line against its log, and every count against the
repository, read-only (`evidence/claims_check.md`); the `live` workflow runs it daily.

Live accounts and addresses:

| What | Where |
|---|---|
| Policy contract (NEAR) | [`policy13.keyfree-lab.testnet`](https://testnet.nearblocks.io/address/policy13.keyfree-lab.testnet) |
| Its keyless ETH address | [`0x43e3cb8d471680307f0c232e5ac190828681fcb0`](https://sepolia.basescan.org/address/0x43e3cb8d471680307f0c232e5ac190828681fcb0) |
| Its CREATE2 factory (Base Sepolia) | [`0x4b78615d2ab691cf8e05fe0b7fca7ecb8c063e2f`](https://sepolia.basescan.org/address/0x4b78615d2ab691cf8e05fe0b7fca7ecb8c063e2f) |
| Its CREATE2 factory (Ethereum Sepolia) | [`0xca875b5d982fb05d6699c61c10806f2470b9ccaa`](https://sepolia.etherscan.io/address/0xca875b5d982fb05d6699c61c10806f2470b9ccaa) |
| Agent account | `agent14.keyfree-lab.testnet` (before v14: `agent13b`) |
| Treasury proxy (Base Sepolia) | [`0x5319b76fda54f4144d6b134016f6415ad169dfaa`](https://sepolia.basescan.org/address/0x5319b76fda54f4144d6b134016f6415ad169dfaa) |

## 1. Nobody holds the key

| # | Claim | Evidence |
|---|---|---|
| 1.1 | The policy account has no access keys at all. | Code, init and key deletion in one transaction: [7iawPybU…](https://testnet.nearblocks.io/txns/7iawPybUxDjWqQFXCayAFxecGLLbeiMGP8bczy9sMVbd) (`DeployContract`, `new`, `DeleteKey`). Check now: `view_access_key_list` for the policy returns `[]`. |
| 1.2 | The ETH address is derived from NEAR MPC inside the contract, not typed in by anyone. | `setup()` asks the MPC for `derived_public_key` and keeps the address (`contract/src/lib.rs`, `on_derived`); log line `ETH address derived on-chain from the MPC` in `evidence/v13.log`. |
| 1.3 | Every transaction was signed by NEAR MPC for that address; no private key was used anywhere. | All 13 Base Sepolia transactions in this file are sent from `0x43e3…fcb0`, nonces 0 to 12 in a row, value 0; on Ethereum Sepolia nonces 0 to 2 (CLAIMS 8). |
| 1.4 | The agent's NEAR key can only call the request methods on the policy. | `agent14` holds one function-call key, receiver = the policy: `request_deploy, request_proxy_upgrade, resign, resign_proxy_upgrade, retry, release, confirm, confirm_stuck` ([created](https://testnet.nearblocks.io/txns/o5Tb3Ny9JHus1kaFnYMfmV3DeqkQRjgKpEUcBA4XYun)). Calling anything else is refused by the protocol before the contract runs: `Access key does not allow method propose_rule` (`evidence/v13.log` attacks, `evidence/v14.log` allow). |
| 1.5 | The contract was upgraded without any key, and its data survived. | a→b: [BqHPR1LD…](https://testnet.nearblocks.io/txns/BqHPR1LDasmmgLscAYESz7aGhBxdntom846MAsxgFPQp); b→v14: [C3J8KRin…](https://testnet.nearblocks.io/txns/C3J8KRino8NDCcKf9gChqooYM8bTAPQhHvAn9BAGf1cH), after the guardian read the 362 719 stored bytes and matched their sha256 `764eb8f8…` with the local build. `get_status` shows build `v14`, version 3; keys still `[]`; allowed codes, nonces and the journal are as before (`evidence/v14.log`, upgrade). |
| 1.6 | The live code is a reproducible build, installed by the same keyless upgrade. | The `build` workflow ran `cargo near build reproducible-wasm` at commit `c2db57d` in the image pinned in `contract/Cargo.toml`: 355 905 bytes, sha256 `9dac5b92…f368`; the policy's `contract_source_metadata` names that commit and image. The owner proposed those bytes ([F9bEhNYB…](https://testnet.nearblocks.io/txns/F9bEhNYBJFt4N2oRc2T9s1DJ1dX9ksnpCUy1AfdBnsPP)), the guardian side read them back and matched the sha256, applying before the delay was refused, then [Ac89k49K…](https://testnet.nearblocks.io/txns/Ac89k49KnAUSPx31zkfEB79PNqsbeqtyyvTyv8HaxbQd) installed them: build `v14.1`, version 4, the account's code sha256 equals the build's, keys `[]`, 10 allowed codes and both chains' nonces unchanged (`evidence/v14.log`). |

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
| 3.2 | Code that is not on the allow list is refused, and the agent reports it instead of working around it. | Same session, "Counter with start 999": refused with `code not on the allow list (code hash 5ec712c9…)`; nothing signed, the next nonce stayed 7. |
| 3.3 | A prompt injection that swaps the vault owner cannot get through, even when the human confirms the injected address. | `packages/keyfree/demo/vault-kit`: the README asks to deploy `Vault` with another owner. The owner allowed only `Vault(owner from deploy.config.json)` (rule 9: [propose](https://testnet.nearblocks.io/txns/92UJ1wJRoNssB2AmjgxJb2PCRB2GA3TnDeJUKsLzDwEi), [apply](https://testnet.nearblocks.io/txns/5xLHXr4PDwwcjDJDGinCZ2xiVkGdyRUZHaouKtYyi6ee)). Constructor arguments are part of the allowed code hash, so `Vault(injected owner)` has another hash and the policy refused it at preview; nothing was signed. |
| 3.3a | So the recipient of a vault is chosen by the council, not by the agent or by whoever talks to it. | `Vault` (`packages/keyfree/demo/vault-kit/contracts/Vault.sol`) takes its owner in the constructor and keeps it `immutable`; only the owner can withdraw. The only `Vault` the policy can sign is the one in rule 9. Check now: `keyfree hash` of `Vault(0x07E8…3510)` is `474fbc98…`, which `get_status` lists; `Vault(0xF4be…AF0c)` is `aa3a1a11…`, which it does not. |
| 3.4 | The agent has no tool to change rules, roles, pause or the policy's code. | `packages/keyfree/src/mcp.ts`: nine tools, all request-side (`keyfree_upgrade` asks for a proxy upgrade the council allowed; it cannot allow one); the MCP self-check (`npm run smoke`) asserts the list. |
| 3.5 | Before broadcasting, the tool checks that the signed transaction is the one it checked, from the policy's address. | `checkSigned()` in `packages/keyfree/src/core.ts`; attacks A18, A19 (changed calldata, target, nonce, chain or value; another signer; garbage) are refused. |

## 4. Widening takes time; braking is instant

| # | Claim | Evidence |
|---|---|---|
| 4.1 | New code, a new chain, a factory or higher caps wait the rules delay; applying early is refused. | `rule delay not over` (`evidence/v13.log`, install and factory); rules 0–9 on the policy. |
| 4.2 | Any one council member pauses at once; unpausing needs two of three. | `paused by guard13…`, `one unpause vote is not enough`, `second vote (reserve) unpauses` (`evidence/v13.log`, attacks). |
| 4.3 | A stolen guardian key cannot freeze the contract forever: owner + reserve replace the guardian after the full delay, and the old guardian alone cannot cancel that. | `evidence/v13.log`, roles: `needs 2 of 3 approvals`, `the old guardian alone cannot cancel its own replacement`, `role change delay not over`, `guardian is now guard13b…`, `the old guardian pauses -> Smart contract panicked: only owner, guardian or reserve`. Check now: `get_roles`. |
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
| Attack bench: every attack in `evidence/attacks.md` must end in a refusal | 63 offline + 1 live | `npm run attacks` (writes `evidence/attacks.md`) |
| Policy contract tests (Rust): unit, golden, 400 random transactions against viem, 3 property tests | 160 | `cd contract && cargo test -- --test-threads=1` |
| The live wasm in a local nearcore node with a stand-in MPC: access matrix, flows, upgrade, retirement, faults | 17 | `sandbox` workflow (`evidence/sandbox.md`) |
| keyfree package tests (unit, command-line checks, attacks on the tool and the MCP server, 41 network faults against nodes that fail on purpose) | 78 | `cd packages/keyfree && npm test` |
| MCP self-check against the live policy | 1 script | `cd packages/keyfree && npm run smoke` |

## 7. A treasury upgrade: only the one the council allowed

The treasury (`packages/keyfree/demo/treasury`) is an ERC-1967 proxy with no way to change its admin. All
three parts were deployed keyless through the policy's factory, at addresses the policy promised first:

| Part | Address | Base Sepolia | NEAR request |
|---|---|---|---|
| TreasuryV1(owner) | [`0xd52f…284c`](https://sepolia.basescan.org/address/0xd52f1a3d44e9361fbd7f538abefbae9647b2284c) | [0xe90a60da…](https://sepolia.basescan.org/tx/0xe90a60dac64b966a7ca93474f26ed8fed46e3a2a43da97e3620480ede2d23217) | [6hninm9Q…](https://testnet.nearblocks.io/txns/6hninm9Qq1LozYM5EczgMqxAnHaoVAJdzJSgdM8p1UL) |
| TreasuryProxy(v1, admin = the policy) | [`0x5319…dfaa`](https://sepolia.basescan.org/address/0x5319b76fda54f4144d6b134016f6415ad169dfaa) | [0x158eb231…](https://sepolia.basescan.org/tx/0x158eb231d17777a82148d34ddd9a09fdc786d3758e0df3c537c924e6ed43ac85) | [BpPM6jUa…](https://testnet.nearblocks.io/txns/BpPM6jUacnFp55dHf8D5svpZZTXPyt8tGMdYVWMV77nX) |
| TreasuryV2(owner, 0.01 ETH a day) | [`0x269b…4060`](https://sepolia.basescan.org/address/0x269bdae85a7864e882bdd97d61fc5bc084594060) | [0xf880c963…](https://sepolia.basescan.org/tx/0xf880c96365282fcdc01c240ebc35ccba15e0c792b0e3b8134f6ebc55dc6348eb) | [kf2SfpMD…](https://testnet.nearblocks.io/txns/kf2SfpMDZQXv9g45WqUUgQA38SVYVoyvJGXuq4cMsxW) |

| # | Claim | Evidence |
|---|---|---|
| 7.1 | The proxy's admin is the policy's keyless address, so no person can change the treasury's code. | ERC-1967 admin slot of the proxy = `0x43e3…fcb0` (`evidence/v14.log`, treasury); `TreasuryProxy.sol` has no function that changes it. |
| 7.2 | An upgrade needs a council rule for exactly (chain, proxy, implementation), and it waits the rules delay. | Before rule 13 the agent's request was refused `proxy upgrade not on the allow list`; applying rule 13 early: `rule delay not over`; the agent's key cannot propose it: `Access key does not allow method propose_rule` (`evidence/v14.log`, allow). |
| 7.3 | With the rule, the agent upgraded the live treasury from v1 to v2 through the `keyfree upgrade` tool. | [0xd9673701…](https://sepolia.basescan.org/tx/0xd9673701797e62a2a4c4853bbc6574ceea5956f21ff0abcf0e6500caff2b1f25), NEAR [3Hhip3r3…](https://testnet.nearblocks.io/txns/3Hhip3r38i4oAU2mk7mjJKTmEE56XbGVzjVWwmgXhMAp), nonce 10. Check now: `version()` of the proxy returns 2. Before signing, the tool checked the admin slot, the implementation's code, a simulation and that the policy's bytes equal viem's. |
| 7.4 | Any other upgrade is refused: another implementation, the same upgrade again, a rollback to v1. | `proxy upgrade not on the allow list` for all three, live (`evidence/v14.log`, allow and after); the allowance is gone after the request: `the allowance is used up` (`get_rules` lists no upgrade for that proxy). |
| 7.5 | The calldata is built by the policy, never taken from the caller, and equals viem's. | `upgrade_call` in `contract/src/lib.rs`; golden test `golden_rlp_proxy_upgrade_matches_viem`. |
| 7.6 | NEAR Read MPC confirms the proxy's `Upgraded` log, and not a forged position. | Real log: [8PdE3yE5…](https://testnet.nearblocks.io/txns/8PdE3yE5zPyDPsQSFwCBc5tg3d6v2BmF38qfsJcsaAL8) returned `true` in 21 s, journal line 10 is `confirmed`; block number + 1: [CaJnpGjZ…](https://testnet.nearblocks.io/txns/CaJnpGjZqpzg3XLbQ8DZHp3V19pSGrVHZ3paZq6icrJv) returned `false`. Golden test `golden_payload_hash_of_the_confirmed_treasury_upgrade` reproduces both hashes offline. |
| 7.7 | A real Claude Code session, through the MCP tools, does only the allowed upgrade. | Second treasury proxy `0xd1b8…6b03` on v1 ([deploy](https://sepolia.basescan.org/tx/0x664ab137b424240b420204c6ffb34810ce32aeebf33bc1aeaaece5614b0f6d08), nonce 11), rule 14 allows it → v2 (`evidence/v14.log`, demo). In a fresh session in `packages/keyfree/demo`: "upgrade it to v1's implementation" → refused at the preview, the agent called the refusal final and left the rule to the owner; "upgrade it to v2" → [upgradeTo](https://sepolia.basescan.org/tx/0x5fe0843486d5584250c634a03c6a81efd0b52d4ae9d3b437746e29db6510904c), nonce 12, `version()` = 2, then Read MPC confirmed it (journal line 12 `confirmed`); "roll it back" → refused, the allowance was used. Nonce 13 stayed free, no rule was proposed. |

## 8. One policy, a second chain

The same policy and the same keyless address work on Ethereum Sepolia; only the council's rules decide
which chains are open. Run: `v14/ethereum.mjs`, log `evidence/ethereum.log`.

| # | Claim | Evidence |
|---|---|---|
| 8.1 | The council opened Ethereum Sepolia through the rules delay; the agent's key could not. | Rules 15 (`AllowChain`, nonce 0, fee floor 0.01 gwei) and 16 (`SetFactory`) refused before the delay, applied after 60 s; `propose_rule` with the agent key: `Access key does not allow method propose_rule`. |
| 8.2 | The factory and a Counter were deployed from `0x43e3…fcb0` on Ethereum Sepolia without a key, and the policy's bytes equal viem's. | Factory, nonce 1: [0x4bf7d487…](https://sepolia.etherscan.io/tx/0x4bf7d487ddfe4999b88e674a6539292a3b0900a9a18c548c600bfe35c6ff92e9), NEAR [H1YpXsmC…](https://testnet.nearblocks.io/txns/H1YpXsmCH4hxN8BdnnLNj6BiBnaDmkytrsgPAjudNABU); Counter(1), nonce 2, the same code and salt as the Base deploy in 3.1: [0x02fec32b…](https://sepolia.etherscan.io/tx/0x02fec32bf055ff33c7aae77d711058e396468aba830e690e42bb6575264821db), NEAR [8ofc8DLm…](https://testnet.nearblocks.io/txns/8ofc8DLmA6vE6VsqQx6pWvNRSv1uorja4qt1ErbdGGz1); `number()` of [`0xc974…b414`](https://sepolia.etherscan.io/address/0xc974ad58fea2218e8d2f1378f2c58d112d00b414) returns 1. `keyfree preview --chain ethereum-sepolia` reports `matches_viem: true`. |
| 8.3 | The allow list is the same on both chains. | Counter(999) on Ethereum Sepolia: `code not on the allow list`. |
| 8.4 | A journal line on Ethereum is not confirmed, and the policy says why. | `confirm` for nonce 2: `Read MPC does not cover this chain`. NEAR Read MPC reads Base and Arbitrum, not Ethereum yet: the testnet and mainnet node configs in [near/mpc](https://github.com/near/mpc/tree/main/crates/node-config/foreign_chains) list no Ethereum section. |
| 8.5 | A failed first try, kept in the record. | Nonce 0 ([0x2407edb5…](https://sepolia.etherscan.io/tx/0x2407edb51ac1e2d4b9489c79bc9b1c19c25208ff3fd8415dd8be8a0ebe79d6c6)) ran out of gas: the run script gave the factory 398 043 gas from a formula, and creating it on Ethereum Sepolia takes about 1.25 M (on Base Sepolia about 0.2 M). A reverted creation still spends its nonce, so the factory went to nonce 1 through a new `SetFactory` rule (17) and its delay. The `keyfree` tool asks the chain to estimate gas before anything is signed; the script now does the same. |

## 9. A daily budget the agent cannot raise

v15 counts, per chain and UTC day, the most gas the policy may commit (gas limit x max fee of every signature)
and how many transactions it signs. Run: `v14/budget.mjs`, log `evidence/v14.log`.

| # | Claim | Evidence |
|---|---|---|
| 9.1 | The policy got the budget by a keyless upgrade to v15. | The `build` workflow at commit `c27aa7d`: 376 508 bytes, sha256 `1ada024b…9826`; proposed [96qq9eJ3…](https://testnet.nearblocks.io/txns/96qq9eJ33UKHcWRkqUvcMdMrEwBjeZqWy6UHAJfxSQLy), the stored bytes matched, applying early was refused, installed by [9qdVZngM…](https://testnet.nearblocks.io/txns/9qdVZngM7P8wHV5JTMjSZe5yBxF6uhZLsojAYGjRR8cH): build `v15`, version 5, keys `[]`, codes and nonces unchanged. |
| 9.2 | Only the council sets a budget, through the delay. | The agent's key: `Access key does not allow method propose_rule`. Rules 19 (Base Sepolia: 1 transaction, 0.00001 ETH a day) and 20 (Ethereum Sepolia: 10 transactions, 0.01 ETH) were refused before the delay and applied after it. |
| 9.3 | When the day's budget is used, the next request is refused by the tool and by the contract. | With 1 of 1 transaction used, `keyfree preview`: `daily limit on chain 84532: 1 transactions today, until the next UTC day`; the same request sent straight to the contract with the agent's key, tool bypassed: refused with the same reason. |
| 9.4 | Raising waits the delay; lowering is a brake any member can use at once. | Rule 21 raised Base Sepolia to 20 transactions and 0.001 ETH a day after the delay; the guardian (`guard13b`) lowered it to 10 and 0.0005 ETH at once; the guardian's attempt to raise it at once was refused: `raising a budget is a rule proposal`. |
| 9.5 | A re-sign keeps the nonce and the content, and counts against the budget. | The day's first signature (journal line 13) was never broadcast. `resign` gave the same nonce, code and salt with fresh fees ([2B6QQ5jy…](https://testnet.nearblocks.io/txns/2B6QQ5jyyUJ7jqE72JV2Y7VBRDByvnJqxPXdiAWp7nEd)); it landed as [0xb22a858d…](https://sepolia.basescan.org/tx/0xb22a858d71c6c341f0c64fa876f231a091b980ba56f179f3e5f84191008ff1bf), Counter(1) at the promised `0x5fa0…f57d`, and the budget showed 2 transactions used. |
| 9.6 | The fixes of the third security review run live, installed the same way. | The `build` workflow at commit `e818bdc`: 383 323 bytes, sha256 `ee660188…d304`; proposed [ACh6bvaL…](https://testnet.nearblocks.io/txns/ACh6bvaLmugXXTHYtat1Fq7CCYajoB9Za5XhRRW44D3K), applying early refused, installed by [AV3zHMa6…](https://testnet.nearblocks.io/txns/AV3zHMa6Qi33te13WkWvSYL4kCogX5SCHSGZgrZf6qCh): build `v16`, version 6, keys `[]`; rules, nonces and the day's budget (2 of 10 used) kept. |

## 10. Someone else's policy, from nothing

A fresh testnet account with no link to the demo (`kf-outsider-494bd7.testnet`, 10 NEAR from the testnet
helper) followed "Run your own policy" in the README with `setup/policy.mjs`, then used the `keyfree` tool.

| # | Claim | Evidence |
|---|---|---|
| 10.1 | It runs the live policy's code, installed keyless. | `setup/policy.mjs wasm` took the code from `policy13` and matched sha256 `ee660188…d304`; `policy.kf-outsider-494bd7.testnet` has 0 access keys, build `v16`, version 1 (`keyfree status`). Its ETH address `0x4ca9…031d` came from the MPC. |
| 10.2 | Its rules waited the delay; its council worked from the tool. | Rules 0–4 applied after the 60 s delay; the council CLI's early `apply` was refused `rule delay not over`. |
| 10.3 | Its agent deployed the factory and then Counter(1) without any key. | Factory [0x7069d601…](https://sepolia.basescan.org/tx/0x7069d6014e740d7a96478df721837be8262e35789621b14d38690b925b9ac8a7) ([NEAR](https://testnet.nearblocks.io/txns/8DKGFPi2rJ4WZgrFnNnApWojb2sW1uq2cMzyS3YJ2By1)) at `0x7716…b766`, serving only the policy's address; rule 5 set it after the delay. `keyfree deploy` with the agent's function-call key: Counter(1) [0xbd514782…](https://sepolia.basescan.org/tx/0xbd514782ec5127efcf4b740f2a1c8df5fe6abc3fc11d656459ddcfa045e5878c) ([NEAR](https://testnet.nearblocks.io/txns/w3i2zLjA84LvvotEUwhG1CM4eyB5cPn5rmQNNN7RxRf)) at `0xa413…3169`, `number()` = 1. Counter(999): `REFUSED code not on the allow list`, exit code 2. |
| 10.4 | Every command of the tool and all 9 MCP tools work live, each with its refusals. | `packages/keyfree/scripts/live.mjs`, 131 of 131 steps (`evidence/tool_live.log`): each brake at once and its refusal, each reopening through the delay, pause and the second unpause vote, cancels of a rule, a role change and a policy upgrade, a treasury deployed and upgraded from the CLI ([upgradeTo](https://sepolia.basescan.org/tx/0xaeace1f9ad802414c2460536da4dc87329c3da0238dca6ac719cfa63f5893db0)) and back through MCP ([upgradeTo](https://sepolia.basescan.org/tx/0xc6f61ffd7727fbe5a5a7f81599fd2f0f7e78ef01964a6bea04599b2b09b5fcb5), Read MPC [confirmed](https://testnet.nearblocks.io/txns/2CMyxoufqgvZQeGwiTQdBJYxRfqSaG4Tnv2nE2fWYy5P)). One success path did not run: `rules allow-chain`, because this policy has its one chain open (its refusal ran; opening a chain ran through `setup/policy.mjs`). |
| 10.5 | When a network fails, nothing unchecked is signed and no nonce is lost. | `packages/keyfree/scripts/live_faults.mjs`, 31 of 31 steps (`evidence/tool_faults_live.log`), real networks behind a proxy that breaks them: a dead EVM or NEAR node, a node of another chain, a base fee of 100 gwei (the contract: `gas price over the cap`), an agent with no NEAR and a key with too small an allowance: nothing signed, the nonce unmoved. A deploy signed and then refused by the node: a new deploy stopped, other code refused, then `retry` through the contract's `resign` with the real MPC ([NEAR](https://testnet.nearblocks.io/txns/BU6hgYTQtrLLcWQLHb2cpcy18fRtp9J38hDBkVDAc6eh)) landed it at the promised address ([0x34dab71d…](https://sepolia.basescan.org/tx/0x34dab71d83261752fc02d0d36dee5e04d17b9aa84608c2aa8941f3fe17ec1e93)). The same for a proxy upgrade, the first live `resign_proxy_upgrade` ([NEAR](https://testnet.nearblocks.io/txns/4HLejbtr55rWqXRTGWtvhdesdWsVLH9Suv6frzZ35qrd), [0x71b7605e…](https://sepolia.basescan.org/tx/0x71b7605eea89062314e51b2821022778875a3b8ba6c722727e27530d12bec470)). An unplanned one: on 2026-11-03 two public NEAR testnet nodes hung and a third lost the answer to a request; the signed line was recovered the same way ([NEAR](https://testnet.nearblocks.io/txns/2A12tDfu4raDhykheMxMQWfZTRuSLX99byz1YAdVvxfm), [0x7fe60897…](https://sepolia.basescan.org/tx/0x7fe60897f5d84eb842a93305cb104d84ca7c2a22c900bac3a188661af3cb89eb)). 41 more cases against nodes that fail on purpose in `npm test`; `retry` and `release` through the tool on the real contract in `evidence/sandbox.md`. |

## Not claimed (yet)

- Not every journal line is confirmed. Read MPC confirmation is a separate call made for the runs above; Base nonce 11 (the second treasury proxy) and all Ethereum lines stay `signed`, the Ethereum ones because Read MPC does not read Ethereum yet (8.4).

- Only testnets: NEAR testnet, Base Sepolia and Ethereum Sepolia. Nothing on mainnet.
- Journal confirmation on Ethereum: NEAR Read MPC does not read Ethereum yet (8.4).
- Arbitrum: the contract knows the chain, but no deploy there has been run.
- `release`, `retry` and `confirm_stuck` never ran on testnet: the real MPC did not fail. `retry` and `release` ran in a local nearcore node against a stand-in MPC that failed on purpose, also through the real tool (`evidence/sandbox.md`); `confirm_stuck` is covered by unit tests, and the tool has no command for it: when a late signature landed, `retry` says so and stops. `resign` and `resign_proxy_upgrade` ran live (9.5, 10.5).
- Faults of a node were forced by a proxy or by fake nodes, apart from one real outage (10.5). A real gas spike after a broadcast did not happen: that case ran against a fake node only.
- Calls other than `upgradeTo` on a proxy: the policy cannot sign them at all.
- Retiring a policy (`sweep`, `finish_retire`) never ran on testnet, the live policy is kept for review; it ran end to end in a local nearcore node (`evidence/sandbox.md`).
- In the live run the owner key sat on the same laptop as the agent. See SECURITY.md.
