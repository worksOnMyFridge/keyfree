// The agent's flows: status, preview, deploy, proxy upgrade, retry, confirm, journal. Everything the policy builds is
// checked against viem before it is signed, and everything it signs is checked again before it is broadcast.
import {
  decodeEventLog, decodeFunctionData, encodeFunctionData, getAddress, getContractAddress, isAddress, keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction,
  type Hex, type TransactionSerializableEIP1559,
} from "viem";
import { agentKey, findChain, localCouncilKeys, type ChainConfig, type Config } from "./config.js";
import { loadCode, type CodeInput } from "./code.js";
import { evm, FACTORY_ABI, PROXY_ABI, ADMIN_SLOT, IMPLEMENTATION_SLOT, slotAddress, randomSalt, txLink, addressLink } from "./evm.js";
import { KeyPair } from "near-api-js";
import { NearFault, Policy, PolicyRefusal, reason } from "./near.js";

interface Preview { unsigned: Hex; hash: string; nonce: number; expected_address: string | null; min_gas: number }
interface Entry {
  kind?: "deploy" | "proxy_upgrade"; status: string; tx_hash: string;
  address?: string; factory?: string; code_hash?: string; salt?: string; proxy?: string; implementation?: string;
}
interface Rules { allowed_code: string[]; allowed_proxy_upgrades?: string[]; max_gas_limit: string; max_fee_cap: string; rules_delay_sec: number; proposals: unknown[] }

export interface DeployInput extends CodeInput {
  chain: string | number;
  salt?: string;
  via_factory?: boolean;
}

export interface RetryInput extends CodeInput {
  chain: string | number;
}

export interface UpgradeInput {
  chain: string | number;
  proxy: string;
  implementation: string;
}

export const upgradeKey = (chainId: number, proxy: string, implementation: string) => `${chainId}:${proxy.toLowerCase()}:${implementation.toLowerCase()}`;

export interface DeployResult {
  chain: string;
  nonce: number;
  address: string | null;
  code_hash: string;
  near_tx: string;
  evm_tx: string;
  gas_used: string;
  links: { near: string; evm: string; contract?: string };
  next: string;
}

// The request methods the agent's function-call key may call, and nothing else.
const AGENT_METHODS = ["request_deploy", "request_proxy_upgrade", "resign", "resign_proxy_upgrade", "retry", "release", "confirm", "confirm_stuck"];
const AGENT_GAS = 250; // Tgas for request_deploy / retry: 100 for the MPC, 50 for the callback, the rest for the build
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const RETRY_HOW = "call keyfree_retry (CLI: keyfree retry --chain <chain>), for a deploy with the same artifact and arguments";

export class Keyfree {
  readonly policy: Policy;
  constructor(readonly cfg: Config) {
    this.policy = new Policy(cfg);
  }

  // The key the tool signs with must be what the README promises: a function-call key on this policy for
  // request methods only. keyfree.json, which a cloned project can bring, names the agent account; if it
  // named the owner or any account whose local key can do more, the tool refuses to sign (review finding X3).
  private agentChecked = false;
  private async agent() {
    const key = agentKey(this.cfg);
    if (!this.agentChecked) {
      const pk = KeyPair.fromString(key as Parameters<typeof KeyPair.fromString>[0]).getPublicKey().toString();
      const keys = await this.policy.accessKeys(this.cfg.agent);
      const found = keys.find((k) => k.public_key === pk);
      const perm = found?.access_key.permission as unknown;
      const fc = typeof perm === "object" && perm !== null ? (perm as { FunctionCall?: { receiver_id: string; method_names: string[] } }).FunctionCall : undefined;
      if (!found) throw new Error(`The local key for ${this.cfg.agent} is not on that account. Not signing.`);
      if (!fc) throw new Error(`The local key for ${this.cfg.agent} is a full-access key. The agent must hold only a function-call key on ${this.cfg.policy}; not signing with this one.`);
      const extra = fc.method_names.filter((m) => !AGENT_METHODS.includes(m));
      if (fc.receiver_id !== this.cfg.policy || fc.method_names.length === 0 || extra.length) {
        throw new Error(`The local key for ${this.cfg.agent} may call ${fc.method_names.length ? fc.method_names.join(", ") : "any method"} on ${fc.receiver_id}; the agent's key must be limited to the request methods of ${this.cfg.policy}. Not signing.`);
      }
      this.agentChecked = true;
    }
    return this.policy.account(this.cfg.agent, key);
  }

  // Z10: an upgrade is allowed by address. Before the council proposes one, the CLI shows the code that sits at
  // that address now and refuses an address with no code: what lands there later would be someone's choice.
  async implementationCode(chainName: string, implementation: string): Promise<{ code_hash: string; bytes: number }> {
    const chain = findChain(this.cfg, chainName);
    const code = await this.evm(chain).getCode({ address: implementation as Hex }).catch((e) => { throw new Error(`The EVM node did not answer for ${implementation}: ${reason(e)}`); });
    if (!code || code === "0x") throw new Error(`${implementation} has no code on ${chain.name}. Allow an upgrade only to an implementation that is already deployed and that you have read.`);
    return { code_hash: keccak256(code), bytes: (code.length - 2) / 2 };
  }

  private evm(chain: ChainConfig) {
    return evm(chain, this.cfg.rpc_timeout_ms);
  }

  // A request whose NEAR transaction may still be running when the node fails: it must not be repeated blindly.
  private async request(method: string, args: Record<string, unknown>) {
    const agent = await this.agent();
    try {
      return await this.policy.call<Hex>(agent, method, args, AGENT_GAS);
    } catch (e) {
      if (!(e instanceof NearFault)) throw e;
      throw new Error(`${e.message} The request may still have gone through: do not send it again. keyfree_journal shows the line; if it stays unlanded, ${RETRY_HOW}.`);
    }
  }

  private async chainReady(chain: ChainConfig) {
    const id = await this.evm(chain).getChainId();
    if (id !== chain.chain_id) throw new Error(`The RPC set for ${chain.name} answers as chain ${id}, not ${chain.chain_id}. Nothing was signed.`);
  }

  // Before a signature is asked for, the address's own nonce must be where the policy's next one is. Behind it,
  // the new transaction would wait for ever behind the gap; ahead of it, the signed transaction would be rejected.
  // "pending" counts what is in the mempool, and a public node can lag a block, so a gap is looked at twice.
  private async nonceReady(chain: ChainConfig, address: Hex, nonce: number) {
    const c = this.evm(chain);
    let count = await c.getTransactionCount({ address, blockTag: "pending" });
    if (count < nonce) {
      await new Promise((r) => setTimeout(r, 4000));
      count = await c.getTransactionCount({ address, blockTag: "pending" });
    }
    if (count < nonce) throw new Error(`Nonce ${count} on ${chain.name} was signed but is not on chain, and anything newer would wait behind it. First ${RETRY_HOW}. Nothing was signed.`);
    if (count > nonce) throw new Error(`The address's nonce on ${chain.name} (${count}) is ahead of the policy's next one (${nonce}): a signature for ${nonce} would be rejected. Nothing was signed. The nonce never moves by hand: the council can only fix this with an upgrade of the policy.`);
  }

  private async rules(): Promise<Rules> {
    const r = await this.policy.view<Rules>("get_rules");
    if (!Array.isArray(r?.allowed_code)) throw new Error("The NEAR node's answer to get_rules has no allow list. Nothing was signed.");
    return r;
  }

  async address(): Promise<Hex> {
    const a = await this.policy.view<string | null>("get_eth_address");
    if (!a) throw new Error(`The policy ${this.cfg.policy} has no ETH address yet: the owner runs setup first.`);
    return a as Hex;
  }

  async status() {
    const [st, roles, rules, address] = await Promise.all([
      this.policy.view<Record<string, unknown>>("get_status"),
      this.policy.view<Record<string, unknown>>("get_roles"),
      this.rules(),
      this.policy.view<string | null>("get_eth_address"),
    ]);
    const keys = (await this.policy.accessKeys(this.cfg.policy)).length;
    const chains = await Promise.all(this.cfg.chains.map(async (c) => {
      const next = await this.policy.view<number | null>("get_next_nonce", { chain_id: c.chain_id });
      // An EVM node being down must not hide the policy's state: the council reads this in an incident.
      const funds = address
        ? await this.evm(c).getBalance({ address: address as Hex }).then((b) => ({ balance_wei: b.toString() } as Record<string, unknown>), (e) => ({ balance_wei: null, rpc_error: reason(e) }))
        : { balance_wei: "0" };
      // Daily budget and today's use (R8); a policy older than v15 has no get_budget.
      const budget = await this.policy.view<Record<string, unknown> | null>("get_budget", { chain_id: c.chain_id }).catch(() => null);
      return { name: c.name, chain_id: c.chain_id, allowed: next !== null, next_nonce: next, ...funds, daily_budget: budget };
    }));
    // Agent and council are only as separate as their keys: say so when a council key is on this machine.
    const council = [roles.owner, roles.guardian, roles.reserve].filter((a): a is string => typeof a === "string");
    const here = localCouncilKeys(this.cfg, council);
    const mpc = await this.mpcCheck(address);
    const warnings = [
      ...(here.length ? [`council keys on this machine (${here.join("; ")}): keep them on another device, never where the agent runs`] : []),
      ...(mpc.warning ? [mpc.warning] : []),
    ];
    return {
      policy: this.cfg.policy, policy_keys: keys, address, build: st.build, version: st.version, paused: st.paused,
      ...(warnings.length ? { warning: warnings.join(" | ") } : {}),
      mpc: mpc.report,
      agent: roles.agent, owner: roles.owner, guardian: roles.guardian, reserve: roles.reserve, retiring: roles.retiring,
      upgrade_delay_sec: st.upgrade_delay_sec, rules_delay_sec: rules.rules_delay_sec, pending_upgrade: st.proposed,
      allowed_code: rules.allowed_code, allowed_proxy_upgrades: rules.allowed_proxy_upgrades ?? [], max_gas_limit: rules.max_gas_limit, max_fee_cap: rules.max_fee_cap, chains,
    };
  }

  // Fees: viem's estimate x fee_multiplier, never under the chain's floor (the policy names the floor when it refuses).
  // `over` = the fees of a transaction still in the mempool: a node takes a replacement only about 10 % above them.
  private async fees(chain: ChainConfig, floor = 0n, over?: { max: bigint; prio: bigint }) {
    const f = await this.evm(chain).estimateFeesPerGas();
    const mult = BigInt(Math.round((this.cfg.fee_multiplier ?? 1.2) * 100));
    let max = (f.maxFeePerGas * mult) / 100n;
    if (max < floor) max = floor;
    let prio = f.maxPriorityFeePerGas < max ? f.maxPriorityFeePerGas : max;
    if (over) {
      const bump = (x: bigint) => (x * 112n) / 100n + 1n;
      if (prio < bump(over.prio)) prio = bump(over.prio);
      if (max < bump(over.max)) max = bump(over.max);
      if (max < prio) max = prio;
    }
    // The fees travel as JSON numbers: above 2^53 they would be rounded, and no real fee is there.
    if (max > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`The node's fee estimate on ${chain.name} (${max} wei per gas) is too large to be real. Nothing was signed.`);
    return { max_fee_per_gas: max, max_priority_fee_per_gas: prio };
  }

  // Z3: the policy signs through the MPC account and path it was installed with. Check both: the account is the
  // network's real MPC, and the address the policy reports is the one that MPC derives for (this policy, path).
  // A look-alike MPC chosen at install would hold a key for the address while the policy shows 0 keys.
  private async mpcCheck(address: string | null): Promise<{ report: Record<string, unknown>; warning?: string }> {
    // The network's MPC is fixed here, not taken from keyfree.json: a config written by an attacker could otherwise
    // name its own MPC as the one to trust.
    const real = this.cfg.near_network === "mainnet" ? "v1.signer" : "v1.signer-prod.testnet";
    const named = this.cfg.mpc_account && this.cfg.mpc_account !== real
      ? `keyfree.json names ${this.cfg.mpc_account} as the MPC; the network's MPC is ${real}, and the policy is checked against it` : undefined;
    let cfg: { mpc: string; path: string } | null = null;
    let readError: string | undefined;
    try { cfg = await this.policy.view<{ mpc: string; path: string }>("get_config"); } catch (e) { readError = reason(e); }
    if (!cfg) {
      // A policy before v19 has no get_config; any other failure is said, not taken for an old policy.
      const older = /MethodNotFound|method.*not found|CodeDoesNotExist/i.test(readError ?? "");
      return older
        ? { report: { checked: false, note: "this policy is older than v19 and does not name its MPC; compare the address with a fresh derivation by hand" }, ...(named ? { warning: named } : {}) }
        : { report: { checked: false, note: "get_config could not be read" }, warning: [named, `could not read the policy's MPC (get_config): ${readError}`].filter(Boolean).join(" | ") };
    }
    if (cfg.mpc !== real) {
      return { report: { checked: true, account: cfg.mpc, path: cfg.path, expected_account: real, address_matches: false },
        warning: [named, `the policy signs through ${cfg.mpc}, not the network's MPC ${real}: whoever runs that contract may hold a key for the policy's address`].filter(Boolean).join(" | ") };
    }
    const key = await this.policy.viewOf<string>(real, "derived_public_key", { path: cfg.path, predecessor: this.cfg.policy, domain_id: 0 }).catch(() => null);
    const derived = typeof key === "string" ? ethAddressOfKey(key) : null;
    if (!derived) return { report: { checked: false, account: cfg.mpc, path: cfg.path, note: "the MPC did not answer derived_public_key" } };
    const same = !!address && derived === address.toLowerCase();
    const warning = [named, same ? undefined : `the policy's address ${address} is not the one ${real} derives for it (${derived})`].filter(Boolean).join(" | ");
    return { report: { checked: true, account: cfg.mpc, path: cfg.path, derived_address: derived, address_matches: same }, ...(warning ? { warning } : {}) };
  }

  // The chain's simulation from our address, +25 %, under the cap. Over the cap it would run out of gas on chain.
  private async gasFor(chain: ChainConfig, account: Hex, to: Hex | undefined, data: Hex, cap: number, min: number, what: string) {
    let est: bigint;
    try {
      est = await this.evm(chain).estimateGas({ account, to, data, value: 0n });
    } catch (e) {
      throw new Error(`The chain says this ${what} would fail (simulation): ${reason(e)}. Nothing was signed.`);
    }
    if (est > BigInt(cap)) throw new Error(`This ${what} needs about ${est} gas, over the policy's cap of ${cap}. Raising the cap is a decision for the human council. Nothing was signed.`);
    return Math.min(cap, Math.max(min, Number((est * 125n) / 100n)));
  }

  private async previewWithFloor(args: Record<string, unknown>, chain: ChainConfig, method = "preview"): Promise<{ pv: Preview; args: Record<string, unknown> }> {
    try {
      return { pv: wellFormed(await this.policy.view<Preview>(method, args)), args };
    } catch (e) {
      const floor = /fee below the floor (\d+)/.exec(String((e as Error).message));
      if (!floor) throw asPreviewError(e);
      const f = await this.fees(chain, BigInt(floor[1]));
      const again = { ...args, max_fee_per_gas: Number(f.max_fee_per_gas), max_priority_fee_per_gas: Number(f.max_priority_fee_per_gas) };
      return { pv: wellFormed(await this.policy.view<Preview>(method, again).catch((e2) => { throw asPreviewError(e2); })), args: again };
    }
  }

  // A proxy upgrade, built and checked, nothing signed: the policy must allow exactly (chain, proxy, implementation),
  // the proxy's admin must be the policy's own address, the implementation must have code, and the bytes must equal viem's.
  private async upgradePlan(input: UpgradeInput) {
    const chain = findChain(this.cfg, input.chain);
    if (!isAddress(input.proxy) || !isAddress(input.implementation)) throw new Error("proxy and implementation must be 0x addresses.");
    const proxy = getAddress(input.proxy);
    const implementation = getAddress(input.implementation);
    const [address, rules] = await Promise.all([this.address(), this.rules()]);
    const k = upgradeKey(chain.chain_id, proxy, implementation);
    if (!(rules.allowed_proxy_upgrades ?? []).includes(k)) {
      throw new PolicyRefusal(`proxy upgrade not on the allow list (${k}). Allowing it is a decision for the human council, outside this tool; it then waits ${rules.rules_delay_sec} s and any member can cancel it. Each allowance is used once.`);
    }
    await this.chainReady(chain);
    const c = this.evm(chain);
    const [admin, current, implCode] = await Promise.all([
      c.getStorageAt({ address: proxy, slot: ADMIN_SLOT }), c.getStorageAt({ address: proxy, slot: IMPLEMENTATION_SLOT }), c.getCode({ address: implementation }),
    ]);
    if (slotAddress(admin) !== address.toLowerCase()) throw new Error(`The proxy ${proxy} has admin ${slotAddress(admin)}, not the policy's address ${address}. Not signing.`);
    if (!implCode || implCode === "0x") throw new Error(`The implementation ${implementation} has no code on ${chain.name}. Not signing.`);
    const f = await this.fees(chain);
    const cap = Number(rules.max_gas_limit);
    const base = { chain_id: chain.chain_id, proxy_hex: proxy, implementation_hex: implementation, max_fee_per_gas: Number(f.max_fee_per_gas), max_priority_fee_per_gas: Number(f.max_priority_fee_per_gas) };
    const data = encodeFunctionData({ abi: PROXY_ABI, functionName: "upgradeTo", args: [implementation] });
    const first = await this.previewWithFloor({ ...base, gas_limit: Math.min(cap, probeGas(data)) }, chain, "preview_proxy_upgrade");
    await this.nonceReady(chain, address, first.pv.nonce);
    const gas = await this.gasFor(chain, address, proxy, data, cap, first.pv.min_gas, "upgrade");
    const { pv, args } = await this.previewWithFloor({ ...first.args, gas_limit: gas }, chain, "preview_proxy_upgrade");
    const mine = serializeTransaction(this.fields(chain, pv.nonce, proxy, data, args));
    if (pv.unsigned !== mine) throw new Error("The transaction the policy built differs from viem's for the same fields. Not signing; report this.");
    const reserve = BigInt(gas) * BigInt(args.max_fee_per_gas as number);
    const balance = await c.getBalance({ address });
    if (balance < reserve) {
      throw new Error(`Not enough ETH on ${address} for this upgrade: needs ${reserve} wei up front (gas ${gas} x fee ${args.max_fee_per_gas}), has ${balance}. Fund the address; nothing was signed.`);
    }
    return { chain, address, proxy, implementation, current: slotAddress(current), pv, args, data, reserve, balance };
  }

  async previewUpgrade(input: UpgradeInput) {
    const p = await this.upgradePlan(input);
    return {
      chain: p.chain.name, nonce: p.pv.nonce, proxy: p.proxy, from_implementation: p.current, to_implementation: p.implementation,
      gas_limit: p.args.gas_limit, max_fee_per_gas: String(p.args.max_fee_per_gas), reserve_wei: p.reserve.toString(), balance_wei: p.balance.toString(),
      matches_viem: true, note: "The allowance is used by the request: after it, the same upgrade (or a rollback) needs a new rule.",
    };
  }

  async upgradeProxy(input: UpgradeInput): Promise<DeployResult> {
    const p = await this.upgradePlan(input);
    const res = await this.request("request_proxy_upgrade", p.args);
    if (!res.value) {
      throw new Error(`The MPC did not sign in time (NEAR tx ${this.policy.tx(res.txHash)}). Nonce ${p.pv.nonce} stays bound to this exact upgrade; call keyfree_retry (later, with new fees). Nothing was broadcast.`);
    }
    return this.broadcast(p.chain, res.value, res.txHash, p.pv.nonce, "", null, this.fields(p.chain, p.pv.nonce, p.proxy, p.data, p.args), p.implementation);
  }

  // Build everything, check it, but sign nothing.
  async preview(input: DeployInput) {
    const p = await this.plan(input);
    return {
      chain: p.chain.name, nonce: p.pv.nonce, expected_address: p.pv.expected_address, salt: p.salt, code_hash: p.code.hash, code: p.code.source,
      gas_limit: p.args.gas_limit, max_fee_per_gas: String(p.args.max_fee_per_gas), reserve_wei: p.reserve.toString(),
      balance_wei: p.balance.toString(), matches_viem: true, bytes: (p.pv.unsigned.length - 2) / 2,
    };
  }

  private async plan(input: DeployInput) {
    const chain = findChain(this.cfg, input.chain);
    const code = loadCode(input);
    const [address, rules] = await Promise.all([this.address(), this.rules()]);
    if (!rules.allowed_code.includes(code.hash)) {
      throw new PolicyRefusal(`code not on the allow list (code hash ${code.hash}). Allowing it is a decision for the human council, outside this tool; it then waits ${rules.rules_delay_sec} s and any member can cancel it.`);
    }
    await this.chainReady(chain);
    const viaFactory = input.via_factory ?? true;
    const salt = viaFactory ? ((input.salt as Hex | undefined) ?? randomSalt()) : null;
    const f = await this.fees(chain);
    const cap = Number(rules.max_gas_limit);
    const base = { chain_id: chain.chain_id, init_code_hex: code.init, max_fee_per_gas: Number(f.max_fee_per_gas), max_priority_fee_per_gas: Number(f.max_priority_fee_per_gas), salt_hex: salt, via_factory: viaFactory || null };
    const data = viaFactory ? encodeFunctionData({ abi: FACTORY_ABI, functionName: "deploy", args: [salt as Hex, code.init] }) : code.init;
    // 1) only to learn the nonce, the target (our factory) and the intrinsic minimum. The gas asked here must
    // pass the policy's minimum without inflating the day's budget, so it is an upper bound of that minimum.
    const first = await this.previewWithFloor({ ...base, gas_limit: Math.min(cap, probeGas(data)) }, chain);
    const draft = parseSigned(first.pv.unsigned);
    const to = draft.to ?? undefined;
    await this.nonceReady(chain, address, first.pv.nonce);
    if (viaFactory) await this.checkFactory(chain, to, address);
    // 2) real gas: ask the chain to simulate it from our address, +25 %
    const gas = await this.gasFor(chain, address, to, data, cap, first.pv.min_gas, "deploy");
    const { pv, args } = await this.previewWithFloor({ ...first.args, gas_limit: gas }, chain);
    // 3) the policy's bytes must equal viem's for the same fields, or we stop before signing
    const mine = serializeTransaction(this.fields(chain, pv.nonce, to, data, args));
    if (pv.unsigned !== mine) throw new Error("The transaction the policy built differs from viem's for the same fields. Not signing; report this.");
    if (viaFactory) {
      const predicted = getContractAddress({ opcode: "CREATE2", from: to as Hex, salt: salt as Hex, bytecode: code.init }).toLowerCase();
      if (pv.expected_address !== predicted) throw new Error(`The policy's promised address ${pv.expected_address} differs from CREATE2 ${predicted}. Not signing.`);
    }
    // 4) the address must hold gas_limit x max fee up front, or a signed nonce would wait forever
    const reserve = BigInt(gas) * BigInt(args.max_fee_per_gas as number);
    const balance = await this.evm(chain).getBalance({ address });
    if (balance < reserve) {
      throw new Error(`Not enough ETH on ${address} for this deploy: needs ${reserve} wei up front (gas ${gas} x fee ${args.max_fee_per_gas}), has ${balance}. Fund the address; nothing was signed.`);
    }
    return { chain, code, address, pv, args, to, data, salt, reserve, balance };
  }

  private fields(chain: ChainConfig, nonce: number, to: Hex | undefined, data: Hex, args: Record<string, unknown>): TransactionSerializableEIP1559 {
    return {
      type: "eip1559", chainId: chain.chain_id, nonce, to, data, value: 0n, gas: BigInt(args.gas_limit as number),
      maxFeePerGas: BigInt(args.max_fee_per_gas as number), maxPriorityFeePerGas: BigInt(args.max_priority_fee_per_gas as number),
    };
  }

  // The factory must be a contract that serves exactly our keyless address.
  private async checkFactory(chain: ChainConfig, to: Hex | undefined, address: Hex) {
    if (!to) throw new Error("The policy built a deploy without a factory target.");
    let served: string;
    try {
      served = await this.evm(chain).readContract({ address: to, abi: FACTORY_ABI, functionName: "keyfree" });
    } catch (e) {
      throw new Error(`Could not read the factory ${to} on ${chain.name}: ${reason(e)}. Not signing.`);
    }
    if (served.toLowerCase() !== address.toLowerCase()) throw new Error(`The factory ${to} does not serve ${address}. Not signing.`);
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    const p = await this.plan(input);
    const res = await this.request("request_deploy", p.args);
    if (!res.value) {
      throw new Error(`The MPC did not sign in time (NEAR tx ${this.policy.tx(res.txHash)}). Nonce ${p.pv.nonce} stays bound to this exact deploy; call keyfree_retry (later, with new fees). Nothing was broadcast.`);
    }
    return this.broadcast(p.chain, res.value, res.txHash, p.pv.nonce, p.code.hash, p.pv.expected_address, this.fields(p.chain, p.pv.nonce, p.to, p.data, p.args));
  }

  // Everything that did not land, through one door. A request the MPC never signed is re-signed by `retry`; one
  // signed but not on chain (the broadcast failed, the answer was lost, or it sits under a low fee) by `resign`.
  // Either way: the same nonce and content, new fees, and whichever variant lands makes the others invalid.
  async retry(input: RetryInput) {
    let open = await this.policy.view<{ pending: number | null; stuck: number | null; chain_id?: number | null }>("get_open");
    if (open.pending !== null) {
      // If the callback never ran, the request can be moved on once its timeout has passed; the contract decides.
      try {
        await this.policy.call(await this.agent(), "release", {}, 30);
      } catch (e) {
        if (e instanceof PolicyRefusal && /still waiting/.test(e.reason)) throw new Error(`Request ${open.pending} is still being signed; wait for it.`);
        throw e;
      }
      open = await this.policy.view("get_open");
    }
    return open.stuck !== null ? this.retryStuck(input, open.stuck, open.chain_id) : this.retryUnlanded(input);
  }

  private async retryStuck(input: RetryInput, nonce: number, chainId?: number | null) {
    // The stuck request's chain is the policy's word, not the caller's (review finding X10).
    const chain = chainId != null ? findChain(this.cfg, chainId) : findChain(this.cfg, input.chain);
    if (String(input.chain) !== chain.name && Number(input.chain) !== chain.chain_id) {
      throw new Error(`The stuck request is on ${chain.name}, not ${input.chain}. Nothing was signed.`);
    }
    await this.chainReady(chain);
    const onChain = await this.evm(chain).getTransactionCount({ address: await this.address() });
    if (onChain > nonce) throw new Error(`Nonce ${nonce} on ${chain.name} is already used on chain, so a new signature for it would be rejected (a late signature of this request landed?). Nothing was signed. The contract's confirm_stuck moves the journal on, with proof of that transaction.`);
    const entry = await this.policy.view<Entry | null>("get_entry", { chain_id: chain.chain_id, nonce });
    if (!entry) throw new Error(`No journal line for ${chain.name} nonce ${nonce}.`);
    const res = await this.requestWithFloor(chain, "retry", {});
    if (!res.value) throw new Error(`Still not signed (NEAR tx ${this.policy.tx(res.txHash)}). Try again later.`);
    const t = parseSigned(res.value);
    sameAsLine(t, entry);
    return this.broadcast(chain, res.value, res.txHash, nonce, entry.code_hash ?? "", entry.address && entry.address !== ZERO_ADDRESS ? entry.address : null,
      { type: "eip1559", chainId: chain.chain_id, nonce, to: t.to ?? undefined, data: t.data, value: 0n, gas: t.gas!, maxFeePerGas: t.maxFeePerGas!, maxPriorityFeePerGas: t.maxPriorityFeePerGas! },
      entry.kind === "proxy_upgrade" ? entry.implementation : undefined);
  }

  private async retryUnlanded(input: RetryInput) {
    const chain = findChain(this.cfg, input.chain);
    await this.chainReady(chain);
    const c = this.evm(chain);
    const [address, rules, next] = await Promise.all([this.address(), this.rules(), this.policy.view<number | null>("get_next_nonce", { chain_id: chain.chain_id })]);
    const nonce = await c.getTransactionCount({ address });
    if (next === null || nonce >= next) throw new Error("Nothing is stuck.");
    const entry = await this.policy.view<Entry | null>("get_entry", { chain_id: chain.chain_id, nonce });
    if (!entry) throw new Error(`Nonce ${nonce} is not on ${chain.name} and has no journal line. Nothing was signed; tell the policy's council.`);
    // The node may lag behind what already landed; then a new signature would only be rejected.
    if (await c.getTransactionReceipt({ hash: entry.tx_hash as Hex }).catch(() => null)) throw new Error(`Nothing is stuck: ${entry.tx_hash} landed (the node's count is still catching up).`);

    let to: Hex | undefined, data: Hex, method: string, base: Record<string, unknown>, expected: string | null = null;
    if (entry.kind === "proxy_upgrade") {
      to = entry.proxy as Hex;
      data = encodeFunctionData({ abi: PROXY_ABI, functionName: "upgradeTo", args: [entry.implementation as Hex] });
      method = "resign_proxy_upgrade";
      base = { chain_id: chain.chain_id, nonce };
    } else {
      if (!input.artifact && !input.init_code_hex) throw new Error(`Line ${nonce} is a deploy that was signed but is not on chain. The journal holds only its code hash (${entry.code_hash}): pass the same artifact and arguments to retry. Nothing was signed.`);
      const code = loadCode(input);
      if (code.hash !== entry.code_hash) throw new Error(`That code (hash ${code.hash}) differs from line ${nonce} (hash ${entry.code_hash}). Pass the same artifact and arguments. Nothing was signed.`);
      const viaFactory = entry.factory !== ZERO_ADDRESS;
      to = viaFactory ? (entry.factory as Hex) : undefined;
      data = viaFactory ? encodeFunctionData({ abi: FACTORY_ABI, functionName: "deploy", args: [entry.salt as Hex, code.init] }) : code.init;
      method = "resign";
      base = { chain_id: chain.chain_id, nonce, init_code_hex: code.init };
      if (viaFactory) expected = entry.address ?? null;
    }
    const inPool = await c.getTransaction({ hash: entry.tx_hash as Hex }).catch(() => null);
    const over = inPool?.maxFeePerGas != null ? { max: inPool.maxFeePerGas, prio: inPool.maxPriorityFeePerGas ?? 0n } : undefined;
    const gas = await this.gasFor(chain, address, to, data, Number(rules.max_gas_limit), probeGas(data), entry.kind === "proxy_upgrade" ? "upgrade" : "deploy");
    const res = await this.requestWithFloor(chain, method, { ...base, gas_limit: gas }, { gas, address, over });
    if (!res.value) throw new Error(`Still not signed (NEAR tx ${this.policy.tx(res.txHash)}). Line ${nonce} stays as it was; try again later.`);
    const t = parseSigned(res.value);
    return this.broadcast(chain, res.value, res.txHash, nonce, entry.code_hash ?? "", expected,
      { type: "eip1559", chainId: chain.chain_id, nonce, to, data, value: 0n, gas: BigInt(gas), maxFeePerGas: t.maxFeePerGas!, maxPriorityFeePerGas: t.maxPriorityFeePerGas! },
      entry.kind === "proxy_upgrade" ? entry.implementation : undefined);
  }

  // Ask with fresh fees; if the chain's floor is above them, the policy names the floor and it is asked once more.
  // With a gas limit, the address must hold gas x fee up front, or the signature would only fail at the node.
  private async requestWithFloor(chain: ChainConfig, method: string, args: Record<string, unknown>, up?: { gas: number; address: Hex; over?: { max: bigint; prio: bigint } }) {
    const attempt = async (floor: bigint) => {
      const f = await this.fees(chain, floor, up?.over);
      if (up) {
        const reserve = BigInt(up.gas) * f.max_fee_per_gas;
        const balance = await this.evm(chain).getBalance({ address: up.address });
        if (balance < reserve) throw new Error(`Not enough ETH on ${up.address} to re-sign: needs ${reserve} wei up front (gas ${up.gas} x fee ${f.max_fee_per_gas}), has ${balance}. Fund the address; nothing was signed.`);
      }
      return this.request(method, { ...args, max_fee_per_gas: Number(f.max_fee_per_gas), max_priority_fee_per_gas: Number(f.max_priority_fee_per_gas) });
    };
    try {
      return await attempt(0n);
    } catch (e) {
      const floor = e instanceof PolicyRefusal ? /fee below the floor (\d+)/.exec(e.reason) : null;
      if (!floor) throw e;
      return attempt(BigInt(floor[1]));
    }
  }

  // `upgrade` = the implementation, for a proxy upgrade (its log is Upgraded, not Deployed).
  private async broadcast(chain: ChainConfig, raw: Hex, nearTx: string, nonce: number, codeHash: string, expected: string | null, want: TransactionSerializableEIP1559, upgrade?: string): Promise<DeployResult> {
    await checkSigned(raw, want, await this.address());
    const c = this.evm(chain);
    const hash = keccak256(raw);
    try {
      await c.sendRawTransaction({ serializedTransaction: raw });
    } catch (e) {
      // The node may have taken it and lost the answer (or already hold it): only a transaction it cannot show is unsent.
      if (!(await c.getTransaction({ hash }).catch(() => null))) {
        throw new Error(`Signed, but not on chain: the node refused the broadcast (${reason(e)}). Nonce ${nonce} on ${chain.name} is bound to this content and nothing else can use it. When the node works again, ${RETRY_HOW}.`);
      }
    }
    let rc;
    try {
      rc = await c.waitForTransactionReceipt({ hash, timeout: this.cfg.receipt_timeout_ms ?? 180_000 });
    } catch (e) {
      throw new Error(`Sent as ${hash}, but no receipt yet (${reason(e)}). It is still valid and may land: do not deploy it again. See ${txLink(chain, hash)}; if it stays pending (the fee may be too low), ${RETRY_HOW}.`);
    }
    const log = rc.logs.find((l) => l.address.toLowerCase() === want.to?.toLowerCase());
    if (upgrade) {
      const links = { near: this.policy.tx(nearTx), evm: txLink(chain, hash), contract: addressLink(chain, want.to!) };
      const base = { chain: chain.name, nonce, address: want.to!.toLowerCase(), code_hash: "", near_tx: nearTx, evm_tx: hash, gas_used: rc.gasUsed.toString(), links };
      if (rc.status !== "success" || !log) return { ...base, next: "The upgrade reverted on chain (the nonce is used, the proxy is unchanged)." };
      const now = (decodeEventLog({ abi: PROXY_ABI, data: log.data, topics: log.topics }).args as { implementation: string }).implementation.toLowerCase();
      if (now !== upgrade.toLowerCase()) throw new Error(`The proxy logged implementation ${now}, not ${upgrade}.`);
      return { ...base, next: `Upgraded: the proxy now runs ${now}. To write it into the journal as a fact, call keyfree_confirm with nonce ${nonce} once the block is Safe (~20 min on Base Sepolia).` };
    }
    let address = rc.contractAddress?.toLowerCase() ?? null;
    if (log) address = (decodeEventLog({ abi: FACTORY_ABI, data: log.data, topics: log.topics }).args as { addr: string }).addr.toLowerCase();
    if (rc.status !== "success") {
      return { chain: chain.name, nonce, address: null, code_hash: codeHash, near_tx: nearTx, evm_tx: hash, gas_used: rc.gasUsed.toString(),
        links: { near: this.policy.tx(nearTx), evm: txLink(chain, hash) }, next: "The deploy reverted on chain (the nonce is used). Check the constructor; nothing else to do for this nonce." };
    }
    if (expected && address !== expected.toLowerCase()) throw new Error(`Deployed at ${address}, but the policy promised ${expected}.`);
    return {
      chain: chain.name, nonce, address, code_hash: codeHash, near_tx: nearTx, evm_tx: hash, gas_used: rc.gasUsed.toString(),
      links: { near: this.policy.tx(nearTx), evm: txLink(chain, hash), ...(address ? { contract: addressLink(chain, address) } : {}) },
      next: log ? `Signed and landed. To write it into the journal as a fact, call keyfree_confirm with nonce ${nonce} once the block is Safe (~20 min on Base Sepolia).` : "Signed and landed (plain creation, no factory log: it cannot be confirmed by Read MPC).",
    };
  }

  // Ask Read MPC to confirm a factory deploy from its Deployed log. Returns at once when the block is not Safe yet.
  async confirm(chainName: string | number, nonce: number) {
    const chain = findChain(this.cfg, chainName);
    const e = await this.policy.view<Entry | null>("get_entry", { chain_id: chain.chain_id, nonce });
    if (!e) throw new Error(`No journal line for ${chain.name} nonce ${nonce}.`);
    if (e.status === "confirmed") return { status: "confirmed", already: true, nonce };
    if (e.status !== "signed") throw new Error(`Line ${nonce} is "${e.status}", not waiting for confirmation.`);
    const c = this.evm(chain);
    const rc = await c.getTransactionReceipt({ hash: e.tx_hash as Hex }).catch(() => null);
    if (!rc) return { status: "not_landed", nonce, next: `Transaction ${e.tx_hash} is not on ${chain.name} yet (or a re-signed variant landed instead).` };
    const emitter = (e.kind === "proxy_upgrade" ? e.proxy : e.factory)?.toLowerCase();
    const log = rc.logs.find((l) => l.address.toLowerCase() === emitter);
    if (!log) throw new Error(e.kind === "proxy_upgrade" ? "No Upgraded log from the proxy in that transaction (it reverted?)." : "No Deployed log from our factory in that transaction: only factory deploys can be confirmed.");
    const safe = await c.getBlock({ blockTag: "safe" });
    if (safe.number < rc.blockNumber) {
      return { status: "waiting_for_safe", nonce, blocks_to_go: Number(rc.blockNumber - safe.number), next: "Call keyfree_confirm again later; Safe on Base Sepolia takes ~20 min." };
    }
    const res = await this.policy.call<boolean>(await this.agent(), "confirm", {
      chain_id: chain.chain_id, nonce, finality: "Safe",
      log: { log_index: log.logIndex, transaction_index: rc.transactionIndex, block_hash: rc.blockHash, block_number: Number(rc.blockNumber) },
    }, 200);
    return { status: res.value ? "confirmed" : "not_confirmed", nonce, link: this.policy.tx(res.txHash), next: res.value ? "The journal line is a confirmed fact now." : "Read MPC did not confirm (timeout or mismatch). Try again later." };
  }

  async journal(chainName: string | number, limit = 10) {
    const chain = findChain(this.cfg, chainName);
    const next = await this.policy.view<number | null>("get_next_nonce", { chain_id: chain.chain_id });
    if (next === null) throw new Error(`${chain.name} is not allowed by the policy.`);
    const lines = [];
    for (let n = next - 1; n >= 0 && lines.length < limit; n--) {
      const e = await this.policy.view<Entry | null>("get_entry", { chain_id: chain.chain_id, nonce: n });
      if (e) lines.push({ nonce: n, ...e, link: txLink(chain, e.tx_hash) });
    }
    return { chain: chain.name, next_nonce: next, lines };
  }
}

// What came back signed must be exactly what was checked (chain, nonce, target, data, no value), signed by
// the policy's own address. Anything else is not broadcast.
export async function checkSigned(raw: Hex, want: TransactionSerializableEIP1559, address: Hex): Promise<void> {
  const got = parseSigned(raw);
  const same = got.chainId === want.chainId && got.nonce === want.nonce && (got.to ?? undefined)?.toLowerCase() === want.to?.toLowerCase()
    && got.data === want.data && (got.value ?? 0n) === 0n && got.type === "eip1559";
  if (!same) throw new Error("The signed transaction is not the one that was checked. Not broadcasting.");
  const from = (await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })).toLowerCase();
  if (from !== address.toLowerCase()) throw new Error(`The signed transaction is signed by ${from}, not by the policy's address. Not broadcasting.`);
}

// A node can answer anything: the fields the flow relies on are looked at before they are used.
function wellFormed(pv: Preview): Preview {
  if (typeof pv?.unsigned !== "string" || !Number.isInteger(pv.nonce)) throw new Error("The NEAR node's answer to the preview is not a preview. Nothing was signed.");
  return pv;
}

function parseSigned(raw: Hex) {
  try {
    return parseTransaction(raw);
  } catch {
    throw new Error("The signed transaction does not parse. Not broadcasting.");
  }
}

// A retry's transaction comes from the policy alone, so it is checked against the journal line it must repeat.
function sameAsLine(t: ReturnType<typeof parseTransaction>, e: Entry) {
  const to = t.to?.toLowerCase() ?? null;
  let same = false;
  try {
    if (e.kind === "proxy_upgrade") {
      const { args } = decodeFunctionData({ abi: PROXY_ABI, data: t.data as Hex });
      same = to === e.proxy?.toLowerCase() && (args[0] as string).toLowerCase() === e.implementation?.toLowerCase();
    } else if (e.factory && e.factory !== ZERO_ADDRESS) {
      const { args } = decodeFunctionData({ abi: FACTORY_ABI, data: t.data as Hex });
      const [salt, init] = args as readonly [Hex, Hex];
      same = to === e.factory.toLowerCase() && salt === e.salt && keccak256(init).slice(2) === e.code_hash;
    } else {
      same = to === null && keccak256(t.data as Hex).slice(2) === e.code_hash;
    }
  } catch { /* other calldata: not the same */ }
  if (!same) throw new Error("The signed transaction is not the journal's line. Not broadcasting.");
}

function asPreviewError(e: unknown): Error {
  const m = String((e as Error)?.message ?? e);
  // A call reports "Smart contract panicked: ...", a view "GuestPanic { panic_msg: \"...\" }".
  const flat = m.replace(/\s+/g, " ");
  const panic = /panic_msg: \\?"(.*?)\\?"/.exec(flat) ?? /panicked: (.*?)(?:$|"|\\n)/.exec(flat);
  return panic ? new PolicyRefusal(panic[1].trim()) : e instanceof Error ? e : new Error(m);
}

// An upper bound of the intrinsic gas the policy requires (EIP-2028 calldata, EIP-3860 init code words, the
// EIP-7623 floor, and a creation's 32 000): enough for any preview, far below the per-transaction cap.
function probeGas(data: Hex): number {
  const n = (data.length - 2) / 2;
  return 21_000 + 32_000 + 40 * n + 2 * Math.ceil(n / 32) + 1_000;
}

// "secp256k1:<base58 of the 64-byte uncompressed point>" -> the EVM address: keccak256(point)[12..].
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function ethAddressOfKey(key: string): string | null {
  const body = key.startsWith("secp256k1:") ? key.slice(10) : null;
  if (!body) return null;
  let n = 0n;
  for (const ch of body) {
    const d = B58.indexOf(ch);
    if (d < 0) return null;
    n = n * 58n + BigInt(d);
  }
  const hex = n.toString(16).padStart(128, "0");
  if (hex.length !== 128) return null;
  return `0x${keccak256(`0x${hex}` as Hex).slice(-40)}`;
}
