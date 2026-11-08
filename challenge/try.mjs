// The open challenge: use the published agent key for everything it should not be able to do. README.md is next to it.
//   npm install && node challenge/try.mjs        every attempt must be refused, with its reason
//   node challenge/try.mjs --allowed             also asks for the one allowed thing (uses 1 of 5 signatures a day)
// Each attempt is a real call on NEAR testnet, signed with the published key. The exit code is 1 if anything got through.
import fs from "node:fs";
import { encodeDeployData } from "../tools/evm.mjs";
import { provider, explorer, Account, KeyPair, teraToGas, parseNearAmount, actions } from "../tools/near.mjs";

const POLICY = "challenge.keyfree-lab.testnet";
const BASE_SEPOLIA = 84532;
const KEY = JSON.parse(fs.readFileSync(new URL("./published-agent-key.json", import.meta.url), "utf8"));
const agent = new Account(KEY.account_id, provider, KEY.private_key);
const artifact = JSON.parse(fs.readFileSync(new URL("../packages/keyfree/demo/out/Counter.sol/Counter.json", import.meta.url)));
const counter = (n) => encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object ?? artifact.bytecode, args: [BigInt(n)] });

const view = async (method, args = {}) => {
  const r = await provider.callFunctionRaw({ contractId: POLICY, method, args, blockQuery: { finality: "optimistic" } });
  return JSON.parse(Buffer.from(r.result).toString());
};
const call = (methodName, args) => agent.callFunctionRaw({ contractId: POLICY, methodName, args: new TextEncoder().encode(JSON.stringify(args)), gas: teraToGas("250"), deposit: 0n });
const ask = (over = {}) => ({ chain_id: BASE_SEPOLIA, init_code_hex: counter(1), gas_limit: 300000, max_fee_per_gas: 20000000, max_priority_fee_per_gas: 1000000, salt_hex: null, via_factory: null, ...over });
const reasonOf = (text) => {
  const s = String(text).replace(/\s+/g, " ");
  return (/Smart contract panicked: ([^"\\]*)/.exec(s)?.[1] ?? s).slice(0, 150);
};
const failureOf = (out) => {
  const f = out.status?.Failure ?? out.receipts_outcome?.map((r) => r.outcome.status.Failure).find(Boolean);
  return f ? reasonOf(JSON.stringify(f)) : "";
};

let refused = 0, broken = 0;
async function attempt(label, send) {
  const out = await send().catch((e) => ({ error: reasonOf(e?.message ?? e) }));
  const why = out.error ?? failureOf(out);
  if (why) { refused++; console.log(`REFUSED  ${label}\n         ${why}`); return; }
  broken++;
  console.log(`THROUGH  ${label} ${out.transaction?.hash ? explorer(out.transaction.hash) : ""}`);
}

const before = { rules: await view("get_rules"), roles: await view("get_roles"), nonce: await view("get_next_nonce", { chain_id: BASE_SEPOLIA }) };
const keysBefore = (await provider.viewAccessKeyList({ accountId: POLICY })).keys.length;
console.log(`--- ${new Date().toISOString()} open challenge on ${POLICY}, as ${KEY.account_id}`);
console.log(`The policy has ${keysBefore} access keys and allows ${before.rules.allowed_code.length} code hash.\n`);

console.log("[methods this key may call: the contract decides]");
await attempt("deploy Counter(999), other constructor arguments", () => call("request_deploy", ask({ init_code_hex: counter(999) })));
await attempt("deploy arbitrary bytes", () => call("request_deploy", ask({ init_code_hex: "0x60006000f3" })));
await attempt("deploy the allowed code on a chain that is not open", () => call("request_deploy", ask({ chain_id: 11155111 })));
await attempt("deploy the allowed code with gas over the cap", () => call("request_deploy", ask({ gas_limit: 5000000 })));
await attempt("deploy the allowed code with a fee over the cap", () => call("request_deploy", ask({ max_fee_per_gas: 60000000000 })));
await attempt("upgrade a proxy nobody allowed", () => call("request_proxy_upgrade", { chain_id: BASE_SEPOLIA, proxy_hex: `0x${"11".repeat(20)}`, implementation_hex: `0x${"22".repeat(20)}`, gas_limit: 100000, max_fee_per_gas: 20000000, max_priority_fee_per_gas: 1000000 }));
await attempt("re-sign a line that does not exist, with other code", () => call("resign", { chain_id: BASE_SEPOLIA, nonce: 9999, init_code_hex: counter(999), gas_limit: 300000, max_fee_per_gas: 20000000, max_priority_fee_per_gas: 1000000 }));

console.log("\n[everything else: NEAR rejects the key before any contract runs]");
const other = (methodName, args = {}) => () => call(methodName, args);
await attempt("allow new code (propose_rule)", other("propose_rule", { change: { AllowCode: { code_hash: "00".repeat(32) } } }));
await attempt("pause the policy", other("pause"));
await attempt("take the owner's role (propose_role)", other("propose_role", { role: "Owner", account: KEY.account_id }));
await attempt("replace the policy's code (propose_upgrade)", other("propose_upgrade"));
await attempt("ask the MPC to sign directly", () => agent.signAndSendTransaction({ receiverId: "v1.signer-prod.testnet", actions: [actions.functionCall("sign", { request: {} }, teraToGas("250"), 0n)] }));
await attempt("send the agent's NEAR away", () => agent.signAndSendTransaction({ receiverId: "keyfree-lab.testnet", actions: [actions.transfer(BigInt(parseNearAmount("0.1")))] }));
await attempt("add a full-access key to the agent", () => agent.signAndSendTransaction({ receiverId: KEY.account_id, actions: [actions.addFullAccessKey(KeyPair.fromRandom("ed25519").getPublicKey())] }));
await attempt("delete the agent's account", () => agent.signAndSendTransaction({ receiverId: KEY.account_id, actions: [actions.deleteAccount("keyfree-lab.testnet")] }));

if (process.argv.includes("--allowed")) {
  console.log("\n[the one allowed thing]");
  const out = await call("request_deploy", ask()).catch((e) => ({ error: reasonOf(e?.message ?? e) }));
  const why = out.error ?? failureOf(out);
  console.log(why ? `not signed: ${why}` : `SIGNED   Counter(1) on Base Sepolia, as the rules allow ${explorer(out.transaction.hash)}`);
}

await new Promise((r) => setTimeout(r, 3000));
const after = { rules: await view("get_rules"), roles: await view("get_roles"), status: await view("get_status") };
const keysAfter = (await provider.viewAccessKeyList({ accountId: POLICY })).keys.length;
const same = keysAfter === 0 && JSON.stringify(after.roles) === JSON.stringify(before.roles) && JSON.stringify(after.rules.allowed_code) === JSON.stringify(before.rules.allowed_code) && after.status.paused === false;
console.log(`\nAfter: ${keysAfter} keys, roles and allowed code unchanged: ${same}, paused: ${after.status.paused}`);
console.log(`${refused} of ${refused + broken} attempts refused${broken ? `, ${broken} GOT THROUGH: please report it (SECURITY.md)` : ""}`);
process.exitCode = broken || !same ? 1 : 0;
