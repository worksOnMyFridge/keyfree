// Network faults for real, on a policy of your own (setup/policy.mjs makes one), never the demo's. A small proxy
// in front of the real RPC nodes breaks what the run needs broken; the contract, NEAR MPC and both chains are real.
// Covers what test/faults.test.mjs models with fake nodes: a dead node, a wrong chain, a gas spike, an agent with
// no NEAR or too small an allowance, and the worst one: signed, then the broadcast fails, then `retry` recovers it
// (the live runs of the contract's resign and resign_proxy_upgrade). It spends a little testnet ETH and NEAR.
//   npm run build && node scripts/live_faults.mjs          about 4 minutes
// Env as scripts/live.mjs: KEYFREE_CONFIG, KEYFREE_AGENT_KEY, KEYFREE_GUARDIAN_KEY, KEYFREE_RESERVE_KEY, and the
// owner's key in KEYFREE_COUNCIL_KEY or ~/.near-credentials. Prints OK/FAIL per step, exit 1 on any FAIL.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto } from "near-api-js";
import { createPublicClient, http as viemHttp } from "viem";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CFG = path.resolve(process.env.KEYFREE_CONFIG ?? "keyfree.json");
const cfg = JSON.parse(fs.readFileSync(CFG, "utf8"));
const CHAIN = cfg.chains[0];
const CLI = path.join(root, "dist", "cli.js");
const COUNTER = path.join(root, "demo", "out", "Counter.sol", "Counter.json");
const OWNER_KEY = process.env.KEYFREE_COUNCIL_KEY ?? path.join(os.homedir(), ".near-credentials", cfg.near_network, `${cfg.owner}.json`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyfree-live-faults-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s) => s.replaceAll(os.homedir(), "~").replace(/\s+/g, " ").slice(0, 260);
const evm = createPublicClient({ transport: viemHttp(CHAIN.rpc) });

let fails = 0, steps = 0;
const say = (s) => console.log(s);
const check = (ok, s) => { steps++; if (!ok) fails++; say(`${ok ? "OK  " : "FAIL"} ${short(s)}`); return ok; };

// A JSON-RPC proxy: `rules[method]` is an HTTP status to fail with, or a function that rewrites the node's result.
async function proxy(target, rules = {}) {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", async () => {
      const m = JSON.parse(body);
      const rule = rules[m.method];
      if (typeof rule === "number") { res.statusCode = rule; return res.end("the proxy says no"); }
      const r = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body });
      const j = await r.json();
      if (typeof rule === "function" && j.result !== undefined) j.result = rule(j.result, m.params);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(j));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

// A config like the real one, with the RPC addresses replaced. The address of a closed port stands for a dead node.
function config(name, over) {
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...cfg, ...over, chains: [{ ...CHAIN, ...(over.evm ? { rpc: over.evm } : {}) }] }));
  return file;
}

function cli(args, { file = CFG, env = {} } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args, "--config", file], { env: { ...process.env, ...env } });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => {
      const start = out.search(/^[{[]/m);
      let json;
      try { json = start >= 0 ? JSON.parse(out.slice(start)) : undefined; } catch { json = undefined; }
      resolve({ code, out: `${out}${err}`, json });
    });
  });
}
async function step(what, args, { exit = 0, says, file, env } = {}) {
  const r = await cli(args, { file, env });
  check(r.code === exit && (!says || says.test(r.out)), `${what}: exit ${r.code}${r.code !== exit ? ` (wanted ${exit})` : ""}${r.code ? `, ${r.out.trim().split("\n")[0]}` : ""}${says && !says.test(r.out) ? `, no "${says.source}" in: ${r.out}` : ""}`);
  return r;
}
const chainStatus = async () => (await cli(["status"])).json.chains.find((c) => c.name === CHAIN.name);
const number = (address) => evm.readContract({ address, abi: [{ type: "function", name: "number", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "number" });
const version = (address) => evm.readContract({ address, abi: [{ type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "version" });
const C1 = ["--artifact", COUNTER, "--args", "[1]"];
const C2 = ["--artifact", COUNTER, "--args", "[2]"];
const CH = ["--chain", CHAIN.name];

say(`--- ${new Date().toISOString()} live faults on ${cfg.policy}, ${CHAIN.name}`);
const startNonce = (await chainStatus()).next_nonce;
const DEAD = "http://127.0.0.1:9";

say("\n[a dead or wrong node: nothing is signed, nothing moves]");
const deadEvm = config("dead_evm", { evm: DEAD });
await step("preview, EVM node dead", ["preview", ...CH, ...C1], { exit: 1, file: deadEvm });
await step("deploy, EVM node dead", ["deploy", ...CH, ...C1], { exit: 1, file: deadEvm });
const shown = await step("status still shows the policy, the balance marked unknown", ["status"], { file: deadEvm, says: /rpc_error/ });
check(shown.json?.policy === cfg.policy && shown.json?.chains[0].balance_wei === null, "status: policy and rules readable with the EVM node dead");
await step("journal, EVM node dead", ["journal", ...CH], { file: deadEvm });
const deadNear = config("dead_near", { near_rpc: DEAD });
await step("status, NEAR node dead", ["status"], { exit: 1, file: deadNear, says: /NEAR/ });
const mainnet = await proxy(CHAIN.rpc, { eth_chainId: () => "0x2105" });
await step("deploy, the node answers as another chain", ["deploy", ...CH, ...C1], { exit: 1, file: config("wrong_chain", { evm: mainnet.url }), says: /8453/ });
await mainnet.close();
const sameNonce = (await chainStatus()).next_nonce;
check(sameNonce === startNonce, `the policy's nonce did not move: ${sameNonce}`);

say("\n[a gas spike: the real contract refuses over its cap]");
const spike = await proxy(CHAIN.rpc, { eth_getBlockByNumber: (b) => (b ? { ...b, baseFeePerGas: "0x174876e800" } : b) });
await step("deploy at a base fee of 100 gwei", ["deploy", ...CH, ...C1], { exit: 2, file: config("spike", { evm: spike.url }), says: /gas price over the cap/ });
await spike.close();

say("\n[an agent with no NEAR, or too small an allowance: real answers of the protocol]");
const owner = new Account(cfg.owner, new JsonRpcProvider({ url: cfg.near_rpc }), JSON.parse(fs.readFileSync(OWNER_KEY, "utf8")).private_key);
const METHODS = ["request_deploy", "request_proxy_upgrade", "resign", "resign_proxy_upgrade", "retry", "release", "confirm", "confirm_stuck"];
async function tempAgent(suffix, near, allowance) {
  const id = `${suffix}${Date.now()}.${cfg.owner}`;
  const fc = KeyPair.fromRandom("ed25519");
  const full = KeyPair.fromRandom("ed25519");
  await owner.signAndSendTransaction({ receiverId: id, actions: [
    actions.createAccount(), actions.transfer(nearToYocto(near)),
    actions.addFunctionCallAccessKey(fc.getPublicKey(), cfg.policy, METHODS, allowance),
    actions.addFullAccessKey(full.getPublicKey()),
  ] });
  const keyFile = path.join(dir, `${suffix}_key.json`);
  fs.writeFileSync(keyFile, JSON.stringify({ private_key: fc.toString() }));
  await sleep(3000);
  return { id, keyFile, remove: () => new Account(id, owner.provider, full.toString()).signAndSendTransaction({ receiverId: id, actions: [actions.deleteAccount(cfg.owner)] }) };
}
const broke = await tempAgent("broke", "0.004");
const allowance = await tempAgent("thrifty", "0.5", nearToYocto("0.0001"));
const brokeBefore = (await chainStatus()).next_nonce;
await step("deploy by an agent with no NEAR", ["deploy", ...CH, ...C1], { exit: 1, file: config("broke", { agent: broke.id }), env: { KEYFREE_AGENT_KEY: broke.keyFile }, says: /too little NEAR/ });
await step("deploy by a key with too small an allowance", ["deploy", ...CH, ...C1], { exit: 1, file: config("thrifty", { agent: allowance.id }), env: { KEYFREE_AGENT_KEY: allowance.keyFile }, says: /allowance/ });
check((await chainStatus()).next_nonce === brokeBefore, "the policy's nonce did not move");
// A node can fail after the deletion went through, and its retry then finds no such account: that is the wanted end.
const gone = (a) => a.remove().catch((e) => { if (!/does not exist/.test(String(e?.message))) throw e; });
await gone(broke);
await gone(allowance);
say("  the two temporary accounts are deleted, their NEAR back with the owner");

say("\n[signed, then the broadcast fails: a deploy]");
const noSend = await proxy(CHAIN.rpc, { eth_sendRawTransaction: 500, eth_getTransactionByHash: () => null });
await step("deploy Counter(1), the broadcast refused", ["deploy", ...CH, ...C1], { exit: 1, file: config("no_send", { evm: noSend.url }), says: /Signed, but not on chain/ });
await noSend.close();
await sleep(3000);
const line = (await chainStatus()).next_nonce - 1;
check(line === brokeBefore, `the policy moved to the next nonce, line ${line} is signed and nothing is on chain`);
await step("a new deploy would wait behind the gap: stopped before signing", ["deploy", ...CH, ...C1], { exit: 1, says: new RegExp(`Nonce ${line} .*retry`) });
await step("retry needs the code of a deploy line", ["retry", ...CH], { exit: 1, says: /same artifact/ });
await step("retry takes only the same code", ["retry", ...CH, ...C2], { exit: 1, says: /differs from line/ });
const entry = (await cli(["journal", ...CH, "--limit", "1"])).json.lines[0];
const back = await step("retry with the code: contract's resign, real MPC", ["retry", ...CH, ...C1]);
check(back.json?.nonce === line && back.json?.address === entry.address, `landed at the promised ${entry.address}: ${back.json?.links?.evm}`);
check(back.json?.near_tx !== undefined, `re-signed on NEAR: ${back.json?.links?.near}`);
if (back.json?.address) check((await number(back.json.address)) === 1n, "number() = 1 on chain");
await sleep(3000);
await step("nothing is stuck any more", ["retry", ...CH], { exit: 1, says: /Nothing is stuck/ });

say("\n[signed, then the broadcast fails: a proxy upgrade]");
const { lines } = (await cli(["journal", ...CH, "--limit", "50"])).json;
const upgrades = lines.filter((l) => l.kind === "proxy_upgrade");
const { proxy: treasury } = upgrades[0];
const running = await version(treasury);
const target = upgrades.find((u) => u.proxy === treasury && u.implementation !== upgrades[0].implementation)?.implementation;
check(Boolean(target), `the treasury ${treasury} runs v${running}, going to ${target}`);
await step("the council allows the upgrade", ["rules", "allow-upgrade", CHAIN.name, treasury, target]);
const pendingRules = (await cli(["pending"])).json.pending.filter((p) => p.kind === "rule");
const wait = Math.max(0, ...pendingRules.map((p) => p.ready_in_sec ?? 0));
say(`waiting ${wait + 3} s for the rules delay`);
await sleep((wait + 3) * 1000);
for (const p of pendingRules) await step(`rule ${p.id} applied`, ["rules", "apply", String(p.id)]);
await sleep(3000);
const noSend2 = await proxy(CHAIN.rpc, { eth_sendRawTransaction: 500, eth_getTransactionByHash: () => null });
await step("upgrade, the broadcast refused", ["upgrade", ...CH, "--proxy", treasury, "--implementation", target], { exit: 1, file: config("no_send2", { evm: noSend2.url }), says: /Signed, but not on chain/ });
await noSend2.close();
await sleep(3000);
check((await version(treasury)) === running, `the treasury still runs v${running}`);
const up = await step("retry: contract's resign_proxy_upgrade, real MPC, no code needed", ["retry", ...CH]);
check((await version(treasury)) !== running, `the treasury moved to v${await version(treasury)}: ${up.json?.links?.evm}`);
check(up.json?.near_tx !== undefined, `re-signed on NEAR: ${up.json?.links?.near}`);
await sleep(3000);
await step("nothing is stuck any more", ["retry", ...CH], { exit: 1, says: /Nothing is stuck/ });

fs.rmSync(dir, { recursive: true, force: true });
say(`\n${steps - fails}/${steps} steps ok`);
process.exitCode = fails ? 1 : 0;
