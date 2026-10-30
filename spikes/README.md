# Early spikes (2026-10-25 .. 28)

The first experiments, kept for the record. They ran against earlier policy versions and are not needed to use or
check Keyfree; the current code is in `contract/`, `packages/keyfree/`, `v13/` and `v14/`.

| File | What it tried | Log |
|---|---|---|
| `run.mjs` | the policy builds an EIP-1559 contract creation, NEAR MPC signs it, viem checks it; nothing broadcast | `evidence/run.log` |
| `spike2.mjs` | two real deploys on Base Sepolia from the keyless address: plain CREATE and CREATE2 | `evidence/spike2.log` |
| `spike3.mjs` | Read MPC asked whether that deploy is finalized; does testnet accept `expected_payload_hash` | `evidence/spike3.log` |
| `spike4.mjs` | a separate agent deploys; the policy's only key is deleted, the agent still deploys through the rules | `evidence/spike4.log` |
| `spike5.mjs` | our CREATE2 factory, a keyless deploy through it, the journal confirmed by Read MPC | `evidence/spike5.log` |
| `spike6.mjs` | upgrade of a keyless policy (build a -> b) through its own rules: sha256, delay, guardian can cancel | `evidence/spike6.log` |
| `spike7.mjs` | keyless self-upgrade to v5; init code of 1 KB, 24 KB and 48 KB through the factory == viem | `evidence/spike7.log` |
| `spike8.mjs` | v6: keyless self-upgrade, closing a nonce gap, 48 KB init code with enough gas | `evidence/spike8.log` |
| `payload_hash.mjs`, `log_payload_check.mjs` | predicting the Read MPC payload hash, checked against a real answer | |
| `old_contract/` | the policy source of v1 to v5 | |

They import `../tools/` and write to `../evidence/`; the wasm builds and keys they used are not in git.
