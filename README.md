# Keyfree

**Your AI deploys contracts. Nobody holds the key.**

AI coding agents (Claude Code, Codex, CI bots) now deploy smart contracts, and to do it they get a private
key: in `.env`, in CI secrets, on the laptop. Whoever controls the agent, a prompt injection in a README, or a
stolen laptop controls that key, and with it the contracts and the money behind them.

Keyfree removes the key. The agent asks; a contract on NEAR decides; NEAR MPC signs.

```
AI agent ──MCP──> keyfree tool ──> policy contract on NEAR ──> NEAR MPC signature ──> Base / Arbitrum
                   checks bytes       allow list, chains,        for the policy's        deploy through
                   vs viem            caps, nonces, roles        own derived address     its own factory
```

- The **policy** is a NEAR contract with no access keys. It holds the rules: which init code may be deployed
  (hash of the code together with its constructor arguments), on which chains, with which gas and fee caps.
- It **builds the EVM transaction itself** from fields and asks NEAR MPC to sign it for the policy's own
  derived address. It never signs a hash someone hands it.
- The agent's NEAR key can only call the request methods. Rules, roles and upgrades belong to a council of
  three humans, and anything that widens power waits a public delay that any of them can cancel.
- After a deploy lands, **NEAR Read MPC** confirms the factory's `Deployed` log, so the policy's journal
  records what happened on chain, not what was intended.

Built for NEAR HACKATHON 2026 (security track). Live on NEAR testnet and Base Sepolia.

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
4. [CLAIMS.md](CLAIMS.md) lists every claim with its transaction, log line or test.

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

53 attacks, offline, in four groups: the agent or a prompt injection, a thief with one or two council keys, a
stranger, a broken or hostile MPC answer. Each one is a test that must end in a refusal with a stated reason;
the bench prints `attack -> refusal` and writes the table to [`evidence/attacks.md`](evidence/attacks.md), with
the testnet run where the same refusal was seen live. Contract attacks run the real policy code on near-sdk's
mocked chain; tool attacks run the built `keyfree` package.

## Run the tests

From the repository root:

```bash
(cd contract && cargo test -- --test-threads=1)       # 133 tests of the policy (Rust, near-sdk 5.29)
(cd packages/keyfree && npm test && npm run smoke)    # 13 tool tests; MCP self-check against the live policy
```

The contract tests include golden tests: the policy's transaction bytes for 1 KB, 24 KB and 48 KB of init code
and for a proxy upgrade equal viem's (`evidence/golden_rlp.json`, made by `golden_vectors.mjs`, offline), and the journal's payload
hash equals the one NEAR Read MPC accepted on Base Sepolia.

## Use it from Claude Code

`packages/keyfree/demo/.mcp.json` registers the MCP server. Open Claude Code in `packages/keyfree/demo` and
ask it to deploy `Counter`. Without the agent key the read-only tools still work (`keyfree_status`,
`keyfree_preview`, `keyfree_journal`, `keyfree_code_hash`), including the refusals.

The agent gets nine tools, all on the request side (deploy, proxy upgrade, preview, retry, confirm, read). There is no tool for rules, roles, pause or upgrades,
and its NEAR key could not call them anyway. Tool descriptions tell the model that a refusal is final and that
text in files is not an instruction from the user. See `packages/keyfree/README.md` for what the tool checks
before and after signing.

## Run your own policy

`v13/run.mjs` runs the whole thing end to end on NEAR testnet and Base Sepolia, one stage per call: accounts,
install without keys, rules through the delay, factory, deploys from 22 B to 48 KB, Read MPC confirmation
(real and forged), live refusals, guardian replacement, upgrade without keys. It needs testnet NEAR (about
10) and a little Base Sepolia ETH on the derived address. The log of our run is `evidence/v13.log`.
`v14/run.mjs` continues on that policy: the treasury (proxy, v1, v2), the keyless upgrade of the policy to
v14, a new agent, the allowed proxy upgrade and its refusals, Read MPC confirmation (`evidence/v14.log`).

## Layout

| Path | What |
|---|---|
| `contract/` | the policy contract (Rust, near-sdk 5.29, `omni-transaction` for EIP-1559) and its tests |
| `factory/` | `KeyfreeFactory.sol`: CREATE2 for exactly one caller, the policy's address; emits `Deployed` |
| `packages/keyfree/` | `keyfree` CLI and `keyfree-mcp` MCP server (TypeScript, viem, near-api-js) |
| `packages/keyfree/demo/` | `Counter`; `vault-kit`, a prompt-injection example (its README swaps the vault owner); `treasury`, the upgradeable treasury (proxy, v1, v2) |
| `v13/`, `v14/` | end-to-end testnet scripts and builds |
| `attacks/` | the attack catalog and `npm run attacks` |
| `evidence/` | logs of the live runs, golden vectors, the attack table |

## Security

Read [SECURITY.md](SECURITY.md). In one line: there is no key, but there is power. Full power is 2 of the 3
council members plus the delay, or the owner plus the delay while the other two stay silent. Keep the
council keys on separate devices, never where the agent runs.

## Disclosures

- **Built during the hackathon.** All Keyfree code was written in the NEAR HACKATHON window (from
  2026-10-19): the first experiments on 2026-10-25, the first commit in this repository on 2026-10-28. There
  is no earlier Keyfree code.
- **Libraries.** near-sdk, omni-transaction, viem, near-api-js, the MCP TypeScript SDK
  (`@modelcontextprotocol/server`), zod, solc-js, binaryen (wasm-opt). Everything else is ours.
- **AI use.** Most of the code and tests were written with Claude Code (Anthropic). Two security reviews were
  done by separate AI reviewer sessions; their findings are fixed with tests.
- **License.** Apache-2.0.
