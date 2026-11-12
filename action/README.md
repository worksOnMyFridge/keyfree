# Keyfree deploy action

Deploy a contract from GitHub Actions through a Keyfree policy. The job holds no EVM key, only the agent's NEAR
function-call key.

```yaml
- uses: worksOnMyFridge/keyfree/action@<full commit sha>
  with:
    chain: base-sepolia
    artifact: out/Counter.sol/Counter.json
    args: '[1]'
    agent-key: ${{ secrets.KEYFREE_AGENT_KEY }}
```

| Input | Default | |
|---|---|---|
| `chain`, `artifact`, `agent-key` | required | chain name from `keyfree.json`; compiled contract; key file contents |
| `args` / `config` / `node-version` | `'[]'` / `keyfree.json` / `'22'` | constructor arguments (JSON array); config path; Node |

Outputs, set only on success: `address`, `evm-url`, `near-url`. Exit codes: 0 deployed, 2 refused by the policy
(nothing was signed), 1 any other error.

Pin a full commit sha of this repository that you have read, never a branch or a tag. Keep the secret in a protected
environment. Full setup: [`../examples/ci/README.md`](../examples/ci/README.md).

This action has not run in a separate repository yet; `keyfree-deploy.sh`, which it wraps, ran from a terminal (see examples/ci).
