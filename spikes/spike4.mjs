// Spike S12, audit fixes 1–2 on testnet: redeploy the v2 policy contract (address derived on-chain,
// callback that never freezes), let a separate agent account deploy to Base Sepolia, then DELETE the
// contract account's only key and show that (a) the key list is empty, (b) the old key can no longer
// redeploy, (c) the agent still deploys through the rules. Testnet NEAR + Base Sepolia dust only.
import fs from "node:fs";
import { keccak256, toHex, getContractAddress, createPublicClient, http, baseSepolia, formatEther, recoverTransactionAddress } from "../tools/evm.mjs";
import { loadAccount, ACCOUNT, provider, explorer, view, KeyPair, teraToGas, parseNearAmount, Account, actions } from "../tools/near.mjs";

const CONTRACT = `keyfree.${ACCOUNT}`, AGENT = `proba.${ACCOUNT}`, STRANGER = `proba2.${ACCOUNT}`;
const MPC = "v1.signer-prod.testnet", CHAIN = baseSepolia.id;
const INIT = "0x600a600c600039600a6000f3602a60005260206000f3", RUNTIME = "0x602a60005260206000f3";
const PROXY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const scan = (h) => `https://sepolia.basescan.org/tx/${h}`;
const key = (f) => KeyPair.fromString(JSON.parse(fs.readFileSync(new URL(f, import.meta.url))).private_key).toString();
const owner = loadAccount();
const contractKey = key("./keyfree_contract_key.json");
const contract = new Account(CONTRACT, provider, contractKey);
const agent = new Account(AGENT, provider, key("../s10-proba/proba_contract_key.json"));
const stranger = new Account(STRANGER, provider, key("../s10-proba/proba2_contract_key.json"));
const base = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const log = [];
const say = (s) => { console.log(s); log.push(s); };
const save = () => fs.appendFileSync(new URL("../evidence/spike4.log", import.meta.url), `--- ${new Date().toISOString()}\n${log.join("\n")}\n`);
const call = (who, methodName, args, gas = "30") => who.callFunctionRaw({ contractId: CONTRACT, methodName, args, gas: teraToGas(gas) });
const refused = async (name, fn, reason) => {
  try { await fn(); say(`FAIL ${name}: was allowed`); }
  catch (e) { const m = String(e.message || e); say(`${m.includes(reason) ? "OK  " : "FAIL"} ${name} -> ${m.replace(/\s+/g, " ").slice(0, 160)}`); }
};
const keys = async () => (await provider.viewAccessKeyList({ accountId: CONTRACT, finalityQuery: { finality: "final" } }).catch(() => provider.viewAccessKeyList({ accountId: CONTRACT }))).keys;

async function deploy(label, salt) {
  const fees = await base.estimateFeesPerGas();
  const args = { chain_id: CHAIN, init_code_hex: INIT, gas_limit: 150000, max_fee_per_gas: Number(fees.maxFeePerGas * 2n), max_priority_fee_per_gas: Number(fees.maxPriorityFeePerGas), salt_hex: salt };
  const pv = await view(CONTRACT, "preview", args);
  const t0 = Date.now();
  const out = await call(agent, "request_deploy", args, "250");
  const raw = JSON.parse(Buffer.from(out.status.SuccessValue, "base64").toString());
  if (!raw) { say(`${label}: not signed, open = ${JSON.stringify(await view(CONTRACT, "get_open"))}`); return; }
  const from = await recoverTransactionAddress({ serializedTransaction: raw });
  const hash = await base.sendRawTransaction({ serializedTransaction: raw });
  const rc = await base.waitForTransactionReceipt({ hash, timeout: 120_000 });
  const where = salt ? getContractAddress({ opcode: "CREATE2", from: PROXY, salt, bytecode: INIT }) : rc.contractAddress;
  const ok = rc.status === "success" && (await base.getCode({ address: where })) === RUNTIME && BigInt((await base.call({ to: where })).data) === 42n;
  say(`${ok ? "OK  " : "FAIL"} ${label}: signed in ${((Date.now() - t0) / 1000).toFixed(1)} s, from ${from}, nonce ${pv.nonce}, contract ${where}, code+call(42) ${ok}  ${explorer(out.transaction.hash)}  ${scan(hash)}`);
}

// 1. fund the agent a little (testnet), redeploy v2 and re-init in one transaction signed by the account itself
await owner.transfer({ receiverId: AGENT, amount: parseNearAmount("0.3") });
const code = fs.readFileSync(new URL("../keyfree.opt.wasm", import.meta.url));
const d = await contract.signAndSendTransaction({ receiverId: CONTRACT, actions: [
  actions.deployContract(code),
  actions.functionCall("new", { owner: ACCOUNT, agent: AGENT, mpc: MPC, path: "keyfree-1" }, teraToGas("30"), 0n),
] });
say(`v2 deployed + init in one tx ${explorer(d.transaction.hash)}`);
const st = await call(owner, "setup", {}, "60");
const derived = JSON.parse(Buffer.from(st.status.SuccessValue, "base64").toString());
say(`address derived ON-CHAIN by the contract: ${derived}`);
const nonce = await base.getTransactionCount({ address: derived });
await call(owner, "allow_code", { code_hash: keccak256(INIT).slice(2) });
await call(owner, "allow_chain", { chain_id: CHAIN, next_nonce: nonce });
say(`rules: code ${keccak256(INIT).slice(2, 14)}…, chain ${CHAIN} from nonce ${nonce}; ETH left ${formatEther(await base.getBalance({ address: derived }))}`);

await refused("stranger re-inits the contract", () => call(stranger, "new", { owner: STRANGER, agent: AGENT, mpc: MPC, path: "x" }), "only the contract account");
await refused("agent changes the rules", () => call(agent, "allow_code", { code_hash: "00" }), "only owner");
await refused("stranger requests a deploy", () => call(stranger, "request_deploy", { chain_id: CHAIN, init_code_hex: INIT, gas_limit: 150000, max_fee_per_gas: 1, max_priority_fee_per_gas: 1, salt_hex: null }, "250"), "only agent or owner");

// 2. deploy while the account still has its key
await deploy("agent deploy #1 (key still exists)", null);

// 3. delete the contract account's keys
say(`keys before: ${(await keys()).map((k) => k.public_key).join(", ")}`);
const del = await contract.deleteKey(KeyPair.fromString(contractKey).getPublicKey());
say(`deleted the only key ${explorer(del.transaction.hash)}`);
await new Promise((r) => setTimeout(r, 3000));
const left = await keys();
say(`${left.length === 0 ? "OK  " : "FAIL"} keys after: ${left.length}`);
await refused("old key tries to redeploy the contract", () => contract.deployContract(code), "");

// 4. still works without any key
await deploy("agent deploy #2 via CREATE2 (no key on the account)", keccak256(toHex(`keyfree-keyless-${Date.now()}`)));
say(`contract nonce ${await view(CONTRACT, "get_next_nonce", { chain_id: CHAIN })}, Base nonce ${await base.getTransactionCount({ address: derived })}, open ${JSON.stringify(await view(CONTRACT, "get_open"))}`);
save();
