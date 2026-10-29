# Security model

## Who can do what

The policy account has no access keys. It changes only through its own methods, called by four roles held
by four different accounts:

| Role | Can do at once | Can do only after the delay |
|---|---|---|
| Agent (an AI or CI) | ask for a deploy of allowed code; retry, re-sign or confirm its own deploys | nothing else |
| Owner | brake (see below) | rules (new code, chain, factory, higher caps), an upgrade and a new agent, all proposed by the owner alone; plus everything a guardian can do |
| Guardian | brake | propose, approve or cancel a new owner, guardian or reserve, or the retirement: each needs 2 of the 3 council members |
| Reserve | brake | same as the guardian |

Brakes are instant and need one council member (owner, guardian or reserve): pause, revoke the agent, remove
code, disable a chain, remove a factory, lower caps, cancel an upgrade or a rule proposal.

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
  journal can lie. Keyfree adds rules in front of it; it does not remove that trust.
- **The EVM RPC** the tool talks to: the tool checks what the policy built against viem and what MPC signed
  against what it checked, so a lying RPC can make a deploy fail or look pending, not change what is signed.
- **The policy code.** It is open and tested (111 unit tests, golden tests against viem, an attack bench of 44 attacks: `npm run attacks`). During development
  it went through two security reviews, each done by a separate AI reviewer session that did not write the
  code; their findings were fixed with tests. It has not had a professional human audit.

## Known limits

- **Owner key on the agent's machine.** In the live run the owner key and the agent ran on the same laptop.
  When asked for code that was not allowed, the Claude Code session itself noticed it could sign as the owner
  and offered to do it after asking. It did not, and the delay plus the other two members would still apply,
  but the separation between agent and owner is only as real as the separation between their keys. Keep the
  owner key on another device or a hardware wallet, never where the agent runs.
- **A signed transaction is public.** The policy returns the signed raw transaction; anyone who sees it can
  broadcast it. That is sending, not a new signature: it can only spend the nonce on the content the rules
  allowed.
- **Deploys only.** The policy signs contract creations (plain or through its own CREATE2 factory) with value
  0. It does not sign calls or transfers.
- **Money after the deploy.** Keyfree fixes who a contract pays at the moment it is deployed: an owner or a
  recipient passed to the constructor is part of the allowed hash. After that the contract obeys its own
  code and its owner. If the vault's owner key is stolen, or the vault has an admin who can change the
  owner, Keyfree does not help; allow only code whose money paths you have read.
- Testnets only so far; Arbitrum not run yet; see "Not claimed" in CLAIMS.md.

## Reporting

Please open a private security advisory on this repository, or contact the author through the profile on
the repository page. Do not post exploits publicly before a fix.
