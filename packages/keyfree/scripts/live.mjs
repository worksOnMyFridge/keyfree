// Every CLI command and MCP tool for real, on a policy of your own (setup/policy.mjs makes one), never the demo's:
// the agent's commands (deploy, upgrade, confirm, journal, refusals), the council's (each brake at once, each
// widening through its delay, cancels, votes, roles) and the 9 MCP tools over stdio the way a coding agent uses them.
// It spends a little testnet ETH (about 8 transactions) and leaves the rules as it found them, plus a treasury.
//   npm run build && node scripts/live.mjs          the whole run, about 5 minutes
//   node scripts/live.mjs confirm                   later, once blocks are Safe: Read MPC on every signed line
// Env: KEYFREE_CONFIG, KEYFREE_AGENT_KEY, KEYFREE_GUARDIAN_KEY, KEYFREE_RESERVE_KEY (key files); the owner's key
// from ~/.near-credentials or KEYFREE_COUNCIL_KEY. Prints OK/FAIL per step, exit 1 on any FAIL.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Account, JsonRpcProvider, teraToGas } from "near-api-js";
import { createPublicClient, encodeDeployData, getContractAddress, http, keccak256, parseEther, toHex } from "viem";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CFG = path.resolve(process.env.KEYFREE_CONFIG ?? "keyfree.json");
const cfg = JSON.parse(fs.readFileSync(CFG, "utf8"));
const CHAIN = cfg.chains[0];
const CLI = path.join(root, "dist", "cli.js");
const KEYS = { guardian: process.env.KEYFREE_GUARDIAN_KEY, reserve: process.env.KEYFREE_RESERVE_KEY, agentkey: process.env.KEYFREE_AGENT_KEY };
const art = (dir, n) => path.join(root, "demo", ...dir, "out", `${n}.sol`, `${n}.json`);
const COUNTER = art([], "Counter");
const load = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(3000); // a call returns before views see its block
const evm = createPublicClient({ transport: http(CHAIN.rpc) });
const tag = process.env.KEYFREE_LIVE_TAG ?? String(Date.now());
const saltOf = (n) => keccak256(toHex(`keyfree-live-${n}-${tag}`));
const short = (s) => s.replaceAll(os.homedir(), "~").replace(/\s+/g, " ").slice(0, 260);

let fails = 0, steps = 0;
const say = (s) => console.log(s);
const check = (ok, s) => { steps++; if (!ok) fails++; say(`${ok ? "OK  " : "FAIL"} ${short(s)}`); return ok; };

// One CLI command in its own process, as a person or script runs it: { code, out, json }.
function cli(args, as) {
  const council = as === "guardian" || as === "reserve" ? ["--as", roles[as]] : [];
  const r = spawnSync(process.execPath, [CLI, ...args, ...(args[0] === "hash" ? [] : ["--config", CFG]), ...council], { encoding: "utf8",
    env: { ...process.env, ...(KEYS[as] ? { KEYFREE_COUNCIL_KEY: KEYS[as] } : {}) } });
  const out = `${r.stdout}${r.stderr}`;
  const start = r.stdout.search(/^[{[]/m);
  let json;
  try { json = start >= 0 ? JSON.parse(r.stdout.slice(start)) : undefined; } catch { json = undefined; }
  return { code: r.status, out, json };
}
// A command that must end with this exit code and say this.
function step(what, args, { exit = 0, says, as } = {}) {
  const r = cli(args, as);
  check(r.code === exit && (!says || says.test(r.out)), `${what}: exit ${r.code}${exit !== r.code ? ` (wanted ${exit})` : ""}${r.code ? `, ${r.out.trim().split("\n")[0]}` : ""}${says && !says.test(r.out) ? `, no "${says.source}" in: ${r.out}` : ""}`);
  return r;
}
const refused = (what, args, says, as) => step(what, args, { exit: 2, says, as });
async function write(what, args, as, opts) { const r = step(what, args, { as, ...opts }); await settle(); return r; }

const status = () => cli(["status"]).json;
const chainStatus = () => status().chains.find((c) => c.name === CHAIN.name);

// Widenings wait their delay: apply these rule ids once the delay is over.
async function applyAll(ids) {
  const open = cli(["pending"]).json.pending.filter((p) => p.kind === "rule" && ids.includes(p.id));
  const wait = Math.max(0, ...open.map((p) => p.ready_in_sec ?? 0));
  say(`waiting ${wait + 3} s for the rules delay`);
  await sleep((wait + 3) * 1000);
  for (const id of ids) {
    let r = cli(["rules", "apply", String(id)], "guardian");
    if (r.code === 2 && /delay not over/.test(r.out)) { await sleep(5000); r = cli(["rules", "apply", String(id)], "guardian"); }
    check(r.code === 0, `rule ${id} applied by the guardian: exit ${r.code}${r.code ? `, ${r.out}` : ""}`);
  }
  await settle();
}

const roles = cli(["roles"]).json;
const version = async (proxy) => Number(await evm.readContract({ address: proxy, abi: [{ type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "version" }));

async function confirmAll() {
  const { lines } = cli(["journal", "--chain", CHAIN.name, "--limit", "50"]).json;
  for (const l of lines.filter((x) => x.status === "signed")) {
    const r = cli(["confirm", "--chain", CHAIN.name, "--nonce", String(l.nonce)]);
    say(`  line ${l.nonce} (${l.kind}): exit ${r.code} ${r.json?.status ?? r.out.trim().split("\n")[0]}`);
    if (r.json?.status === "confirmed") check(true, `line ${l.nonce} (${l.kind}) confirmed by Read MPC ${r.json.link}`);
    else if (l.factory === `0x${"0".repeat(40)}`) check(r.code === 1 && /only factory deploys/.test(r.out), `line ${l.nonce}, a plain creation, cannot be confirmed`);
    else check(r.json?.status === "waiting_for_safe", `line ${l.nonce}: ${r.json?.status ?? r.out} (${r.json?.blocks_to_go ?? "?"} blocks to go)`);
  }
}

if (process.argv[2] === "confirm") {
  await confirmAll();
  say(`\n${steps - fails}/${steps} steps ok`);
  process.exit(fails ? 1 : 0);
}

say(`--- ${new Date().toISOString()} live run on ${cfg.policy}, ${CHAIN.name}`);
const st0 = status();
const ETH = st0.address;
check(st0.policy_keys === 0, `status: ${st0.policy} has 0 keys, build ${st0.build}, address ${ETH}`);
// Where setup/policy.mjs keeps the address of this policy's factory, next to the config.
const FACTORY = load(path.join(path.dirname(CFG), "state.json")).factory[CHAIN.name];

// Everything the run will deploy, with its address, known before anything is signed.
const counterInit = (n) => encodeDeployData({ abi: load(COUNTER).abi, bytecode: load(COUNTER).bytecode.object, args: [BigInt(n)] });
const at = (salt, init) => getContractAddress({ opcode: "CREATE2", from: FACTORY, salt, bytecode: init }).toLowerCase();
const OWNER_OF_TREASURY = load(path.join(root, "demo", "vault-kit", "deploy.config.json")).constructor.owner;
const [V1, V2, PX] = ["TreasuryV1", "TreasuryV2", "TreasuryProxy"].map((n) => ({ file: art(["treasury"], n), ...load(art(["treasury"], n)) }));
const LIMIT = parseEther("0.01");
const initV1 = encodeDeployData({ abi: V1.abi, bytecode: V1.bytecode.object, args: [OWNER_OF_TREASURY] });
const initV2 = encodeDeployData({ abi: V2.abi, bytecode: V2.bytecode.object, args: [OWNER_OF_TREASURY, LIMIT] });
const addrV1 = at(saltOf("v1"), initV1), addrV2 = at(saltOf("v2"), initV2);
const initPX = encodeDeployData({ abi: PX.abi, bytecode: PX.bytecode.object, args: [addrV1, ETH] });
const PROXY = at(saltOf("proxy"), initPX);
// The tool's own code hashes must be the ones the contract will be asked for: Counter(3) is free per run.
const MCP_COUNT = 1000 + (Number(BigInt(tag) % 1000000n));

say("\n[agent: read, preview, refusals]");
const h = step("hash of Counter(1)", ["hash", "--artifact", COUNTER, "--args", "[1]"]);
check(h.out.trim() === keccak256(counterInit(1)).slice(2), `hash == viem's: ${h.out.trim()}`);
step("hash from raw init code", ["hash", "--init", "0x6000"], { says: new RegExp(keccak256("0x6000").slice(2)) });
const salt0 = saltOf("counter");
const counterArgs = ["--chain", CHAIN.name, "--artifact", COUNTER, "--args", "[1]", "--salt", salt0];
const pv = step("preview Counter(1)", ["preview", ...counterArgs]);
check(pv.json?.matches_viem === true && pv.json?.expected_address === at(salt0, counterInit(1)), `preview: nonce ${pv.json?.nonce}, promises ${pv.json?.expected_address}, matches viem`);
refused("preview Counter(999)", ["preview", "--chain", CHAIN.name, "--artifact", COUNTER, "--args", "[999]"], /code not on the allow list/);
refused("deploy Counter(999)", ["deploy", "--chain", CHAIN.name, "--artifact", COUNTER, "--args", "[999]"], /code not on the allow list/);
refused("upgrade-preview without a rule", ["upgrade-preview", "--chain", CHAIN.name, "--proxy", PROXY, "--implementation", addrV2], /not on the allow list/);
refused("upgrade without a rule", ["upgrade", "--chain", CHAIN.name, "--proxy", PROXY, "--implementation", addrV2], /not on the allow list/);
step("retry with nothing stuck", ["retry", "--chain", CHAIN.name], { exit: 1, says: /Nothing is stuck/ });
step("journal", ["journal", "--chain", CHAIN.name, "--limit", "2"]);
step("rules", ["rules"], { says: /allowed_code/ });
step("roles", ["roles"], { says: /guardian/ });
step("pending with nothing open", ["pending"]);

say("\n[agent: deploy]");
const nonceBefore = chainStatus().next_nonce;
const d = step("deploy Counter(1)", ["deploy", ...counterArgs]);
check(d.json?.address === at(salt0, counterInit(1)), `landed at the promised ${d.json?.address}: ${d.json?.links?.evm}`);
check(d.json?.nonce === nonceBefore, `nonce ${d.json?.nonce}`);
check(Number(await evm.readContract({ address: d.json.address, abi: load(COUNTER).abi, functionName: "number" })) === 1, "number() = 1 on chain");
await settle();
refused("the same salt and code again", ["deploy", ...counterArgs], /salt and code already used/);
const j = step("journal shows it", ["journal", "--chain", CHAIN.name, "--limit", "1"]);
const top = j.json?.lines?.[0];
check(top?.nonce === d.json.nonce && top?.status === "signed", `journal line ${top?.nonce}: ${top?.status}, ${top?.kind}`);
step("confirm a plain creation", ["confirm", "--chain", CHAIN.name, "--nonce", "0"], { exit: 1, says: /only factory deploys/ });
step("confirm a line that does not exist", ["confirm", "--chain", CHAIN.name, "--nonce", "9999"], { exit: 1, says: /No journal line/ });
const fresh = step("confirm the fresh line", ["confirm", "--chain", CHAIN.name, "--nonce", String(d.json.nonce)]);
check(fresh.json?.status === "waiting_for_safe", `too early: ${fresh.json?.status}, ${fresh.json?.blocks_to_go} blocks to go`);

say("\n[council: a widening waits; pending shows it; apply early refused; any member cancels]");
const hash2 = keccak256(counterInit(2)).slice(2);
const p = await write("rules allow-code Counter(2)", ["rules", "allow-code", hash2]);
const id2 = p.json?.result;
const open = cli(["pending"]);
check(open.code === 3 && open.json.pending.some((x) => x.id === id2), `pending exits 3 and lists rule ${id2}, ready in ${open.json?.pending?.[0]?.ready_in_sec} s`);
refused("rules apply before the delay", ["rules", "apply", String(id2)], /rule delay not over/);
step("the agent's key cannot propose", ["rules", "allow-code", hash2, "--as", cfg.agent], { exit: 2, says: /may not call that method/, as: "agentkey" });
await write("rules cancel by the guardian", ["rules", "cancel", String(id2)], "guardian");
check(cli(["pending"]).code === 0, "pending exits 0 again");
refused("Counter(2) stays refused", ["preview", "--chain", CHAIN.name, "--artifact", COUNTER, "--args", "[2]"], /code not on the allow list/);

say("\n[council: pause takes one, unpause takes two]");
await write("pause by the guardian", ["pause"], "guardian");
check(status().paused === true, "status: paused");
refused("deploy while paused", ["deploy", "--chain", CHAIN.name, "--artifact", COUNTER, "--args", "[1]"], /paused/);
await write("unpause, first vote (owner)", ["unpause"]);
check(status().paused === true, "one vote is not enough: still paused");
await write("unpause, second vote (reserve)", ["unpause"], "reserve");
check(status().paused === false, "two votes: running again");

say("\n[council: each brake at once; the order lets each refusal show, the tool checks the code before the contract]");
const pv1 = ["preview", "--chain", CHAIN.name, "--artifact", COUNTER, "--args", "[1]"];
const b0 = chainStatus().daily_budget;
// The rest of the run signs too, and an earlier run the same UTC day counts: the budget refuses what is over it.
const dayTxs = Math.max(b0.max_tx_per_day, b0.used_tx_today + 20);
const lim0 = status();
await write("lower-budget to what is used", ["lower-budget", CHAIN.name, b0.max_wei_per_day, String(b0.used_tx_today)], "reserve");
refused("preview over the lowered budget", pv1, /daily limit/);
await write("lower-limits", ["lower-limits", "30000", lim0.max_fee_cap], "reserve");
refused("preview under the lowered gas cap", pv1, /intrinsic minimum/);
refused("raising a cap at once is refused", ["lower-limits", lim0.max_gas_limit, lim0.max_fee_cap], /raising a cap is a rule proposal/, "guardian");
await write("remove-factory", ["remove-factory", CHAIN.name], "guardian");
refused("preview without a factory", pv1, /no factory on this chain/);
await write("disable-chain", ["disable-chain", CHAIN.name], "reserve");
refused("preview on a disabled chain", pv1, /chain is disabled/);
await write("remove-code", ["remove-code", keccak256(counterInit(1)).slice(2)], "guardian");
refused("preview of removed code", pv1, /code not on the allow list/);
refused("allow-chain on an open chain: its nonce moves only by signing", ["rules", "allow-chain", CHAIN.name, "0", "1000000"], /chain already allowed/);

say("\n[council: reopening is a widening, and the run's treasury goes through the same delay]");
const DUMMY = [`0x${"11".repeat(20)}`, `0x${"22".repeat(20)}`];
const ids = [];
const counterMcp = keccak256(counterInit(MCP_COUNT)).slice(2);
for (const [what, args] of [
  ["set-budget", ["rules", "set-budget", CHAIN.name, b0.max_wei_per_day, String(dayTxs)]],
  ["set-factory", ["rules", "set-factory", CHAIN.name, FACTORY]],
  ["set-limits", ["rules", "set-limits", lim0.max_gas_limit, lim0.max_fee_cap]],
  ["allow-code Counter(1)", ["rules", "allow-code", keccak256(counterInit(1)).slice(2)]],
  ["enable-chain", ["rules", "enable-chain", CHAIN.name]],
  ["allow-code TreasuryV1", ["rules", "allow-code", keccak256(initV1).slice(2)]],
  ["allow-code TreasuryV2", ["rules", "allow-code", keccak256(initV2).slice(2)]],
]) ids.push(step(what, args).json?.result);
await settle();
await applyAll(ids);
// At most 8 open proposals: the second group goes after the first has been applied.
const ids2 = [];
for (const [what, args] of [
  ["allow-code TreasuryProxy", ["rules", "allow-code", keccak256(initPX).slice(2)]],
  [`allow-code Counter(${MCP_COUNT}) for the MCP run`, ["rules", "allow-code", counterMcp]],
  ["allow-upgrade proxy -> v2", ["rules", "allow-upgrade", CHAIN.name, PROXY, addrV2]],
  ["allow-upgrade proxy -> v1, for the MCP run", ["rules", "allow-upgrade", CHAIN.name, PROXY, addrV1]],
  ["allow-upgrade of a dummy, to remove it", ["rules", "allow-upgrade", CHAIN.name, ...DUMMY]],
]) ids2.push(step(what, args).json?.result);
await settle();
await applyAll(ids2);
const after = chainStatus();
check(after.allowed && after.daily_budget.max_tx_per_day === dayTxs, `chain open again, budget ${after.daily_budget.max_tx_per_day} transactions a day`);
step("Counter(1) previews again", pv1);
const dummyKey = `${CHAIN.chain_id}:${DUMMY[0]}:${DUMMY[1]}`;
check(status().allowed_proxy_upgrades.includes(dummyKey), "the dummy upgrade is on the list");
await write("remove-upgrade at once", ["remove-upgrade", CHAIN.name, ...DUMMY], "guardian");
check(!status().allowed_proxy_upgrades.includes(dummyKey), "and off it");

say("\n[council: a role change and a policy upgrade, proposed and cancelled]");
const ownerKey = JSON.parse(fs.readFileSync(process.env.KEYFREE_COUNCIL_KEY ?? path.join(os.homedir(), ".near-credentials", cfg.near_network, `${roles.owner}.json`), "utf8")).private_key;
const provider = new JsonRpcProvider({ url: cfg.near_rpc });
const owner = new Account(roles.owner, provider, ownerKey);
await owner.callFunction({ contractId: cfg.policy, methodName: "propose_role", args: { role: "Agent", account: `other.${roles.owner}` }, gas: teraToGas("30") });
await settle();
const pr = cli(["pending"]);
check(pr.code === 3 && pr.json.pending.some((x) => x.kind === "role" && x.role === "Agent"), "pending lists the new agent proposed by the owner");
refused("rules apply of an id that does not exist", ["rules", "apply", "99999"], /no such rule proposal/, "guardian");
await write("cancel-role by the guardian", ["cancel-role", roles.owner], "guardian");
check(cli(["pending"]).code === 0, "the new agent is gone");
const fakeCode = new Uint8Array(1000).fill(7);
await owner.callFunctionRaw({ contractId: cfg.policy, methodName: "propose_upgrade", args: fakeCode, gas: teraToGas("100"), deposit: 2n * 10n ** 22n });
await settle();
const pu = cli(["pending"]);
check(pu.code === 3 && pu.json.pending.some((x) => x.kind === "policy upgrade"), "pending lists a proposed policy upgrade");
await write("cancel-upgrade by the reserve", ["cancel-upgrade"], "reserve");
check(cli(["pending"]).code === 0, "the proposal is gone");

say("\n[agent: a treasury, and its one allowed upgrade]");
const dep = (what, a, args, salt, want) => {
  const r = step(`deploy ${what}`, ["deploy", "--chain", CHAIN.name, "--artifact", a, "--args", JSON.stringify(args), "--salt", salt]);
  check(r.json?.address === want, `${what} at the promised ${r.json?.address}: ${r.json?.links?.evm}`);
  return r;
};
dep("TreasuryV1", V1.file, [OWNER_OF_TREASURY], saltOf("v1"), addrV1);
await settle();
dep("TreasuryProxy", PX.file, [addrV1, ETH], saltOf("proxy"), PROXY);
await settle();
dep("TreasuryV2", V2.file, [OWNER_OF_TREASURY, String(LIMIT)], saltOf("v2"), addrV2);
await settle();
check((await version(PROXY)) === 1, "the proxy runs v1");
const up = ["--chain", CHAIN.name, "--proxy", PROXY, "--implementation", addrV2];
const upv = step("upgrade-preview proxy -> v2", ["upgrade-preview", ...up]);
check(upv.json?.matches_viem === true, `upgrade-preview: admin ok, matches viem, nonce ${upv.json?.nonce}`);
const u = step("upgrade proxy -> v2", ["upgrade", ...up]);
check((await version(PROXY)) === 2, `the proxy runs v2: ${u.json?.links?.evm}`);
await settle();
refused("the same upgrade again", ["upgrade", ...up], /not on the allow list/);

say("\n[MCP: the 9 tools over stdio, the way a coding agent uses them]");
const client = new Client({ name: "keyfree-live", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "mcp.js")],
  env: { ...getDefaultEnvironment(), KEYFREE_CONFIG: CFG, KEYFREE_AGENT_KEY: process.env.KEYFREE_AGENT_KEY ?? "" } }));
const tool = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join("\n");
  let data;
  try { data = JSON.parse(text); } catch { data = undefined; }
  return { error: r.isError === true, text, data };
};
const RULE = /do not try another way around it/;
const { tools } = await client.listTools();
check(tools.length === 9 && !tools.some((t) => /rule|role|pause|allow|propose|apply|cancel/.test(t.name)), `${tools.length} tools, none of the council's`);
const ms = await tool("keyfree_status", {});
check(!ms.error && ms.data.policy_keys === 0, `keyfree_status: ${ms.data?.policy}, 0 keys`);
const mh = await tool("keyfree_code_hash", { artifact: COUNTER, constructor_args: [MCP_COUNT] });
check(mh.data?.code_hash === counterMcp, `keyfree_code_hash: ${mh.data?.code_hash}`);
const msalt = saltOf("mcp");
const mpv = await tool("keyfree_preview", { chain: CHAIN.name, artifact: COUNTER, constructor_args: [MCP_COUNT], salt: msalt });
check(!mpv.error && mpv.data.matches_viem === true && mpv.data.expected_address === at(msalt, counterInit(MCP_COUNT)), `keyfree_preview: promises ${mpv.data?.expected_address}`);
const mno = await tool("keyfree_preview", { chain: CHAIN.chain_id, artifact: COUNTER, constructor_args: [999] });
check(mno.error && /code not on the allow list/.test(mno.text) && RULE.test(mno.text), "keyfree_preview of other code: refused, with the do-not-work-around rule");
const mbad = await tool("keyfree_deploy", { chain: CHAIN.name, artifact: COUNTER, private_key: "0x1234" });
check(mbad.error && /private_key|Unrecognized/.test(mbad.text), "keyfree_deploy with an extra argument: rejected before the handler");
const md = await tool("keyfree_deploy", { chain: CHAIN.name, artifact: COUNTER, constructor_args: [MCP_COUNT], salt: msalt });
check(!md.error && md.data.address === mpv.data.expected_address, `keyfree_deploy: at the promised ${md.data?.address}: ${md.data?.links?.evm}`);
await settle();
const mag = await tool("keyfree_deploy", { chain: CHAIN.name, artifact: COUNTER, constructor_args: [MCP_COUNT], salt: msalt });
check(mag.error && /salt and code already used/.test(mag.text) && RULE.test(mag.text), "keyfree_deploy again: refused");
const mup = { chain: CHAIN.name, proxy: PROXY, implementation: addrV1 };
const mupv = await tool("keyfree_upgrade_preview", mup);
check(!mupv.error && mupv.data.matches_viem === true, "keyfree_upgrade_preview: the allowed rollback, matches viem");
const mu = await tool("keyfree_upgrade", mup);
check(!mu.error && (await version(PROXY)) === 1, `keyfree_upgrade: the proxy runs v1 again: ${mu.data?.links?.evm}`);
await settle();
const mua = await tool("keyfree_upgrade", mup);
check(mua.error && /not on the allow list/.test(mua.text) && RULE.test(mua.text), "keyfree_upgrade again: refused, the allowance was used");
const mr = await tool("keyfree_retry", { chain: CHAIN.name });
check(mr.error && /Nothing is stuck/.test(mr.text), "keyfree_retry with nothing stuck");
const mc = await tool("keyfree_confirm", { chain: CHAIN.name, nonce: md.data.nonce });
check(!mc.error && mc.data.status === "waiting_for_safe", `keyfree_confirm too early: ${mc.data?.status}`);
const mj = await tool("keyfree_journal", { chain: CHAIN.name, limit: 2 });
check(!mj.error && mj.data.lines[0].kind === "proxy_upgrade" && mj.data.lines[1].nonce === md.data.nonce, `keyfree_journal: line ${mj.data?.lines?.[0]?.nonce} ${mj.data?.lines?.[0]?.kind}, line ${mj.data?.lines?.[1]?.nonce} ${mj.data?.lines?.[1]?.kind}`);
await client.close();

say("\n[what is left]");
const end = status();
check(end.paused === false && end.policy_keys === 0 && end.max_gas_limit === lim0.max_gas_limit && end.max_fee_cap === lim0.max_fee_cap, `running, 0 keys, caps as before (${end.max_gas_limit} gas, ${end.max_fee_cap} wei)`);
check(cli(["pending"]).code === 0, "nothing waiting");
await confirmAll();
say(`\n${steps - fails}/${steps} steps ok`);
process.exitCode = fails ? 1 : 0;
