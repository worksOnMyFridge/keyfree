// More ways to try the published agent key, beyond the 15 of try.mjs. Written on 2026-11-14, the day the repository
// opened, as our own attempt to break it before anyone else. Two parts:
//   1. free: 88 malformed and hostile requests to the policy's `preview`, a read-only call that runs the same checks
//      as a real request. Whatever it accepts is decoded and must be exactly "create Counter(1) on Base Sepolia";
//   2. real calls on NEAR testnet, signed with the published key: other content on a nonce that was already signed,
//      the housekeeping methods, forged confirmations, the shape of the NEAR transaction itself, too little gas.
//   npm install && node challenge/more.mjs       part 2 costs the agent about 0.004 NEAR of gas
//   node challenge/more.mjs --free               part 1 only: nothing is sent
//   node challenge/more.mjs --allowed            also races two allowed requests for one nonce (uses 1 of 5 signatures a day)
// The exit code is 1 if a preview accepted anything else, an attempt got through, or the policy changed.
import fs from "node:fs";
import { encodeDeployData, parseTransaction } from "../tools/evm.mjs";
import { provider, explorer, Account, teraToGas, actions } from "../tools/near.mjs";

const POLICY = "challenge.keyfree-lab.testnet";
const CHAIN = 84532;
const NODES = [process.env.NEAR_RPC || "https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "https://near-testnet.drpc.org"];
const KEY = JSON.parse(fs.readFileSync(new URL("./published-agent-key.json", import.meta.url), "utf8"));
const agent = new Account(KEY.account_id, provider, KEY.private_key);
const artifact = JSON.parse(fs.readFileSync(new URL("../packages/keyfree/demo/out/Counter.sol/Counter.json", import.meta.url)));
const bytecode = artifact.bytecode.object ?? artifact.bytecode;
const counter = (n) => encodeDeployData({ abi: artifact.abi, bytecode, args: [BigInt(n)] });
const ALLOWED = counter(1);
const view = async (method, args = {}) => JSON.parse(Buffer.from((await provider.callFunctionRaw({ contractId: POLICY, method, args, blockQuery: { finality: "final" } })).result).toString());
const reasonOf = (text) => {
  const s = String(text).replace(/\s+/g, " ");
  return (/panic_msg: \\*"(.+?)\\*"/.exec(s)?.[1] ?? /Smart contract panicked: ([^"\\]*)/.exec(s)?.[1] ?? /(Failed to deserialize[^"\\]*)/.exec(s)?.[1] ?? s).slice(0, 150);
};
let failed = 0;

// ---------- part 1: the same checks, asked for free ----------
// The arguments go out as the exact text written here, so wrong types, duplicate keys and broken JSON reach the contract.
async function previewRaw(text) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(NODES[i % NODES.length], { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: POLICY, method_name: "preview", args_base64: Buffer.from(text).toString("base64") } }) });
      const j = await r.json();
      if (j.error) { const s = JSON.stringify(j.error); if (/panicked|GuestPanic|CONTRACT_EXECUTION|Deserializ/i.test(s)) return { refused: s }; throw new Error(s.slice(0, 120)); }
      if (j.result.error) return { refused: j.result.error };
      return { ok: JSON.parse(Buffer.from(j.result.result).toString()) };
    } catch (e) {
      if (i === 5) return { network: String(e.message).slice(0, 100) };
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}
const base = { chain_id: CHAIN, init_code_hex: ALLOWED, gas_limit: 300000, max_fee_per_gas: 20000000, max_priority_fee_per_gas: 1000000, salt_hex: null, via_factory: null };
const J = (o) => JSON.stringify(o);
// The allowed request with some fields replaced by raw JSON text.
const raw = (over) => { let t = J(base); for (const [k, v] of Object.entries(over)) t = t.replace(new RegExp(`"${k}":("[^"]*"|[^,}]*)`), `"${k}":${v}`); return t; };
const code = bytecode.replace(/^0x/, ""), arg = (n) => BigInt(n).toString(16).padStart(64, "0"), C = ALLOWED.slice(2), SALT = "0x" + "ab".repeat(32);
const inputs = [["the allowed request, as it is", J(base)]];
for (const c of ["1", "8453", "10", "42161", "11155111", "84531", "84533", "0", "18446744073709551615", "18446744073709636148", "-84532", "\"84532\"", "84532.0", "8.4532e4", "[84532]", "null", "true", "084532", "0x14a34"]) inputs.push([`chain_id ${c}`, raw({ chain_id: c })]);
for (const [n, v] of [["upper-case hex", "0x" + C.toUpperCase()], ["0X prefix", "0X" + C], ["0x0x double prefix", "0x0x" + C], ["no prefix", C], ["a leading space", " 0x" + C], ["a trailing newline", "0x" + C + "\\n"],
  ["one nibble more", "0x" + C + "0"], ["a zero byte appended", "0x" + C + "00"], ["a zero byte prepended", "0x00" + C], ["Counter(0)", "0x" + code + arg(0)], ["Counter(2)", "0x" + code + arg(2)], ["Counter(999)", "0x" + code + arg(999)],
  ["the argument one byte short", "0x" + code + arg(1).slice(2)], ["the argument padded to 33 bytes", "0x" + code + "00" + arg(1)], ["empty", ""], ["only 0x", "0x"], ["not hex", "0xzz"], ["a look-alike digit", "0x" + C.replace("6", "\u0666")],
  ["a self-destruct stub", "0x6000ff"], ["one byte over the size cap", "0x" + "00".repeat(49153)], ["600 KB of zeros", "0x" + "00".repeat(600000)]]) inputs.push([`code: ${n}`, raw({ init_code_hex: `"${v}"` })]);
inputs.push(["code as a number", raw({ init_code_hex: "123" })], ["code as an array of bytes", raw({ init_code_hex: "[96,128]" })], ["code null", raw({ init_code_hex: "null" })]);
for (const g of ["0", "1", "21000", "53000", "1000000", "1000001", "18446744073709551616", "340282366920938463463374607431768211455", "340282366920938463463374607431768211456", "-1", "\"300000\"", "3e5", "300000.5"]) inputs.push([`gas_limit ${g}`, raw({ gas_limit: g })]);
for (const f of ["0", "1", "50000000000", "50000000001", "340282366920938463463374607431768211455", "\"20000000\"", "-1"]) inputs.push([`max_fee ${f}`, raw({ max_fee_per_gas: f })]);
for (const f of ["0", "20000000", "20000001", "50000000000", "340282366920938463463374607431768211455"]) inputs.push([`priority fee ${f}`, raw({ max_priority_fee_per_gas: f })]);
inputs.push(["the gas cap at the fee cap (over the daily budget)", raw({ gas_limit: "1000000", max_fee_per_gas: "50000000000", max_priority_fee_per_gas: "0" })],
  ["a salt without the factory", raw({ salt_hex: `"${SALT}"` })], ["the factory without a salt", raw({ via_factory: "true" })], ["the factory with a salt", raw({ salt_hex: `"${SALT}"`, via_factory: "true" })],
  ["the factory with a 31-byte salt", raw({ salt_hex: `"0x${"ab".repeat(31)}"`, via_factory: "true" })], ["via_factory as a string", raw({ via_factory: "\"true\"" })], ["via_factory 1", raw({ via_factory: "1" })], ["the salt as a number", raw({ salt_hex: "5" })],
  ["a duplicate key: the allowed code first, other code last", J(base).replace(/}$/, `,"init_code_hex":"0x${code + arg(999)}"}`)],
  ["a duplicate key: other code first, the allowed code last", `{"init_code_hex":"0x${code + arg(999)}",` + J(base).slice(1)],
  ["a duplicate key: the open chain first, another chain last", J(base).replace(/}$/, `,"chain_id":1}`)],
  ["extra fields: to, value, data, nonce", J({ ...base, to: "0x" + "11".repeat(20), value: "1000000000000000000", data: "0xdeadbeef", nonce: 0 })],
  ["no chain", J({ ...base, chain_id: undefined })], ["the arguments as an array", J(Object.values(base))], ["an empty object", "{}"], ["not JSON", "chain_id=84532"], ["no arguments", ""],
  ["a byte-order mark before the JSON", "\ufeff" + J(base)], ["deeply nested junk in an extra field", J({ ...base, x: JSON.parse("[".repeat(200) + "]".repeat(200)) })]);

console.log(`--- ${new Date().toISOString()} more attempts on ${POLICY}\n\n[1. free: ${inputs.length} requests to preview, which runs the checks of a real request]`);
let accepted = 0, refusedFree = 0, unanswered = 0; const reasons = {};
for (const [name, text] of inputs) {
  const r = await previewRaw(text);
  if (r.network) { unanswered++; console.log(`NO ANSWER  ${name}: ${r.network}`); continue; }
  if (r.refused) { refusedFree++; const w = reasonOf(r.refused).replace(/`.*$/, "").slice(0, 60); reasons[w] = (reasons[w] ?? 0) + 1; continue; }
  accepted++;
  const tx = parseTransaction(r.ok.unsigned);
  const exact = tx.type === "eip1559" && tx.chainId === CHAIN && (tx.to === undefined || tx.to === null) && (tx.value ?? 0n) === 0n && tx.data.toLowerCase() === ALLOWED.toLowerCase() && !(tx.accessList?.length);
  if (!exact) failed++;
  console.log(`${exact ? "ACCEPTED  Counter(1) on Base Sepolia, nothing else" : "ACCEPTED SOMETHING ELSE: please report it (SECURITY.md)"}  <- ${name}`);
}
console.log(`${inputs.length} requests: ${refusedFree} refused, ${accepted} accepted${unanswered ? `, ${unanswered} without an answer` : ""}; accepted but not exactly Counter(1) on Base Sepolia: ${failed}`);
console.log("refused because:"); for (const [w, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${w}`);
if (unanswered) failed++;                                  // an input that was not answered was not tried
if (process.argv.includes("--free")) process.exit(failed ? 1 : 0);

// ---------- part 2: real calls with the published key ----------
const enc = (a) => new TextEncoder().encode(JSON.stringify(a));
const call = (methodName, args, gas = "250", deposit = 0n) => agent.callFunctionRaw({ contractId: POLICY, methodName, args: enc(args), gas: teraToGas(gas), deposit });
const failureOf = (out) => { const f = out.status?.Failure ?? out.receipts_outcome?.map((r) => r.outcome.status.Failure).find(Boolean); return f ? reasonOf(JSON.stringify(f)) : ""; };
let refused = 0, through = 0;
async function attempt(label, send) {
  const out = await send().catch((e) => ({ error: reasonOf(e?.message ?? e) }));
  const why = out.error ?? failureOf(out);
  if (why) { refused++; console.log(`REFUSED  ${label}\n         ${why}`); return false; }
  through++; console.log(`THROUGH  ${label} ${out.transaction?.hash ? explorer(out.transaction.hash) : ""}`); return true;
}
const snapshot = async () => ({ rules: J((await view("get_rules")).allowed_code) + J((await view("get_rules")).proposals), roles: J(await view("get_roles")), status: J(await view("get_status")),
  keys: (await provider.viewAccessKeyList({ accountId: POLICY })).keys.length, agentKeys: (await provider.viewAccessKeyList({ accountId: KEY.account_id })).keys.length, nonce: await view("get_next_nonce", { chain_id: CHAIN }) });
const before = await snapshot();
const ask = (over = {}) => ({ ...base, ...over });
const fees = { gas_limit: 300000, max_fee_per_gas: 20000000, max_priority_fee_per_gas: 1000000 };
const log = { log_index: 0, transaction_index: 0, block_hash: "0x" + "11".repeat(32), block_number: 1 };
// The newest line the policy already signed: its nonce is taken, and nothing else may ever be signed on it.
let signed = null;
for (let n = before.nonce - 1; n >= Math.max(0, before.nonce - 5) && signed === null; n--) if ((await view("get_entry", { chain_id: CHAIN, nonce: n }))?.status === "signed") signed = n;

console.log(`\n[2. real calls. The policy has ${before.keys} access keys; its next nonce on Base Sepolia is ${before.nonce}]`);
if (signed !== null) {
  console.log(`\n[other content on nonce ${signed}, which is already signed]`);
  await attempt(`re-sign nonce ${signed} with Counter(999)`, () => call("resign", { chain_id: CHAIN, nonce: signed, init_code_hex: counter(999), ...fees }));
  await attempt(`re-sign nonce ${signed} with the allowed code and gas over the cap`, () => call("resign", { chain_id: CHAIN, nonce: signed, init_code_hex: ALLOWED, ...fees, gas_limit: 9000000 }));
  await attempt(`re-sign nonce ${signed} on another chain`, () => call("resign", { chain_id: 1, nonce: signed, init_code_hex: ALLOWED, ...fees }));
  await attempt(`re-sign nonce ${signed} as a proxy upgrade`, () => call("resign_proxy_upgrade", { chain_id: CHAIN, nonce: signed, ...fees }));
  await attempt(`confirm nonce ${signed} with an invented log`, () => call("confirm", { chain_id: CHAIN, nonce: signed, log, finality: "Finalized" }));
  await attempt(`confirm nonce ${signed} from a block that is only the latest`, () => call("confirm", { chain_id: CHAIN, nonce: signed, log, finality: "Latest" }));
}
console.log("\n[the housekeeping methods this key may call]");
await attempt("retry when nothing is stuck", () => call("retry", { max_fee_per_gas: 20000000, max_priority_fee_per_gas: 1000000 }));
await attempt("release when nothing is pending", () => call("release", {}));
await attempt("confirm a nonce that was never requested", () => call("confirm", { chain_id: CHAIN, nonce: 4000000, log, finality: "Finalized" }));
await attempt("confirm_stuck with an invented signature", () => call("confirm_stuck", { sig: { r: "0x" + "22".repeat(32), s: "0x" + "33".repeat(32), v: 0, gas_limit: null, max_fee_per_gas: null, max_priority_fee_per_gas: null }, log, finality: "Finalized" }));

console.log("\n[the shape of the NEAR transaction: NEAR rejects it before the contract runs]");
await attempt("two calls in one transaction: an allowed method, then propose_rule", () => agent.signAndSendTransaction({ receiverId: POLICY, actions: [
  actions.functionCall("release", {}, teraToGas("30"), 0n), actions.functionCall("propose_rule", { change: { AllowCode: { code_hash: "00".repeat(32) } } }, teraToGas("30"), 0n)] }));
await attempt("an allowed method with 1 yoctoNEAR attached", () => call("release", {}, "30", 1n));
await attempt("a method name with a trailing space", () => call("request_deploy ", ask()));
await attempt("a method name in another case", () => call("Request_Deploy", ask()));
await attempt("the policy's own callback (on_signed)", () => call("on_signed", {}));
await attempt("the migration entry point (migrate)", () => call("migrate", {}));
await attempt("deploy code onto the policy's account", () => agent.signAndSendTransaction({ receiverId: POLICY, actions: [actions.deployContract(new Uint8Array([0, 97, 115, 109]))] }));
await attempt("the allowed method name, sent to the MPC contract", () => agent.signAndSendTransaction({ receiverId: "v1.signer-prod.testnet", actions: [actions.functionCall("request_deploy", ask(), teraToGas("30"), 0n)] }));

console.log("\n[starve the signing: the allowed request with too little gas for the signature and its callback]");
await attempt("the allowed request with 140 Tgas", () => call("request_deploy", ask(), "140"));
await attempt("the allowed request with 20 Tgas", () => call("request_deploy", ask(), "20"));
const open = await view("get_open");
const stranded = open.pending !== null || open.stuck !== null;
console.log(`         after it: ${stranded ? "A REQUEST WAS LEFT OPEN" : "no request was left open, the nonce did not move"}`);

let racedOk = true;
if (process.argv.includes("--allowed")) {
  console.log("\n[a race: two allowed requests for one nonce, sent at the same moment; at most one may be signed]");
  const won = await Promise.all([20000000, 30000000].map((fee) => attempt(`Counter(1) with fee ${fee}`, () => call("request_deploy", ask({ max_fee_per_gas: fee }))).then((ok) => { if (ok) { through--; } return ok; })));
  racedOk = won.filter(Boolean).length <= 1;
  console.log(`         ${won.filter(Boolean).length} of 2 signed${racedOk ? "" : ": TWO CONTENTS ON ONE NONCE"}`);
  await new Promise((r) => setTimeout(r, 4000));
}

const after = await snapshot();
const same = after.keys === 0 && after.rules === before.rules && after.roles === before.roles && after.status === before.status && after.agentKeys === before.agentKeys;
console.log(`\nAfter: ${after.keys} keys on the policy, rules, roles and status unchanged: ${same}`);
console.log(`${refused} of ${refused + through} attempts refused${through ? `, ${through} GOT THROUGH: please report it (SECURITY.md)` : ""}`);
process.exitCode = failed || through || stranded || !racedOk || !same ? 1 : 0;
