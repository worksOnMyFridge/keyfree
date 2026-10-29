// Keyfree v13 end to end on NEAR testnet + Base Sepolia. One stage per call, results appended to
// evidence/v13.log, progress kept in evidence/v13_state.json.
//   node v13/run.mjs plan       offline: config, wasm builds, what each stage will do
//   node v13/run.mjs check      read-only: accounts, balances, keys (no transactions)
//   accounts   create policy (temporary key), agent (function-call key only), guardian, reserve, guardian2
//   install    deploy v13 "a" + new + delete the policy key in ONE transaction -> 0 keys; derive the ETH address;
//              propose the rules (factory, test codes, Base Sepolia, caps), wait rules_delay_sec, apply them
//   agent <id> rotate the agent: new account with a function-call key, owner proposal, delay, apply
//   fund       wait until the derived ETH address has Base Sepolia ETH
//   factory    keyless deploy of KeyfreeFactory, then the SetFactory rule through the delay
//   deploy     keyless deploys through the factory: 22 B, 1 KB, 24 KB, 48 KB init code; bytes == viem
//   confirm    wait for a Safe block, confirm the last deploy by Read MPC; a forged position must fail
//   attacks    live refusals: each must fail with its reason (or by the protocol for the agent's key)
//   roles      replace the guardian: 2 of 3 + delay; one cancel is not enough; the old guardian is out
//   upgrade    propose build "b" as bytes, guardian checks sha256, cancel, again, wait, apply -> version 2
//   retire     Role::Retire, sweep, finish_retire: the account is deleted and its NEAR goes to the owner
// Signers per role (config.signers): "credentials" (~/.near-credentials), "local" (v13/<role>_key.json,
// gitignored), "external" (the key is on another device: the script prints the near CLI command and waits).
import fs from "node:fs";
import crypto from "node:crypto";
import { keccak256, toHex, getContractAddress, createPublicClient, http, baseSepolia, formatEther,
  encodeFunctionData, encodeDeployData, serializeTransaction, decodeEventLog } from "../../tools/evm.mjs";
import { loadAccount, provider, explorer, view, KeyPair, teraToGas, parseNearAmount, Account, actions } from "../../tools/near.mjs";

const here = (f) => new URL(`./${f}`, import.meta.url);
const top = (f) => new URL(`../${f}`, import.meta.url);
const CFG = JSON.parse(fs.readFileSync(fs.existsSync(here("config.json")) ? here("config.json") : here("config.example.json")));
const P = CFG.policy, CHAIN = CFG.chain_id;
const F = JSON.parse(fs.readFileSync(top("factory/factory.json")));
const WASM = { a: here("keyfree_v13a.opt.wasm"), b: here("keyfree_v13b.opt.wasm") };
const AGENT_METHODS = ["request_deploy", "resign", "retry", "release", "confirm", "confirm_stuck"];
const TINY = "0x600a600c600039600a6000f3602a60005260206000f3";
const scan = (h) => `https://sepolia.basescan.org/tx/${h}`;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
// Calls return at EXECUTED_OPTIMISTIC, views read the final block (1-2 blocks behind): wait before reading
// back what a call just changed (a check right after cancel_upgrade read the old state on 29.10).
const settle = () => wait(3);

const stateFile = top("evidence/v13_state.json");
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : {};
const keep = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
const log = [];
let oks = 0, fails = 0;
const say = (s) => { console.log(s); log.push(s); };
const check = (ok, s) => { ok ? oks++ : fails++; say(`${ok ? "OK  " : "FAIL"} ${s}`); };
const save = () => fs.appendFileSync(top("evidence/v13.log"), `--- ${new Date().toISOString()} ${process.argv.slice(2).join(" ")} (${oks} ok, ${fails} fail)\n${log.join("\n")}\n`);

// ---- accounts and signing ----
const ROLE_ID = { owner: CFG.lab, agent: CFG.agent, guardian: CFG.guardian, reserve: CFG.reserve, guardian2: CFG.guardian2 };
const keyFile = (role) => here(`${role}_key.json`); // never printed, *_key.json is gitignored
function signer(role) {
  const id = ROLE_ID[role] ?? role, how = CFG.signers[role] ?? "local";
  if (how === "credentials") return { id, acc: loadAccount(id) };
  if (how === "local") return { id, acc: new Account(id, provider, JSON.parse(fs.readFileSync(keyFile(role))).private_key) };
  return { id, acc: null };
}
const result = (out) => JSON.parse(Buffer.from(out.status.SuccessValue ?? "", "base64").toString() || "null");
const kfLogs = (out) => { for (const r of out.receipts_outcome) for (const l of r.outcome.logs) if (l.startsWith("keyfree")) say(`  log: ${l}`); };

// Call the policy as a role. An external role prints the command and waits until `until()` is true.
async function act(role, methodName, args, { gas = "30", deposit = 0n, until } = {}) {
  const s = signer(role);
  if (s.acc) { const out = await s.acc.callFunctionRaw({ contractId: P, methodName, args, gas: teraToGas(gas), deposit }); kfLogs(out); return out; }
  say(`EXTERNAL ${role} (${s.id}) signs on its own device:\n  near contract call-function as-transaction ${P} ${methodName} json-args '${JSON.stringify(args)}' prepaid-gas '${gas} Tgas' attached-deposit '${deposit} yoctoNEAR' sign-as ${s.id} network-config testnet sign-with-keychain send`);
  if (!until) throw new Error(`${role} is external and this step has no check to wait for`);
  for (let i = 0; i < 180; i++) { if (await until()) { say(`  done by ${role}`); return null; } await wait(10); }
  throw new Error(`timed out waiting for ${role}`);
}
// `reason` is one text or a list of texts, any of which counts (protocol errors are worded by the library).
async function refused(name, fn, reason) {
  const reasons = [reason].flat();
  try { await fn(); check(false, `${name}: was allowed`); }
  catch (e) { const m = String(e.message || e).replace(/\s+/g, " "); check(reasons.some((r) => m.includes(r)), `${name} -> ${m.slice(0, 160)}`); }
}
const exists = (accountId) => provider.viewAccount({ accountId }).then(() => true, () => false);
const keysOf = async (accountId) => (await provider.viewAccessKeyList({ accountId })).keys;
const untilTime = async (unix, what) => { const s = Math.max(0, unix - Date.now() / 1000) + 5; say(`waiting ${Math.ceil(s)} s for ${what}`); await wait(s); };

// ---- EVM side ----
const base = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
// Init code that returns `runtimeLen` bytes of runtime, padded to `totalLen` (first runtime byte 0x60, never 0xEF).
function initFor(runtimeLen, totalLen = 0) {
  const prefix = [0x61, runtimeLen >> 8, runtimeLen & 0xff, 0x80, 0x60, 0x0c, 0x60, 0x00, 0x39, 0x60, 0x00, 0xf3];
  const runtime = Array.from({ length: runtimeLen }, (_, i) => (i === 0 ? 0x60 : (i * 7 + 3) & 0xff));
  const pad = Array(Math.max(0, totalLen - prefix.length - runtimeLen)).fill(0);
  return toHex(Uint8Array.from([...prefix, ...runtime, ...pad]));
}
const CASES = [
  { name: "tiny 22 B", init: TINY, runtime: 10 },
  { name: "1 KB", init: initFor(1000), runtime: 1000 },
  { name: "24 KB", init: initFor(24000), runtime: 24000 },
  { name: "48 KB", init: initFor(24576, 49152), runtime: 24576 },
];

// The address must hold gas_limit x max fee up front. KF_FEE_X=1 signs at viem's estimate (it already has
// headroom over the base fee) when the faucet (once a day) left little ETH; the default keeps x2.
const FEE_X = BigInt(process.env.KF_FEE_X || 2);
async function fees() {
  const f = await base.estimateFeesPerGas();
  const max = f.maxFeePerGas * FEE_X > BigInt(CFG.fee_floor_wei) ? f.maxFeePerGas * FEE_X : BigInt(CFG.fee_floor_wei);
  return { max_fee_per_gas: Number(max), max_priority_fee_per_gas: Number(f.maxPriorityFeePerGas < max ? f.maxPriorityFeePerGas : max) };
}

// Ask the policy to sign a deploy, compare its bytes with viem, broadcast, wait for the receipt.
async function agentDeploy(label, init, { salt = null, gasExtra = 100_000 } = {}) {
  const f = await fees();
  const ask = { chain_id: CHAIN, init_code_hex: init, gas_limit: 0, ...f, salt_hex: salt, via_factory: salt ? true : null };
  const probe = await view(P, "preview", { ...ask, gas_limit: CFG.max_gas_limit });
  const args = { ...ask, gas_limit: Math.min(CFG.max_gas_limit, probe.min_gas + gasExtra) };
  const pv = await view(P, "preview", args);
  const data = salt ? encodeFunctionData({ abi: F.abi, functionName: "deploy", args: [salt, init] }) : init;
  const mine = serializeTransaction({ type: "eip1559", chainId: CHAIN, nonce: pv.nonce, to: salt ? state.factory : undefined, data, value: 0n,
    gas: BigInt(args.gas_limit), maxFeePerGas: BigInt(args.max_fee_per_gas), maxPriorityFeePerGas: BigInt(args.max_priority_fee_per_gas) });
  check(pv.unsigned === mine, `${label}: unsigned tx built by the contract == viem (${(mine.length - 2) / 2} bytes, nonce ${pv.nonce})`);
  if (salt) {
    const predicted = getContractAddress({ opcode: "CREATE2", from: state.factory, salt, bytecode: init }).toLowerCase();
    check(pv.expected_address === predicted, `${label}: promised address ${pv.expected_address} == viem CREATE2`);
  }
  const t0 = Date.now();
  const out = await act("agent", "request_deploy", args, { gas: "250" });
  const raw = result(out);
  if (!raw) { check(false, `${label}: not signed ${JSON.stringify(await view(P, "get_open"))}`); return null; }
  const hash = await base.sendRawTransaction({ serializedTransaction: raw });
  const rc = await base.waitForTransactionReceipt({ hash, timeout: 180_000 });
  check(rc.status === "success", `${label}: signed in ${((Date.now() - t0) / 1000).toFixed(1)} s, gas ${rc.gasUsed} of ${args.gas_limit}  ${explorer(out.transaction.hash)}  ${scan(hash)}`);
  return { rc, nonce: pv.nonce, expected: pv.expected_address };
}

// Rules go through the delay: propose all, wait once, apply all.
async function rules(changes) {
  const ids = [];
  for (const change of changes) ids.push(result(await act("owner", "propose_rule", { change })));
  say(`proposed rules ${ids.join(", ")}: ${changes.map((c) => Object.keys(c)[0]).join(", ")}`);
  // Any council member may apply; the owner does it here, so an external guardian is never needed for rules.
  await refused("apply a rule before the delay", () => act("owner", "apply_rule", { id: ids[0] }), "rule delay not over");
  await untilTime(Date.now() / 1000 + CFG.rules_delay_sec, "the rules delay");
  for (const id of ids) await act("owner", "apply_rule", { id });
  say(`applied rules ${ids.join(", ")}`);
}

const stage = process.argv[2];
try {
  if (stage === "plan") {
    say(`config: ${fs.existsSync(here("config.json")) ? "v13/config.json" : "v13/config.example.json"}`);
    for (const [r, id] of Object.entries(ROLE_ID)) say(`  ${r.padEnd(9)} ${id}  signer: ${CFG.signers[r]}`);
    say(`  policy    ${P}  delays: upgrade/roles ${CFG.upgrade_delay_sec} s, rules ${CFG.rules_delay_sec} s`);
    for (const [b, f] of Object.entries(WASM)) {
      if (!fs.existsSync(f)) { say(`  build ${b}: missing, run v13/build_wasm.ps1`); continue; }
      const w = fs.readFileSync(f);
      say(`  build ${b}: ${w.length} bytes, sha256 ${sha(w)}, code storage ~${(w.length / 1e5).toFixed(1)} NEAR`);
    }
    for (const c of CASES) say(`  case ${c.name.padEnd(9)} init ${(c.init.length - 2) / 2} bytes, runtime ${c.runtime}, code hash ${keccak256(c.init).slice(2, 14)}...`);
    say("stages: check, accounts, install, fund, factory, deploy, confirm, attacks, roles, upgrade, retire");
  } else if (stage === "check") {
    for (const [r, id] of Object.entries({ ...ROLE_ID, policy: P })) {
      if (!(await exists(id))) { say(`  ${r.padEnd(9)} ${id}: does not exist`); continue; }
      const a = await provider.viewAccount({ accountId: id });
      const ks = await keysOf(id);
      say(`  ${r.padEnd(9)} ${id}: ${(Number(BigInt(a.amount) / 10n ** 20n) / 1e4).toFixed(2)} NEAR, keys: ${ks.map((k) => (k.access_key.permission === "FullAccess" ? "full" : `fc(${k.access_key.permission.FunctionCall.method_names.length} methods)`)).join(", ") || "none"}`);
    }
    if (state.address) say(`  ETH ${state.address}: ${formatEther(await base.getBalance({ address: state.address }))} on Base Sepolia`);
  } else if (stage === "accounts") {
    const owner = signer("owner").acc;
    const make = async (role, id, near, keyAction) => {
      if (await exists(id)) { say(`  ${id} exists`); return; }
      const kp = KeyPair.fromRandom("ed25519");
      fs.writeFileSync(keyFile(role), JSON.stringify({ private_key: kp.toString() }));
      const o = await owner.signAndSendTransaction({ receiverId: id, actions: [actions.createAccount(), actions.transfer(BigInt(parseNearAmount(near))), keyAction(kp.getPublicKey())] });
      say(`  created ${id} (${near} NEAR) ${explorer(o.transaction.hash)}`);
    };
    // The policy gets a temporary key only to install itself; install deletes it in the same transaction.
    await make("policy", P, "9", (pk) => actions.addFullAccessKey(pk));
    // The agent never has a full key: only these methods on the policy (R4). No allowance: NEAR charges the
    // full prepaid gas against it on every call (250 Tgas ~ 0.25 NEAR), so a small allowance blocks the
    // first request (seen on testnet 29.10); the account's own balance is the real cap.
    await make("agent", CFG.agent, "2", (pk) => actions.addFunctionCallAccessKey(pk, P, AGENT_METHODS));
    for (const r of ["guardian", "reserve", "guardian2"]) if (CFG.signers[r] === "local") await make(r, ROLE_ID[r], "0.3", (pk) => actions.addFullAccessKey(pk));
    const ak = await keysOf(CFG.agent);
    check(ak.length === 1 && ak[0].access_key.permission !== "FullAccess", `agent ${CFG.agent} holds only a function-call key: ${JSON.stringify(ak[0]?.access_key.permission?.FunctionCall?.method_names)}`);
  } else if (stage === "install") {
    const code = fs.readFileSync(WASM.a);
    const policyKey = JSON.parse(fs.readFileSync(keyFile("policy"))).private_key;
    const pa = new Account(P, provider, policyKey);
    const d = await pa.signAndSendTransaction({ receiverId: P, actions: [
      actions.deployContract(code),
      actions.functionCall("new", { owner: CFG.lab, agent: CFG.agent, guardian: CFG.guardian, reserve: CFG.reserve, mpc: CFG.mpc, path: CFG.path,
        upgrade_delay_sec: CFG.upgrade_delay_sec, rules_delay_sec: CFG.rules_delay_sec }, teraToGas("30"), 0n),
      actions.deleteKey(KeyPair.fromString(policyKey).getPublicKey()),
    ] });
    say(`v13 "a" (sha256 ${sha(code).slice(0, 16)}...) deployed + init + key deleted in one transaction ${explorer(d.transaction.hash)}`);
    await wait(3);
    check((await keysOf(P)).length === 0, `policy ${P} has 0 keys (R1)`);
    const st = await view(P, "get_status");
    check(st.build === "a" && st.version === 1, `get_status: build ${st.build}, version ${st.version}, upgrade delay ${st.upgrade_delay_sec} s`);
    state.address = result(await act("owner", "setup", {}, { gas: "60" }));
    check(/^0x[0-9a-f]{40}$/.test(state.address ?? ""), `ETH address derived on-chain from the MPC: ${state.address}`);
    state.factoryInit = encodeDeployData({ abi: F.abi, bytecode: F.bytecode, args: [state.address] });
    keep();
    const nonce = await base.getTransactionCount({ address: state.address });
    await rules([
      { AllowCode: { code_hash: keccak256(state.factoryInit).slice(2) } },
      ...CASES.map((c) => ({ AllowCode: { code_hash: keccak256(c.init).slice(2) } })),
      { AllowChain: { chain_id: CHAIN, next_nonce: nonce, min_fee_per_gas: CFG.fee_floor_wei } },
      { SetLimits: { max_gas_limit: CFG.max_gas_limit, max_fee_cap: CFG.max_fee_cap } },
    ]);
    const r = await view(P, "get_rules");
    check(r.allowed_code.length === CASES.length + 1 && r.max_gas_limit === String(CFG.max_gas_limit), `rules live: ${r.allowed_code.length} codes, gas cap ${r.max_gas_limit}, chain ${CHAIN} from nonce ${nonce}`);
  } else if (stage === "agent") {
    // Rotate the agent: a new account with a function-call key, then the owner's proposal through the delay.
    const id = process.argv[3];
    if (!id) throw new Error("usage: agent <new-agent-account>");
    if (fs.existsSync(keyFile("agent")) && !(await exists(id))) fs.renameSync(keyFile("agent"), here(`agent_${Date.now()}_old_key.json`));
    if (!(await exists(id))) {
      const kp = KeyPair.fromRandom("ed25519");
      fs.writeFileSync(keyFile("agent"), JSON.stringify({ private_key: kp.toString() }));
      const o = await signer("owner").acc.signAndSendTransaction({ receiverId: id, actions: [actions.createAccount(), actions.transfer(BigInt(parseNearAmount("2"))),
        actions.addFunctionCallAccessKey(kp.getPublicKey(), P, AGENT_METHODS)] });
      say(`  created ${id} (2 NEAR, function-call key, no allowance) ${explorer(o.transaction.hash)}`);
    }
    await act("owner", "propose_role", { role: "Agent", account: id });
    await refused("apply the new agent before the delay", () => act("owner", "apply_role", { proposer: CFG.lab }), "role change delay not over");
    await untilTime((await view(P, "get_roles")).role_changes[0].ready_at, "the agent delay");
    await act("owner", "apply_role", { proposer: CFG.lab });
    check((await view(P, "get_roles")).agent === id, `agent is now ${id} (set CFG.agent to it in v13/config.json)`);
  } else if (stage === "fund") {
    say(`send Base Sepolia ETH to ${state.address} (faucet); 0.01 ETH is plenty`);
    for (;;) { const b = await base.getBalance({ address: state.address }); if (b > 0n) { say(`  balance ${formatEther(b)} ETH`); break; } await wait(15); }
  } else if (stage === "factory") {
    if (!state.factory) {
      const r = await agentDeploy("keyless deploy of KeyfreeFactory", state.factoryInit, { gasExtra: 600_000 });
      state.factory = r.rc.contractAddress.toLowerCase();
      keep();
    }
    const k = await base.readContract({ address: state.factory, abi: F.abi, functionName: "keyfree" });
    check(k.toLowerCase() === state.address, `factory ${state.factory} serves only ${k}`);
    await rules([{ SetFactory: { chain_id: CHAIN, factory_hex: state.factory } }]);
  } else if (stage === "deploy") {
    // optional argv[3]: case numbers to run, e.g. "0,1,2" (the address must hold gas_limit x fee for each)
    const pick = process.argv[3] ? process.argv[3].split(",").map(Number) : CASES.map((_, i) => i);
    state.deploys = state.deploys || [];
    for (const c of CASES.filter((_, i) => pick.includes(i))) {
      say(`  balance ${formatEther(await base.getBalance({ address: state.address }))} ETH before ${c.name}`);
      const salt = keccak256(toHex(`keyfree-v13-${c.name}-${Date.now()}`));
      // code deposit is 200 gas per runtime byte; the rest covers CREATE2, the init run and the 1/64 the factory keeps
      const r = await agentDeploy(c.name, c.init, { salt, gasExtra: 200 * c.runtime + 250_000 });
      if (!r) continue;
      const lg = r.rc.logs.find((l) => l.address.toLowerCase() === state.factory);
      const ev = decodeEventLog({ abi: F.abi, data: lg.data, topics: lg.topics });
      const code = await base.getCode({ address: r.expected });
      check(ev.args.addr.toLowerCase() === r.expected && (code.length - 2) / 2 === c.runtime, `${c.name}: Deployed(${ev.args.addr}), ${(code.length - 2) / 2} bytes of runtime at the promised address`);
      state.deploys.push({ name: c.name, nonce: r.nonce, tx: r.rc.transactionHash, log_index: lg.logIndex, transaction_index: r.rc.transactionIndex,
        block_hash: r.rc.blockHash, block_number: Number(r.rc.blockNumber), salt, init_hash: keccak256(c.init) });
      keep();
    }
  } else if (stage === "confirm") {
    const L = state.deploys.at(-1);
    for (;;) {
      const b = await base.getBlock({ blockTag: "safe" });
      if (b.number >= BigInt(L.block_number)) break;
      say(`waiting: safe block ${b.number}, ours ${L.block_number}`);
      await wait(60);
    }
    for (const wrong of [true, false]) {
      const t0 = Date.now();
      const log = { log_index: L.log_index, transaction_index: L.transaction_index, block_hash: L.block_hash, block_number: L.block_number + (wrong ? 1 : 0) };
      const out = await act("agent", "confirm", { chain_id: CHAIN, nonce: L.nonce, log, finality: "Safe" }, { gas: "200" });
      check(result(out) === !wrong, `${wrong ? "FORGED log position" : "real log"} (${L.name}, nonce ${L.nonce}): Read MPC answered ${result(out)} in ${((Date.now() - t0) / 1000).toFixed(1)} s  ${explorer(out.transaction.hash)}`);
    }
    check((await view(P, "get_entry", { chain_id: CHAIN, nonce: L.nonce })).status === "confirmed", "journal line is confirmed");
  } else if (stage === "attacks") {
    const f = await fees();
    const req = (o) => ({ chain_id: CHAIN, init_code_hex: TINY, gas_limit: 300000, ...f, salt_hex: null, via_factory: null, ...o });
    const used = state.deploys[0];
    await refused("agent deploys code that is not on the list", () => act("agent", "request_deploy", req({ init_code_hex: initFor(77) }), { gas: "250" }), "code not on the allow list");
    await refused("agent uses a salt without the factory (shared proxy)", () => act("agent", "request_deploy", req({ salt_hex: used.salt }), { gas: "250" }), "a salt needs the factory");
    await refused("agent signs with a 1 wei fee", () => act("agent", "request_deploy", req({ max_fee_per_gas: 1, max_priority_fee_per_gas: 1 }), { gas: "250" }), "fee below the floor");
    await refused("agent repeats a salt + code on a new nonce", () => act("agent", "request_deploy", req({ salt_hex: used.salt, via_factory: true }), { gas: "250" }), "salt and code already used");
    await refused("agent's key calls a method outside its list", () => signer("agent").acc.callFunctionRaw({ contractId: P, methodName: "propose_rule", args: { change: { AllowCode: { code_hash: "ab".repeat(32) } } }, gas: teraToGas("30") }), ["MethodNameMismatch", "does not allow method", "not allowed", "isn't allowed"]);
    await refused("owner raises a cap at once", () => act("owner", "lower_limits", { max_gas_limit: CFG.max_gas_limit * 2, max_fee_cap: CFG.max_fee_cap }), "raising a cap is a rule proposal");
    await refused("owner re-opens a chain with a lower nonce", () => act("owner", "propose_rule", { change: { AllowChain: { chain_id: CHAIN, next_nonce: 0, min_fee_per_gas: 1 } } }), "chain already allowed");
    await refused("a stranger pauses", () => signer("guardian2").acc.callFunctionRaw({ contractId: P, methodName: "pause", args: {}, gas: teraToGas("30") }), "only owner, guardian or reserve");
    await refused("confirm_stuck with Latest", () => act("agent", "confirm_stuck", { tx_hash: used.tx, log: { log_index: 0, transaction_index: 0, block_hash: used.block_hash, block_number: used.block_number }, finality: "Latest" }, { gas: "200" }), "a stuck request needs Safe or Finalized");
    await act("guardian", "pause", {}, { until: async () => (await view(P, "get_status")).paused });
    await refused("agent deploys while paused", () => act("agent", "request_deploy", req({}), { gas: "250" }), "paused");
    await act("guardian", "unpause", {}, { until: async () => (await view(P, "get_roles")).unpause_votes.length === 1 });
    check((await view(P, "get_status")).paused, "one unpause vote is not enough");
    await act("reserve", "unpause", {}, { until: async () => !(await view(P, "get_status")).paused });
    check(!(await view(P, "get_status")).paused, "second vote (reserve) unpauses");
  } else if (stage === "roles") {
    const g2 = CFG.guardian2;
    await act("owner", "propose_role", { role: "Guardian", account: g2 });
    await refused("apply with one approval", () => act("owner", "apply_role", { proposer: CFG.lab }), "needs 2 of 3 approvals");
    await act("reserve", "approve_role", { proposer: CFG.lab }, { until: async () => (await view(P, "get_roles")).role_changes[0]?.approvals.length === 2 });
    const ready = (await view(P, "get_roles")).role_changes[0].ready_at;
    await act("guardian", "cancel_role", { proposer: CFG.lab }, { until: async () => (await view(P, "get_roles")).role_changes[0]?.cancels.length === 1 });
    check((await view(P, "get_roles")).role_changes.length === 1, "the old guardian alone cannot cancel its own replacement");
    await refused("apply before the delay (owner + reserve together)", () => act("owner", "apply_role", { proposer: CFG.lab }), "role change delay not over");
    await untilTime(ready, "the role delay");
    await act("owner", "apply_role", { proposer: CFG.lab });
    check((await view(P, "get_roles")).guardian === g2, `guardian is now ${g2}`);
    await refused("the old guardian pauses", () => act("guardian", "pause", {}), "only owner, guardian or reserve");
    ROLE_ID.guardian = g2;
  } else if (stage === "upgrade") {
    const B = fs.readFileSync(WASM.b);
    const stake = BigInt(B.length + 1000) * 10n ** 19n;
    const owner = signer("owner").acc;
    const propose = () => owner.signAndSendTransaction({ receiverId: P, actions: [actions.functionCall("propose_upgrade", B, teraToGas("300"), stake)] });
    const g = signer("guardian2").acc;
    kfLogs(await propose());
    const shown = Buffer.from(await view(P, "get_proposed_code"), "base64");
    check(sha(shown) === sha(B), `guardian reads the proposed code from the chain: ${shown.length} bytes, sha256 ${sha(shown).slice(0, 16)}... == local build "b"`);
    await g.callFunctionRaw({ contractId: P, methodName: "cancel_upgrade", args: {}, gas: teraToGas("30") });
    await settle();
    check((await view(P, "get_status")).proposed === null, "guardian cancelled; the stored code is gone");
    kfLogs(await propose());
    const apply = () => owner.callFunctionRaw({ contractId: P, methodName: "apply_upgrade", args: {}, gas: teraToGas("300") });
    await refused("apply before the delay", apply, "upgrade delay not over");
    await untilTime((await view(P, "get_status")).proposed[1], "the upgrade delay");
    const up = await apply();
    kfLogs(up);
    await wait(3);
    const st = await view(P, "get_status");
    check(st.build === "b" && st.version === 2 && st.proposed === null, `upgraded WITHOUT a key: build ${st.build}, version ${st.version}, proposal cleared by migrate  ${explorer(up.transaction.hash)}`);
    check((await keysOf(P)).length === 0, "policy still has 0 keys");
  } else if (stage === "cancel") {
    // Re-check of the guardian's veto alone: propose a code, the guardian cancels, the proposal and the bytes are gone.
    const A = fs.readFileSync(WASM.a);
    kfLogs(await signer("owner").acc.signAndSendTransaction({ receiverId: P, actions: [actions.functionCall("propose_upgrade", A, teraToGas("300"), BigInt(A.length + 1000) * 10n ** 19n)] }));
    await settle();
    check((await view(P, "get_status")).proposed?.[0] === sha(A), `proposal is on the chain: sha256 ${sha(A).slice(0, 16)}...`);
    kfLogs(await signer("guardian2").acc.callFunctionRaw({ contractId: P, methodName: "cancel_upgrade", args: {}, gas: teraToGas("30") }));
    await settle();
    check((await view(P, "get_status")).proposed === null && (await view(P, "get_proposed_code")) === null, "guardian cancelled: no proposal, no stored code");
  } else if (stage === "retire") {
    const ownerBefore = BigInt((await provider.viewAccount({ accountId: CFG.lab })).amount);
    await act("owner", "propose_role", { role: "Retire", account: CFG.lab });
    await act("reserve", "approve_role", { proposer: CFG.lab }, { until: async () => (await view(P, "get_roles")).role_changes[0]?.approvals.length === 2 });
    await untilTime((await view(P, "get_roles")).role_changes[0].ready_at, "the retire delay");
    await act("owner", "apply_role", { proposer: CFG.lab });
    check((await view(P, "get_roles")).retiring === CFG.lab, "the policy is retiring for good");
    await refused("unpause while retiring", () => act("owner", "unpause", {}), "the policy is retiring");
    for (;;) { const left = result(await act("owner", "sweep", { limit: 100 }, { gas: "300" })); say(`  sweep: ${left} entries left`); if (left === 0) break; }
    const fin = await act("owner", "finish_retire", {}, { gas: "30" });
    await wait(5);
    check(!(await exists(P)), `policy account deleted  ${explorer(fin.transaction.hash)}`);
    const back = BigInt((await provider.viewAccount({ accountId: CFG.lab })).amount) - ownerBefore;
    say(`  owner balance change: ${(Number(back / 10n ** 20n) / 1e4).toFixed(2)} NEAR (includes gas of this stage)`);
  } else {
    say(`unknown stage "${stage}"; see the header of v13/run.mjs`);
  }
} catch (e) {
  check(false, `stage ${stage} stopped: ${String(e.message || e).replace(/\s+/g, " ").slice(0, 300)}`);
}
if (stage !== "plan") save();
console.log(`${oks} ok, ${fails} fail`);
