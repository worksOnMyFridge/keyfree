// Spike S12, maintenance without keys: put v4 (build "a") on policy.keyfree-lab.testnet, DELETE its key,
// then upgrade it to build "b" only through the contract's own rules (proposed sha256 + delay + guardian
// can cancel). Afterwards the same ETH address still deploys through the factory. Pause is checked too.
import fs from "node:fs";
import crypto from "node:crypto";
import { keccak256, toHex, createPublicClient, http, baseSepolia } from "./tools/evm.mjs";
import { loadAccount, provider, explorer, view, KeyPair, teraToGas, parseNearAmount, Account, actions } from "./tools/near.mjs";

const LAB = "keyfree-lab.testnet", POLICY = `policy.${LAB}`, AGENT = `agent.${LAB}`, GUARD = `guardian.${LAB}`;
const MPC = "v1.signer-prod.testnet", CHAIN = baseSepolia.id, DELAY = 60;
const INIT = "0x600a600c600039600a6000f3602a60005260206000f3";
const state = JSON.parse(fs.readFileSync(new URL("./evidence/spike5_state.json", import.meta.url)));
const A = fs.readFileSync(new URL("./keyfree_v4a.opt.wasm", import.meta.url)), B = fs.readFileSync(new URL("./keyfree_v4b.opt.wasm", import.meta.url));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const log = [];
const say = (s) => { console.log(s); log.push(s); };
const keyFile = (p) => new URL(`./${p}_contract_key.json`, import.meta.url); // spike-only keys, never printed
const acc = (id, p) => new Account(id, provider, JSON.parse(fs.readFileSync(keyFile(p))).private_key);
const owner = loadAccount(LAB);
const base = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const call = (who, methodName, args, gas = "30") => who.callFunctionRaw({ contractId: POLICY, methodName, args, gas: teraToGas(gas) });
const refused = async (name, fn, reason) => {
  try { await fn(); say(`FAIL ${name}: was allowed`); }
  catch (e) { const m = String(e.message || e); say(`${m.includes(reason) ? "OK  " : "FAIL"} ${name} -> ${m.replace(/\s+/g, " ").slice(0, 140)}`); }
};
const codeHash = async () => (await provider.viewAccount({ accountId: POLICY })).code_hash;
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));

if (!fs.existsSync(keyFile("guardian"))) {
  const kp = KeyPair.fromRandom("ed25519");
  fs.writeFileSync(keyFile("guardian"), JSON.stringify({ private_key: kp.toString() }));
  await owner.createSubAccount({ accountOrPrefix: "guardian", publicKey: kp.getPublicKey(), nearToTransfer: parseNearAmount("0.3") });
}
const policy = acc(POLICY, "policy"), agent = acc(AGENT, "agent"), guardian = acc(GUARD, "guardian");

// 1. v4 build "a" with a 60 s upgrade delay (spike only; the real one is days), same rules as before
const d = await policy.signAndSendTransaction({ receiverId: POLICY, actions: [
  actions.deployContract(A),
  actions.functionCall("new", { owner: LAB, agent: AGENT, guardian: GUARD, mpc: MPC, path: "keyfree-1", upgrade_delay_sec: DELAY }, teraToGas("30"), 0n),
] });
say(`v4a deployed + init ${explorer(d.transaction.hash)}; sha256 ${sha(A).slice(0, 12)}…`);
const addr = JSON.parse(Buffer.from((await call(owner, "setup", {}, "60")).status.SuccessValue, "base64").toString());
await call(owner, "allow_code", { code_hash: keccak256(INIT).slice(2) });
await call(owner, "allow_chain", { chain_id: CHAIN, next_nonce: await base.getTransactionCount({ address: addr }) });
await call(owner, "set_factory", { chain_id: CHAIN, factory_hex: state.factory });
say(`same ETH address ${addr}; rules and factory ${state.factory} set`);

// 2. delete the policy account's only key
const del = await policy.deleteKey(KeyPair.fromString(JSON.parse(fs.readFileSync(keyFile("policy"))).private_key).getPublicKey());
await wait(3);
say(`key deleted ${explorer(del.transaction.hash)}; keys left: ${(await provider.viewAccessKeyList({ accountId: POLICY })).keys.length}`);

// 3. upgrade rules
const before = await codeHash();
await call(owner, "propose_upgrade", { code_sha256: sha(B) });
await call(guardian, "cancel_upgrade", {});
const apply = (code) => owner.signAndSendTransaction({ receiverId: POLICY, actions: [actions.functionCall("apply_upgrade", code, teraToGas("300"), 0n)] });
await refused("apply after the guardian cancelled", () => apply(B), "no upgrade proposed");
await call(owner, "propose_upgrade", { code_sha256: sha(B) });
await refused("apply before the delay is over", () => apply(B), "upgrade delay not over");
await refused("agent proposes an upgrade", () => call(agent, "propose_upgrade", { code_sha256: sha(A) }), "only owner");
await wait(DELAY + 5);
await refused("apply with code that was not proposed", () => apply(A), "code does not match the proposed hash");
const up = await apply(B);
for (const r of up.receipts_outcome) for (const l of r.outcome.logs) if (l.startsWith("keyfree")) say(`log: ${l}`);
await wait(3);
const st = await view(POLICY, "get_status");
say(`${st.build === "b" && st.version === 2 ? "OK  " : "FAIL"} upgraded WITHOUT a key: build ${st.build}, version ${st.version}, account code_hash ${before.slice(0, 8)}… -> ${(await codeHash()).slice(0, 8)}…  ${explorer(up.transaction.hash)}`);
say(`keys on the account still: ${(await provider.viewAccessKeyList({ accountId: POLICY })).keys.length}; address still ${await view(POLICY, "get_eth_address")}`);

// 4. pause / unpause, then a deploy through the factory from the same address
const fees = await base.estimateFeesPerGas();
const req = { chain_id: CHAIN, init_code_hex: INIT, gas_limit: 300000, max_fee_per_gas: Number(fees.maxFeePerGas * 2n), max_priority_fee_per_gas: Number(fees.maxPriorityFeePerGas), salt_hex: keccak256(toHex(`after-upgrade-${Date.now()}`)), via_factory: true };
await call(guardian, "pause", {});
await refused("agent deploys while paused", () => call(agent, "request_deploy", req, "250"), "paused");
await refused("guardian unpauses", () => call(guardian, "unpause", {}), "only owner");
await call(owner, "unpause", {});
const out = await call(agent, "request_deploy", req, "250");
const raw = JSON.parse(Buffer.from(out.status.SuccessValue, "base64").toString());
const rc = await base.waitForTransactionReceipt({ hash: await base.sendRawTransaction({ serializedTransaction: raw }) });
say(`${rc.status === "success" ? "OK  " : "FAIL"} deploy after the keyless upgrade, same address, through the factory  https://sepolia.basescan.org/tx/${rc.transactionHash}`);
fs.appendFileSync(new URL("./evidence/spike6.log", import.meta.url), `--- ${new Date().toISOString()}\n${log.join("\n")}\n`);
