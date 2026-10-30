// Keyfree v14 (the money scenario) on the live v13 policy: NEAR testnet + Base Sepolia. One stage per call,
// results appended to evidence/v14.log, progress kept in evidence/v14_state.json. Accounts, keys and signers
// are the v13 ones (v13/config.json, v13/<role>_key.json); a key in v14/ wins over v13/ (the new agent's).
//   node v14/run.mjs check       read-only: balances, keys, what the policy runs
//   treasury    allow TreasuryV1(owner), TreasuryProxy(V1, policy address), TreasuryV2(owner, limit) through the
//               rules delay, deploy all three keyless through the factory; the proxy runs v1, its admin is the policy
//   upgrade     propose the v14 build as bytes, the guardian checks its sha256, wait, apply -> v14 without a key;
//               the v13 state is still there (codes, nonces, journal)
//   agent <id>  new agent whose function-call key also has request_proxy_upgrade and resign_proxy_upgrade
//   allow       AllowProxyUpgrade(proxy -> v2) through the rules delay; live refusals before and after
//   after       after `keyfree upgrade` (the CLI, as an agent would): the proxy runs v2; the same upgrade again,
//               a rollback to v1 and another implementation are refused
//   confirm     Read MPC confirms the proxy's Upgraded log in a Safe block; a forged position is not confirmed
//   demo        a second treasury proxy on v1 and AllowProxyUpgrade(it -> v2), for a fresh Claude Code session
import fs from "node:fs";
import crypto from "node:crypto";
import { keccak256, toHex, getContractAddress, createPublicClient, http, baseSepolia, formatEther,
  encodeFunctionData, encodeDeployData, serializeTransaction, decodeEventLog, parseEther } from "../tools/evm.mjs";
import { loadAccount, provider, explorer, view, KeyPair, teraToGas, parseNearAmount, Account, actions } from "../tools/near.mjs";

const here = (f) => new URL(`./${f}`, import.meta.url);
const top = (f) => new URL(`../${f}`, import.meta.url);
const CFG = JSON.parse(fs.readFileSync(top(fs.existsSync(here("config.json")) ? "v14/config.json" : "v13/config.json")));
const P = CFG.policy, CHAIN = CFG.chain_id;
const V13 = JSON.parse(fs.readFileSync(top("evidence/v13_state.json")));
const F = JSON.parse(fs.readFileSync(top("factory/factory.json")));
const art = (n) => JSON.parse(fs.readFileSync(top(`packages/keyfree/demo/treasury/out/${n}.sol/${n}.json`)));
const WASM = here("keyfree_v14.opt.wasm");
const AGENT_METHODS = ["request_deploy", "request_proxy_upgrade", "resign", "resign_proxy_upgrade", "retry", "release", "confirm", "confirm_stuck"];
// The treasury owner from the vault-kit example (a throwaway testnet address) and v2's daily limit.
const TREASURY_OWNER = JSON.parse(fs.readFileSync(top("packages/keyfree/demo/vault-kit/deploy.config.json"))).constructor.owner;
const DAILY_LIMIT = parseEther("0.01");
const scan = (h) => `https://sepolia.basescan.org/tx/${h}`;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
const settle = () => wait(3); // calls return optimistic, views read final (see v13/run.mjs)

const stateFile = top("evidence/v14_state.json");
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : {};
const keep = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
const log = [];
let oks = 0, fails = 0;
const say = (s) => { console.log(s); log.push(s); };
const check = (ok, s) => { ok ? oks++ : fails++; say(`${ok ? "OK  " : "FAIL"} ${s}`); };
const save = () => fs.appendFileSync(top("evidence/v14.log"), `--- ${new Date().toISOString()} ${process.argv.slice(2).join(" ")} (${oks} ok, ${fails} fail)\n${log.join("\n")}\n`);

// ---- accounts and signing (keys never printed, *_key.json is gitignored) ----
const ROLE_ID = { owner: CFG.lab, agent: CFG.agent, guardian: CFG.guardian2, reserve: CFG.reserve };
const KEY_ROLE = { guardian: "guardian2" }; // the guardian today is v13's guardian2
const keyFile = (role) => [here(`${role}_key.json`), top(`v13/${role}_key.json`)].find((f) => fs.existsSync(f));
function signer(role) {
  const id = ROLE_ID[role], k = KEY_ROLE[role] ?? role;
  if ((CFG.signers[k] ?? "local") === "credentials") return loadAccount(id);
  return new Account(id, provider, JSON.parse(fs.readFileSync(keyFile(k))).private_key);
}
const result = (out) => JSON.parse(Buffer.from(out.status.SuccessValue ?? "", "base64").toString() || "null");
const kfLogs = (out) => { for (const r of out.receipts_outcome) for (const l of r.outcome.logs) if (l.startsWith("keyfree")) say(`  log: ${l}`); };
async function act(role, methodName, args, gas = "30") {
  const out = await signer(role).callFunctionRaw({ contractId: P, methodName, args, gas: teraToGas(gas) });
  kfLogs(out);
  return out;
}
async function refused(name, fn, reason) {
  const reasons = [reason].flat();
  try { await fn(); check(false, `${name}: was allowed`); }
  catch (e) { const m = String(e.message || e).replace(/\s+/g, " "); check(reasons.some((r) => m.includes(r)), `${name} -> ${m.slice(0, 160)}`); }
}
const balance = async (accountId) => Number(BigInt((await provider.viewAccount({ accountId })).amount) / 10n ** 21n) / 1000;
const keysOf = async (accountId) => (await provider.viewAccessKeyList({ accountId })).keys;
const untilTime = async (unix, what) => { const s = Math.max(0, unix - Date.now() / 1000) + 5; say(`waiting ${Math.ceil(s)} s for ${what}`); await wait(s); };

// ---- EVM side ----
const base = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const slot = async (address, s) => `0x${(await base.getStorageAt({ address, slot: s })).slice(-40)}`;
const VERSION_ABI = [{ type: "function", name: "version", stateMutability: "pure", inputs: [], outputs: [{ type: "uint256" }] }];
const UPGRADE_ABI = [{ type: "function", name: "upgradeTo", stateMutability: "nonpayable", inputs: [{ name: "implementation", type: "address" }], outputs: [] },
  { type: "event", name: "Upgraded", anonymous: false, inputs: [{ indexed: true, name: "implementation", type: "address" }] }];
const runs = async (proxy) => Number(await base.readContract({ address: proxy, abi: VERSION_ABI, functionName: "version" }));

async function fees() {
  const f = await base.estimateFeesPerGas();
  const max = f.maxFeePerGas > BigInt(CFG.fee_floor_wei) ? f.maxFeePerGas : BigInt(CFG.fee_floor_wei);
  return { max_fee_per_gas: Number(max), max_priority_fee_per_gas: Number(f.maxPriorityFeePerGas < max ? f.maxPriorityFeePerGas : max) };
}

// A keyless deploy through the factory, bytes compared with viem (as v13/run.mjs agentDeploy).
async function agentDeploy(label, init, salt, gasExtra) {
  const f = await fees();
  const ask = { chain_id: CHAIN, init_code_hex: init, ...f, salt_hex: salt, via_factory: true };
  const probe = await view(P, "preview", { ...ask, gas_limit: CFG.max_gas_limit });
  const args = { ...ask, gas_limit: Math.min(CFG.max_gas_limit, probe.min_gas + gasExtra) };
  const pv = await view(P, "preview", args);
  const data = encodeFunctionData({ abi: F.abi, functionName: "deploy", args: [salt, init] });
  const mine = serializeTransaction({ type: "eip1559", chainId: CHAIN, nonce: pv.nonce, to: V13.factory, data, value: 0n,
    gas: BigInt(args.gas_limit), maxFeePerGas: BigInt(args.max_fee_per_gas), maxPriorityFeePerGas: BigInt(args.max_priority_fee_per_gas) });
  check(pv.unsigned === mine, `${label}: unsigned tx built by the contract == viem (nonce ${pv.nonce})`);
  const out = await act("agent", "request_deploy", args, "250");
  const raw = result(out);
  if (!raw) throw new Error(`${label}: not signed ${JSON.stringify(await view(P, "get_open"))}`);
  const hash = await base.sendRawTransaction({ serializedTransaction: raw });
  const rc = await base.waitForTransactionReceipt({ hash, timeout: 180_000 });
  check(rc.status === "success", `${label}: landed, gas ${rc.gasUsed} of ${args.gas_limit}  ${explorer(out.transaction.hash)}  ${scan(hash)}`);
  return { rc, nonce: pv.nonce, address: pv.expected_address };
}

async function rules(changes) {
  const ids = [];
  for (const change of changes) ids.push(result(await act("owner", "propose_rule", { change })));
  say(`proposed rules ${ids.join(", ")}: ${changes.map((c) => Object.keys(c)[0]).join(", ")}`);
  await refused("apply a rule before the delay", () => act("owner", "apply_rule", { id: ids[0] }), "rule delay not over");
  await untilTime(Date.now() / 1000 + CFG.rules_delay_sec, "the rules delay");
  for (const id of ids) await act("owner", "apply_rule", { id });
  say(`applied rules ${ids.join(", ")}`);
  return ids;
}

// The proxy upgrade request as the agent sends it, with the policy's bytes compared with viem first.
async function askUpgrade(implementation) {
  const f = await fees();
  const args = { chain_id: CHAIN, proxy_hex: state.proxy, implementation_hex: implementation, gas_limit: 100_000, ...f };
  return act("agent", "request_proxy_upgrade", args, "250");
}

const stage = process.argv[2];
try {
  if (stage === "check") {
    for (const a of [CFG.lab, P, CFG.agent, CFG.guardian2, CFG.reserve]) say(`${a}: ${await balance(a)} NEAR`);
    const st = await view(P, "get_status");
    say(`policy: build ${st.build}, version ${st.version}, keys ${(await keysOf(P)).length}, ETH ${formatEther(await base.getBalance({ address: V13.address }))} on ${V13.address}`);
    if (fs.existsSync(WASM)) say(`v14 wasm ${fs.statSync(WASM).size} bytes, stake ~${(fs.statSync(WASM).size + 1000) / 1e5} NEAR, sha256 ${sha(fs.readFileSync(WASM)).slice(0, 16)}...`);
  } else if (stage === "treasury") {
    // CREATE2 addresses are known before signing, so the proxy's constructor arguments can name v1 and the policy.
    state.salts ??= Object.fromEntries(["v1", "proxy", "v2"].map((n) => [n, keccak256(toHex(`keyfree-v14-treasury-${n}-${Date.now()}`))]));
    const at = (salt, init) => getContractAddress({ opcode: "CREATE2", from: V13.factory, salt, bytecode: init }).toLowerCase();
    const V1 = art("TreasuryV1"), V2 = art("TreasuryV2"), PX = art("TreasuryProxy");
    const initV1 = encodeDeployData({ abi: V1.abi, bytecode: V1.bytecode.object, args: [TREASURY_OWNER] });
    const v1 = at(state.salts.v1, initV1);
    const initProxy = encodeDeployData({ abi: PX.abi, bytecode: PX.bytecode.object, args: [v1, V13.address] });
    const initV2 = encodeDeployData({ abi: V2.abi, bytecode: V2.bytecode.object, args: [TREASURY_OWNER, DAILY_LIMIT] });
    const plan = { v1: [initV1, v1], proxy: [initProxy, at(state.salts.proxy, initProxy)], v2: [initV2, at(state.salts.v2, initV2)] };
    keep();
    const allowed = (await view(P, "get_rules")).allowed_code;
    const missing = Object.values(plan).filter(([init]) => !allowed.includes(keccak256(init).slice(2)));
    if (missing.length) await rules(missing.map(([init]) => ({ AllowCode: { code_hash: keccak256(init).slice(2) } })));
    for (const n of ["v1", "proxy", "v2"]) {
      const [init, addr] = plan[n];
      if (((await base.getCode({ address: addr })) ?? "0x").length > 2) { say(`  ${n} already at ${addr}`); state[n] = addr; continue; }
      const r = await agentDeploy(`treasury ${n}`, init, state.salts[n], 400_000);
      check(r.address === addr, `treasury ${n} at the promised address ${addr}`);
      state[n] = addr;
      state.deploys = [...(state.deploys ?? []), { name: n, nonce: r.nonce, tx: r.rc.transactionHash }];
      keep();
    }
    check((await slot(state.proxy, ADMIN_SLOT)) === V13.address, `proxy admin = the policy's keyless address ${V13.address}`);
    check((await slot(state.proxy, IMPL_SLOT)) === state.v1 && (await runs(state.proxy)) === 1, `proxy ${state.proxy} runs TreasuryV1 (version() = 1)`);
  } else if (stage === "upgrade") {
    const B = fs.readFileSync(WASM);
    const stake = BigInt(B.length + 1000) * 10n ** 19n;
    const before = { rules: await view(P, "get_rules"), nonce: await view(P, "get_next_nonce", { chain_id: CHAIN }), last: await view(P, "get_entry", { chain_id: CHAIN, nonce: 6 }) };
    if (!(await view(P, "get_status")).proposed) {
      kfLogs(await signer("owner").signAndSendTransaction({ receiverId: P, actions: [actions.functionCall("propose_upgrade", B, teraToGas("300"), stake)] }));
      await settle();
    }
    const shown = Buffer.from(await view(P, "get_proposed_code"), "base64");
    check(sha(shown) === sha(B), `guardian reads the proposed code from the chain: ${shown.length} bytes, sha256 ${sha(shown).slice(0, 16)}... == local build "v14"`);
    const apply = () => signer("owner").callFunctionRaw({ contractId: P, methodName: "apply_upgrade", args: {}, gas: teraToGas("300") });
    await refused("apply before the delay", apply, "upgrade delay not over");
    await untilTime((await view(P, "get_status")).proposed[1], "the upgrade delay");
    const up = await apply();
    kfLogs(up);
    await settle();
    const st = await view(P, "get_status");
    check(st.build === "v14" && st.proposed === null, `upgraded WITHOUT a key: build ${st.build}, version ${st.version}  ${explorer(up.transaction.hash)}`);
    check((await keysOf(P)).length === 0, "policy still has 0 keys");
    const after = { rules: await view(P, "get_rules"), nonce: await view(P, "get_next_nonce", { chain_id: CHAIN }), last: await view(P, "get_entry", { chain_id: CHAIN, nonce: 6 }) };
    check(JSON.stringify(after.rules.allowed_code.sort()) === JSON.stringify(before.rules.allowed_code.sort()) && after.nonce === before.nonce && after.last.status === before.last.status,
      `v13 state migrated: ${after.rules.allowed_code.length} codes, next nonce ${after.nonce}, journal line 6 "${after.last.status}"`);
    check(Array.isArray(after.rules.allowed_proxy_upgrades) && after.rules.allowed_proxy_upgrades.length === 0, "new: allowed_proxy_upgrades = []");
  } else if (stage === "agent") {
    const id = process.argv[3];
    if (!id) throw new Error("usage: agent <new-agent-account>");
    const file = here("agent_key.json");
    if (!(await provider.viewAccount({ accountId: id }).then(() => true, () => false))) {
      const kp = KeyPair.fromRandom("ed25519");
      fs.writeFileSync(file, JSON.stringify({ private_key: kp.toString() }));
      const o = await signer("owner").signAndSendTransaction({ receiverId: id, actions: [actions.createAccount(), actions.transfer(BigInt(parseNearAmount(process.env.KF_AGENT_NEAR || "0.3"))),
        actions.addFunctionCallAccessKey(kp.getPublicKey(), P, AGENT_METHODS)] });
      say(`  created ${id} (function-call key on ${AGENT_METHODS.length} methods, no allowance) ${explorer(o.transaction.hash)}`);
    }
    await act("owner", "propose_role", { role: "Agent", account: id });
    await refused("apply the new agent before the delay", () => act("owner", "apply_role", { proposer: CFG.lab }), "role change delay not over");
    await untilTime((await view(P, "get_roles")).role_changes[0].ready_at, "the agent delay");
    await act("owner", "apply_role", { proposer: CFG.lab });
    await settle();
    check((await view(P, "get_roles")).agent === id, `agent is now ${id} (write it into v14/config.json)`);
  } else if (stage === "allow") {
    const upgrade = { AllowProxyUpgrade: { chain_id: CHAIN, proxy_hex: state.proxy, implementation_hex: state.v2 } };
    await refused("agent asks for the upgrade before any rule", () => askUpgrade(state.v2), "proxy upgrade not on the allow list");
    await refused("agent's key allows the upgrade itself", () => signer("agent").callFunctionRaw({ contractId: P, methodName: "propose_rule", args: { change: upgrade }, gas: teraToGas("30") }),
      ["does not allow method", "MethodNameMismatch", "not allowed"]);
    [state.rule] = await rules([upgrade]);
    keep();
    const key = `${CHAIN}:${state.proxy}:${state.v2}`;
    check((await view(P, "get_rules")).allowed_proxy_upgrades.includes(key), `allowed: ${key}`);
    await refused("agent asks for another implementation (the factory stands in for an attacker's contract)", () => askUpgrade(V13.factory), "proxy upgrade not on the allow list");
  } else if (stage === "after") {
    check((await slot(state.proxy, IMPL_SLOT)) === state.v2 && (await runs(state.proxy)) === 2, `proxy ${state.proxy} runs TreasuryV2 now (version() = 2)`);
    const n = (await view(P, "get_next_nonce", { chain_id: CHAIN })) - 1;
    const e = await view(P, "get_entry", { chain_id: CHAIN, nonce: n });
    check(e.kind === "proxy_upgrade" && e.implementation === state.v2 && e.status === "signed", `journal line ${n}: proxy upgrade to v2, signed, tx ${e.tx_hash}`);
    state.upgrade = { nonce: n, tx: e.tx_hash };
    keep();
    check((await view(P, "get_rules")).allowed_proxy_upgrades.length === 0, "the allowance is used up");
    await refused("the same upgrade again", () => askUpgrade(state.v2), "proxy upgrade not on the allow list");
    await refused("rollback to v1", () => askUpgrade(state.v1), "proxy upgrade not on the allow list");
  } else if (stage === "confirm") {
    const rc = await base.getTransactionReceipt({ hash: state.upgrade.tx });
    const lg = rc.logs.find((l) => l.address.toLowerCase() === state.proxy);
    const ev = decodeEventLog({ abi: UPGRADE_ABI, data: lg.data, topics: lg.topics });
    check(ev.eventName === "Upgraded" && ev.args.implementation.toLowerCase() === state.v2, `Upgraded(${ev.args.implementation}) from the proxy, block ${rc.blockNumber}`);
    for (;;) {
      const b = await base.getBlock({ blockTag: "safe" });
      if (b.number >= rc.blockNumber) break;
      say(`waiting: safe block ${b.number}, ours ${rc.blockNumber}`);
      await wait(60);
    }
    for (const wrong of [true, false]) {
      const t0 = Date.now();
      const where = { log_index: lg.logIndex, transaction_index: rc.transactionIndex, block_hash: rc.blockHash, block_number: Number(rc.blockNumber) + (wrong ? 1 : 0) };
      const out = await act("agent", "confirm", { chain_id: CHAIN, nonce: state.upgrade.nonce, log: where, finality: "Safe" }, "200");
      check(result(out) === !wrong, `${wrong ? "FORGED log position" : "real Upgraded log"}: Read MPC answered ${result(out)} in ${((Date.now() - t0) / 1000).toFixed(1)} s  ${explorer(out.transaction.hash)}`);
    }
    await settle();
    check((await view(P, "get_entry", { chain_id: CHAIN, nonce: state.upgrade.nonce })).status === "confirmed", "journal line is confirmed");
  } else if (stage === "demo") {
    // A second treasury for the Claude Code session: the same proxy code (already allowed) with a new salt,
    // running v1, plus AllowProxyUpgrade(proxy2 -> v2). Run again after the session to see where it stands.
    const d = (state.demo ??= { salt: keccak256(toHex(`keyfree-v14-treasury-demo-${Date.now()}`)) });
    keep();
    const PX = art("TreasuryProxy");
    const init = encodeDeployData({ abi: PX.abi, bytecode: PX.bytecode.object, args: [state.v1, V13.address] });
    const addr = getContractAddress({ opcode: "CREATE2", from: V13.factory, salt: d.salt, bytecode: init }).toLowerCase();
    if (((await base.getCode({ address: addr })) ?? "0x").length <= 2) {
      const r = await agentDeploy("demo treasury proxy", init, d.salt, 400_000);
      check(r.address === addr, `demo proxy at the promised address ${addr}`);
      Object.assign(d, { nonce: r.nonce, tx: r.rc.transactionHash });
    }
    d.proxy = addr;
    keep();
    check((await slot(addr, ADMIN_SLOT)) === V13.address, `demo proxy admin = the policy's keyless address`);
    const key = `${CHAIN}:${addr}:${state.v2}`;
    say(`demo proxy ${addr} runs version ${await runs(addr)}`);
    if (d.rule === undefined && (await runs(addr)) === 1) {
      [d.rule] = await rules([{ AllowProxyUpgrade: { chain_id: CHAIN, proxy_hex: addr, implementation_hex: state.v2 } }]);
      keep();
    }
    say(`allowed now: ${(await view(P, "get_rules")).allowed_proxy_upgrades.includes(key) ? key : "nothing for this proxy (used up or not yet)"}`);
  } else {
    console.log("stages: check | treasury | upgrade | agent <id> | allow | after | confirm | demo");
  }
} catch (e) {
  check(false, `stopped: ${String(e.message || e).replace(/\s+/g, " ").slice(0, 300)}`);
}
if (stage) save();
console.log(`${oks} ok, ${fails} fail`);
