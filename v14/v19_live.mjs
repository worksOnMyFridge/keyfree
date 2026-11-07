// v19 on the live demo policy (fifth review, Z3, Z4, Z6), read and acted on for real. Appends to evidence/v19_live.log.
//   node v14/v19_live.mjs
// Z3: the policy names its MPC and path; the address the network's MPC derives for (policy, path) is the policy's.
// Z4: a factory deploy whose gas cannot cover CREATE2 is refused in preview, with the floor named; enough gas passes.
// Z6: the owner proposes a rule, a council member pauses, after the delay the rule cannot be applied while paused;
//     it is cancelled and the policy unpaused by 2 of 3. Keys are read from files and never printed.
import fs from "node:fs";
import { provider, explorer, Account, loadAccount } from "../tools/near.mjs";
import { loadCode } from "../packages/keyfree/dist/code.js";
import { ethAddressOfKey } from "../packages/keyfree/dist/core.js";

const top = (f) => new URL(`../${f}`, import.meta.url);
const CFG = JSON.parse(fs.readFileSync(top("v14/config.json")));
const P = CFG.policy;
const LOG = top("evidence/v19_live.log");
let fails = 0;
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };
const check = (ok, s) => { if (!ok) fails++; say(`${ok ? "OK  " : "FAIL"} ${s}`); };
const local = (id, file) => new Account(id, provider, JSON.parse(fs.readFileSync(top(file), "utf8")).private_key);
const view = async (contractId, method, args = {}) => {
  const r = await provider.callFunctionRaw({ contractId, method, args, blockQuery: { finality: "optimistic" } });
  return JSON.parse(Buffer.from(r.result).toString());
};
const call = async (acc, methodName, args) => {
  const out = await acc.callFunctionRaw({ contractId: P, methodName, args: new TextEncoder().encode(JSON.stringify(args)), gas: 30_000_000_000_000n, deposit: 0n })
    .catch((e) => ({ error: String(e?.message ?? e) }));
  return out;
};
// The reason a call failed, or "" when it went through.
const failure = (out) => {
  if (out.error) return out.error;
  const f = out.status?.Failure ?? out.receipts_outcome?.map((r) => r.outcome.status.Failure).find(Boolean);
  return f ? JSON.stringify(f) : "";
};
const link = (out) => (out.transaction?.hash ? explorer(out.transaction.hash) : "(the contract refused the call with this message; the client gave back no transaction hash)");
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));

say(`--- ${new Date().toISOString()} v19 checks on ${P}`);
const st = await view(P, "get_status");
check(st.build === "v19", `build ${st.build}, version ${st.version}`);

// Z3
const conf = await view(P, "get_config");
check(conf.mpc === "v1.signer-prod.testnet" && conf.path === "keyfree-1", `get_config: MPC ${conf.mpc}, path ${conf.path}, delays ${conf.rules_delay_sec} s / ${conf.upgrade_delay_sec} s`);
const derived = ethAddressOfKey(await view(conf.mpc, "derived_public_key", { path: conf.path, predecessor: P, domain_id: 0 }));
const addr = await view(P, "get_eth_address");
check(derived === addr, `the address ${conf.mpc} derives for (${P}, ${conf.path}) is the policy's: ${derived}`);

// Z4
const counter = loadCode({ artifact: fileURLPath(top("packages/keyfree/demo/out/Counter.sol/Counter.json")), constructor_args: [1] }).init;
const ask = (gas) => ({ chain_id: 84532, init_code_hex: counter, gas_limit: gas, max_fee_per_gas: 20_000_000, max_priority_fee_per_gas: 1_000_000, salt_hex: `0x${"7".repeat(64)}`, via_factory: true });
const low = await view(P, "preview", ask(50_000)).then(() => "allowed", (e) => String(e?.message ?? e));
const floor = /surely spends: (\d+)/.exec(low)?.[1];
check(!!floor && Number(floor) > 50_000, `factory deploy of Counter(1) at 50 000 gas refused before signing: "gas limit below the intrinsic minimum plus what this call surely spends: ${floor}"`);
const ok = await view(P, "preview", ask(300_000));
check(Number(ok.min_gas) === Number(floor), `at 300 000 gas the preview builds it and reports the same floor, min_gas ${ok.min_gas}`);

// Z6
const owner = loadAccount(CFG.lab);
const roles = await view(P, "get_roles");
const guardian = local(roles.guardian, roles.guardian === CFG.guardian2 ? "v13/guardian2_key.json" : "v13/guardian_key.json");
const reserve = local(roles.reserve, "v13/reserve_key.json");
const hash = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
let out = await call(owner, "propose_rule", { change: { AllowCode: { code_hash: hash } } });
const id = JSON.parse(Buffer.from(out.status?.SuccessValue ?? "", "base64").toString() || "null");
check(Number.isInteger(id), `owner proposes rule ${id}: AllowCode(${hash.slice(0, 12)}...), a code nobody needs ${link(out)}`);
out = await call(guardian, "pause", {});
check(!failure(out), `${roles.guardian} pauses at once ${link(out)}`);
const ready = Number((await view(P, "get_rules")).proposals.find((p) => p.id === id)?.ready_at ?? 0);
const left = Math.max(0, ready - Date.now() / 1000) + 5;
say(`  waiting ${Math.ceil(left)} s for the rules delay`);
await wait(left);
out = await call(owner, "apply_rule", { id });
check(/paused: no rule is applied while paused/.test(failure(out)), `after the delay the owner cannot apply it while paused: "paused: no rule is applied while paused" ${link(out)}`);
check(!(await view(P, "get_rules")).allowed_code.includes(hash), "the code is not on the allow list");
out = await call(guardian, "cancel_rule", { id });
check(!failure(out), `${roles.guardian} cancels rule ${id} ${link(out)}`);
out = await call(owner, "unpause", {});
check(!failure(out), `unpause, first vote: the owner ${link(out)}`);
out = await call(reserve, "unpause", {});
check(!failure(out), `unpause, second vote: ${roles.reserve} ${link(out)}`);
const end = await view(P, "get_status");
const rules = await view(P, "get_rules");
check(end.paused === false && !rules.proposals.some((p) => p.id === id), `running again, no rule waiting: paused ${end.paused}, open proposals ${rules.proposals.length}`);

say(fails ? `${fails} FAILED` : "all v19 checks passed");
fs.appendFileSync(LOG, `${lines.join("\n")}\n\n`);
process.exitCode = fails ? 1 : 0;

function fileURLPath(u) { return decodeURIComponent(new URL(u).pathname.replace(/^\/([A-Za-z]:)/, "$1")); }
