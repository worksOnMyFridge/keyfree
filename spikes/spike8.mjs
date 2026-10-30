// Spike S12, v6 on testnet: keyless self-upgrade, then
// (1) close the nonce gap left by the 48 KB tx that Base refused (its gas limit 1.5 M < intrinsic ~2 M,
//     so that signed tx can never become valid; the owner re-syncs the nonce),
// (2) 48 KB init code through the factory with enough gas,
// (3) gas below the intrinsic minimum is refused before signing,
// (4) an underpriced deploy that the chain does not take is healed by resign(): same nonce + content, new fees.
import fs from "node:fs";
import crypto from "node:crypto";
import { keccak256, toHex, getContractAddress, createPublicClient, http, baseSepolia, formatEther } from "../tools/evm.mjs";
import { loadAccount, provider, explorer, view, teraToGas, Account, actions } from "../tools/near.mjs";

const LAB = "keyfree-lab.testnet", POLICY = `policy.${LAB}`, AGENT = `agent.${LAB}`, CHAIN = baseSepolia.id;
const stateFile = new URL("../evidence/spike5_state.json", import.meta.url);
const state = JSON.parse(fs.readFileSync(stateFile));
const D = fs.readFileSync(new URL("../keyfree_v6d.opt.wasm", import.meta.url));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const log = [];
const say = (s) => { console.log(s); log.push(s); };
const owner = loadAccount(LAB);
const agent = new Account(AGENT, provider, JSON.parse(fs.readFileSync(new URL("../agent_contract_key.json", import.meta.url))).private_key);
const base = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const call = (who, methodName, args, gas = "30") => who.callFunctionRaw({ contractId: POLICY, methodName, args, gas: teraToGas(gas) });
const result = (out) => JSON.parse(Buffer.from(out.status.SuccessValue, "base64").toString() || "null");
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
const refused = async (name, fn, reason) => {
  try { await fn(); say(`FAIL ${name}: was allowed`); }
  catch (e) { const m = String(e.message || e); say(`${m.includes(reason) ? "OK  " : "FAIL"} ${name} -> ${m.replace(/\s+/g, " ").slice(0, 140)}`); }
};
const TINY = "600a600c600039600a6000f3602a60005260206000f3";

if (process.argv[2] !== "skip-upgrade") {
  await call(owner, "propose_upgrade", { code_sha256: sha(D) });
  await wait(65);
  const up = await owner.signAndSendTransaction({ receiverId: POLICY, actions: [actions.functionCall("apply_upgrade", D, teraToGas("300"), 0n)] });
  await wait(3);
  const st = await view(POLICY, "get_status");
  say(`${st.build === "d" ? "OK  " : "FAIL"} keyless upgrade to v6: build ${st.build}, version ${st.version}  ${explorer(up.transaction.hash)}`);
}

// (1) gap: contract says next nonce 6, Base says 5; the nonce-5 tx is permanently invalid
const chainNonce = await base.getTransactionCount({ address: state.address });
say(`before: contract next ${await view(POLICY, "get_next_nonce", { chain_id: CHAIN })}, Base ${chainNonce}`);
await call(owner, "allow_chain", { chain_id: CHAIN, next_nonce: chainNonce });
say(`owner re-synced the nonce to ${chainNonce} (safe only because the signed nonce-${chainNonce} tx is below intrinsic gas forever)`);

async function deploy(label, init, { gas, fee, prio, send = true } = {}) {
  const salt = keccak256(toHex(`${label}-${Date.now()}`));
  const fees = await base.estimateFeesPerGas();
  const args = { chain_id: CHAIN, init_code_hex: init, gas_limit: gas, max_fee_per_gas: fee ?? Number(fees.maxFeePerGas * 2n), max_priority_fee_per_gas: prio ?? Number(fees.maxPriorityFeePerGas), salt_hex: salt, via_factory: true };
  const pv = await view(POLICY, "preview", args).catch(() => null);
  const raw = result(await call(agent, "request_deploy", args, "300"));
  let hash = null, err = null;
  if (send) hash = await base.sendRawTransaction({ serializedTransaction: raw }).catch((e) => { err = e.shortMessage || e.message; return null; });
  return { salt, nonce: pv?.nonce, min_gas: pv?.min_gas, raw, hash, err, init };
}
const check = async (label, d, hash) => {
  const rc = await base.waitForTransactionReceipt({ hash, timeout: 180_000 });
  const addr = getContractAddress({ opcode: "CREATE2", from: state.factory, salt: d.salt, bytecode: d.init });
  const ok = rc.status === "success" && BigInt((await base.call({ to: addr })).data) === 42n;
  say(`${ok ? "OK  " : "FAIL"} ${label}: nonce ${d.nonce}, Base gas ${rc.gasUsed} (min ${d.min_gas}), cost ${formatEther(rc.gasUsed * rc.effectiveGasPrice)} ETH  https://sepolia.basescan.org/tx/${hash}`);
};

// (3) below intrinsic: refused before anything is signed
const big = "0x" + TINY + crypto.randomBytes(49152 - TINY.length / 2).toString("hex");
await call(owner, "allow_code", { code_hash: keccak256(big).slice(2) });
await refused("48 KB with 1.5 M gas (below intrinsic)", () => call(agent, "request_deploy", { chain_id: CHAIN, init_code_hex: big, gas_limit: 1_500_000, max_fee_per_gas: 10_000_000, max_priority_fee_per_gas: 1_000_000, salt_hex: keccak256(toHex("x")), via_factory: true }, "300"), "gas limit below the intrinsic minimum");

// (2) 48 KB with enough gas
const min = (await view(POLICY, "preview", { chain_id: CHAIN, init_code_hex: big, gas_limit: 2_900_000, max_fee_per_gas: 10_000_000, max_priority_fee_per_gas: 1_000_000, salt_hex: keccak256(toHex("y")), via_factory: true })).min_gas;
const b = await deploy("big48", big, { gas: Math.min(2_900_000, Math.ceil(min * 1.05) + 200_000) });
say(`48 KB intrinsic minimum computed by the contract: ${min}`);
if (b.hash) await check("48 KB through the factory", b, b.hash); else say(`FAIL 48 KB not accepted: ${b.err}`);

// (4) underpriced: fee 1 wei, the chain does not take it -> resign with real fees, same nonce + content
const u = await deploy("underpriced", "0x" + TINY, { gas: 300_000, fee: 1, prio: 1 });
say(`underpriced deploy nonce ${u.nonce}: Base says ${u.hash ? "accepted into the pool (will never be mined at 1 wei)" : u.err}`);
const fees = await base.estimateFeesPerGas();
const fixed = result(await call(agent, "resign", { chain_id: CHAIN, nonce: u.nonce, init_code_hex: u.init, gas_limit: 300_000, max_fee_per_gas: Number(fees.maxFeePerGas * 3n), max_priority_fee_per_gas: Number(fees.maxPriorityFeePerGas * 3n) }, "300"));
const h2 = await base.sendRawTransaction({ serializedTransaction: fixed });
await check("resigned with real fees (same nonce and content)", u, h2);
say(`after: contract next ${await view(POLICY, "get_next_nonce", { chain_id: CHAIN })}, Base ${await base.getTransactionCount({ address: state.address })}, open ${JSON.stringify(await view(POLICY, "get_open"))}; ETH left ${formatEther(await base.getBalance({ address: state.address }))}`);
fs.appendFileSync(new URL("../evidence/spike8.log", import.meta.url), `--- ${new Date().toISOString()}\n${log.join("\n")}\n`);
