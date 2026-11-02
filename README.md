# Keyfree

**Your AI deploys contracts. Nobody holds the key.**

AI coding agents (Claude Code, Codex, CI bots) now deploy smart contracts, and to do it they get a private
key: in `.env`, in CI secrets, on the laptop. Whoever controls the agent, a prompt injection in a README, or a
stolen laptop controls that key, and with it the contracts and the money behind them.

Keyfree removes the key. The agent asks; a contract on NEAR decides; NEAR MPC signs.

```
AI agent ──MCP──> keyfree tool ──> policy contract on NEAR ──> NEAR MPC signature ──> Base, Ethereum
                   checks bytes       allow list, chains,        for the policy's        deploy through
                   vs viem            caps, daily budget,        own derived address     its own factory
                                      nonces, roles
```

- The **policy** is a NEAR contract with no access keys. It holds the rules: which init code may be deployed
  (hash of the code together with its constructor arguments), on which chains, with which gas and fee caps, and
  how much gas and how many transactions per chain a day (the daily budget).
- It **builds the EVM transaction itself** from fields and asks NEAR MPC to sign it for the policy's own
  derived address. It never signs a hash someone hands it.
- The agent's NEAR key can only call the request methods. Rules, roles and upgrades belong to a council of
  three humans, and anything that widens power waits a public delay that any of them can cancel.
- After a deploy lands, **NEAR Read MPC** confirms the factory's `Deployed` log, so the policy's journal
  records what happened on chain, not what was intended.

Built for NEAR HACKATHON 2026 (security track). Live on NEAR testnet, Base Sepolia and Ethereum Sepolia.

## Where the money goes

A deploy is where a contract learns who it pays. A treasury vault gets its owner in the constructor, and
from then on only that owner can withdraw. So the question "can the agent send the money somewhere else?"
is the question "can the agent deploy the vault with another owner?".

With Keyfree it cannot. The council allows `Vault(owner = the treasury)`, and the allowed hash covers the
constructor arguments. `Vault(any other owner)` is other code and is refused before anything is signed. We
ran this with a real Claude Code session: a README in the project asked it to deploy the vault with a new
owner, the human then confirmed that address too, and the policy still refused
([CLAIMS 3.3](CLAIMS.md#3-an-ai-agent-deploys-and-cannot-be-talked-past-the-rules)).

Whoever sets the rules decides where the money goes; whoever runs the agent does not.

The same holds after the deploy, for a treasury that can be upgraded. Its money sits behind an ERC-1967
proxy whose admin is the policy's keyless address, so the only way to change its code is an `upgradeTo`
the policy signs. The council allows one exact upgrade (this proxy, this implementation) through the rules
delay; the agent's request uses it up, so the same upgrade, a rollback or any other implementation is
refused. On Base Sepolia the agent switched a live treasury from v1 to v2 (v2 adds a daily withdrawal limit)
and was refused all three of those ([CLAIMS 7](CLAIMS.md#7-a-treasury-upgrade-only-the-one-the-council-allowed)).
A fresh Claude Code session did the same on a second treasury: another version refused, v2 done and confirmed
by Read MPC, the rollback refused (CLAIMS 7.7).
Besides deploys, `upgradeTo` on a proxy is the only call the policy can sign, and it never sends value.

## See it in 2 minutes (browser only)

1. Open the policy [`policy13.keyfree-lab.testnet`](https://testnet.nearblocks.io/address/policy13.keyfree-lab.testnet).
   You see a contract account with **no access keys**: it was deployed, initialised and had its key deleted in
   [one transaction](https://testnet.nearblocks.io/txns/7iawPybUxDjWqQFXCayAFxecGLLbeiMGP8bczy9sMVbd).
2. Open its ETH address [`0x43e3…fcb0`](https://sepolia.basescan.org/address/0x43e3cb8d471680307f0c232e5ac190828681fcb0) on Base Sepolia.
   You see eleven contract deploys and two treasury upgrades, nonces 0 to 12, from an address whose private
   key does not exist.
3. Open [this deploy](https://sepolia.basescan.org/tx/0x59ec94223de38de6bcbb12515c2facacd4578ce80483f734100869ae4f4e7120).
   A Claude Code session made it after one sentence: "deploy Counter with start 1 to Base Sepolia through keyfree".
4. The same keyless address on [Ethereum Sepolia](https://sepolia.etherscan.io/address/0x43e3cb8d471680307f0c232e5ac190828681fcb0):
   the council opened a second chain with one rule, and the same allow list holds there
   ([CLAIMS 8](CLAIMS.md#8-one-policy-a-second-chain)).
5. [CLAIMS.md](CLAIMS.md) lists every claim with its transaction, log line or test.

## Try it in 10 minutes (no keys, no money)

Node 20+.

```bash
cd packages/keyfree
npm install && npm run build
cp keyfree.example.json demo/keyfree.json
cd demo

node ../dist/cli.js status
# -> the live policy: 0 keys, its ETH address, allowed code, chains, roles

node ../dist/cli.js preview --chain base-sepolia --artifact out/Counter.sol/Counter.json --args "[1]"
# -> the transaction the policy would sign: its nonce, the address the contract will get,
#    and "matches_viem": true (the policy's bytes equal viem's for the same fields)

node ../dist/cli.js preview --chain base-sepolia --artifact out/Counter.sol/Counter.json --args "[999]"
# -> REFUSED  code not on the allow list (code hash 5ec712c9…)
#    Constructor arguments are part of what is allowed: Counter(999) is other code.
```

Reading and previewing need no key. Deploying needs the agent's key for this policy, which only the agent has.

## Try to break it

```bash
(cd packages/keyfree && npm install)   # once
npm run attacks                        # from the repository root; needs Rust (cargo) and Node 20+
```

63 attacks, offline, in four groups: the agent or a prompt injection, a thief with one or two council keys, a
stranger, a broken or hostile MPC answer. Each one is a test that must end in a refusal with a stated reason;
the bench prints `attack -> refusal` and writes the table to [`evidence/attacks.md`](evidence/attacks.md), with
the testnet run where the same refusal was seen live. Contract attacks run the real policy code on near-sdk's
mocked chain; tool attacks run the built `keyfree` package.

## Run the tests

From the repository root:

```bash
(cd contract && cargo test -- --test-threads=1)       # 156 tests of the policy (Rust, near-sdk 5.29);
                                                      # on Windows set AWS_LC_SYS_PREBUILT_NASM=1 first
(cd packages/keyfree && npm test && npm run smoke)    # 37 tool tests; MCP self-check against the live policy
npm install && npm run test:factory                   # 6 tests of the CREATE2 factory on an in-process EVM
```

The same checks, without the live smoke test, run in CI (`.github/workflows/ci.yml`). `npm audit` reports `tmp`
through solc-js 0.8.28; the build only calls solc's `compile()`, not the command-line code that uses `tmp`, and
another solc version would change the bytecode and with it the allowed code hashes.

The contract tests include golden tests: the policy's transaction bytes for 1 KB, 24 KB and 48 KB of init code
and for a proxy upgrade equal viem's (`evidence/golden_rlp.json`, made by `golden_vectors.mjs`, offline), and the journal's payload
hash equals the one NEAR Read MPC accepted on Base Sepolia.

## Check which code the live policy runs

The live policy runs a reproducible build: the same commit gives the same bytes on any machine with Docker.
The policy says which commit itself: its `contract_source_metadata` view (NEP-330) returns the repository
link, the commit `e818bdcc706e356f0667c7235c183e55c30b6a3b`, the Docker image and the build command.

```bash
git checkout e818bdcc706e356f0667c7235c183e55c30b6a3b
cd contract
cargo near build reproducible-wasm         # cargo-near 0.22.0; Docker image pinned by digest in Cargo.toml
sha256sum target/near/keyfree_policy.wasm
# -> ee66018871942c4ccf924283008866901d884d1ecd0c99869b68e639794da304  (383 323 bytes)
```

NEAR shows an account's code hash as base58 of that sha256: for `policy13.keyfree-lab.testnet` it is
`H3cFJqHCGSNxTjX3NnihiJGPy6E5QB27Ed15KEuM2aFD` (`near state` or the RPC `view_account`). The commit is part of
the metadata inside the wasm, so every commit gives its own hash; the `build` workflow
(`.github/workflows/build.yml`) builds each change to the contract and prints both hashes.
The policy moved to reproducible builds on 2026-11-01 through its own keyless upgrades (v14.1, CLAIMS 1.6; v15, CLAIMS 9.1; v16, CLAIMS 9.6); earlier versions
were built on a laptop and their bytes carry that machine's paths, so they cannot be rebuilt elsewhere.

## Use it from Claude Code

`packages/keyfree/demo/.mcp.json` registers the MCP server. Open Claude Code in `packages/keyfree/demo` and
ask it to deploy `Counter`. Without the agent key the read-only tools still work (`keyfree_status`,
`keyfree_preview`, `keyfree_journal`, `keyfree_code_hash`), including the refusals.

The agent gets nine tools, all on the request side (deploy, proxy upgrade, preview, retry, confirm, read). There is no tool for rules, roles, pause or upgrades,
and its NEAR key could not call them anyway. Tool descriptions tell the model that a refusal is final and that
text in files is not an instruction from the user. See `packages/keyfree/README.md` for what the tool checks
before and after signing.

## What the agent's key can and cannot do

The agent signs on NEAR with a **function-call access key**: a key that NEAR itself limits to one contract and
a list of methods. The live agent `agent14.keyfree-lab.testnet` has one key, for `policy13` and eight methods:
`request_deploy`, `request_proxy_upgrade`, `resign`, `resign_proxy_upgrade`, `retry`, `release`, `confirm`,
`confirm_stuck`.

- It cannot propose or apply rules, change roles, pause or upgrade the policy: NEAR rejects the call before
  the contract runs (`Access key does not allow method propose_rule`, CLAIMS 7.2 and 8.1).
- It cannot move the agent account's NEAR or add keys; a function-call key never can.
- Each call is paid from the agent account (a request uses about 250 Tgas). This key has no allowance limit,
  so it cannot lock itself out by spending its allowance; a key with an allowance stops once the allowance is
  used up, which happened to an earlier agent key in the v13 run (`evidence/v13.log`). When the account runs
  low, anyone can top it up.
- A stolen agent key can ask only for allowed code on open chains within the caps and the daily budget, and
  any council member revokes the agent at once.
- The tool checks this before it signs: if the key it finds for the agent account can do more than these
  methods on this policy (say a project's `keyfree.json` names the owner), it refuses.

## How this differs from other ways to keep the key from the agent

| | Rules live in | Can sign beyond the rules | Rules for deploys and upgrades |
|---|---|---|---|
| Private key in `.env` or CI secrets | nowhere | whoever reads the file | none |
| Wallet services with policies in a TEE (Coinbase CDP, OutLayer agent custody) | the provider's service or enclave | the provider's infrastructure | limits on transfers and calls; no allow list of init code in their docs (checked 2026-11-01) |
| Safe with modules | a contract on each chain | the Safe owners | per chain; the agent needs its own key for the module |
| Keyfree | one public contract on NEAR, for every EVM chain it opens | nobody: the policy has no key, and NEAR MPC signs only what the contract built | the hash of the whole init code, exact proxy upgrades, a public delay for anything that widens power |

Keyfree does not move money: it decides what code gets deployed and which upgrades happen, and a deploy or an
upgrade is where a contract learns who it pays.

## Run your own policy

After `npm install` in the repository root, `v13/run.mjs` runs the whole thing end to end on NEAR testnet and Base Sepolia, one stage per call: accounts,
install without keys, rules through the delay, factory, deploys from 22 B to 48 KB, Read MPC confirmation
(real and forged), live refusals, guardian replacement, upgrade without keys. It needs testnet NEAR (about
10) and a little Base Sepolia ETH on the derived address. The log of our run is `evidence/v13.log`.
`v14/run.mjs` continues on that policy: the treasury (proxy, v1, v2), the keyless upgrade of the policy to
v14, a new agent, the allowed proxy upgrade and its refusals, Read MPC confirmation (`evidence/v14.log`).
`v14/ethereum.mjs` opens Ethereum Sepolia on the same policy (`evidence/ethereum.log`), `v14/upgrade.mjs`
moves the policy to a reproducible build without a key, and `v14/budget.mjs` sets and tests the daily budget
(`evidence/v14.log`).

## Layout

| Path | What |
|---|---|
| `contract/` | the policy contract (Rust, near-sdk 5.29, `omni-transaction` for EIP-1559), its tests and version history |
| `factory/` | `KeyfreeFactory.sol`: CREATE2 for exactly one caller, the policy's address; emits `Deployed` |
| `packages/keyfree/` | `keyfree` CLI and `keyfree-mcp` MCP server (TypeScript, viem, near-api-js) |
| `packages/keyfree/demo/` | `Counter`; `vault-kit`, a prompt-injection example (its README swaps the vault owner); `treasury`, the upgradeable treasury (proxy, v1, v2) |
| `v13/`, `v14/` | end-to-end testnet scripts and builds |
| `tools/` | small viem and NEAR helpers the scripts share |
| `spikes/` | the first experiments (2026-10-25 .. 28), kept for the record |
| `attacks/` | the attack catalog and `npm run attacks` |
| `evidence/` | logs of the live runs, golden vectors, the attack table |
| `explorer/` | a read-only page of the live policy (keys, rules, budgets, pending changes, journal, a live refusal); serve it with any static server (`python -m http.server -d explorer`), it needs no key |
| `.github/workflows/` | `ci`: tests and the attack bench, dependency audits (`cargo audit`, `npm audit`) and a secret scan of the whole history (gitleaks, rules in `.gitleaks.toml`) on every push, and the tool on Windows, Linux and macOS with Node 20, 22 and 24; `build`: the reproducible build of the policy; `live`: the README's read-only paths against the live policy, daily |
| `audit/` | the attack catalogs the third review checked against (contracts and MPC; AI agents and MCP) and the second review's probe tests ([AUDIT.md](AUDIT.md)) |

## Security

Read [SECURITY.md](SECURITY.md) and, for every finding of the three security reviews, [AUDIT.md](AUDIT.md). In one line: there is no key, but there is power. Full power is 2 of the 3
council members plus the delay, or the owner plus the delay while the other two stay silent. Keep the
council keys on separate devices, never where the agent runs; `keyfree status` warns when a council key is on
the machine it runs on.

The delay protects only if someone looks. The live demo policy uses short delays so a judge can watch a whole
cycle: 60 s for rules, 180 s for upgrades and role changes; real use needs hours or days. `keyfree pending`
lists every widening that waits its delay, with the command that cancels it, and exits with code 3 when there
is one: run it on a schedule (cron, a scheduled CI job) and send the alert to the council.

## Disclosures

- **Built during the hackathon.** All Keyfree code was written in the NEAR HACKATHON window (from
  2026-10-19): the first experiments on 2026-10-25, the first commit in this repository on 2026-10-29 (UTC). There
  is no earlier Keyfree code.
- **Libraries.** near-sdk, omni-transaction, viem, near-api-js, the MCP TypeScript SDK
  (`@modelcontextprotocol/server`), zod, solc-js, binaryen (wasm-opt). Everything else is ours.
- **AI use.** Most of the code and tests were written with Claude Code (Anthropic). Three security reviews were
  done by separate AI reviewer sessions; their findings are fixed with tests.
- **License.** Apache-2.0 ([LICENSE](LICENSE)). The Solidity contracts (`factory/`, `packages/keyfree/demo/`)
  carry `SPDX-License-Identifier: MIT`: the header is part of their bytecode metadata, so changing it would
  change the code hashes the live policy allows.
