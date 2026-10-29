#!/usr/bin/env node
// keyfree CLI. Agent commands use the agent's function-call key (same as the MCP server).
// Council commands (rules, narrowing, pause, roles) are for humans and sign with a council key:
// --as <account> (default: "owner" from keyfree.json), key from ~/.near-credentials or KEYFREE_COUNCIL_KEY.
import { councilKey, findChain, loadConfig, type Config } from "./config.js";
import { loadCode } from "./code.js";
import { Keyfree } from "./core.js";
import { PolicyRefusal } from "./near.js";

const HELP = `keyfree - deploy EVM contracts with no private key (rules in a NEAR contract, NEAR MPC signs)

agent (agent key):
  status                                  what the policy allows now
  hash  --artifact <file> [--args <json>] code hash the allow list must hold (or --init <hex>)
  preview --chain <c> --artifact <file>   build and check, sign nothing
  deploy  --chain <c> --artifact <file> [--args <json>] [--salt <hex>]
  retry   --chain <c>                     re-sign a stuck deploy with new fees
  confirm --chain <c> --nonce <n>         journal line -> confirmed by Read MPC (needs a Safe block)
  journal --chain <c> [--limit <n>]

council (human key, --as <account>):
  rules                                   allow list, caps, open proposals
  rules allow-code <hash>                 widening: waits the rules delay, any council member may cancel
  rules allow-chain <chain> <nonce> <floor_wei> | rules set-factory <chain> <address> | rules set-limits <gas> <fee_wei>
  rules apply <id> | rules cancel <id>
  remove-code <hash> | disable-chain <chain> | remove-factory <chain> | lower-limits <gas> <fee_wei>   brakes, at once
  pause | unpause | roles
`;

function flags(argv: string[]) {
  const pos: string[] = [];
  const f: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) f[argv[i].slice(2)] = argv[i + 1] ?? "", i++;
    else pos.push(argv[i]);
  }
  return { pos, f };
}

function codeOf(f: Record<string, string>) {
  return { artifact: f.artifact, init_code_hex: f.init, constructor_args: f.args ? (JSON.parse(f.args) as unknown[]) : undefined };
}

async function council(cfg: Config, kf: Keyfree, as: string | undefined, method: string, args: Record<string, unknown>) {
  const who = as ?? cfg.owner;
  if (!who) throw new Error('Council commands need --as <account> or "owner" in keyfree.json.');
  const r = await kf.policy.call<unknown>(kf.policy.account(who, councilKey(cfg, who)), method, args, 30);
  for (const l of r.logs) console.log(`  ${l}`);
  return { result: r.value, link: kf.policy.tx(r.txHash) };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") return console.log(HELP);
  const { pos, f } = flags(rest);
  if (cmd === "hash") return out(loadCode(codeOf(f)).hash);
  const cfg = loadConfig(f.config);
  const kf = new Keyfree(cfg);
  const chainId = (c: string) => findChain(cfg, c).chain_id;
  switch (cmd) {
    case "status": return out(await kf.status());
    case "preview": return out(await kf.preview({ chain: f.chain, salt: f.salt, ...codeOf(f) }));
    case "deploy": return out(await kf.deploy({ chain: f.chain, salt: f.salt, ...codeOf(f) }));
    case "retry": return out(await kf.retry(f.chain));
    case "confirm": return out(await kf.confirm(f.chain, Number(f.nonce)));
    case "journal": return out(await kf.journal(f.chain, Number(f.limit ?? 10)));
    case "roles": return out(await kf.policy.view("get_roles"));
    case "rules": {
      const [sub, a, b, c] = pos;
      if (!sub) return out(await kf.policy.view("get_rules"));
      const change =
        sub === "allow-code" ? { AllowCode: { code_hash: a } } :
        sub === "allow-chain" ? { AllowChain: { chain_id: chainId(a), next_nonce: Number(b), min_fee_per_gas: Number(c) } } :
        sub === "enable-chain" ? { EnableChain: { chain_id: chainId(a) } } :
        sub === "set-factory" ? { SetFactory: { chain_id: chainId(a), factory_hex: b } } :
        sub === "set-limits" ? { SetLimits: { max_gas_limit: Number(a), max_fee_cap: Number(b) } } : null;
      if (change) return out(await council(cfg, kf, f.as, "propose_rule", { change }));
      if (sub === "apply" || sub === "cancel") return out(await council(cfg, kf, f.as, `${sub}_rule`, { id: Number(a) }));
      throw new Error(`Unknown rules command "${sub}".\n\n${HELP}`);
    }
    case "remove-code": return out(await council(cfg, kf, f.as, "remove_code", { code_hash: pos[0] }));
    case "disable-chain": return out(await council(cfg, kf, f.as, "disable_chain", { chain_id: chainId(pos[0]) }));
    case "remove-factory": return out(await council(cfg, kf, f.as, "remove_factory", { chain_id: chainId(pos[0]) }));
    case "lower-limits": return out(await council(cfg, kf, f.as, "lower_limits", { max_gas_limit: Number(pos[0]), max_fee_cap: Number(pos[1]) }));
    case "pause": return out(await council(cfg, kf, f.as, "pause", {}));
    case "unpause": return out(await council(cfg, kf, f.as, "unpause", {}));
    default: throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

function out(v: unknown) {
  console.log(typeof v === "string" ? v : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
}

main().catch((e) => {
  console.error(e instanceof PolicyRefusal ? `REFUSED  ${e.reason}` : `ERROR  ${(e as Error).message ?? e}`);
  process.exit(1);
});
