# Security model

## Who can do what

The policy account has no access keys. It changes only through its own methods, called by four roles held
by four different accounts:

| Role | Can do at once | Can do only after the delay |
|---|---|---|
| Agent (an AI or CI) | ask for a deploy of allowed code, or for an allowed proxy upgrade; retry, re-sign or confirm its own requests | nothing else |
| Owner | brake (see below) | rules (new code, chain, factory, higher caps, a proxy upgrade), an upgrade of the policy and a new agent, all proposed by the owner alone; plus everything a guardian can do |
| Guardian | brake | propose, approve or cancel a new owner, guardian or reserve, or the retirement: each needs 2 of the 3 council members |
| Reserve | brake | same as the guardian |

Brakes are instant and need one council member (owner, guardian or reserve): pause, revoke the agent, remove
code or an allowed proxy upgrade, disable a chain, remove a factory, lower caps, cancel an upgrade or a rule
proposal. Brakes stop new signatures, not those already issued (see "Known limits"). From v19 a pause also stops
any rule or policy upgrade from being applied; replacing a council member still works while paused, so the honest
two can remove a stolen key that keeps pausing.

Anything that widens power waits, and the wait cannot be shortened, not even by two members together:

- rules: `rules_delay_sec`, any council member may cancel;
- a new agent: `upgrade_delay_sec`, any council member may cancel (revoking the agent is a brake, at once);
- an upgrade: `upgrade_delay_sec`, any council member may cancel; the new code itself is stored on chain
  from the moment it is proposed, so the others can read it and compare it with a build of the published
  source before it can be applied;
- a new owner, guardian or reserve, and retiring the policy: 2 of 3 approvals, then `upgrade_delay_sec`
  counted from the second approval; cancelling also needs 2 of 3, so one stolen key cannot keep its role;
- unpause is the one exception without a delay: it needs 2 of 3 votes (and any one member can pause again).

**So, honestly:** there is no key, but there is power. Full power is either 2 of the 3 council members plus
the delay, or the owner plus the delay while the guardian and the reserve stay silent. The delays and the
three separate people (or devices) are the protection; a policy whose council keys all sit in one place is
only as safe as that place.

## What an attacker gets

| Attacker has | Result |
|---|---|
| a prompt injection in a README, issue or web page | the agent can only ask for allowed code with allowed constructor arguments; other bytes have another hash and are refused (CLAIMS 3.3) |
| the agent's NEAR key | the same, plus spending the agent account's own NEAR on gas; no rule, role or upgrade method is callable with that key (CLAIMS 1.4) |
| the guardian's or the reserve's key | can pause and cancel; cannot widen anything; owner + the other member replace it after the delay (CLAIMS 4.3) |
| the owner's key | can propose widening; it waits the delay, it is public on chain, and the guardian or the reserve can cancel it |
| two council keys | full power after the delay (the formula above) |

## What is trusted

- **NEAR MPC** (the chain-signatures network) signs for the policy's derived address and, through Read MPC,
  reports what happened on the EVM chain. If the MPC network colludes or is broken, both signing and the
  journal can lie. Keyfree adds rules in front of it; it does not remove that trust. Which MPC a policy signs
  through is fixed at install: from v19 `get_config` names it, and `keyfree status` and `setup check` say whether it
  is the network's MPC and whether the policy's address is the one that MPC derives (a look-alike MPC would hold a
  key for the address while the policy shows 0 keys).
- **The EVM RPC** the tool talks to: the tool checks what the policy built against viem and what MPC signed
  against what it checked, so a lying RPC can make a deploy fail or look pending, not change what is signed.
- **The NEAR RPC** the tool talks to: the contract decides on chain, whatever a node says. A lying node can stop the
  tool or show it a false state, including a false ETH address, so a report of success is only as good as the node;
  `keyfree_confirm` and the explorers are the check. A retry's transaction is compared with its journal line too.
- **The policy code.** It is open and tested (186 unit and property tests, golden and random-vector tests against viem, the live wasm in a local nearcore node, an attack bench of 65 attacks: `npm run attacks`). During development
  it went through five security reviews, each done by a separate AI reviewer session that did not write the
  code, the fourth on another model, the fifth on the whole lifecycle; their findings were fixed with tests or stated as limits (AUDIT.md). It has not had a professional human audit.

## Known limits

- **Council keys on the agent's machine.** `setup/policy.mjs` makes no council key where the agent runs (the
  guardian and the reserve are accounts made on other devices) unless a quick testnet trial asks for it, and
  `keyfree status` names every council key it finds next to the agent. The demo policies are such trials: their
  council keys sit on the laptop that ran them. In the live run the owner key and the agent ran on the same laptop.
  When asked for code that was not allowed, the Claude Code session itself noticed it could sign as the owner
  and offered to do it after asking. It did not, and the delay plus the other two members would still apply,
  but the separation between agent and owner is only as real as the separation between their keys. Keep the
  owner key on another device or a hardware wallet, never where the agent runs.
- **The alarm.** A widening is safe only if someone sees it during its delay. The `watch` workflow checks every 15
  minutes and can post to every council member (`KEYFREE_ALERT_WEBHOOK`); GitHub may run a schedule late or skip it
  and turns it off after 60 days without activity, so a real policy needs delays of hours (setup warns under one
  hour). The demo policies use 60 s and 180 s for testing, which no schedule can watch.
- **A signed transaction is public.** The policy returns the signed raw transaction; anyone who sees it can
  broadcast it. That is sending, not a new signature: it can only spend the nonce on the content the rules
  allowed.
- **A signature cannot be recalled.** An EVM transaction does not expire. A signature held back can land
  whenever its holder likes, after a pause or a brake too, and later nonces wait behind it. Removing an allowed
  proxy upgrade helps only before the agent asks for it. Burning the nonce with another transaction would not
  settle it: the holder sees that coming and can land the signature first. So the council decides at the
  moment it allows code or an upgrade, not after.
- **One stuck request holds every chain.** A request the MPC did not sign blocks new requests on all chains until
  it is retried. If the council then brakes what that request needs (its code, chain, factory or gas), `retry` is
  refused too, and the way out is to allow it again through the rules delay, retry, and brake again. A stolen
  council key waiting for an MPC failure could cause this. To stop signing without this effect, pause.
- **A nonce that moved ahead.** If the address's nonce on a chain is ahead of the policy's (a wrong number in a
  hand-made `AllowChain`), nothing can fix it but an upgrade of the policy: the nonce never moves by hand, on
  purpose. `setup/policy.mjs` reads the real count.
- **Deploys and one kind of call.** The policy signs contract creations (plain or through its own CREATE2
  factory) and `upgradeTo(implementation)` on a proxy, always with value 0. It signs no other call and no
  transfer.
- **Money sent to the policy's address.** The policy signs only value-0 deploys and `upgradeTo`, so ETH or tokens sent
  to its address can never leave it, not even at retirement, unless a future version of the policy adds a way.
- **Money after the deploy.** Keyfree fixes who a contract pays at the moment it is deployed: an owner or a
  recipient passed to the constructor is part of the allowed hash. After that the contract obeys its own
  code and its owner. If the vault's owner key is stolen, Keyfree does not help. For a treasury behind a
  proxy whose admin is the policy, a code change is an allowed upgrade or nothing: the council should allow
  only an implementation whose code it has read (best one it deployed through Keyfree, with an allowed
  hash). A proxy with another admin, or with a way to change its admin, is outside Keyfree.
- **No budget, no signature.** A chain the council opened without a daily budget signs nothing until the
  budget's rule has passed (from v17). The amount is the council's: a budget set too high limits little.
- **The daily budget counts signatures.** Every signature counts with its most it can cost (gas limit x max
  fee), broadcast or not, by UTC day: around midnight two days' budget can be spent close together, and on
  Base the L1 data fee is charged on top of gas x fee. It bounds what the agent can start, not the exact bill.
- **A retired policy keeps its account.** Deleting it would free the name for its parent account to create
  again, and the MPC would sign for the same EVM address. The storage stake of the code stays locked for good.
- **Reproducible from v14.1 on.** The live code is a `cargo near` reproducible build (README, "Check which
  code the live policy runs"). Versions up to v14 were built on a laptop and cannot be rebuilt byte for byte.
- Testnets only so far (Base Sepolia, Ethereum Sepolia); Arbitrum not run yet; see "Not claimed" in
  CLAIMS.md. The findings of the five security reviews and what was done about each are in [AUDIT.md](AUDIT.md).

## Reporting

Please open a private security advisory on this repository, or contact the author through the profile on
the repository page. Do not post exploits publicly before a fix.
