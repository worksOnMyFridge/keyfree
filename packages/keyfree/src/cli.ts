#!/usr/bin/env node
// keyfree CLI. Agent commands use the agent's function-call key (same as the MCP server).
// Council commands (rules, narrowing, pause, roles) are for humans and sign with a council key:
// --as <account> (default: "owner" from keyfree.json), key from ~/.near-credentials or KEYFREE_COUNCIL_KEY.
import { councilKey, findChain, loadConfig, type Config } from "./config.js";
import { loadCode } from "./code.js";
import { Keyfree } from "./core.js";
import { PolicyRefusal, clean } from "./near.js";

const HELP = `keyfree - deploy EVM contracts with no private key (rules in a NEAR contract, NEAR MPC signs)

agent (agent key):
  status                                  what the policy allows now
  hash  --artifact <file> [--args <json>] code hash the allow list must hold (or --init <hex>)
  preview --chain <c> --artifact <file>   build and check, sign nothing
  deploy  --chain <c> --artifact <file> [--args <json>] [--salt <hex>]
  upgrade-preview --chain <c> --proxy <addr> --implementation <addr>
  upgrade --chain <c> --proxy <addr> --implementation <addr>   one allowed upgradeTo on a proxy
  retry   --chain <c>                     re-sign a stuck deploy or upgrade with new fees
  confirm --chain <c> --nonce <n>         journal line -> confirmed by Read MPC (needs a Safe block)
  journal --chain <c> [--limit <n>]

council (human key, --as <account>):
  pending                                 widenings waiting their delay (no key; exit code 3 if any): run it on
                                          a schedule and alert the council, who can cancel during the delay
  rules                                   allow list, caps, open proposals
  rules allow-code <hash>                 widening: waits the rules delay, any council member may cancel
  rules allow-upgrade <chain> <proxy> <implementation>   one upgradeTo, used up by the request
  rules allow-chain <chain> <nonce> <floor_wei> | rules enable-chain <chain> | rules set-factory <chain> <address>
  rules set-limits <gas> <fee_wei>
  rules set-budget <chain> <wei_per_day> <tx_per_day>   a chain's daily budget (raising waits the delay)
  rules apply <id> | rules cancel <id>
  remove-code <hash> | remove-upgrade <chain> <proxy> <implementation> | disable-chain <chain> | remove-factory <chain>
  lower-limits <gas> <fee_wei> | lower-budget <chain> <wei_per_day> <tx_per_day>   brakes, at once
  pause | unpause | roles | cancel-role <proposer> | cancel-upgrade

every command: --config <file> (default ./keyfree.json)
exit codes: 0 done, 1 error, 2 refused by the policy, 3 pending has something waiting its delay
`;

interface Pending { kind: string; ready_in_sec: number | null; [k: string]: unknown }

// The flags each command takes; anything else is refused, so a typo (--arg for --args) never runs silently.
const COUNCIL = ["as", "config"];
const FLAGS: Record<string, string[]> = {
  hash: ["artifact", "args", "init"],
  status: ["config"],
  preview: ["chain", "artifact", "args", "init", "salt", "config"],
  deploy: ["chain", "artifact", "args", "init", "salt", "config"],
  "upgrade-preview": ["chain", "proxy", "implementation", "config"],
  upgrade: ["chain", "proxy", "implementation", "config"],
  retry: ["chain", "config"],
  confirm: ["chain", "nonce", "config"],
  journal: ["chain", "limit", "config"],
  roles: ["config"],
  pending: ["config"],
};

function flags(cmd: string, argv: string[]) {
  const pos: string[] = [];
  const f: Record<string, string> = {};
  const known = FLAGS[cmd] ?? COUNCIL;
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) { pos.push(argv[i]); continue; }
    const name = argv[i].slice(2);
    if (!known.includes(name)) throw new Error(`"${cmd}" has no flag --${name}. It takes: ${known.map((k) => `--${k}`).join(" ")}.`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value.`);
    f[name] = v;
  }
  return { pos, f };
}

// Arguments are checked here, before anything is signed: a council call with a missing or malformed value
// would otherwise reach the chain, fail inside the contract and still cost gas.
function need(name: string, v: string | undefined): string {
  if (v === undefined || v === "") throw new Error(`Missing <${name}>. See keyfree help.`);
  return v;
}
function int(name: string, v: string | undefined, max: bigint): bigint {
  const s = need(name, v);
  if (!/^\d+$/.test(s) || BigInt(s) > max) throw new Error(`<${name}> must be a whole number from 0 to ${max}, got "${s}".`);
  return BigInt(s);
}
const u32 = (n: string, v?: string) => int(n, v, 0xffffffffn);
const u64 = (n: string, v?: string) => int(n, v, 0xffffffffffffffffn);
const u128 = (n: string, v?: string) => int(n, v, (1n << 128n) - 1n);
function hex(name: string, v: string | undefined, bytes: number, prefix: boolean): string {
  const s = need(name, v);
  if (!new RegExp(`^${prefix ? "0x" : ""}[0-9a-fA-F]{${bytes * 2}}$`).test(s)) {
    throw new Error(`<${name}> must be ${prefix ? "0x and " : ""}${bytes * 2} hex characters, got "${s}".`);
  }
  return s;
}
const addr = (n: string, v?: string) => hex(n, v, 20, true);
const codeHash = (n: string, v?: string) => hex(n, v, 32, false).toLowerCase();

// JSON with exact integers: u64 and u128 values go to the contract as plain numbers without passing through
// a JavaScript number, which would round anything above 2^53 (wei amounts get there easily).
function jsonBytes(args: Record<string, unknown>): Uint8Array {
  const text = JSON.stringify(args, (_k, x) => (typeof x === "bigint" ? `__int__${x}` : x)).replace(/"__int__(\d+)"/g, "$1");
  return new TextEncoder().encode(text);
}

function codeOf(f: Record<string, string>) {
  let constructor_args: unknown;
  if (f.args !== undefined) {
    try { constructor_args = JSON.parse(f.args); } catch { constructor_args = undefined; }
    if (!Array.isArray(constructor_args)) throw new Error(`--args must be a JSON array of constructor arguments, like '[1]'; got ${f.args}`);
  }
  if (f.salt !== undefined) hex("salt", f.salt, 32, true);
  return { artifact: f.artifact, init_code_hex: f.init, constructor_args: constructor_args as unknown[] | undefined };
}

async function council(cfg: Config, kf: Keyfree, as: string | undefined, method: string, args: Record<string, unknown>) {
  const who = as ?? cfg.owner;
  if (!who) throw new Error('Council commands need --as <account> or "owner" in keyfree.json.');
  const r = await kf.policy.call<unknown>(kf.policy.account(who, councilKey(cfg, who)), method, jsonBytes(args), 30);
  for (const l of r.logs) console.log(`  ${l}`);
  return { result: r.value, link: kf.policy.tx(r.txHash) };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") return console.log(HELP);
  const { pos, f } = flags(cmd, rest);
  if (cmd === "hash") return out(loadCode(codeOf(f)).hash);
  const cfg = loadConfig(f.config);
  const kf = new Keyfree(cfg);
  const chainId = (c: string | undefined) => findChain(cfg, need("chain", c)).chain_id;
  const chain = () => need("chain", f.chain);
  switch (cmd) {
    case "status": return out(await kf.status());
    case "preview": return out(await kf.preview({ chain: chain(), salt: f.salt, ...codeOf(f) }));
    case "deploy": return out(await kf.deploy({ chain: chain(), salt: f.salt, ...codeOf(f) }));
    case "upgrade-preview": return out(await kf.previewUpgrade({ chain: chain(), proxy: f.proxy, implementation: f.implementation }));
    case "upgrade": return out(await kf.upgradeProxy({ chain: chain(), proxy: f.proxy, implementation: f.implementation }));
    case "retry": return out(await kf.retry(chain()));
    case "confirm": return out(await kf.confirm(chain(), Number(u64("nonce", f.nonce))));
    case "journal": return out(await kf.journal(chain(), f.limit === undefined ? 10 : Number(int("limit", f.limit, 1000n))));
    case "roles": return out(await kf.policy.view("get_roles"));
    case "pending": {
      // Everything that widens power waits a public delay; the delay only helps if someone looks.
      const [rules, roles, st] = await Promise.all([
        kf.policy.view<{ proposals?: { id: number; change: unknown; ready_at: number }[] }>("get_rules"),
        kf.policy.view<{ role_changes?: { role: string; account: string; proposer: string; ready_at: number | null }[] }>("get_roles"),
        kf.policy.view<{ proposed: [string, number] | null }>("get_status"),
      ]);
      const left = (t: number | null) => (t === null ? null : Math.max(0, Math.round(t - Date.now() / 1000)));
      const pending: Pending[] = [
        ...(rules.proposals ?? []).map((p) => ({ kind: "rule", id: p.id, change: p.change, ready_in_sec: left(p.ready_at), cancel: `keyfree rules cancel ${p.id}` })),
        ...(roles.role_changes ?? []).map((r) => ({ kind: "role", role: r.role, account: r.account, proposer: r.proposer, ready_in_sec: left(r.ready_at), cancel: `keyfree cancel-role ${r.proposer}` })),
        ...(st.proposed ? [{ kind: "policy upgrade", code_sha256: st.proposed[0], ready_in_sec: left(st.proposed[1]), cancel: "keyfree cancel-upgrade" }] : []),
      ];
      out({ policy: cfg.policy, pending });
      if (pending.length) process.exitCode = 3;
      return;
    }
    case "cancel-role": return out(await council(cfg, kf, f.as, "cancel_role", { proposer: need("proposer", pos[0]) }));
    case "cancel-upgrade": return out(await council(cfg, kf, f.as, "cancel_upgrade", {}));
    case "rules": {
      const [sub, a, b, c] = pos;
      if (!sub) return out(await kf.policy.view("get_rules"));
      const change =
        sub === "allow-code" ? { AllowCode: { code_hash: codeHash("hash", a) } } :
        sub === "allow-chain" ? { AllowChain: { chain_id: chainId(a), next_nonce: u64("nonce", b), min_fee_per_gas: u128("floor_wei", c) } } :
        sub === "enable-chain" ? { EnableChain: { chain_id: chainId(a) } } :
        sub === "set-factory" ? { SetFactory: { chain_id: chainId(a), factory_hex: addr("address", b) } } :
        sub === "set-limits" ? { SetLimits: { max_gas_limit: u128("gas", a), max_fee_cap: u128("fee_wei", b) } } :
        sub === "allow-upgrade" ? { AllowProxyUpgrade: { chain_id: chainId(a), proxy_hex: addr("proxy", b), implementation_hex: addr("implementation", c) } } :
        sub === "set-budget" ? { SetBudget: { chain_id: chainId(a), max_wei_per_day: u128("wei_per_day", b), max_tx_per_day: u32("tx_per_day", c) } } : null;
      if (change) return out(await council(cfg, kf, f.as, "propose_rule", { change }));
      if (sub === "apply" || sub === "cancel") return out(await council(cfg, kf, f.as, `${sub}_rule`, { id: u32("id", a) }));
      throw new Error(`Unknown rules command "${sub}".\n\n${HELP}`);
    }
    case "remove-code": return out(await council(cfg, kf, f.as, "remove_code", { code_hash: codeHash("hash", pos[0]) }));
    case "remove-upgrade": return out(await council(cfg, kf, f.as, "remove_proxy_upgrade", { chain_id: chainId(pos[0]), proxy_hex: addr("proxy", pos[1]), implementation_hex: addr("implementation", pos[2]) }));
    case "disable-chain": return out(await council(cfg, kf, f.as, "disable_chain", { chain_id: chainId(pos[0]) }));
    case "remove-factory": return out(await council(cfg, kf, f.as, "remove_factory", { chain_id: chainId(pos[0]) }));
    case "lower-limits": return out(await council(cfg, kf, f.as, "lower_limits", { max_gas_limit: u128("gas", pos[0]), max_fee_cap: u128("fee_wei", pos[1]) }));
    case "lower-budget": return out(await council(cfg, kf, f.as, "lower_budget", { chain_id: chainId(pos[0]), max_wei_per_day: u128("wei_per_day", pos[1]), max_tx_per_day: u32("tx_per_day", pos[2]) }));
    case "pause": return out(await council(cfg, kf, f.as, "pause", {}));
    case "unpause": return out(await council(cfg, kf, f.as, "unpause", {}));
    default: throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

function out(v: unknown) {
  console.log(typeof v === "string" ? v : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
}

// exitCode, not process.exit(): exiting while fetch sockets close trips a libuv assertion on Windows.
main().catch((e) => {
  console.error(e instanceof PolicyRefusal ? `REFUSED  ${e.reason}` : `ERROR  ${clean(String((e as Error).message ?? e))}`);
  process.exitCode = e instanceof PolicyRefusal ? 2 : 1;
});
