// Spike S12, audit item 4: own CREATE2 factory + journal confirmed by Read MPC.
// Stages (argv[2]): near   — create policy/agent accounts under keyfree-lab.testnet, deploy v3, derive address, rules
//                   base   — keyless deploy of KeyfreeFactory, register it, keyless deploy through it, checks
//                   confirm <nonce> [Safe|Finalized] — wait until the block is safe, then ask the contract to confirm via Read MPC
import fs from "node:fs";
import { keccak256, toHex, getContractAddress, createPublicClient, http, baseSepolia, formatEther, recoverTransactionAddress,
  encodeFunctionData, encodeDeployData, serializeTransaction, decodeEventLog, privateKeyToAccount, generatePrivateKey } from "./tools/evm.mjs";
import { loadAccount, provider, explorer, view, KeyPair, teraToGas, parseNearAmount, Account, actions } from "./tools/near.mjs";

const LAB = "keyfree-lab.testnet", POLICY = `policy.${LAB}`, AGENT = `agent.${LAB}`;
const MPC = "v1.signer-prod.testnet", CHAIN = baseSepolia.id;
const INIT = "0x600a600c600039600a6000f3602a60005260206000f3", RUNTIME = "0x602a60005260206000f3";
const F = JSON.parse(fs.readFileSync(new URL("./factory/factory.json", import.meta.url)));
const scan = (h) => `https://sepolia.basescan.org/tx/${h}`;
const stateFile = new URL("./evidence/spike5_state.json", import.meta.url);
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : {};
const keep = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
const log = [];
const say = (s) => { console.log(s); log.push(s); };
const save = () => fs.appendFileSync(new URL("./evidence/spike5.log", import.meta.url), `--- ${new Date().toISOString()} ${process.argv.slice(2).join(" ")}\n${log.join("\n")}\n`);
const owner = loadAccount(LAB);
const base = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const keyFile = (p) => new URL(`./${p}_contract_key.json`, import.meta.url); // spike-only keys, never printed
const accountOf = (id, prefix) => new Account(id, provider, JSON.parse(fs.readFileSync(keyFile(prefix))).private_key);
const call = (who, methodName, args, gas = "30", deposit = 0n) => who.callFunctionRaw({ contractId: POLICY, methodName, args, gas: teraToGas(gas), deposit });
const result = (out) => JSON.parse(Buffer.from(out.status.SuccessValue, "base64").toString() || "null");

async function sub(prefix, near) {
  if (fs.existsSync(keyFile(prefix))) return;
  const kp = KeyPair.fromRandom("ed25519");
  fs.writeFileSync(keyFile(prefix), JSON.stringify({ private_key: kp.toString() }));
  const o = await owner.createSubAccount({ accountOrPrefix: prefix, publicKey: kp.getPublicKey(), nearToTransfer: parseNearAmount(near) });
  say(`created ${prefix}.${LAB} ${explorer(o.transaction.hash)}`);
}

async function agentDeploy(label, init, opts = {}) {
  const agent = accountOf(AGENT, "agent");
  const fees = await base.estimateFeesPerGas();
  const args = { chain_id: CHAIN, init_code_hex: init, gas_limit: opts.gas || 300000, max_fee_per_gas: Number(fees.maxFeePerGas * 2n),
    max_priority_fee_per_gas: Number(fees.maxPriorityFeePerGas), salt_hex: opts.salt || null, via_factory: opts.viaFactory || null };
  const pv = await view(POLICY, "preview", args);
  if (opts.viaFactory) { // contract encoding of the factory call must match viem
    const data = encodeFunctionData({ abi: F.abi, functionName: "deploy", args: [opts.salt, init] });
    const mine = serializeTransaction({ type: "eip1559", chainId: CHAIN, nonce: pv.nonce, to: state.factory, data, value: 0n, gas: BigInt(args.gas_limit),
      maxFeePerGas: BigInt(args.max_fee_per_gas), maxPriorityFeePerGas: BigInt(args.max_priority_fee_per_gas) });
    const predicted = getContractAddress({ opcode: "CREATE2", from: state.factory, salt: opts.salt, bytecode: init }).toLowerCase();
    say(`${pv.unsigned === mine ? "OK  " : "FAIL"} factory-call encoding == viem; ${pv.expected_address === predicted ? "OK  " : "FAIL"} expected address ${pv.expected_address}`);
  }
  const t0 = Date.now();
  const out = await call(agent, "request_deploy", args, "250");
  const raw = result(out);
  if (!raw) { say(`FAIL ${label}: not signed ${JSON.stringify(await view(POLICY, "get_open"))}`); return null; }
  const hash = await base.sendRawTransaction({ serializedTransaction: raw });
  const rc = await base.waitForTransactionReceipt({ hash, timeout: 120_000 });
  say(`${rc.status === "success" ? "OK  " : "FAIL"} ${label}: signed in ${((Date.now() - t0) / 1000).toFixed(1)} s, nonce ${pv.nonce}, gas ${rc.gasUsed}  ${explorer(out.transaction.hash)}  ${scan(hash)}`);
  return { rc, nonce: pv.nonce, expected: pv.expected_address, from: await recoverTransactionAddress({ serializedTransaction: raw }) };
}

const stage = process.argv[2];
if (stage === "near") {
  await sub("policy", "3");
  await sub("agent", "0.5");
  const policy = accountOf(POLICY, "policy");
  const d = await policy.signAndSendTransaction({ receiverId: POLICY, actions: [
    actions.deployContract(fs.readFileSync(new URL("./keyfree.opt.wasm", import.meta.url))),
    actions.functionCall("new", { owner: LAB, agent: AGENT, mpc: MPC, path: "keyfree-1" }, teraToGas("30"), 0n),
  ] });
  say(`v3 deployed + init ${explorer(d.transaction.hash)}`);
  state.address = result(await call(owner, "setup", {}, "60"));
  say(`address derived on-chain: ${state.address}`);
  // allow-list = exact init code incl. constructor args, so the factory is bound to our address (A3)
  state.factoryInit = encodeDeployData({ abi: F.abi, bytecode: F.bytecode, args: [state.address] });
  await call(owner, "allow_code", { code_hash: keccak256(state.factoryInit).slice(2) });
  await call(owner, "allow_code", { code_hash: keccak256(INIT).slice(2) });
  await call(owner, "allow_chain", { chain_id: CHAIN, next_nonce: await base.getTransactionCount({ address: state.address }) });
  say(`rules set: factory init ${keccak256(state.factoryInit).slice(0, 14)}…, tiny init ${keccak256(INIT).slice(0, 14)}…`);
  keep();
} else if (stage === "base") {
  say(`ETH on ${state.address}: ${formatEther(await base.getBalance({ address: state.address }))}`);
  if (!state.factory) {
    const r = await agentDeploy("keyless deploy of KeyfreeFactory", state.factoryInit, { gas: 400000 });
    state.factory = r.rc.contractAddress.toLowerCase();
    const k = await base.readContract({ address: state.factory, abi: F.abi, functionName: "keyfree" });
    say(`${k.toLowerCase() === state.address ? "OK  " : "FAIL"} factory ${state.factory} serves only ${k}`);
    await call(owner, "set_factory", { chain_id: CHAIN, factory_hex: state.factory });
    keep();
  }
  // a stranger cannot use the factory (so nobody can take our planned addresses)
  const stranger = privateKeyToAccount(generatePrivateKey()).address;
  const salt = keccak256(toHex(`keyfree-factory-${Date.now()}`));
  await base.call({ account: stranger, to: state.factory, data: encodeFunctionData({ abi: F.abi, functionName: "deploy", args: [salt, INIT] }) })
    .then(() => say("FAIL stranger could call the factory"))
    .catch((e) => say(`${String(e.shortMessage || e.message).includes("only keyfree") ? "OK  " : "FAIL"} stranger calls the factory -> ${String(e.shortMessage || e.message).slice(0, 90)}`));
  const r = await agentDeploy("keyless deploy THROUGH the factory", INIT, { salt, viaFactory: true });
  const lg = r.rc.logs.find((l) => l.address.toLowerCase() === state.factory);
  const ev = decodeEventLog({ abi: F.abi, data: lg.data, topics: lg.topics });
  const ok = ev.args.addr.toLowerCase() === r.expected && (await base.getCode({ address: r.expected })) === RUNTIME && BigInt((await base.call({ to: r.expected })).data) === 42n;
  say(`${ok ? "OK  " : "FAIL"} Deployed(${ev.args.addr}) at log ${lg.logIndex}, block ${r.rc.blockNumber}; code + call(42) at the address the contract promised`);
  say(`journal: ${JSON.stringify(await view(POLICY, "get_entry", { chain_id: CHAIN, nonce: r.nonce }))}`);
  state.last = { nonce: r.nonce, tx: r.rc.transactionHash, log_index: lg.logIndex, transaction_index: r.rc.transactionIndex, block_hash: r.rc.blockHash, block_number: Number(r.rc.blockNumber) };
  keep();
} else if (stage === "confirm") {
  const nonce = Number(process.argv[3] ?? state.last.nonce), finality = process.argv[4] || "Safe";
  const L = state.last;
  const tag = finality === "Finalized" ? "finalized" : finality === "Safe" ? "safe" : "latest";
  for (;;) {
    const b = await base.getBlock({ blockTag: tag });
    if (b.number >= BigInt(L.block_number)) break;
    say(`waiting: ${tag} block ${b.number}, ours ${L.block_number} (${Number(BigInt(L.block_number) - b.number)} blocks to go)`);
    await new Promise((r) => setTimeout(r, 60_000));
  }
  const agent = accountOf(AGENT, "agent");
  const t0 = Date.now();
  try {
    const wrong = process.argv[5] === "wrong"; // forged position: block number + 1
    if (wrong) say("sending a FORGED log position (block number + 1): must NOT be confirmed");
    const out = await call(agent, "confirm", { chain_id: CHAIN, nonce, log: { log_index: L.log_index, transaction_index: L.transaction_index, block_hash: L.block_hash, block_number: L.block_number + (wrong ? 1 : 0) }, finality }, "200");
    for (const r of out.receipts_outcome) for (const l of r.outcome.logs) if (l.startsWith("keyfree")) say(`log: ${l}`);
    say(`confirm (${finality}) answered ${result(out)} in ${((Date.now() - t0) / 1000).toFixed(1)} s  ${explorer(out.transaction.hash)}`);
  } catch (e) { say(`confirm (${finality}) error after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${String(e.message).replace(/\s+/g, " ").slice(0, 300)}`); }
  say(`journal: ${JSON.stringify(await view(POLICY, "get_entry", { chain_id: CHAIN, nonce }))}`);
}
save();
