# keyfree

CLI and MCP server that let an AI coding agent deploy EVM contracts with no private key anywhere.
The rules live in a NEAR contract (the policy), NEAR MPC signs, this package checks and broadcasts.

## What the agent gets (MCP, `keyfree-mcp`)

| Tool | Does |
|---|---|
| `keyfree_status` | what the policy allows now: keyless address, keys on the policy (0), allowed code, chains, caps, roles; a warning if a council key sits on this machine |
| `keyfree_code_hash` | the hash the allow list must hold for an artifact + constructor arguments (offline) |
| `keyfree_preview` | builds and checks a deploy, signs nothing |
| `keyfree_deploy` | the policy builds the transaction, MPC signs, the tool re-checks and broadcasts |
| `keyfree_upgrade_preview` | builds and checks `upgradeTo(implementation)` on a proxy, signs nothing |
| `keyfree_upgrade` | one proxy upgrade the council allowed: the policy builds the call, MPC signs, the tool re-checks and broadcasts |
| `keyfree_retry` | re-signs what did not land: the MPC did not answer in time, the broadcast failed, or it sits pending under a low fee (same nonce, same content, new fees) |
| `keyfree_confirm` | NEAR Read MPC confirms the factory's `Deployed` log (or the proxy's `Upgraded` log): the journal line becomes a fact |
| `keyfree_journal` | the policy's journal for a chain |

The agent gets no tool for rules, roles, pause or the policy's own code. Its NEAR key is a function-call key that
may only call `request_deploy`, `request_proxy_upgrade`, `resign`, `resign_proxy_upgrade`, `retry`, `release`,
`confirm`, `confirm_stuck`; anything else is refused by the protocol before it reaches the contract.

## What the tool checks before and after signing

1. The code hash is on the policy's allow list. Otherwise it refuses and says that allowing it is the council's decision; it does not hand the model a council command.
2. The factory serves exactly the policy's keyless address (`keyfree()` on chain).
3. The chain simulates the deploy from that address (`eth_estimateGas`); gas = estimate + 25 %.
4. The unsigned transaction built by the policy equals viem's for the same fields, byte for byte; the promised
   address equals viem's CREATE2.
5. The address holds `gas limit x max fee` (a signed nonce that cannot be mined would block the chain's queue).
6. The signed transaction is that same transaction and recovers to the policy's address. Only then it is broadcast.

For a proxy upgrade, steps 1 and 2 are: exactly this (chain, proxy, implementation) is allowed, the proxy's
ERC-1967 admin slot holds the policy's address, and the implementation has code. After broadcasting, the
proxy's `Upgraded` log must name that implementation.

## When a network fails

Nothing is signed until the checks pass, and a failure never takes a nonce away for good.

- **A node is down, silent, or answers rubbish.** The command ends with a plain message and exit code 1 within about a
  minute (`rpc_timeout_ms` in `keyfree.json`). `near_rpc_fallbacks` and a chain's `rpc_fallbacks` name further nodes,
  tried in order: public nodes do go down. `status`, `journal` and every council brake work with the EVM node dead.
- **The node is the wrong chain, the fee is over the cap, or the code needs more gas than the cap.** Stopped before signing.
- **Signed, then the broadcast fails.** The message says so. The nonce stays bound to that content; a new deploy is
  stopped before it costs a signature, because it would only wait behind the gap. `keyfree retry` re-signs the same
  content with fresh fees and lands it at the promised address (a deploy needs its artifact and arguments again: the
  journal holds only the hash, and other code is refused).
- **Sent, then a fee spike leaves it pending.** The message gives the transaction; `keyfree retry` replaces it with a higher fee.
- **The NEAR node loses the answer to a request.** The tool looks its transaction up by hash and uses that signature,
  so no second one is spent. A call is never re-signed under a new nonce on a mere node error.
- **The agent's account is short of NEAR.** A call reserves its whole gas up front (250 Tgas for a request): plain
  message, nothing happened on the policy.

An RPC address may carry an API key: messages only ever show its host. `npm test` covers all of this against two local
nodes that fail on purpose; `npm run live:faults` runs the real cases on a policy of your own (`evidence/tool_faults_live.log`).

## Run

```bash
npm install && npm run build
cp keyfree.example.json demo/keyfree.json
export KEYFREE_AGENT_KEY=/path/to/agent_key.json   # {"private_key": "ed25519:..."}, never in the repo
npm test && npm run smoke                            # offline unit tests; MCP self-check (read only)
npm run live                                         # every command and MCP tool for real, on a policy of your own
npm run live:faults                                  # dead nodes, a gas spike, a lost broadcast and its recovery, for real
node dist/cli.js status                              # from a folder with keyfree.json
```

Claude Code: open `demo/` (it has `.mcp.json`), then ask "deploy Counter with start 1 to Base Sepolia".

Human (council) commands sign with a key from `~/.near-credentials` (`--as <account>`, default `owner`):
`keyfree rules allow-code <hash>`, `keyfree rules allow-upgrade <chain> <proxy> <implementation>`,
`keyfree rules apply <id>`, `keyfree pause`, ... see `keyfree help`. `keyfree pending` needs no key: it lists
every widening that waits its delay, with the command that cancels it, and exits with code 3 when there is one,
so a scheduled job can alert the council.

Every argument is checked before anything is signed: an unknown flag (`--arg` for `--args`), a missing value,
a malformed hash or address, or a number that is not a whole number in range stops the command with a message,
so a typo never reaches the chain. Wei amounts are passed and read as exact integers, also above 2^53.
Exit codes: `0` done, `1` error, `2` refused by the policy, `3` (`pending` only) something waits its delay.
