// Spike S12: (1) keyless self-upgrade of policy.keyfree-lab.testnet to v5 (late-answer fix),
// (2) golden RLP on real deploys through the factory with init code of 1 KB, 24 KB and 48 KB (EIP-3860
// limit): contract bytes == viem, tx lands, code is right, and the NEAR callback gas stays inside 50 Tgas.
import fs from "node:fs";
import crypto from "node:crypto";
import { keccak256, toHex, getContractAddress, createPublicClient, http, baseSepolia, encodeFunctionData, serializeTransaction, formatEther } from "../tools/evm.mjs";
import { loadAccount, provider, explorer, view, teraToGas, parseNearAmount, Account, actions } from "../tools/near.mjs";

const LAB = "keyfree-lab.testnet", POLICY = `policy.${LAB}`, AGENT = `agent.${LAB}`, CHAIN = baseSepolia.id;
const F = JSON.parse(fs.readFileSync(new URL("./factory/factory.json", import.meta.url)));
const stateFile = new URL("./evidence/spike5_state.json", import.meta.url);
const state = JSON.parse(fs.readFileSync(stateFile));
const C = fs.readFileSync(new URL("./keyfree_v5c.opt.wasm", import.meta.url));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const log = [];
const say = (s) => { console.log(s); log.push(s); };
const owner = loadAccount(LAB);
const agent = new Account(AGENT, provider, JSON.parse(fs.readFileSync(new URL("./agent_contract_key.json", import.meta.url))).private_key);
const base = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const call = (who, methodName, args, gas = "30") => who.callFunctionRaw({ contractId: POLICY, methodName, args, gas: teraToGas(gas) });
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));

if (process.argv[2] !== "skip-upgrade") {
  // top-up needs no key on the policy account: anyone can send NEAR for storage
  await owner.transfer({ receiverId: POLICY, amount: parseNearAmount("1") });
  await call(owner, "propose_upgrade", { code_sha256: sha(C) });
  say(`proposed v5 ${sha(C).slice(0, 12)}…, waiting for the delay`);
  await wait(65);
  const up = await owner.signAndSendTransaction({ receiverId: POLICY, actions: [actions.functionCall("apply_upgrade", C, teraToGas("300"), 0n)] });
  await wait(3);
  const st = await view(POLICY, "get_status");
  say(`${st.build === "c" ? "OK  " : "FAIL"} keyless upgrade to v5: build ${st.build}, version ${st.version}, keys ${(await provider.viewAccessKeyList({ accountId: POLICY })).keys.length}  ${explorer(up.transaction.hash)}`);
}

// init code = the tiny deployer (returns a 10-byte runtime) + never-executed padding up to `size`
const TINY = "600a600c600039600a6000f3602a60005260206000f3";
const initOf = (size) => "0x" + TINY + crypto.randomBytes(size - TINY.length / 2).toString("hex");
state.big = state.big || [];
for (const size of [1024, 24576, 49152]) {
  const init = initOf(size);
  await call(owner, "allow_code", { code_hash: keccak256(init).slice(2) });
  const salt = keccak256(toHex(`big-${size}-${Date.now()}`));
  const fees = await base.estimateFeesPerGas();
  const args = { chain_id: CHAIN, init_code_hex: init, gas_limit: 1_500_000, max_fee_per_gas: Number(fees.maxFeePerGas * 2n), max_priority_fee_per_gas: Number(fees.maxPriorityFeePerGas), salt_hex: salt, via_factory: true };
  const pv = await view(POLICY, "preview", args);
  const mine = serializeTransaction({ type: "eip1559", chainId: CHAIN, nonce: pv.nonce, to: state.factory, value: 0n, gas: 1_500_000n,
    data: encodeFunctionData({ abi: F.abi, functionName: "deploy", args: [salt, init] }), maxFeePerGas: BigInt(args.max_fee_per_gas), maxPriorityFeePerGas: BigInt(args.max_priority_fee_per_gas) });
  const out = await call(agent, "request_deploy", args, "300");
  const raw = JSON.parse(Buffer.from(out.status.SuccessValue, "base64").toString());
  const cb = out.receipts_outcome.filter((r) => r.outcome.executor_id === POLICY).at(-1);
  const rc = await base.waitForTransactionReceipt({ hash: await base.sendRawTransaction({ serializedTransaction: raw }), timeout: 120_000 });
  const addr = getContractAddress({ opcode: "CREATE2", from: state.factory, salt, bytecode: init });
  const ok = rc.status === "success" && pv.unsigned === mine && pv.expected_address === addr.toLowerCase() && BigInt((await base.call({ to: addr })).data) === 42n;
  const lg = rc.logs.find((l) => l.address.toLowerCase() === state.factory);
  say(`${ok ? "OK  " : "FAIL"} init ${size} B: bytes==viem ${pv.unsigned === mine}, landed ${rc.status}, call(42) at promised address; Base gas ${rc.gasUsed}, cost ${formatEther(rc.gasUsed * rc.effectiveGasPrice)} ETH; NEAR callback ${(Number(cb.outcome.gas_burnt) / 1e12).toFixed(1)} of 50 Tgas  https://sepolia.basescan.org/tx/${rc.transactionHash}`);
  state.big.push({ size, nonce: pv.nonce, log_index: lg.logIndex, transaction_index: rc.transactionIndex, block_hash: rc.blockHash, block_number: Number(rc.blockNumber) });
}
fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
say(`ETH left ${formatEther(await base.getBalance({ address: state.address }))}`);
fs.appendFileSync(new URL("./evidence/spike7.log", import.meta.url), `--- ${new Date().toISOString()}\n${log.join("\n")}\n`);
