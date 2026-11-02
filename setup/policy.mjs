// Your own Keyfree policy on NEAR testnet, on the code the live demo policy runs. One stage per call; progress
// is kept in setup/state.json, keys of accounts this script creates in setup/<role>_key.json (gitignored).
//   node setup/policy.mjs plan      offline: the config and what each stage will do
//   wasm       take the policy code from the reference policy on chain (or "wasm" in the config) and check its
//              sha256 against the reproducible build ("wasm_sha256"); nothing else is ever installed
//   accounts   create the policy (temporary key), the agent (function-call key only), guardian and reserve
//              as sub-accounts of the owner; accounts that already exist are left alone
//   install    deploy + init + delete the policy's key in ONE transaction -> 0 keys; derive the ETH address;
//              propose the rules: each chain from its current nonce, a daily budget per chain, gas caps, the
//              factory's code
//   apply      after the rules delay: apply every rule this script proposed
//   factory <chain>   once the ETH address holds a little ETH: the agent deploys the factory without a key,
//              then the SetFactory rule is proposed (run apply again after the delay)
//   keyfree    write setup/keyfree.json for the keyfree tool (CLI and MCP)
//   check      read-only: keys, roles, rules, chains, budget
// The owner signs with its key from ~/.near-credentials/testnet/<owner>.json.
import fs from "node:fs";
import crypto from "node:crypto";
import { createPublicClient, http, encodeDeployData, serializeTransaction, keccak256 } from "../tools/evm.mjs";
import { loadAccount, provider, explorer, KeyPair, teraToGas, parseNearAmount, Account, actions } from "../tools/near.mjs";

const here = (f) => new URL(`./${f}`, import.meta.url);
const CFG = JSON.parse(fs.readFileSync(fs.existsSync(here("config.json")) ? here("config.json") : here("config.example.json")));
const P = CFG.policy;
const F = JSON.parse(fs.readFileSync(new URL("../factory/factory.json", import.meta.url)));
const AGENT_METHODS = ["request_deploy", "request_proxy_upgrade", "resign", "resign_proxy_upgrade", "retry", "release", "confirm", "confirm_stuck"];
const WASM = here("policy.wasm");
const stateFile = here("state.json");
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : { proposed: [] };
const keep = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
const keyFile = (role) => here(`${role}_key.json`); // never printed
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
const settle = () => wait(3); // a call returns before views see its block
let fails = 0;
const say = (s) => console.log(s);
const check = (ok, s) => { if (!ok) fails++; say(`${ok ? "OK  " : "FAIL"} ${s}`); };

const view = async (method, args = {}) => {
  const r = await provider.callFunctionRaw({ contractId: P, method, args, blockQuery: { finality: "optimistic" } });
  return JSON.parse(Buffer.from(r.result).toString().replace(/"(?:[^"\\]|\\.)*"|-?\d{16,}/g, (m) => (m[0] === '"' ? m : `"${m}"`)));
};
const exists = (accountId) => provider.viewAccount({ accountId }).then(() => true, () => false);
const keysOf = async (accountId) => (await provider.viewAccessKeyList({ accountId })).keys;
const owner = () => loadAccount(CFG.owner);
const agent = () => new Account(CFG.agent, provider, JSON.parse(fs.readFileSync(keyFile("agent"))).private_key);
const result = (out) => JSON.parse(Buffer.from(out.status.SuccessValue ?? "", "base64").toString() || "null");
const logs = (out) => { for (const r of out.receipts_outcome) for (const l of r.outcome.logs) if (l.startsWith("keyfree")) say(`  log: ${l}`); };
// Arguments as JSON with exact integers: BigInt values (wei amounts) are written as plain numbers, never rounded.
const exact = (args) => new TextEncoder().encode(JSON.stringify(args, (_k, x) => (typeof x === "bigint" ? `__int__${x}` : x)).replace(/"__int__(\d+)"/g, "$1"));
const call = async (acc, methodName, args, gas = "30") => { const out = await acc.callFunctionRaw({ contractId: P, methodName, args: exact(args), gas: teraToGas(gas), deposit: 0n }); logs(out); return out; };
const chainOf = (name) => CFG.chains.find((c) => c.name === name) ?? (() => { throw new Error(`no chain "${name}" in the config`); })();
const evm = (c) => createPublicClient({ transport: http(c.rpc) });
const factoryInit = () => encodeDeployData({ abi: F.abi, bytecode: F.bytecode, args: [state.address] });

async function propose(changes) {
  for (const change of changes) {
    const id = result(await call(owner(), "propose_rule", { change }));
    state.proposed.push(id);
    say(`  rule ${id} proposed: ${Object.keys(change)[0]} ${JSON.stringify(Object.values(change)[0], (_k, x) => (typeof x === "bigint" ? String(x) : x))}`);
  }
  keep();
  say(`run "node setup/policy.mjs apply" after the rules delay (${CFG.rules_delay_sec} s); any council member can cancel meanwhile`);
}

const stage = process.argv[2];
try {
  if (stage === "plan" || !stage) {
    say(`policy ${P}, owner ${CFG.owner}, agent ${CFG.agent}, guardian ${CFG.guardian}, reserve ${CFG.reserve}`);
    say(`delays: rules ${CFG.rules_delay_sec} s, upgrades and roles ${CFG.upgrade_delay_sec} s; MPC ${CFG.mpc}, path ${CFG.path}`);
    say(`code: ${CFG.wasm ?? `from ${CFG.reference_policy}`}, must have sha256 ${CFG.wasm_sha256}`);
    for (const c of CFG.chains) say(`chain ${c.name} (${c.chain_id}): fee floor ${c.fee_floor_wei} wei, budget ${c.max_wei_per_day} wei and ${c.max_tx_per_day} transactions a day`);
    say("stages: wasm, accounts, install, apply, factory <chain>, apply, keyfree, check");
  } else if (stage === "wasm") {
    let code;
    if (CFG.wasm) code = fs.readFileSync(CFG.wasm);
    else {
      const r = await provider.query({ request_type: "view_code", account_id: CFG.reference_policy, finality: "final" });
      code = Buffer.from(r.code_base64, "base64");
    }
    check(sha(code) === CFG.wasm_sha256, `policy code ${code.length} bytes, sha256 ${sha(code)} ${sha(code) === CFG.wasm_sha256 ? "==" : "!="} the reproducible build`);
    if (!fails) fs.writeFileSync(WASM, code);
  } else if (stage === "accounts") {
    const o = owner();
    const make = async (role, id, near, keyAction) => {
      if (await exists(id)) return say(`  ${id} exists, left as it is`);
      if (!id.endsWith(`.${CFG.owner}`)) throw new Error(`${id} does not exist and is not a sub-account of ${CFG.owner}: create it yourself`);
      const kp = KeyPair.fromRandom("ed25519");
      fs.writeFileSync(keyFile(role), JSON.stringify({ account_id: id, private_key: kp.toString() }));
      const out = await o.signAndSendTransaction({ receiverId: id, actions: [actions.createAccount(), actions.transfer(BigInt(parseNearAmount(near))), keyAction(kp.getPublicKey())] });
      say(`  created ${id} with ${near} NEAR ${explorer(out.transaction.hash)}`);
    };
    // The policy gets a key only to install itself; install deletes it in the same transaction.
    await make("policy", P, CFG.policy_near, (pk) => actions.addFullAccessKey(pk));
    // The agent never gets a full key: only the request methods on this policy, and no allowance (a small one
    // runs out on the first 250 Tgas request; the agent account's own balance is the cap).
    await make("agent", CFG.agent, CFG.agent_near, (pk) => actions.addFunctionCallAccessKey(pk, P, AGENT_METHODS));
    for (const r of ["guardian", "reserve"]) await make(r, CFG[r], CFG.council_near, (pk) => actions.addFullAccessKey(pk));
    const ak = await keysOf(CFG.agent);
    check(ak.every((k) => k.access_key.permission !== "FullAccess"), `agent ${CFG.agent} holds no full-access key (${ak.length} key)`);
  } else if (stage === "install") {
    const code = fs.readFileSync(WASM);
    check(sha(code) === CFG.wasm_sha256, `setup/policy.wasm is the reproducible build (sha256 ${sha(code).slice(0, 16)}...)`);
    if (fails) throw new Error("run the wasm stage first");
    const key = JSON.parse(fs.readFileSync(keyFile("policy"))).private_key;
    const out = await new Account(P, provider, key).signAndSendTransaction({ receiverId: P, actions: [
      actions.deployContract(code),
      actions.functionCall("new", { owner: CFG.owner, agent: CFG.agent, guardian: CFG.guardian, reserve: CFG.reserve, mpc: CFG.mpc, path: CFG.path,
        upgrade_delay_sec: CFG.upgrade_delay_sec, rules_delay_sec: CFG.rules_delay_sec }, teraToGas("30"), 0n),
      actions.deleteKey(KeyPair.fromString(key).getPublicKey()),
    ] });
    say(`deployed, initialised and key deleted in one transaction ${explorer(out.transaction.hash)}`);
    await settle();
    check((await keysOf(P)).length === 0, `${P} has 0 access keys`);
    const st = await view("get_status");
    check(st.build === CFG.expect_build, `get_status: build ${st.build}, version ${st.version}`);
    state.address = result(await call(owner(), "setup", {}, "60"));
    check(/^0x[0-9a-f]{40}$/.test(state.address ?? ""), `ETH address derived by the MPC for this policy: ${state.address}`);
    keep();
    const changes = [];
    for (const c of CFG.chains) {
      const nonce = await evm(c).getTransactionCount({ address: state.address });
      changes.push({ AllowChain: { chain_id: c.chain_id, next_nonce: nonce, min_fee_per_gas: BigInt(c.fee_floor_wei) } });
      changes.push({ SetBudget: { chain_id: c.chain_id, max_wei_per_day: BigInt(c.max_wei_per_day), max_tx_per_day: c.max_tx_per_day } });
    }
    changes.push({ SetLimits: { max_gas_limit: BigInt(CFG.max_gas_limit), max_fee_cap: BigInt(CFG.max_fee_cap) } });
    changes.push({ AllowCode: { code_hash: keccak256(factoryInit()).slice(2) } });
    await propose(changes);
  } else if (stage === "apply") {
    const open = new Map(((await view("get_rules")).proposals ?? []).map((p) => [p.id, p]));
    for (const id of state.proposed) {
      const p = open.get(id);
      if (!p) { say(`  rule ${id} no longer open (applied or cancelled)`); continue; }
      const left = Number(p.ready_at) - Date.now() / 1000;
      if (left > 0) { say(`  rule ${id} ready in ${Math.ceil(left)} s`); continue; }
      await call(owner(), "apply_rule", { id });
      say(`  rule ${id} applied`);
    }
    await settle();
    state.proposed = ((await view("get_rules")).proposals ?? []).map((p) => p.id).filter((id) => state.proposed.includes(id));
    keep();
    check(state.proposed.length === 0, state.proposed.length ? `still waiting: ${state.proposed.join(", ")}` : "every proposed rule is applied");
  } else if (stage === "factory") {
    const c = chainOf(process.argv[3] ?? CFG.chains[0].name);
    const client = evm(c);
    const init = factoryInit();
    const f = await client.estimateFeesPerGas();
    const max = f.maxFeePerGas * 2n > BigInt(c.fee_floor_wei) ? f.maxFeePerGas * 2n : BigInt(c.fee_floor_wei);
    const prio = f.maxPriorityFeePerGas < max ? f.maxPriorityFeePerGas : max;
    const ask = { chain_id: c.chain_id, init_code_hex: init, max_fee_per_gas: Number(max), max_priority_fee_per_gas: Number(prio), salt_hex: null, via_factory: null };
    // Gas from the chain's own estimate for this exact deploy from the keyless address, plus a quarter.
    const gas = Number((await client.estimateGas({ account: state.address, data: init })) * 125n / 100n);
    const args = { ...ask, gas_limit: gas };
    const pv = await view("preview", args);
    const mine = serializeTransaction({ type: "eip1559", chainId: c.chain_id, nonce: pv.nonce, data: init, value: 0n,
      gas: BigInt(gas), maxFeePerGas: max, maxPriorityFeePerGas: prio });
    check(pv.unsigned === mine, `the policy's unsigned factory deploy == viem (nonce ${pv.nonce}, gas ${gas})`);
    const balance = await client.getBalance({ address: state.address });
    if (balance < BigInt(gas) * max) throw new Error(`${state.address} on ${c.name} needs ${BigInt(gas) * max} wei, has ${balance}: fund it from a faucet`);
    const out = await call(agent(), "request_deploy", args, "250");
    const raw = result(out);
    if (!raw) throw new Error(`not signed: ${JSON.stringify(await view("get_open"))}`);
    const hash = await client.sendRawTransaction({ serializedTransaction: raw });
    const rc = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
    check(rc.status === "success", `factory deployed by the agent without a key: ${rc.contractAddress} (${c.explorer}/tx/${hash}, ${explorer(out.transaction.hash)})`);
    const served = await client.readContract({ address: rc.contractAddress, abi: F.abi, functionName: "keyfree" });
    check(served.toLowerCase() === state.address, `the factory serves only ${served}`);
    (state.factory ??= {})[c.name] = rc.contractAddress.toLowerCase();
    keep();
    await propose([{ SetFactory: { chain_id: c.chain_id, factory_hex: state.factory[c.name] } }]);
  } else if (stage === "keyfree") {
    const out = {
      near_network: "testnet", near_rpc: CFG.near_rpc, near_explorer: "https://testnet.nearblocks.io",
      policy: P, agent: CFG.agent, owner: CFG.owner, fee_multiplier: 1.2,
      chains: CFG.chains.map((c) => ({ name: c.name, chain_id: c.chain_id, rpc: c.rpc, explorer: c.explorer })),
    };
    fs.writeFileSync(here("keyfree.json"), JSON.stringify(out, null, 2));
    say(`wrote setup/keyfree.json; the agent's key is setup/agent_key.json: KEYFREE_AGENT_KEY=setup/agent_key.json`);
  } else if (stage === "check") {
    const [keys, st, roles, rules] = [await keysOf(P), await view("get_status"), await view("get_roles"), await view("get_rules")];
    check(keys.length === 0, `${P}: ${keys.length} access keys, build ${st.build}, version ${st.version}, paused ${st.paused}`);
    say(`  roles: owner ${roles.owner}, agent ${roles.agent}, guardian ${roles.guardian}, reserve ${roles.reserve}`);
    say(`  allowed code ${rules.allowed_code.length}, gas cap ${rules.max_gas_limit}, fee cap ${rules.max_fee_cap}, open proposals ${(rules.proposals ?? []).length}`);
    for (const c of CFG.chains) {
      const [nonce, budget] = [await view("get_next_nonce", { chain_id: c.chain_id }), await view("get_budget", { chain_id: c.chain_id })];
      say(`  ${c.name}: next nonce ${nonce}, budget ${JSON.stringify(budget)}`);
    }
  } else {
    say(`unknown stage "${stage}"; see the header of setup/policy.mjs`);
  }
} catch (e) {
  check(false, `stage ${stage} stopped: ${String(e.message || e).replace(/\s+/g, " ").slice(0, 300)}`);
}
process.exitCode = fails ? 1 : 0;
