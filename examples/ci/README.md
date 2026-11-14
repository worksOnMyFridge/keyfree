# Deploy from CI through Keyfree

A CI job that deploys contracts usually holds a deployer key in its secrets. Whoever can change the workflow, a
dependency of the build, or the constructor arguments in a pull request can use that key for anything. Here the job
holds no EVM key at all.

- [`deploy.yml`](deploy.yml): a GitHub Actions workflow to copy into your repository. It deploys in one step, with
  the [`action`](../../action/README.md) in this repository.
- [`keyfree-deploy.sh`](keyfree-deploy.sh): what the action runs; it also works the same from any other CI or a
  terminal.

## What the job holds, and what it can do

The secret `KEYFREE_AGENT_KEY` is the agent's key file for your policy (`{"account_id": ..., "private_key": ...}`,
as `setup/policy.mjs` writes it). It is a NEAR **function-call key**: it can only call the policy's request methods.
With it the job can ask for code the council allowed, with exactly the constructor arguments the council allowed, on
the chains the policy opened, within the caps and the daily budget. It cannot change rules, roles or the policy's
code, and it cannot move the agent account's NEAR, only spend it on gas.

If a change in the repository makes the job ask for other bytes (another owner, another constructor argument, other
code), the preview is refused and the job fails before anything is signed:

```
Refused by the policy: REFUSED  code not on the allow list (code hash 5ec712c9…).
```

New code reaches the allow list only through the council: a rule that waits a public delay, which any member can
cancel (`keyfree rules allow-code <hash>`).

## Set it up

1. A policy of your own (`setup/policy.mjs` in this repository) and the code you want to deploy on its allow list
   (`keyfree hash` prints the hash; the council proposes it).
2. In your repository: `keyfree.json` (the policy, the agent account, the chains; `setup/policy.mjs keyfree` writes
   it) and the compiled artifact.
3. A GitHub environment named `testnet` with the secret `KEYFREE_AGENT_KEY`. Protect it: allow deployments from
   `main` only and add a required reviewer. Without those rules the secret reaches a workflow on any branch.
4. Copy `deploy.yml` to `.github/workflows/`, set `chain` and `artifact` in its one action step, and keep the sha
   after `@` on a full commit of this repository you have read (the file pins one), never a branch or a tag.

Keep the council's keys out of CI. Run [`watch.yml`](../../.github/workflows/watch.yml) next to it, so a widening
that waits its delay raises an alarm while it can still be cancelled.

## Seen live

The script ran from a terminal on 2026-11-07 against `policy.kf-outsider-494bd7.testnet` (build v18), with the
agent key passed the way the workflow passes it:

- `ARGS=[999]`: exit 2, `REFUSED code not on the allow list (code hash 5ec712c9…)`, nothing signed.
- `ARGS=[1]`: exit 0, Counter(1) at `0xfddf…cc13`, nonce 51
  ([Base Sepolia](https://sepolia.basescan.org/tx/0xd49ebd7aa8de68da6fdc41730296ec62d85b535aa57be3ea64f1c40004dfe63e),
  [NEAR](https://testnet.nearblocks.io/txns/7ZWDHjQSTwuAvYM3V7ntFerzJJn5kgxWthusA4sH2KDw)).

The temporary key file was gone after both runs. The workflow itself has not run in a separate repository yet.
