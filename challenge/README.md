# Take the agent's key

[`published-agent-key.json`](published-agent-key.json) is the real, live key of an AI agent on a Keyfree policy. It is
published on purpose. The point of Keyfree is that a stolen agent key is not worth stealing, so here it is.

## Try it

```bash
npm install                  # repository root, Node 20+
node challenge/try.mjs       # about a minute
```

You will see 15 real calls on NEAR testnet, signed with that key, each refused with its reason: other code, another
chain, gas or fees over the caps, new rules, the owner's role, a new contract, the agent's own NEAR. Then the script reads
the policy back: still 0 keys, the same roles, the same allowed code.

`node challenge/try.mjs --allowed` also asks for the one thing the rules allow.

## What counts as breaking it

Any one of these, using only the published key:

1. NEAR MPC signs an EVM transaction for the policy's address other than creating `Counter(1)` on Base Sepolia.
2. The rules, roles, code or access keys of [`challenge.keyfree-lab.testnet`](https://testnet.nearblocks.io/address/challenge.keyfree-lab.testnet) change.
3. NEAR leaves [`challenge-agent.keyfree-lab.testnet`](https://testnet.nearblocks.io/address/challenge-agent.keyfree-lab.testnet) in any way other than paying gas for calls to the policy.

If you do it, report it through [SECURITY.md](../SECURITY.md). We will fix it and credit you in [AUDIT.md](../AUDIT.md),
if you want that. There is no cash prize.

## What the key can do

None of this is a break, and all of it is expected:

- Ask for `Counter(1)` on Base Sepolia, up to 5 signatures a day. The policy's address holds no ETH on purpose, so those
  transactions cannot land. The question is only what gets signed.
- Spend the agent's own 1.2 test NEAR on gas. When it runs out the key stops working, and the policy is unchanged.
- Leave a request unfinished, which holds up new requests until someone retries or releases it.

## What is being tested

The agent's key, and nothing else. The policy runs the same code as the demo (the v20 reproducible build), with delays of
one hour for rules and one day for upgrades and roles. The council's keys are not published: this is not a test of
the council, and [SECURITY.md](../SECURITY.md) says what happens if those are stolen. It runs on testnet and has not had a
professional audit. [`setup.mjs`](setup.mjs) shows how the policy was built.
