// Keyfree on a second chain: the live policy (policy13, v14) opens Ethereum Sepolia next to Base Sepolia.
// Same policy, same keyless address, the same allow list: Counter(1) is allowed on both chains, Counter(999) on neither.
// One stage per call, results appended to evidence/ethereum.log, progress in evidence/ethereum_state.json.
//   node v14/ethereum.mjs check     read-only: the address's ETH and nonce on Sepolia, what the policy allows
//   open        AllowChain(Sepolia, its nonce, fee floor) + SetFactory(the address CREATE gives at that nonce)
//               through the rules delay
//   factory     deploy KeyfreeFactory keyless with a plain CREATE (gas from the chain's own estimate)
//   counter     Counter(1) through the factory, the code and salt of the Base deploy; Counter(999) refused;
//               confirm refused (NEAR Read MPC does not read Ethereum yet)
import fs from "node:fs";
import { keccak256, getContractAddress, createPublicClient, http, sepolia, formatEther, encodeFunctionData,
  encodeDeployData, serializeTransaction } from "../tools/evm.mjs";
import { loadAccount, provider, explorer, view, teraToGas, Account } from "../tools/near.mjs";

const top = (f) => new URL(`../${f}`, import.meta.url);
const here = (f) => new URL(`./${f}`, import.meta.url);
const CFG = JSON.parse(fs.readFileSync(top(fs.existsSync(here("config.json")) ? "v14/config.json" : "v13/config.json")));
const P = CFG.policy;
const V13 = JSON.parse(fs.readFileSync(top("evidence/v13_state.json")));
const F = JSON.parse(fs.readFileSync(top("factory/factory.json")));
const COUNTER = JSON.parse(fs.readFileSync(top("packages/keyfree/demo/out/Counter.sol/Counter.json")));
const CHAIN = 11155111;
const BASE = 84532;
// Base journal line 6: the Counter(1) a Claude Code session deployed (CLAIMS 3.1). Same salt and code here.
const BASE_COUNTER_NONCE = 6;
// 0.01 gwei: below it a signed transaction could sit in the mempool for good.
const FEE_FLOOR = 10_000_000;
const RPC = process.env.KF_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const eth = createPublicClient({ chain: sepolia, transport: http(RPC) });
const scan = (h) => `https://sepolia.etherscan.io/tx/${h}`;
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
const settle = () => wait(3);

const stateFile = top("evidence/ethereum_state.json");
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : {};
const keep = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
const log = [];
let oks = 0, fails = 0;
const say = (s) => { console.log(s); log.push(s); };
const check = (ok, s) => { ok ? oks++ : fails++; say(`${ok ? "OK  " : "FAIL"} ${s}`); };
const save = () => fs.appendFileSync(top("evidence/ethereum.log"), `--- ${new Date().toISOString()} ${process.argv.slice(2).join(" ")} (${oks} ok, ${fails} fail)\n${log.join("\n")}\n`);

// Signers as in v14/run.mjs (keys never printed, *_key.json is gitignored).
const keyFile = (role) => [here(`${role}_key.json`), top(`v13/${role}_key.json`)].find((f) => fs.existsSync(f));
const signer = (role) => role === "owner" && (CFG.signers.owner ?? "local") === "credentials"
  ? loadAccount(CFG.lab)
  : new Account(role === "owner" ? CFG.lab : CFG.agent, provider, JSON.parse(fs.readFileSync(keyFile(role))).private_key);
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
const hasCode = async (address) => ((await eth.getCode({ address })) ?? "0x").length > 2;

async function fees() {
  const f = await eth.estimateFeesPerGas();
  const max = f.maxFeePerGas * 2n > BigInt(FEE_FLOOR) ? f.maxFeePerGas * 2n : BigInt(FEE_FLOOR);
  return { max_fee_per_gas: Number(max), max_priority_fee_per_gas: Number(f.maxPriorityFeePerGas < max ? f.maxPriorityFeePerGas : max) };
}

// A keyless deploy on Sepolia: the policy's unsigned bytes are compared with viem's before the agent asks.
async function agentDeploy(label, init, salt) {
  const viaFactory = salt !== null;
  const ask = { chain_id: CHAIN, init_code_hex: init, ...(await fees()), salt_hex: salt, via_factory: viaFactory || null };
  const probe = await view(P, "preview", { ...ask, gas_limit: CFG.max_gas_limit });
  const to = viaFactory ? state.factory : undefined;
  const data = viaFactory ? encodeFunctionData({ abi: F.abi, functionName: "deploy", args: [salt, init] }) : init;
  // Real gas: the chain simulates the call from our address, +25 % (as the keyfree tool does). Creating a
  // contract costs about 6 times more gas on Ethereum Sepolia than on Base Sepolia, so a formula is not enough.
  const est = await eth.estimateGas({ account: V13.address, to, data });
  const args = { ...ask, gas_limit: Math.min(CFG.max_gas_limit, Math.max(probe.min_gas, Number((est * 125n) / 100n))) };
  const pv = await view(P, "preview", args);
  const mine = serializeTransaction({ type: "eip1559", chainId: CHAIN, nonce: pv.nonce, to, data, value: 0n,
    gas: BigInt(args.gas_limit), maxFeePerGas: BigInt(args.max_fee_per_gas), maxPriorityFeePerGas: BigInt(args.max_priority_fee_per_gas) });
  check(pv.unsigned === mine, `${label}: unsigned tx built by the contract == viem (chain ${CHAIN}, nonce ${pv.nonce})`);
  const out = await act("agent", "request_deploy", args, "250");
  const raw = result(out);
  if (!raw) throw new Error(`${label}: not signed ${JSON.stringify(await view(P, "get_open"))}`);
  const hash = await eth.sendRawTransaction({ serializedTransaction: raw });
  const rc = await eth.waitForTransactionReceipt({ hash, timeout: 300_000 });
  check(rc.status === "success", `${label}: landed, gas ${rc.gasUsed} of ${args.gas_limit}  ${explorer(out.transaction.hash)}  ${scan(hash)}`);
  return { rc, nonce: pv.nonce, address: viaFactory ? pv.expected_address : getContractAddress({ from: V13.address, nonce: BigInt(pv.nonce) }).toLowerCase() };
}

const stage = process.argv[2];
try {
  if (stage === "check") {
    const n = await eth.getTransactionCount({ address: V13.address });
    say(`${V13.address} on Sepolia: ${formatEther(await eth.getBalance({ address: V13.address }))} ETH, nonce ${n}`);
    say(`policy next nonce on Sepolia: ${await view(P, "get_next_nonce", { chain_id: CHAIN })}; factory slot at nonce 0: ${getContractAddress({ from: V13.address, nonce: 0n }).toLowerCase()}`);
  } else if (stage === "open") {
    const n = await eth.getTransactionCount({ address: V13.address });
    const factory = getContractAddress({ from: V13.address, nonce: BigInt(n) }).toLowerCase();
    check(n !== 0 || factory === V13.factory, `the factory will land at ${factory}${factory === V13.factory ? ", the same address as on Base" : ""}`);
    if ((await view(P, "get_next_nonce", { chain_id: CHAIN })) === null) {
      const changes = [{ AllowChain: { chain_id: CHAIN, next_nonce: n, min_fee_per_gas: FEE_FLOOR } }, { SetFactory: { chain_id: CHAIN, factory_hex: factory } }];
      await refused("agent opens a chain itself", () => act("agent", "propose_rule", { change: changes[0] }),
        ["does not allow method", "MethodNameMismatch", "not allowed"]);
      const ids = [];
      for (const change of changes) ids.push(result(await act("owner", "propose_rule", { change })));
      say(`proposed rules ${ids.join(", ")}: AllowChain(${CHAIN}, nonce ${n}, floor ${FEE_FLOOR} wei), SetFactory(${factory})`);
      await refused("apply before the rules delay", () => act("owner", "apply_rule", { id: ids[0] }), "rule delay not over");
      say(`waiting ${CFG.rules_delay_sec + 5} s for the rules delay`);
      await wait(CFG.rules_delay_sec + 5);
      for (const id of ids) await act("owner", "apply_rule", { id });
      await settle();
      state.rules = ids;
      state.factory = factory;
      keep();
    }
    check((await view(P, "get_next_nonce", { chain_id: CHAIN })) === n, `Sepolia is open in the policy at nonce ${n}`);
  } else if (stage === "factory") {
    // The first try (nonce 0) ran out of gas: it was given 398 043 gas from a formula, the chain needed about
    // 1.26 M. A reverted creation still spends its nonce, so the factory goes to the next nonce, through a
    // new SetFactory rule and the rules delay.
    if (!(await hasCode(state.factory))) {
      const n = await eth.getTransactionCount({ address: V13.address });
      const next = getContractAddress({ from: V13.address, nonce: BigInt(n) }).toLowerCase();
      if (next !== state.factory) {
        const change = { SetFactory: { chain_id: CHAIN, factory_hex: next } };
        const id = result(await act("owner", "propose_rule", { change }));
        say(`proposed rule ${id}: SetFactory(${next}) for nonce ${n}`);
        await refused("apply before the rules delay", () => act("owner", "apply_rule", { id }), "rule delay not over");
        say(`waiting ${CFG.rules_delay_sec + 5} s for the rules delay`);
        await wait(CFG.rules_delay_sec + 5);
        await act("owner", "apply_rule", { id });
        await settle();
        state.rules = [...(state.rules ?? []), id];
        state.factory = next;
        keep();
      }
      const r = await agentDeploy("KeyfreeFactory", V13.factoryInit, null);
      check(r.address === state.factory, `factory at the promised address ${r.address}`);
      Object.assign(state, { factory_tx: r.rc.transactionHash, factory_nonce: r.nonce });
      keep();
    }
    const owner = await eth.readContract({ address: state.factory, abi: F.abi, functionName: "keyfree" });
    check(owner.toLowerCase() === V13.address, `factory ${state.factory}: keyfree() = the policy's keyless address`);
  } else if (stage === "counter") {
    const base = await view(P, "get_entry", { chain_id: BASE, nonce: BASE_COUNTER_NONCE });
    const init = encodeDeployData({ abi: COUNTER.abi, bytecode: COUNTER.bytecode.object, args: [1n] });
    check(keccak256(init).slice(2) === base.code_hash, `Counter(1) init code hash ${base.code_hash.slice(0, 8)}... is the one deployed on Base at ${base.address}`);
    const at = getContractAddress({ opcode: "CREATE2", from: state.factory, salt: base.salt, bytecode: init }).toLowerCase();
    if (!(await hasCode(at))) {
      const r = await agentDeploy("Counter(1)", init, base.salt);
      check(r.address === at, `Counter(1) at the promised address ${at}`);
      Object.assign(state, { counter: r.address, counter_tx: r.rc.transactionHash, counter_nonce: r.nonce });
      keep();
    }
    const n = await eth.readContract({ address: at, abi: COUNTER.abi, functionName: "number" });
    check(n === 1n, `Counter at ${at} on Ethereum Sepolia, from the same keyless address as on Base; number() = ${n}`);
    const other = encodeDeployData({ abi: COUNTER.abi, bytecode: COUNTER.bytecode.object, args: [999n] });
    await refused("Counter(999) on Sepolia", async () => view(P, "preview", { chain_id: CHAIN, init_code_hex: other, gas_limit: 1_000_000, ...(await fees()), salt_hex: null, via_factory: null }), "code not on the allow list");
    const rc = await eth.getTransactionReceipt({ hash: state.counter_tx });
    const lg = rc.logs.find((l) => l.address.toLowerCase() === state.factory);
    const where = { log_index: lg.logIndex, transaction_index: rc.transactionIndex, block_hash: rc.blockHash, block_number: Number(rc.blockNumber) };
    await refused("confirm on Sepolia (NEAR Read MPC does not read Ethereum yet)", () => act("agent", "confirm", { chain_id: CHAIN, nonce: state.counter_nonce, log: where, finality: "Safe" }, "200"), "Read MPC does not cover this chain");
  } else {
    console.log("stages: check | open | factory | counter");
  }
} catch (e) {
  check(false, `stopped: ${String(e.message || e).replace(/\s+/g, " ").slice(0, 300)}`);
}
save();
process.exit(fails ? 1 : 0);
