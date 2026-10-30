// Spike S12 (Keyfree), experiment 1: deploy the policy contract on testnet, let it build an
// EIP-1559 contract-creation tx for Base Sepolia, get it signed by the NEAR MPC through a
// cross-contract call, and check the result independently with viem. Nothing is broadcast.
import fs from "node:fs";
import { keccak256, serializeTransaction, parseTransaction, recoverTransactionAddress, getContractAddress, createPublicClient, http, baseSepolia } from "./tools/evm.mjs";
import { loadAccount, ACCOUNT, provider, explorer, gasUsed, view, KeyPair, teraToGas, parseNearAmount, Account } from "./tools/near.mjs";

const MPC = "v1.signer-prod.testnet", PATH = "keyfree-1", PREFIX = process.env.KF_PREFIX || "keyfree";
const CONTRACT = `${PREFIX}.${ACCOUNT}`;
const CHAIN = baseSepolia.id; // 84532
// init code that deploys a 10-byte runtime returning 42
const INIT = "0x600a600c600039600a6000f3602a60005260206000f3";
const EVIL = "0x600a600c600039600a6000f3602a60005260206000ff"; // same shape, ends in SELFDESTRUCT
const owner = loadAccount();
const keyFile = new URL(`./${PREFIX}_contract_key.json`, import.meta.url); // spike-only key, never printed
const evidence = [];
fs.mkdirSync(new URL("./evidence/", import.meta.url), { recursive: true });

const step = async (name, fn, mustFail = null) => { // mustFail = expected refusal text
  const t0 = Date.now();
  try {
    const out = await fn();
    const hash = out?.transaction?.hash;
    const line = `${mustFail ? "BAD " : "OK  "} ${name}  ${Date.now() - t0} ms${hash ? `  gas ${(gasUsed(out) / 1e12).toFixed(2)} Tgas  ${explorer(hash)}` : ""}`;
    console.log(line); evidence.push(line);
    return out;
  } catch (e) {
    const msg = String(e.message || e);
    const ok = mustFail && msg.includes(mustFail);
    const line = `${ok ? "OK  " : "FAIL"} ${name}  -> ${msg.replace(/\s+/g, " ").slice(0, 200)}`;
    console.log(line); evidence.push(line);
    return null;
  }
};

// 1. the ETH address that only this contract (as predecessor) can make the MPC sign for
const b58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58dec = (s) => { let n = 0n; for (const c of s) n = n * 58n + BigInt(b58.indexOf(c)); return Buffer.from(n.toString(16).padStart(128, "0"), "hex"); };
const derived = await view(MPC, "derived_public_key", { path: PATH, predecessor: CONTRACT, domain_id: 0 });
const ethAddr = "0x" + keccak256(b58dec(derived.split(":")[1])).slice(-40);
console.log("MPC-derived ETH address of the contract:", ethAddr);

const base = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const nonce = await base.getTransactionCount({ address: ethAddr });
const fees = await base.estimateFeesPerGas();
const tx = { gas: 200_000n, maxFeePerGas: fees.maxFeePerGas * 2n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
console.log(`Base Sepolia nonce ${nonce}, maxFee ${tx.maxFeePerGas} wei`);

// 2. create + deploy + init + rules
let kp;
if (!fs.existsSync(keyFile)) {
  kp = KeyPair.fromRandom("ed25519");
  fs.writeFileSync(keyFile, JSON.stringify({ private_key: kp.toString() }));
  await step(`create ${CONTRACT}`, () => owner.createSubAccount({ accountOrPrefix: PREFIX, publicKey: kp.getPublicKey(), nearToTransfer: parseNearAmount("2.3") }));
} else kp = KeyPair.fromString(JSON.parse(fs.readFileSync(keyFile)).private_key);
const contract = new Account(CONTRACT, provider, kp.toString());
const call = (who, methodName, args, gas = "30") => who.callFunctionRaw({ contractId: CONTRACT, methodName, args, gas: teraToGas(gas) });

if (process.argv[2] !== "skip-deploy") {
  await step("deploy", () => contract.deployContract(fs.readFileSync(new URL("./keyfree.opt.wasm", import.meta.url))));
  await step("init", () => call(contract, "new", { owner: ACCOUNT, agent: ACCOUNT, mpc: MPC, path: PATH, eth_address: ethAddr }));
  await step("owner allows the init code hash", () => call(owner, "allow_code", { code_hash: keccak256(INIT).slice(2) }));
  await step(`owner allows chain ${CHAIN}`, () => call(owner, "allow_chain", { chain_id: CHAIN, next_nonce: nonce }));
  await new Promise((r) => setTimeout(r, 2000));
}

const req = (code, over = {}) => ({ chain_id: CHAIN, init_code_hex: code, gas_limit: Number(tx.gas), max_fee_per_gas: Number(tx.maxFeePerGas), max_priority_fee_per_gas: Number(tx.maxPriorityFeePerGas), ...over });

// 3. attacks that must be refused before anything is signed
await step("stranger changes the rules (must FAIL)", () => call(contract, "allow_code", { code_hash: keccak256(EVIL).slice(2) }), "only owner");
await step("agent asks to deploy code not on the list (must FAIL)", () => call(owner, "request_deploy", req(EVIL), "300"), "code not on the allow list");
await step("agent asks for a chain not allowed (must FAIL)", () => call(owner, "request_deploy", req(INIT, { chain_id: 1 }), "300"), "chain not allowed");
await step("agent sets a gas price over the cap (must FAIL)", () => call(owner, "request_deploy", req(INIT, { max_fee_per_gas: 9e11 }), "300"), "gas price over the cap");
await step("stranger asks to deploy (must FAIL)", () => call(contract, "request_deploy", req(INIT), "300"), "only agent or owner");

// 4. the contract's own encoding must match viem byte for byte
const pv = await view(CONTRACT, "preview", req(INIT));
const viemUnsigned = serializeTransaction({ type: "eip1559", chainId: CHAIN, nonce: pv.nonce, data: INIT, value: 0n, ...tx });
const same = pv.unsigned === viemUnsigned;
console.log("contract encoding == viem encoding:", same); evidence.push(`encoding matches viem: ${same}`);

// 5. the real thing: contract -> MPC sign -> callback returns the signed raw tx
const t0 = Date.now();
const out = await step("agent requests deploy, contract asks MPC to sign", () => call(owner, "request_deploy", req(INIT), "300"));
const secs = ((Date.now() - t0) / 1000).toFixed(1);
let raw = out?.status?.SuccessValue ? JSON.parse(Buffer.from(out.status.SuccessValue, "base64").toString()) : null;
if (out) for (const r of out.receipts_outcome) for (const l of r.outcome.logs) if (l.startsWith("keyfree")) console.log("log:", l);
if (!raw) raw = await view(CONTRACT, "get_last_signed").catch(() => null);
console.log(`signed raw tx after ${secs} s:`, raw ? raw.slice(0, 40) + "…" : null);
if (raw) {
  const parsed = parseTransaction(raw);
  const from = await recoverTransactionAddress({ serializedTransaction: raw });
  const lowS = BigInt(parsed.s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
  const checks = {
    recovered_from: from,
    from_is_contract_address: from.toLowerCase() === ethAddr,
    chain_id: parsed.chainId, nonce: parsed.nonce, to: parsed.to ?? null, value: String(parsed.value ?? 0n),
    data_is_allowed_code: parsed.data === INIT,
    low_s: lowS,
    would_create: getContractAddress({ from, nonce: BigInt(parsed.nonce) }),
    nonce_after: await view(CONTRACT, "get_next_nonce", { chain_id: CHAIN }),
    seconds: Number(secs),
  };
  console.log(checks); evidence.push(JSON.stringify(checks));
  fs.writeFileSync(new URL("./evidence/signed_tx.txt", import.meta.url), raw + "\n");
}
fs.appendFileSync(new URL("./evidence/run.log", import.meta.url), `--- ${new Date().toISOString()}\n${evidence.join("\n")}\n`);
