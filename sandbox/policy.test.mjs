// The policy in a real NEAR runtime: a local nearcore sandbox runs the exact wasm of the live policy next to a
// stand-in MPC contract (sandbox/mock-mpc). Real accounts and access keys, gas, storage, promises, callbacks
// and batches, nothing on testnet. The unit tests in contract/ run the same code on near-sdk's mocked chain;
// here the runtime is nearcore itself (private callbacks, a function-call key, a batch that fails half-way).
//   POLICY_WASM=<policy wasm> MOCK_WASM=<mock wasm> npm run test:sandbox
// Linux x64/arm64 or macOS arm64 (the sandbox binaries); the sandbox workflow builds both wasm files first and
// checks the policy's sha256 against the live build. Writes evidence/sandbox.md.
// The last test drives the real tool (packages/keyfree, built) against this contract, with a failing EVM node.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, DEFAULT_NEAR_SANDBOX_VERSION } from "near-sandbox";
import { Account, JsonRpcProvider, KeyPair, actions, teraToGas } from "near-api-js";
import { parseTransaction, serializeTransaction, recoverTransactionAddress, keccak256, getContractAddress, encodeDeployData, encodeFunctionData, decodeFunctionData, parseAbi } from "viem";
import { publicKeyToAddress } from "viem/accounts";

const POLICY = fs.readFileSync(process.env.POLICY_WASM ?? "sandbox/policy.wasm");
const MOCK = fs.readFileSync(process.env.MOCK_WASM ?? "sandbox/mock_mpc.wasm");
const F = JSON.parse(fs.readFileSync(new URL("../factory/factory.json", import.meta.url)));
const C = JSON.parse(fs.readFileSync(new URL("../packages/keyfree/demo/out/Counter.sol/Counter.json", import.meta.url)));

const CHAIN = 84532;
const FLOOR = 1_000_000n;
const FEE = 2_000_000_000;
const PRIO = 1_000_000;
const BIG_BUDGET = 12345678901234567891n; // above 2^53: must survive JSON both ways exactly
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const AGENT_METHODS = ["request_deploy", "request_proxy_upgrade", "resign", "resign_proxy_upgrade", "retry", "release", "confirm", "confirm_stuck"];
const DELAYS = { upgrade_delay_sec: 6, rules_delay_sec: 3 };

const ID = (n) => `${n}.${DEFAULT_ACCOUNT_ID}`;
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const counter = (n) => encodeDeployData({ abi: C.abi, bytecode: C.bytecode.object, args: [BigInt(n)] });
const hashOf = (hex) => keccak256(hex).slice(2);
const toHexBytes = (n, f) => `0x${Buffer.from(Uint8Array.from({ length: n }, (_, i) => f(i))).toString("hex")}`;
const tgas = (g) => (Number(g) / 1e12).toFixed(1);

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58encode = (buf) => { let n = BigInt(`0x${Buffer.from(buf).toString("hex")}`), s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } return s; };
const b58decode = (s) => { let n = 0n; for (const c of s) n = n * 58n + BigInt(B58.indexOf(c)); return Buffer.from(n.toString(16).padStart(128, "0"), "hex"); };

// Exact JSON integers both ways: BigInt arguments are written as plain numbers, long numbers are read as strings.
const exact = (args) => new TextEncoder().encode(JSON.stringify(args, (_k, x) => (typeof x === "bigint" ? `__int__${x}` : x)).replace(/"__int__(\d+)"/g, "$1"));
const parseExact = (t) => JSON.parse(t.replace(/"(?:[^"\\]|\\.)*"|-?\d{16,}/g, (m) => (m.startsWith('"') ? m : `"${m}"`)));

let sandbox, provider, root, POL, ETH;
const acc = {};
const keys = {};
const ev = { checks: [], gas: [], matrix: [], views: [] };
const note = (s) => { ev.checks.push(s); console.log(`  ok: ${s}`); };

function outcome(out) {
  const st = out.status ?? {};
  const fail = st.Failure ? JSON.stringify(st.Failure) : null;
  const msg = fail ? (fail.match(/"ExecutionError":"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/^Smart contract panicked: /, "") ?? fail) : null;
  const all = [out.transaction_outcome, ...out.receipts_outcome];
  const gas = all.reduce((s, o) => s + BigInt(o.outcome.gas_burnt), 0n);
  const logs = out.receipts_outcome.flatMap((r) => r.outcome.logs);
  const failedReceipts = out.receipts_outcome.filter((r) => r.outcome.status.Failure).map((r) => JSON.stringify(r.outcome.status.Failure));
  let value;
  if (st.SuccessValue !== undefined) { const t = Buffer.from(st.SuccessValue, "base64").toString(); value = t ? parseExact(t) : undefined; }
  return { ok: !fail, fail, msg, value, gas, logs, failedReceipts };
}

const send = async (from, receiverId, acts) => outcome(await from.signAndSendTransaction({ receiverId, actions: acts, waitUntil: "EXECUTED_OPTIMISTIC", throwOnFailure: false }));
const call = (from, contract, method, args = {}, { gas = "300", deposit = 0n, input } = {}) =>
  send(from, contract, [actions.functionCall(method, input ?? exact(args), teraToGas(gas), deposit)]);
const view = async (contractId, method, args = {}) => {
  const r = await provider.callFunctionRaw({ contractId, method, args, blockQuery: { finality: "optimistic" } });
  return parseExact(Buffer.from(r.result).toString());
};
const refused = async (p, reason) => {
  const r = await p;
  assert.equal(r.ok, false, `expected a refusal "${reason}", got success`);
  assert.ok(r.msg.includes(reason), `expected "${reason}", got: ${r.msg}`);
  return r;
};
const passed = async (p, what) => {
  const r = await p;
  assert.ok(r.ok, `${what}: ${r.msg}`);
  return r;
};
const chainNow = async () => {
  const h = (await provider.viewBlock({ finality: "optimistic" })).header;
  return Number(BigInt(h.timestamp_nanosec ?? h.timestamp) / 1_000_000_000n);
};
const untilChain = async (ts) => { for (let i = 0; i < 240 && (await chainNow()) < ts; i++) await sleep(500); };

const yocto = (nearAmount) => BigInt(Math.round(nearAmount * 1e6)) * 10n ** 18n;
async function makeAccount(id, nearAmount, extra = []) {
  const kp = KeyPair.fromRandom("ed25519");
  keys[id] = kp;
  const r = await send(root, id, [actions.createAccount(), actions.transfer(yocto(nearAmount)), actions.addFullAccessKey(kp.getPublicKey()), ...extra]);
  assert.ok(r.ok, `create ${id}: ${r.msg}`);
  return new Account(id, provider, kp.toString());
}

// The install the README describes: deploy + init + delete the only key, in one transaction.
async function install(name, nearAmount = 15) {
  const id = ID(name);
  const self = await makeAccount(id, nearAmount);
  const r = await send(self, id, [
    actions.deployContract(POLICY),
    actions.functionCall("new", exact({ owner: ID("owner"), agent: ID("agent"), guardian: ID("guardian"), reserve: ID("reserve"), mpc: ID("mpc"), path: "keyfree-1", ...DELAYS }), teraToGas("30"), 0n),
    actions.deleteKey(keys[id].getPublicKey()),
  ]);
  assert.ok(r.ok, `install ${id}: ${r.msg}`);
  return id;
}

async function propose(change, policy = POL) {
  const r = await passed(call(acc.owner, policy, "propose_rule", { change }), "propose_rule");
  return r.value;
}
async function applyRules(ids, by = acc.guardian, policy = POL) {
  const open = (await view(policy, "get_rules")).proposals.filter((p) => ids.includes(p.id));
  await untilChain(Math.max(...open.map((p) => Number(p.ready_at))));
  for (const id of ids) await passed(call(by, policy, "apply_rule", { id }), `apply_rule ${id}`);
}
// A second policy for the fault tests, so the main run's nonces and budget stay as counted: installed, its
// address derived, chain 84532 open from nonce 0 with a budget, the given codes allowed. Returns its ETH address.
async function prepare(policy, codes) {
  const eth = (await passed(call(acc.owner, policy, "setup", {}, { gas: "100" }), "setup")).value;
  const ids = [await propose({ AllowChain: { chain_id: CHAIN, next_nonce: 0, min_fee_per_gas: FLOOR } }, policy),
    await propose({ SetBudget: { chain_id: CHAIN, max_wei_per_day: BIG_BUDGET, max_tx_per_day: 100 } }, policy)];
  for (const code of codes) ids.push(await propose({ AllowCode: { code_hash: hashOf(code) } }, policy));
  await applyRules(ids, acc.guardian, policy);
  return eth;
}
const signs = async () => (await view(ID("mpc"), "get_log")).signs;
const rpc = (method, params) => fetch(sandbox.rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "kf", method, params }) }).then((r) => r.json());
async function until(what, cond, seconds = 300) {
  for (let i = 0; i < seconds * 2; i++) { if (await cond()) return; await sleep(500); }
  assert.fail(`waited ${seconds} s for ${what}`);
}
const setMode = (sign, verify = "ok") => passed(call(acc.mpc, ID("mpc"), "set_mode", { sign, verify }), "set_mode");

// The signed transaction carries exactly the previewed content, low s, and recovers to the policy's address.
async function checkRaw(raw, unsigned, eth = ETH) {
  assert.match(raw ?? "", /^0x02[0-9a-f]+$/, "a signed EIP-1559 transaction");
  const { r, s, v, yParity, ...u } = parseTransaction(raw);
  assert.equal(serializeTransaction(u), unsigned, "signed content == preview");
  assert.ok(BigInt(s) <= SECP_N / 2n, "low s (EIP-2)");
  assert.equal((await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase(), eth, "recovers to the policy's ETH address");
  return parseTransaction(raw);
}
const deployArgs = (init, gas, salt = null) => ({ chain_id: CHAIN, init_code_hex: init, gas_limit: gas, max_fee_per_gas: FEE, max_priority_fee_per_gas: PRIO, salt_hex: salt, via_factory: salt ? true : null });

before(async () => {
  sandbox = await Sandbox.start({});
  provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY);
  for (const [n, amount] of [["owner", 60], ["guardian", 10], ["reserve", 10], ["stranger", 10], ["newagent", 10], ["mpc", 20]]) acc[n] = await makeAccount(ID(n), amount);
  // The agent's working key is the one the README gives an agent: function calls on the policy, the agent methods
  // only. Its full key here exists for the access matrix (contract-level refusals, not key-level ones).
  const fc = KeyPair.fromRandom("ed25519");
  acc.agent = await makeAccount(ID("agent"), 10, [actions.addFunctionCallAccessKey(fc.getPublicKey(), ID("policy"), AGENT_METHODS)]);
  acc.agentKey = new Account(ID("agent"), provider, fc.toString());
  assert.ok((await send(acc.mpc, ID("mpc"), [actions.deployContract(MOCK)])).ok, "mock MPC deployed");
});

after(async () => {
  const md = ["# Sandbox run", "", "Run: `.github/workflows/sandbox.yml` (or `npm run test:sandbox` with POLICY_WASM and MOCK_WASM).", "",
    `The policy's wasm (sha256 \`${sha256(POLICY).toString("hex")}\`, ${POLICY.length} bytes) in a local nearcore sandbox ${DEFAULT_NEAR_SANDBOX_VERSION},`,
    "next to a stand-in MPC contract (`sandbox/mock-mpc`). Real accounts and keys, gas, storage, promises and callbacks.", ""];
  if (ev.matrix.length) {
    md.push("## Who may call what", "", "Each method called by each account on a fresh policy. ✓ = past the role check (it may still refuse for", "another reason), – = refused for the caller's role.", "",
      "| Method | stranger | agent | guardian | reserve | owner |", "|---|---|---|---|---|---|");
    for (const row of ev.matrix) md.push(`| ${row.label} | ${row.cells.join(" | ")} |`);
    md.push("", `Read-only methods, callable by anyone without a transaction: ${ev.views.join(", ")}.`, "");
  }
  md.push("## Checks", "", ...ev.checks.map((c) => `- ${c}`), "", "## Gas", "", "| Call | Tgas burnt |", "|---|---|", ...ev.gas.map(([w, g]) => `| ${w} | ${tgas(g)} |`), "");
  fs.mkdirSync(new URL("../evidence/", import.meta.url), { recursive: true });
  fs.writeFileSync(new URL("../evidence/sandbox.md", import.meta.url), md.join("\n"));
  await sandbox?.tearDown();
});

test("install: deploy + init + key deletion in one transaction leave a keyless policy", async () => {
  POL = await install("policy");
  assert.equal((await provider.viewAccessKeyList({ accountId: POL })).keys.length, 0);
  const st = await view(POL, "get_status");
  assert.equal(st.build, process.env.KF_BUILD ?? "dev");
  assert.equal(st.version, 1);
  assert.equal((await provider.viewAccount({ accountId: POL })).code_hash, b58encode(sha256(POLICY)));
  await refused(call(acc.stranger, POL, "new", { owner: ID("stranger"), agent: ID("agent"), guardian: ID("guardian"), reserve: ID("reserve"), mpc: ID("mpc"), path: "x", ...DELAYS }), "only the contract account");
  await refused(call(acc.owner, POL, "new", { owner: ID("owner"), agent: ID("agent"), guardian: ID("guardian"), reserve: ID("reserve"), mpc: ID("mpc"), path: "x", ...DELAYS }), "only the contract account");
  note(`installed ${POL} in one transaction: 0 access keys, code hash = the wasm under test, build ${st.build}; init again refused for every account`);
});

test("access matrix: every method x every role on a fresh policy", async () => {
  const MAT = await install("matrix");
  const who = ["stranger", "agent", "guardian", "reserve", "owner"];
  const C3 = ["guardian", "reserve", "owner"], AO = ["agent", "owner"], ALL = who, NONE = [];
  const role = new Set(["only owner", "only agent or owner", "only owner, guardian or reserve", "only owner proposes a new agent", "only the contract account"]);
  const isRole = (m) => role.has(m) || /^Method \w+ is private$/.test(m ?? "");
  const log = { log_index: 0, transaction_index: 0, block_hash: "00".repeat(32), block_number: 1 };
  const fee = { gas_limit: 21_000, max_fee_per_gas: 1, max_priority_fee_per_gas: 1 };
  const a20 = (b) => `0x${b.repeat(20)}`;
  // [label, method, args, who passes the role check, raw input instead of JSON]. Calls that pass change
  // nothing a later row's role check depends on; revoke_agent comes last.
  const rows = [
    ["new", "new", { owner: ID("x"), agent: ID("y"), guardian: ID("z"), reserve: ID("w"), mpc: ID("mpc"), path: "p", ...DELAYS }, NONE],
    ["migrate (private)", "migrate", {}, NONE],
    ["on_derived (private)", "on_derived", {}, NONE],
    ["on_signed (private)", "on_signed", {}, NONE],
    ["on_confirmed (private)", "on_confirmed", { chain_id: 1, nonce: 0, tx_hash: "00" }, NONE],
    ["on_stuck_confirmed (private)", "on_stuck_confirmed", { chain_id: 1, nonce: 0, tx_hash: "00" }, NONE],
    ["propose_role (guardian, reserve, owner, retire)", "propose_role", { role: "Guardian", account: ID("newguardian") }, C3],
    ["propose_role (a new agent)", "propose_role", { role: "Agent", account: ID("newagent") }, ["owner"]],
    ["approve_role", "approve_role", { proposer: ID("nobody") }, C3],
    ["cancel_role", "cancel_role", { proposer: ID("nobody") }, C3],
    ["apply_role", "apply_role", { proposer: ID("nobody") }, C3],
    ["sweep", "sweep", { limit: 1 }, C3],
    ["finish_retire", "finish_retire", {}, C3],
    ["propose_upgrade", "propose_upgrade", null, ["owner"], new Uint8Array()],
    ["cancel_upgrade", "cancel_upgrade", {}, C3],
    ["apply_upgrade", "apply_upgrade", {}, ["owner"]],
    ["pause", "pause", {}, C3],
    ["unpause", "unpause", {}, C3],
    ["setup", "setup", {}, ALL],
    ["propose_rule", "propose_rule", { change: { AllowCode: { code_hash: "00" } } }, ["owner"]],
    ["cancel_rule", "cancel_rule", { id: 999 }, C3],
    ["apply_rule", "apply_rule", { id: 999 }, C3],
    ["remove_code", "remove_code", { code_hash: "00".repeat(32) }, C3],
    ["disable_chain", "disable_chain", { chain_id: 1 }, C3],
    ["remove_factory", "remove_factory", { chain_id: 1 }, C3],
    ["remove_proxy_upgrade", "remove_proxy_upgrade", { chain_id: 1, proxy_hex: a20("11"), implementation_hex: a20("22") }, C3],
    ["lower_limits", "lower_limits", { max_gas_limit: 3_000_000, max_fee_cap: 50_000_000_000 }, C3],
    ["lower_budget", "lower_budget", { chain_id: 1, max_wei_per_day: 1, max_tx_per_day: 1 }, C3],
    ["request_deploy", "request_deploy", { chain_id: 1, init_code_hex: "00", ...fee, salt_hex: null, via_factory: null }, AO],
    ["request_proxy_upgrade", "request_proxy_upgrade", { chain_id: 1, proxy_hex: a20("11"), implementation_hex: a20("22"), ...fee }, AO],
    ["resign", "resign", { chain_id: 1, nonce: 0, init_code_hex: "00", ...fee }, AO],
    ["resign_proxy_upgrade", "resign_proxy_upgrade", { chain_id: 1, nonce: 0, ...fee }, AO],
    ["retry", "retry", { max_fee_per_gas: 1, max_priority_fee_per_gas: 1 }, AO],
    ["release", "release", {}, AO],
    ["confirm", "confirm", { chain_id: 1, nonce: 0, log, finality: "Finalized" }, ALL],
    ["confirm_stuck", "confirm_stuck", { sig: { r: "00", s: "00", v: 0, gas_limit: null, max_fee_per_gas: null, max_priority_fee_per_gas: null }, log, finality: "Finalized" }, AO],
    ["revoke_agent", "revoke_agent", {}, C3],
  ];
  const wrong = [];
  for (const [label, method, args, allowed, input] of rows) {
    const cells = [];
    for (const w of who) {
      const r = await call(acc[w], MAT, method, args ?? {}, { gas: "100", input });
      const gate = !r.ok && isRole(r.msg);
      cells.push(gate ? "–" : "✓");
      if (gate === allowed.includes(w)) wrong.push(`${label} by ${w}: ${gate ? `refused (${r.msg})` : `passed (${r.ok ? "ok" : r.msg})`}`);
    }
    ev.matrix.push({ label: `\`${label}\``, cells });
  }
  const views = [["get_roles", {}], ["get_status", {}], ["get_rules", {}], ["get_budget", { chain_id: 1 }], ["get_proposed_code", {}], ["get_entry", { chain_id: 1, nonce: 0 }],
    ["get_eth_address", {}], ["get_next_nonce", { chain_id: 1 }], ["get_open", {}]];
  for (const [m, a] of views) { await view(MAT, m, a); ev.views.push(`\`${m}\``); }
  for (const m of ["preview", "preview_proxy_upgrade"]) {
    const a = m === "preview" ? { chain_id: 1, init_code_hex: "00", ...fee, salt_hex: null, via_factory: null } : { chain_id: 1, proxy_hex: a20("11"), implementation_hex: a20("22"), ...fee };
    await assert.rejects(view(MAT, m, a), /chain not allowed/);
    ev.views.push(`\`${m}\``);
  }
  assert.deepEqual(wrong, [], wrong.join("\n"));
  note(`access matrix: ${rows.length} rows x 5 accounts as real transactions, ${views.length + 2} read-only methods; every role check as designed (table above)`);
});

test("setup: the policy asks the MPC for its own key and keeps the ETH address", async () => {
  const r = await passed(call(acc.stranger, POL, "setup", {}, { gas: "100" }), "setup");
  const key = await view(ID("mpc"), "derived_public_key", { path: "keyfree-1", predecessor: POL, domain_id: 0 });
  ETH = publicKeyToAddress(`0x04${b58decode(key.slice("secp256k1:".length)).toString("hex")}`).toLowerCase();
  assert.equal(r.value, ETH);
  assert.equal(await view(POL, "get_eth_address"), ETH);
  await refused(call(acc.owner, POL, "setup", {}, { gas: "100" }), "address already set");
  note(`setup (anyone may call it): the policy derived ${ETH} for (its own account, keyfree-1); a second setup is refused`);
});

test("rules: the owner proposes, any council member applies, only after the delay; amounts stay exact", async () => {
  await refused(call(acc.agent, POL, "propose_rule", { change: { AllowCode: { code_hash: hashOf(counter(1)) } } }), "only owner");
  await refused(call(acc.guardian, POL, "propose_rule", { change: { AllowCode: { code_hash: hashOf(counter(1)) } } }), "only owner");
  await assert.rejects(call(acc.agentKey, POL, "propose_rule", { change: { AllowCode: { code_hash: hashOf(counter(1)) } } }), "the agent's key cannot even send a call outside its methods");
  const factoryInit = encodeDeployData({ abi: F.abi, bytecode: F.bytecode, args: [ETH] });
  const ids = [];
  for (const change of [
    { AllowChain: { chain_id: CHAIN, next_nonce: 0, min_fee_per_gas: FLOOR } },
    { SetLimits: { max_gas_limit: 10_000_000n, max_fee_cap: 50_000_000_000n } },
    { SetBudget: { chain_id: CHAIN, max_wei_per_day: BIG_BUDGET, max_tx_per_day: 20 } },
    { AllowCode: { code_hash: hashOf(factoryInit) } },
    { AllowCode: { code_hash: hashOf(counter(1)) } },
  ]) ids.push(await propose(change));
  await refused(call(acc.guardian, POL, "apply_rule", { id: ids[0] }), "rule delay not over");
  await refused(call(acc.stranger, POL, "apply_rule", { id: ids[0] }), "only owner, guardian or reserve");
  await applyRules(ids);
  const rules = await view(POL, "get_rules");
  assert.deepEqual(rules.allowed_code.sort(), [hashOf(factoryInit), hashOf(counter(1))].sort());
  assert.equal(rules.max_gas_limit, "10000000");
  assert.equal((await view(POL, "get_budget", { chain_id: CHAIN })).max_wei_per_day, String(BIG_BUDGET));
  assert.equal(await view(POL, "get_next_nonce", { chain_id: CHAIN }), 0);
  note(`rules: ${ids.length} proposed by the owner; refused for agent and guardian, refused before the delay, applied by the guardian after it; a budget of ${BIG_BUDGET} wei reads back exactly`);
  // A chain open without a budget signs nothing (AUDIT.md, V1): the agent's request stops before the MPC is asked.
  const OTHER = 11155111;
  const asked = await signs();
  await applyRules([await propose({ AllowChain: { chain_id: OTHER, next_nonce: 0, min_fee_per_gas: FLOOR } })]);
  const noBudget = { ...deployArgs(factoryInit, 3_000_000), chain_id: OTHER };
  await assert.rejects(view(POL, "preview", noBudget), /no daily budget on chain 11155111/);
  await refused(call(acc.agentKey, POL, "request_deploy", noBudget), "no daily budget on chain 11155111");
  assert.deepEqual(await signs(), asked, "the MPC was not asked");
  assert.equal(await view(POL, "get_next_nonce", { chain_id: OTHER }), 0);
  assert.equal(await view(POL, "get_entry", { chain_id: OTHER, nonce: 0 }), null);
  note("a chain opened without a budget: preview and the agent's request refused with no daily budget on chain 11155111; the MPC was not asked, the nonce did not move, no journal line");
});

let FACTORY;
test("plain deploy: the agent's limited key asks, the MPC signs, the transaction is the preview and recovers to the policy", async () => {
  const init = encodeDeployData({ abi: F.abi, bytecode: F.bytecode, args: [ETH] });
  const args = deployArgs(init, 3_000_000);
  const pv = await view(POL, "preview", args);
  assert.equal(pv.unsigned, serializeTransaction({ type: "eip1559", chainId: CHAIN, nonce: 0, data: init, value: 0n, gas: 3_000_000n, maxFeePerGas: BigInt(FEE), maxPriorityFeePerGas: BigInt(PRIO) }), "preview == viem");
  const r = await passed(call(acc.agentKey, POL, "request_deploy", args), "request_deploy");
  await checkRaw(r.value, pv.unsigned);
  assert.equal(await view(POL, "get_next_nonce", { chain_id: CHAIN }), 1);
  const e = await view(POL, "get_entry", { chain_id: CHAIN, nonce: 0 });
  assert.equal(e.status, "signed");
  assert.equal(e.tx_hash, keccak256(r.value));
  ev.gas.push([`request_deploy + MPC sign + on_signed (factory, plain create, ${(init.length - 2) / 2} bytes)`, r.gas]);
  FACTORY = getContractAddress({ from: ETH, nonce: 0n }).toLowerCase();
  note(`plain deploy by the agent's function-call key: signed tx == preview == viem, low s, recovers to ${ETH}; nonce 0 -> 1; journal line "signed" with the tx hash`);
});

test("factory deploy: the address is CREATE2 of the factory; Read MPC confirms, a failed confirmation changes nothing", async () => {
  await applyRules([await propose({ SetFactory: { chain_id: CHAIN, factory_hex: FACTORY } })]);
  const salt = `0x${"00".repeat(31)}01`;
  const init = counter(1);
  const args = deployArgs(init, 1_000_000, salt);
  const pv = await view(POL, "preview", args);
  assert.equal(pv.expected_address, getContractAddress({ opcode: "CREATE2", from: FACTORY, salt, bytecode: init }).toLowerCase());
  const r = await passed(call(acc.agentKey, POL, "request_deploy", args), "factory request_deploy");
  const tx = await checkRaw(r.value, pv.unsigned);
  assert.equal(tx.to.toLowerCase(), FACTORY);
  const d = decodeFunctionData({ abi: F.abi, data: tx.data });
  assert.equal(d.functionName, "deploy");
  assert.deepEqual([d.args[0], d.args[1]], [salt, init]);
  ev.gas.push(["request_deploy + MPC sign + on_signed (Counter through the factory)", r.gas]);
  await refused(call(acc.agentKey, POL, "request_deploy", deployArgs(init, 1_000_000, salt)), "salt and code already used on this chain");

  const log = { log_index: 0, transaction_index: 0, block_hash: `0x${"ab".repeat(32)}`, block_number: 1 };
  await setMode("ok", "panic");
  const no = await passed(call(acc.stranger, POL, "confirm", { chain_id: CHAIN, nonce: 1, log, finality: "Finalized" }), "confirm");
  assert.equal(no.value, false);
  assert.equal((await view(POL, "get_entry", { chain_id: CHAIN, nonce: 1 })).status, "signed");
  await refused(call(acc.stranger, POL, "confirm", { chain_id: CHAIN, nonce: 1, log, finality: "Latest" }), "Safe or Finalized");
  await setMode("ok", "ok");
  const yes = await passed(call(acc.stranger, POL, "confirm", { chain_id: CHAIN, nonce: 1, log, finality: "Finalized" }), "confirm");
  assert.equal(yes.value, true);
  assert.equal((await view(POL, "get_entry", { chain_id: CHAIN, nonce: 1 })).status, "confirmed");
  const asked = JSON.parse((await view(ID("mpc"), "get_log")).last_verify);
  assert.equal(asked.request.Base.tx_id, keccak256(r.value).slice(2), "Read MPC is asked about the very transaction the policy signed");
  assert.match(asked.expected_payload_hash, /^[0-9a-f]{64}$/);
  ev.gas.push(["confirm + Read MPC + on_confirmed", yes.gas]);
  await refused(call(acc.stranger, POL, "confirm", { chain_id: CHAIN, nonce: 1, log, finality: "Finalized" }), "not waiting for confirmation");
  note(`factory deploy: expected address == viem CREATE2, tx goes to the factory with deploy(salt, code); the same salt+code is refused a second nonce; a failed Read MPC answer leaves "signed", a good one gives "confirmed" for the tx hash the policy signed`);
});

test("the MPC failing in every way leaves the nonce bound and the contract working; retry signs the same content", async () => {
  const args = deployArgs(counter(1), 500_000);
  const pv = await view(POL, "preview", args);
  assert.equal(pv.nonce, 2);
  await setMode("panic");
  const r = await passed(call(acc.agentKey, POL, "request_deploy", args), "request_deploy with a failing MPC");
  assert.equal(r.value, null);
  assert.deepEqual(await view(POL, "get_open"), { pending: null, stuck: 2, chain_id: CHAIN });
  await refused(call(acc.agentKey, POL, "request_deploy", args), "an earlier request did not finish");
  const seen = ["panic"];
  for (const mode of ["garbage", "not_json", "huge", "other_key"]) {
    await setMode(mode);
    const t = await passed(call(acc.agentKey, POL, "retry", { max_fee_per_gas: FEE, max_priority_fee_per_gas: PRIO }), `retry (${mode})`);
    assert.equal(t.value, null, mode);
    assert.equal((await view(POL, "get_open")).stuck, 2, `${mode}: still bound to nonce 2`);
    assert.ok(t.logs.some((l) => l.includes("not signed")), `${mode}: the policy says why`);
    seen.push(mode);
  }
  await setMode("high_s");
  const ok = await passed(call(acc.agentKey, POL, "retry", { max_fee_per_gas: FEE, max_priority_fee_per_gas: PRIO }), "retry (high s)");
  await checkRaw(ok.value, pv.unsigned);
  assert.equal(await view(POL, "get_next_nonce", { chain_id: CHAIN }), 3);
  assert.deepEqual(await view(POL, "get_open"), { pending: null, stuck: null, chain_id: null });
  await setMode("ok");
  note(`MPC answers ${seen.join(", ")} (a failure, garbage, not JSON, 20 KB, another key's signature): no callback panicked, nonce 2 stayed bound to the same deploy, a new request was refused meanwhile; a high-s answer is flipped and the retry signs exactly the previewed deploy`);
});

test("proxy upgrade: one allowed upgradeTo, built by the policy, used up by the request", async () => {
  const proxy = `0x${"11".repeat(20)}`, impl = `0x${"22".repeat(20)}`;
  await applyRules([await propose({ AllowProxyUpgrade: { chain_id: CHAIN, proxy_hex: proxy, implementation_hex: impl } })]);
  const args = { chain_id: CHAIN, proxy_hex: proxy, implementation_hex: impl, gas_limit: 100_000, max_fee_per_gas: FEE, max_priority_fee_per_gas: PRIO };
  const pv = await view(POL, "preview_proxy_upgrade", args);
  const r = await passed(call(acc.agentKey, POL, "request_proxy_upgrade", args), "request_proxy_upgrade");
  const tx = await checkRaw(r.value, pv.unsigned);
  assert.equal(tx.to.toLowerCase(), proxy);
  assert.equal(tx.data, encodeFunctionData({ abi: parseAbi(["function upgradeTo(address)"]), functionName: "upgradeTo", args: [impl] }));
  assert.equal((await view(POL, "get_entry", { chain_id: CHAIN, nonce: 3 })).kind, "proxy_upgrade");
  await refused(call(acc.agentKey, POL, "request_proxy_upgrade", args), "proxy upgrade not on the allow list");
  note("proxy upgrade: the signed tx is upgradeTo(implementation) to the allowed proxy, nonce 3; the same upgrade is refused a second time");
});

test("roles: any council member revokes the agent at once; a new agent works only after the delay", async () => {
  await passed(call(acc.reserve, POL, "revoke_agent"), "revoke_agent");
  const args = deployArgs(counter(1), 1_000_000, `0x${"00".repeat(31)}02`);
  await refused(call(acc.agentKey, POL, "request_deploy", args), "only agent or owner");
  await refused(call(acc.guardian, POL, "propose_role", { role: "Agent", account: ID("newagent") }), "only owner proposes a new agent");
  await passed(call(acc.owner, POL, "propose_role", { role: "Agent", account: ID("newagent") }), "propose new agent");
  await refused(call(acc.guardian, POL, "apply_role", { proposer: ID("owner") }), "role change delay not over");
  const ready = Number((await view(POL, "get_roles")).role_changes[0].ready_at);
  await untilChain(ready);
  await passed(call(acc.guardian, POL, "apply_role", { proposer: ID("owner") }), "apply new agent");
  assert.equal((await view(POL, "get_roles")).agent, ID("newagent"));
  const pv = await view(POL, "preview", args);
  const r = await passed(call(acc.newagent, POL, "request_deploy", args), "new agent request");
  await checkRaw(r.value, pv.unsigned);
  await refused(call(acc.agent, POL, "request_deploy", deployArgs(counter(1), 1_000_000, `0x${"00".repeat(31)}03`)), "only agent or owner");
  note(`roles: revoked by the reserve at once; a new agent proposed by the owner (the guardian may not), refused before the ${DELAYS.upgrade_delay_sec} s delay, applied after it; the new agent signs (nonce 4), the old one is refused`);
});

test("budget: every signature counts, failed ones and retries too; a council member lowers it at once", async () => {
  const b = await view(POL, "get_budget", { chain_id: CHAIN });
  // factory 1 + Counter via factory 1 + request and 5 retries 6 + proxy upgrade 1 + new agent 1
  assert.equal(b.used_tx_today, 10);
  assert.equal(b.used_wei_today, String((3_000_000n + 1_000_000n + 6n * 500_000n + 100_000n + 1_000_000n) * BigInt(FEE)));
  await refused(call(acc.stranger, POL, "lower_budget", { chain_id: CHAIN, max_wei_per_day: 1, max_tx_per_day: 1 }), "only owner, guardian or reserve");
  await refused(call(acc.reserve, POL, "lower_budget", { chain_id: CHAIN, max_wei_per_day: BIG_BUDGET + 1n, max_tx_per_day: 10 }), "raising a budget is a rule proposal");
  await passed(call(acc.reserve, POL, "lower_budget", { chain_id: CHAIN, max_wei_per_day: BIG_BUDGET, max_tx_per_day: 10 }), "lower_budget");
  const args = deployArgs(counter(1), 1_000_000, `0x${"00".repeat(31)}04`);
  await assert.rejects(view(POL, "preview", args), /daily limit on chain 84532: 10 transactions today/);
  await refused(call(acc.newagent, POL, "request_deploy", args), "daily limit on chain 84532");
  note(`budget: 10 signatures counted today (failed attempts and retries included) with ${b.used_wei_today} wei of worst-case gas; the reserve lowered the limit to 10 at once and the 11th was refused, in preview too; raising it at once was refused`);
});

test("upgrade: a failing migrate leaves the old code and the proposal; the same code upgrades without a key", async () => {
  const deposit = (n) => BigInt(n + 2_000) * 10n ** 19n;
  await refused(call(acc.guardian, POL, "propose_upgrade", null, { input: MOCK, deposit: deposit(MOCK.length) }), "only owner");
  await refused(call(acc.owner, POL, "propose_upgrade", null, { input: MOCK, deposit: 1n }), "for the code storage");
  const p1 = await passed(call(acc.owner, POL, "propose_upgrade", null, { input: MOCK, deposit: deposit(MOCK.length) }), "propose mock");
  let st = await view(POL, "get_status");
  assert.equal(st.proposed[0], sha256(MOCK).toString("hex"));
  await refused(call(acc.owner, POL, "apply_upgrade"), "upgrade delay not over");
  await untilChain(Number(st.proposed[1]));
  const bad = await call(acc.owner, POL, "apply_upgrade");
  assert.equal(bad.ok, false, "a wasm without migrate cannot be applied");
  assert.equal((await provider.viewAccount({ accountId: POL })).code_hash, b58encode(sha256(POLICY)), "the old code is still there");
  st = await view(POL, "get_status");
  assert.equal(st.version, 1);
  assert.equal(st.proposed[0], sha256(MOCK).toString("hex"), "the proposal is still there");
  await passed(call(acc.guardian, POL, "cancel_upgrade"), "cancel_upgrade");
  assert.equal(await view(POL, "get_proposed_code"), null);

  const p2 = await passed(call(acc.owner, POL, "propose_upgrade", null, { input: POLICY, deposit: deposit(POLICY.length) }), "propose policy");
  await untilChain(Number((await view(POL, "get_status")).proposed[1]));
  const good = await passed(call(acc.owner, POL, "apply_upgrade"), "apply_upgrade");
  st = await view(POL, "get_status");
  assert.equal(st.version, 2);
  assert.equal(st.proposed, null);
  assert.equal(await view(POL, "get_proposed_code"), null);
  assert.equal((await view(POL, "get_entry", { chain_id: CHAIN, nonce: 1 })).status, "confirmed", "the journal survived");
  assert.equal((await view(POL, "get_rules")).allowed_code.length, 2, "the rules survived");
  assert.equal((await provider.viewAccessKeyList({ accountId: POL })).keys.length, 0);
  ev.gas.push([`propose_upgrade (${POLICY.length} bytes as the call input)`, p2.gas], ["apply_upgrade (deploy itself + migrate, one batch)", good.gas], ["propose_upgrade of the stand-in", p1.gas]);
  note(`upgrade: a wasm without migrate was proposed and applied after the delay: the batch failed, the old code (same hash) and the proposal stayed (N17); a guardian cancelled it; the policy's own wasm then upgraded it with no key: version 2, journal and rules kept, still 0 keys`);
});

test("retirement: 2 of 3 and the full delay; the state is swept, the free NEAR goes to the beneficiary, the account stays keyless", async () => {
  await refused(call(acc.guardian, POL, "propose_role", { role: "Retire", account: ID("stranger") }), "the beneficiary must be a council member");
  await passed(call(acc.guardian, POL, "propose_role", { role: "Retire", account: ID("guardian") }), "propose retire");
  await refused(call(acc.reserve, POL, "apply_role", { proposer: ID("guardian") }), "needs 2 of 3 approvals");
  await passed(call(acc.owner, POL, "approve_role", { proposer: ID("guardian") }), "approve retire");
  await refused(call(acc.reserve, POL, "apply_role", { proposer: ID("guardian") }), "role change delay not over");
  await untilChain(Number((await view(POL, "get_roles")).role_changes[0].ready_at));
  await passed(call(acc.reserve, POL, "apply_role", { proposer: ID("guardian") }), "apply retire");
  assert.equal((await view(POL, "get_roles")).retiring, ID("guardian"));
  await refused(call(acc.newagent, POL, "request_deploy", deployArgs(counter(1), 1_000_000, `0x${"00".repeat(31)}05`)), "paused");
  await refused(call(acc.owner, POL, "propose_rule", { change: { AllowCode: { code_hash: hashOf(counter(2)) } } }), "the policy is retiring");
  await refused(call(acc.owner, POL, "finish_retire"), "sweep first");
  let left = -1;
  for (let i = 0; i < 20 && left !== 0; i++) left = (await passed(call(acc.owner, POL, "sweep", { limit: 20 }), "sweep")).value;
  assert.equal(left, 0);
  const before = BigInt((await provider.viewAccount({ accountId: ID("guardian") })).amount);
  const fin = await passed(call(acc.reserve, POL, "finish_retire"), "finish_retire");
  const after = BigInt((await provider.viewAccount({ accountId: ID("guardian") })).amount);
  assert.ok(after > before, "the beneficiary received the free NEAR");
  assert.equal((await provider.viewAccessKeyList({ accountId: POL })).keys.length, 0, "the account stays, keyless");
  assert.equal((await provider.viewAccount({ accountId: POL })).code_hash, b58encode(sha256(POLICY)));
  ev.gas.push(["finish_retire (transfer of the free NEAR)", fin.gas]);
  note(`retirement: beneficiary must be a council member; 1 of 3 refused, applied after the delay with 2 of 3; then requests and rules are refused, the state swept to 0, ${((after - before) / 10n ** 21n).toString()} milliNEAR went to the guardian, the account stays with its code and 0 keys`);
});

// Faults (P5), each on a policy of its own.
// A request whose execution has to wait: sent, and its outcome read later by hash.
async function sendLater(from, contract, method, args) {
  const signed = await from.createSignedTransaction({ receiverId: contract, actions: [actions.functionCall(method, exact(args), teraToGas("300"), 0n)] });
  const txHash = b58encode(sha256(signed.transaction.encode()));
  await provider.sendTransactionUntil(signed, "INCLUDED");
  return async () => outcome(await provider.viewTransactionStatus({ txHash, accountId: from.accountId, waitUntil: "EXECUTED_OPTIMISTIC" }));
}

test("faults: a late MPC answer; meanwhile nothing else is signed, and a pause stops new requests but not the one at the MPC", async () => {
  const P = await install("late");
  const eth = await prepare(P, [counter(1), counter(2)]);
  await setMode("hang");
  const args = deployArgs(counter(1), 500_000);
  const pv = await view(P, "preview", args);
  const result = await sendLater(acc.agent, P, "request_deploy", args);
  await until("the request to reach the MPC", async () => (await view(P, "get_open")).pending === 0, 60);
  await refused(call(acc.owner, P, "request_deploy", deployArgs(counter(2), 500_000)), "another request is being signed");
  await refused(call(acc.agent, P, "release"), "still waiting for the MPC");
  await passed(call(acc.guardian, P, "pause"), "pause");
  assert.equal((await passed(call(acc.stranger, ID("mpc"), "resume_sign"), "the MPC answers")).value, true);
  const r = await result();
  assert.ok(r.ok, r.msg);
  await checkRaw(r.value, pv.unsigned, eth);
  assert.deepEqual(await view(P, "get_open"), { pending: null, stuck: null, chain_id: null });
  assert.equal(await view(P, "get_next_nonce", { chain_id: CHAIN }), 1);
  await refused(call(acc.agent, P, "request_deploy", deployArgs(counter(2), 500_000)), "paused");
  await setMode("ok");
  note("late MPC answer (yield and resume, like the real contract): while it waited, another request and release were refused; a pause in between stopped new requests, and the answer that came after the pause still gave the previewed transaction, nonce 0 -> 1");
});

test("faults: no MPC answer at all; the runtime's timeout parks the request on its nonce, retry signs the same content", async () => {
  const P = await install("silent");
  const eth = await prepare(P, [counter(1)]);
  await setMode("hang");
  const args = deployArgs(counter(1), 500_000);
  const pv = await view(P, "preview", args);
  const result = await sendLater(acc.agent, P, "request_deploy", args);
  await until("the request to reach the MPC", async () => (await view(P, "get_open")).pending === 0, 60);
  const ff = await rpc("sandbox_fast_forward", { delta_height: 260 });
  // After 250 blocks the agent may also release it by hand; whichever comes first parks it, the other changes nothing.
  const rel = await call(acc.agent, P, "release");
  await until("the request to be parked", async () => (await view(P, "get_open")).pending === null, 400);
  assert.equal((await view(P, "get_open")).stuck, 0);
  // The request's own outcome: its callback ran with the timeout, or found nothing pending after release.
  const r = await result().catch(() => null);
  if (r) assert.equal(r.value ?? null, null, "no signature came out");
  assert.equal(await view(P, "get_next_nonce", { chain_id: CHAIN }), 0, "the nonce did not move");
  await refused(call(acc.agent, P, "request_deploy", args), "an earlier request did not finish");
  await setMode("ok");
  const t = await passed(call(acc.agent, P, "retry", { max_fee_per_gas: FEE, max_priority_fee_per_gas: PRIO }), "retry");
  await checkRaw(t.value, pv.unsigned, eth);
  assert.equal(await view(P, "get_next_nonce", { chain_id: CHAIN }), 1);
  note(`no MPC answer: ${ff.error ? "without fast-forward, " : "after a 260-block fast-forward, "}the request was parked on nonce 0 by ${rel.ok ? "release" : "the runtime's yield timeout"} (no signature, nonce unmoved), a new request was refused, and retry then signed exactly the previewed deploy`);
});

test("faults: two requests in the same moment never get one nonce twice", async () => {
  const P = await install("race");
  const eth = await prepare(P, [counter(1), counter(2)]);
  await setMode("ok");
  const asks = [[acc.agent, counter(1)], [acc.owner, counter(2)]];
  const pvs = await Promise.all(asks.map(([, code]) => view(P, "preview", deployArgs(code, 500_000))));
  const rs = await Promise.all(asks.map(([who, code]) => call(who, P, "request_deploy", deployArgs(code, 500_000))));
  const raws = rs.filter((r) => r.ok && r.value).map((r) => r.value);
  for (const r of rs.filter((x) => !(x.ok && x.value))) assert.ok(r.msg?.includes("another request is being signed"), r.msg ?? "a request returned nothing");
  assert.ok(raws.length >= 1);
  const nonces = raws.map((raw) => parseTransaction(raw).nonce);
  assert.equal(new Set(nonces).size, nonces.length, "distinct nonces");
  for (const raw of raws) assert.equal((await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase(), eth);
  assert.equal(await view(P, "get_next_nonce", { chain_id: CHAIN }), raws.length);
  assert.ok(pvs.every((p) => p.nonce === 0));
  note(`two requests sent at once (agent and owner): ${raws.length} signed with nonces ${nonces.join(", ")}, ${rs.length - raws.length} refused as "another request is being signed"; never one nonce twice`);
});

test("faults: a policy short of NEAR for its storage refuses the request before the MPC is asked; a top-up from anyone fixes it", async () => {
  const blob = toHexBytes(49_152, (i) => (i * 7 + 3) & 0xff);
  // Enough for the code and some state at 10^-5 NEAR a byte (0.1 NEAR = 10 000 bytes), far short of the
  // 0.49 NEAR the blob needs. 0.06 was too close: v19's wasm, 634 bytes larger, rounded below the install.
  const lean = Math.ceil((POLICY.length / 1e5 + 0.1) * 100) / 100;
  const P = await install("lean", lean);
  const eth = await prepare(P, [blob]);
  await assert.rejects(view(P, "preview", deployArgs(`${blob}00`, 3_000_000)), /init code too large/);
  const args = deployArgs(blob, 3_000_000);
  const pv = await view(P, "preview", args);
  const [n0, s0] = [await view(P, "get_next_nonce", { chain_id: CHAIN }), await signs()];
  const short = await call(acc.agent, P, "request_deploy", args);
  assert.equal(short.ok, false);
  assert.match(short.fail, /LackBalanceForState/);
  assert.deepEqual(await view(P, "get_open"), { pending: null, stuck: null, chain_id: null });
  assert.equal(await view(P, "get_next_nonce", { chain_id: CHAIN }), n0);
  assert.equal(await signs(), s0, "the MPC was never asked");
  await passed(send(acc.stranger, P, [actions.transfer(yocto(1))]), "top-up");
  const r = await passed(call(acc.agent, P, "request_deploy", args), "request after the top-up");
  await checkRaw(r.value, pv.unsigned, eth);
  ev.gas.push(["request_deploy + MPC sign + on_signed (the largest allowed code, 49 152 bytes)", r.gas]);
  note(`storage: a policy with ${lean} NEAR could not store a 49 152-byte request (LackBalanceForState): nothing changed and the MPC was never asked; 1 NEAR sent by a stranger, and the same request was signed (${tgas(r.gas)} Tgas); 49 153 bytes is refused`);
});

test("the tool on the real contract: no MPC answer, a failed broadcast, a lost upgrade; retry recovers each with the same content", async () => {
  const { fakeEvm } = await import("../packages/keyfree/test/fake_chains.mjs");
  const CLI = fileURLToPath(new URL("../packages/keyfree/dist/cli.js", import.meta.url));
  const ARTIFACT = fileURLToPath(new URL("../packages/keyfree/demo/out/Counter.sol/Counter.json", import.meta.url));
  const FACTORY_ADDR = "0x4b78615d2ab691cf8e05fe0b7fca7ecb8c063e2f";
  const PROXY = "0x2222222222222222222222222222222222222222";
  const IMPL = "0x3333333333333333333333333333333333333333";
  const P = await install("toolrun");
  const eth = await prepare(P, [counter(1), counter(2)]);
  await applyRules([
    await propose({ SetFactory: { chain_id: CHAIN, factory_hex: FACTORY_ADDR } }, P),
    await propose({ AllowProxyUpgrade: { chain_id: CHAIN, proxy_hex: PROXY, implementation_hex: IMPL } }, P),
  ], acc.guardian, P);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyfree-tool-"));
  const fc = KeyPair.fromRandom("ed25519");
  await passed(send(acc.agent, ID("agent"), [actions.addFunctionCallAccessKey(fc.getPublicKey(), P, AGENT_METHODS)]), "the agent's key for this policy");
  const keyFile = path.join(dir, "agent_key.json");
  fs.writeFileSync(keyFile, JSON.stringify({ private_key: fc.toString() }));
  const evm = await fakeEvm({ factory: FACTORY_ADDR, proxy: PROXY, signer: eth });
  evm.st.code.set(IMPL, "0x60");
  const config = path.join(dir, "keyfree.json");
  fs.writeFileSync(config, JSON.stringify({
    near_network: "testnet", near_rpc: sandbox.rpcUrl, near_explorer: "https://near.example", policy: P, agent: ID("agent"), owner: ID("owner"), receipt_timeout_ms: 5000,
    chains: [{ name: "base-sepolia", chain_id: CHAIN, rpc: evm.url, explorer: "https://evm.example" }],
  }));
  const tool = (...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args, "--config", config], { env: { ...process.env, HOME: dir, KEYFREE_AGENT_KEY: keyFile } });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, out, err, json: () => JSON.parse(out) }));
  });
  const CH = ["--chain", "base-sepolia"];
  const code = (n) => ["--artifact", ARTIFACT, "--args", `[${n}]`];
  try {
    // 1) the MPC never answers: the deploy waits, retry says so, and after the timeout it releases and re-signs.
    await setMode("hang");
    const stalled = tool("deploy", ...CH, ...code(1));
    await until("the request to reach the MPC", async () => (await view(P, "get_open")).pending === 0, 60);
    let r = await tool("retry", ...CH);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /still being signed/);
    await rpc("sandbox_fast_forward", { delta_height: 260 });
    await setMode("ok");
    // Fees under the chain's floor on the way: the contract names the floor and the tool asks once more.
    evm.st.prio = 1n;
    evm.st.baseFee = 1n;
    r = await tool("retry", ...CH);
    assert.equal(r.code, 0, r.err);
    const first = r.json();
    assert.equal(first.nonce, 0);
    assert.equal(evm.st.count, 1);
    assert.equal((await tool("journal", ...CH)).json().lines[0].address, first.address);
    assert.equal((await stalled).code, 1);
    evm.st.prio = 1_000_000n;
    evm.st.baseFee = 1_000_000n;

    // 2) signed, then the node refuses the broadcast: a new deploy is stopped, retry takes only the same code.
    evm.st.faults.eth_sendRawTransaction = 500;
    r = await tool("deploy", ...CH, ...code(2));
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /Signed, but not on chain/);
    delete evm.st.faults.eth_sendRawTransaction;
    assert.equal(await view(P, "get_next_nonce", { chain_id: CHAIN }), 2);
    const line = await view(P, "get_entry", { chain_id: CHAIN, nonce: 1 });
    assert.equal(line.status, "signed");
    const signsBefore = await signs();
    r = await tool("deploy", ...CH, ...code(1));
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /Nonce 1 .*retry/);
    r = await tool("retry", ...CH, ...code(1));
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /differs from line 1/);
    assert.equal(await signs(), signsBefore, "no signature was spent on the refused attempts");
    r = await tool("retry", ...CH, ...code(2));
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().nonce, 1);
    assert.equal(r.json().address, line.address);
    assert.equal(evm.st.count, 2);

    // 3) the same for a proxy upgrade: the contract's resign_proxy_upgrade, no code needed.
    evm.st.faults.eth_sendRawTransaction = "down";
    r = await tool("upgrade", ...CH, "--proxy", PROXY, "--implementation", IMPL);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /Signed, but not on chain/);
    delete evm.st.faults.eth_sendRawTransaction;
    r = await tool("retry", ...CH);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().nonce, 2);
    assert.equal(evm.st.impl.toLowerCase(), IMPL);
    r = await tool("retry", ...CH);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /Nothing is stuck/);
    note(`the real tool on this contract, with a local EVM node failing on purpose: no MPC answer (retry waits, then releases and re-signs, the contract naming its fee floor on the way); a refused broadcast of a deploy (a new deploy stopped, other code refused with no signature spent, resign lands the promised ${line.address}); the same for a proxy upgrade (resign_proxy_upgrade). All on the same nonces.`);
  } finally {
    await evm.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
