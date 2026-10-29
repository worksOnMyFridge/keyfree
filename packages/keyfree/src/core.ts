// The agent's flows: status, preview, deploy, retry, confirm, journal. Everything the policy builds is checked
// against viem before it is signed, and everything it signs is checked again before it is broadcast.
import {
  decodeEventLog, encodeFunctionData, getContractAddress, parseTransaction, recoverTransactionAddress, serializeTransaction,
  type Hex, type TransactionSerializableEIP1559,
} from "viem";
import { agentKey, findChain, type ChainConfig, type Config } from "./config.js";
import { loadCode, type CodeInput } from "./code.js";
import { evm, FACTORY_ABI, randomSalt, txLink, addressLink } from "./evm.js";
import { Policy, PolicyRefusal } from "./near.js";

interface Preview { unsigned: Hex; hash: string; nonce: number; expected_address: string | null; min_gas: number }
interface Entry { status: string; tx_hash: string; address: string; factory: string; code_hash: string; salt: string }
interface Rules { allowed_code: string[]; max_gas_limit: string; max_fee_cap: string; rules_delay_sec: number; proposals: unknown[] }

export interface DeployInput extends CodeInput {
  chain: string | number;
  salt?: string;
  via_factory?: boolean;
}

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

const AGENT_GAS = 250; // Tgas for request_deploy / retry: 100 for the MPC, 50 for the callback, the rest for the build

export class Keyfree {
  readonly policy: Policy;
  constructor(readonly cfg: Config) {
    this.policy = new Policy(cfg);
  }

  private agent() {
    return this.policy.account(this.cfg.agent, agentKey(this.cfg));
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
      this.policy.view<Rules>("get_rules"),
      this.policy.view<string | null>("get_eth_address"),
    ]);
    const keys = (await this.policy.provider.viewAccessKeyList({ accountId: this.cfg.policy })).keys.length;
    const chains = await Promise.all(this.cfg.chains.map(async (c) => {
      const next = await this.policy.view<number | null>("get_next_nonce", { chain_id: c.chain_id });
      const balance = address ? await evm(c).getBalance({ address: address as Hex }) : 0n;
      return { name: c.name, chain_id: c.chain_id, allowed: next !== null, next_nonce: next, balance_wei: balance.toString() };
    }));
    return {
      policy: this.cfg.policy, policy_keys: keys, address, build: st.build, version: st.version, paused: st.paused,
      agent: roles.agent, owner: roles.owner, guardian: roles.guardian, reserve: roles.reserve, retiring: roles.retiring,
      upgrade_delay_sec: st.upgrade_delay_sec, rules_delay_sec: rules.rules_delay_sec, pending_upgrade: st.proposed,
      allowed_code: rules.allowed_code, max_gas_limit: rules.max_gas_limit, max_fee_cap: rules.max_fee_cap, chains,
    };
  }

  // Fees: viem's estimate x fee_multiplier, never under the chain's floor (the policy names the floor when it refuses).
  private async fees(chain: ChainConfig, floor = 0n) {
    const f = await evm(chain).estimateFeesPerGas();
    const mult = BigInt(Math.round((this.cfg.fee_multiplier ?? 1.2) * 100));
    let max = (f.maxFeePerGas * mult) / 100n;
    if (max < floor) max = floor;
    const prio = f.maxPriorityFeePerGas < max ? f.maxPriorityFeePerGas : max;
    return { max_fee_per_gas: max, max_priority_fee_per_gas: prio };
  }

  private async previewWithFloor(args: Record<string, unknown>, chain: ChainConfig): Promise<{ pv: Preview; args: Record<string, unknown> }> {
    try {
      return { pv: await this.policy.view<Preview>("preview", args), args };
    } catch (e) {
      const floor = /fee below the floor (\d+)/.exec(String((e as Error).message));
      if (!floor) throw asPreviewError(e);
      const f = await this.fees(chain, BigInt(floor[1]));
      const again = { ...args, max_fee_per_gas: Number(f.max_fee_per_gas), max_priority_fee_per_gas: Number(f.max_priority_fee_per_gas) };
      return { pv: await this.policy.view<Preview>("preview", again).catch((e2) => { throw asPreviewError(e2); }), args: again };
    }
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
    const [address, rules] = await Promise.all([this.address(), this.policy.view<Rules>("get_rules")]);
    if (!rules.allowed_code.includes(code.hash)) {
      throw new PolicyRefusal(`code not on the allow list (code hash ${code.hash}). Only a human owner can allow it: keyfree rules allow-code ${code.hash} (it then waits ${rules.rules_delay_sec} s and can be cancelled).`);
    }
    const viaFactory = input.via_factory ?? true;
    const salt = viaFactory ? ((input.salt as Hex | undefined) ?? randomSalt()) : null;
    const f = await this.fees(chain);
    const cap = Number(rules.max_gas_limit);
    const base = { chain_id: chain.chain_id, init_code_hex: code.init, max_fee_per_gas: Number(f.max_fee_per_gas), max_priority_fee_per_gas: Number(f.max_priority_fee_per_gas), salt_hex: salt, via_factory: viaFactory || null };
    // 1) at the cap, only to learn the nonce, the target (our factory) and the intrinsic minimum
    const first = await this.previewWithFloor({ ...base, gas_limit: cap }, chain);
    const draft = parseTransaction(first.pv.unsigned);
    const to = draft.to ?? undefined;
    const data = viaFactory ? encodeFunctionData({ abi: FACTORY_ABI, functionName: "deploy", args: [salt as Hex, code.init] }) : code.init;
    if (viaFactory) await this.checkFactory(chain, to, address);
    // 2) real gas: ask the chain to simulate it from our address, +25 %
    let est: bigint;
    try {
      est = await evm(chain).estimateGas({ account: address, to, data, value: 0n });
    } catch (e) {
      throw new Error(`The chain says this deploy would fail (simulation): ${String((e as Error).message).split("\n")[0]}. Nothing was signed.`);
    }
    const gas = Math.min(cap, Math.max(first.pv.min_gas, Number((est * 125n) / 100n)));
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
    const balance = await evm(chain).getBalance({ address });
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
    const served = await evm(chain).readContract({ address: to, abi: FACTORY_ABI, functionName: "keyfree" }).catch(() => null);
    if (!served || served.toLowerCase() !== address.toLowerCase()) throw new Error(`The factory ${to} does not serve ${address}. Not signing.`);
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    const p = await this.plan(input);
    const res = await this.policy.call<Hex>(this.agent(), "request_deploy", p.args, AGENT_GAS);
    if (!res.value) {
      throw new Error(`The MPC did not sign in time (NEAR tx ${this.policy.tx(res.txHash)}). Nonce ${p.pv.nonce} stays bound to this exact deploy; call keyfree_retry (later, with new fees). Nothing was broadcast.`);
    }
    return this.broadcast(p.chain, res.value, res.txHash, p.pv.nonce, p.code.hash, p.pv.expected_address, this.fields(p.chain, p.pv.nonce, p.to, p.data, p.args));
  }

  // Re-sign the stuck request (same nonce and content, new fees) and broadcast it.
  async retry(chainName: string | number) {
    const chain = findChain(this.cfg, chainName);
    const open = await this.policy.view<{ pending: number | null; stuck: number | null }>("get_open");
    if (open.stuck === null) throw new Error(open.pending !== null ? `Request ${open.pending} is still being signed; wait for it.` : "Nothing is stuck.");
    const f = await this.fees(chain);
    const res = await this.policy.call<Hex>(this.agent(), "retry", { max_fee_per_gas: Number(f.max_fee_per_gas), max_priority_fee_per_gas: Number(f.max_priority_fee_per_gas) }, AGENT_GAS);
    if (!res.value) throw new Error(`Still not signed (NEAR tx ${this.policy.tx(res.txHash)}). Try again later.`);
    const t = parseTransaction(res.value);
    const entry = await this.policy.view<Entry | null>("get_entry", { chain_id: chain.chain_id, nonce: open.stuck });
    return this.broadcast(chain, res.value, res.txHash, open.stuck, entry?.code_hash ?? "", entry && entry.address !== `0x${"0".repeat(40)}` ? entry.address : null,
      { type: "eip1559", chainId: chain.chain_id, nonce: open.stuck, to: t.to ?? undefined, data: t.data, value: 0n, gas: t.gas!, maxFeePerGas: t.maxFeePerGas!, maxPriorityFeePerGas: t.maxPriorityFeePerGas! });
  }

  private async broadcast(chain: ChainConfig, raw: Hex, nearTx: string, nonce: number, codeHash: string, expected: string | null, want: TransactionSerializableEIP1559): Promise<DeployResult> {
    await checkSigned(raw, want, await this.address());
    const c = evm(chain);
    const hash = await c.sendRawTransaction({ serializedTransaction: raw });
    const rc = await c.waitForTransactionReceipt({ hash, timeout: 180_000 });
    let address = rc.contractAddress?.toLowerCase() ?? null;
    const log = rc.logs.find((l) => l.address.toLowerCase() === want.to?.toLowerCase());
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
    const c = evm(chain);
    const rc = await c.getTransactionReceipt({ hash: e.tx_hash as Hex }).catch(() => null);
    if (!rc) return { status: "not_landed", nonce, next: `Transaction ${e.tx_hash} is not on ${chain.name} yet (or a re-signed variant landed instead).` };
    const log = rc.logs.find((l) => l.address.toLowerCase() === e.factory.toLowerCase());
    if (!log) throw new Error("No Deployed log from our factory in that transaction: only factory deploys can be confirmed.");
    const safe = await c.getBlock({ blockTag: "safe" });
    if (safe.number < rc.blockNumber) {
      return { status: "waiting_for_safe", nonce, blocks_to_go: Number(rc.blockNumber - safe.number), next: "Call keyfree_confirm again later; Safe on Base Sepolia takes ~20 min." };
    }
    const res = await this.policy.call<boolean>(this.agent(), "confirm", {
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
  let got;
  try {
    got = parseTransaction(raw);
  } catch {
    throw new Error("The signed transaction does not parse. Not broadcasting.");
  }
  const same = got.chainId === want.chainId && got.nonce === want.nonce && (got.to ?? undefined)?.toLowerCase() === want.to?.toLowerCase()
    && got.data === want.data && (got.value ?? 0n) === 0n && got.type === "eip1559";
  if (!same) throw new Error("The signed transaction is not the one that was checked. Not broadcasting.");
  const from = (await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })).toLowerCase();
  if (from !== address.toLowerCase()) throw new Error(`The signed transaction is signed by ${from}, not by the policy's address. Not broadcasting.`);
}

function asPreviewError(e: unknown): Error {
  const m = String((e as Error)?.message ?? e);
  const panic = /panicked: (.*?)(?:$|"|\\n)/.exec(m.replace(/\s+/g, " "));
  return panic ? new PolicyRefusal(panic[1].trim()) : e instanceof Error ? e : new Error(m);
}
