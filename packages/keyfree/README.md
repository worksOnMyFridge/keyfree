# keyfree

CLI and MCP server that let an AI coding agent deploy EVM contracts with no private key anywhere.
The rules live in a NEAR contract (the policy), NEAR MPC signs, this package checks and broadcasts.

## What the agent gets (MCP, `keyfree-mcp`)

| Tool | Does |
|---|---|
| `keyfree_status` | what the policy allows now: keyless address, keys on the policy (0), allowed code, chains, caps, roles |
| `keyfree_code_hash` | the hash the allow list must hold for an artifact + constructor arguments (offline) |
| `keyfree_preview` | builds and checks a deploy, signs nothing |
| `keyfree_deploy` | the policy builds the transaction, MPC signs, the tool re-checks and broadcasts |
| `keyfree_retry` | re-signs a deploy the MPC did not answer in time (same nonce, same content) |
| `keyfree_confirm` | NEAR Read MPC confirms the factory's `Deployed` log: the journal line becomes a fact |
| `keyfree_journal` | the policy's journal for a chain |

The agent gets no tool for rules, roles, pause or upgrades. Its NEAR key is a function-call key that may only
call `request_deploy`, `resign`, `retry`, `release`, `confirm`, `confirm_stuck`; anything else is refused by the
protocol before it reaches the contract.

## What the tool checks before and after signing

1. The code hash is on the policy's allow list (otherwise it says what the owner would have to allow).
2. The factory serves exactly the policy's keyless address (`keyfree()` on chain).
3. The chain simulates the deploy from that address (`eth_estimateGas`); gas = estimate + 25 %.
4. The unsigned transaction built by the policy equals viem's for the same fields, byte for byte; the promised
   address equals viem's CREATE2.
5. The address holds `gas limit x max fee` (a signed nonce that cannot be mined would block the chain's queue).
6. The signed transaction is that same transaction and recovers to the policy's address. Only then it is broadcast.

## Run

```bash
npm install && npm run build
cp keyfree.example.json demo/keyfree.json
export KEYFREE_AGENT_KEY=/path/to/agent_key.json   # {"private_key": "ed25519:..."}, never in the repo
npm test && npm run smoke                            # offline unit tests; MCP self-check (read only)
node dist/cli.js status                              # from a folder with keyfree.json
```

Claude Code: open `demo/` (it has `.mcp.json`), then ask "deploy Counter with start 1 to Base Sepolia".

Human (council) commands sign with a key from `~/.near-credentials` (`--as <account>`, default `owner`):
`keyfree rules allow-code <hash>`, `keyfree rules apply <id>`, `keyfree pause`, ... see `keyfree help`.
