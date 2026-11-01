// Keyless upgrade of the live policy to a reproducible build (the wasm and sha256 from the `build` workflow).
//   node v14/upgrade.mjs <keyfree_policy.wasm> <sha256 printed by the build workflow>
// Before anything is proposed the bytes are checked offline: the sha256 is the one the build printed, every
// method the live code exports is still there, panic messages still reach the caller (panic_utf8), and no
// machine path is inside. Then the owner stores the bytes, the guardian side reads them back from the chain
// and compares the sha256, the delay runs, and the contract deploys exactly those bytes onto itself.
// Results are appended to evidence/v14.log.
import fs from "node:fs";
import crypto from "node:crypto";
import { provider, explorer, view, teraToGas, actions, loadAccount, Account } from "../tools/near.mjs";

const top = (f) => new URL(`../${f}`, import.meta.url);
const here = (f) => new URL(`./${f}`, import.meta.url);
const CFG = JSON.parse(fs.readFileSync(top(fs.existsSync(here("config.json")) ? "v14/config.json" : "v13/config.json")));
const P = CFG.policy;
const [file, want] = process.argv.slice(2);
if (!file || !/^[0-9a-f]{64}$/.test(want ?? "")) { console.log("usage: node v14/upgrade.mjs <wasm> <sha256>"); process.exit(2); }

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
const log = [];
let oks = 0, fails = 0;
const say = (s) => { console.log(s); log.push(s); };
const check = (ok, s) => { ok ? oks++ : fails++; say(`${ok ? "OK  " : "FAIL"} ${s}`); return ok; };
const save = () => fs.appendFileSync(top("evidence/v14.log"), `--- ${new Date().toISOString()} upgrade to a reproducible build (${oks} ok, ${fails} fail)\n${log.join("\n")}\n`);
const owner = () => (CFG.signers.owner ?? "local") === "credentials" ? loadAccount(CFG.lab)
  : new Account(CFG.lab, provider, JSON.parse(fs.readFileSync(top("v13/owner_key.json"))).private_key);
const kfLogs = (out) => { for (const r of out.receipts_outcome) for (const l of r.outcome.logs) if (l.startsWith("keyfree")) say(`  log: ${l}`); };
const keys = async () => (await provider.viewAccessKeyList({ accountId: P })).keys.length;
const liveCode = async () => {
  const r = await provider.query({ request_type: "view_code", finality: "final", account_id: P });
  return Buffer.from(r.code_base64, "base64");
};

try {
  const B = fs.readFileSync(file);
  // 1) offline checks of the new bytes against the code running now
  if (!check(sha(B) === want, `new wasm ${B.length} bytes, sha256 ${sha(B).slice(0, 16)}... == the build workflow's`)) throw new Error("sha256 mismatch");
  const live = await liveCode();
  const names = (b) => new Set(WebAssembly.Module.exports(new WebAssembly.Module(b)).map((e) => e.name));
  const [oldNames, newNames] = [names(live), names(B)];
  const missing = [...oldNames].filter((n) => !n.startsWith("__") && !newNames.has(n)); // __data_end, __heap_base: linker symbols, not methods
  check(missing.length === 0, `every method the live code exports is still there (${oldNames.size} -> ${newNames.size})${missing.length ? `, missing: ${missing}` : ""}`);
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(B)).map((i) => i.name);
  check(imports.includes("panic_utf8") && B.includes("code not on the allow list"), "refusals keep their text (panic_utf8 imported, messages present)");
  check(!/Users[\\/]|la1wo|\/home\/runner/.test(B.toString("latin1")), "no machine path inside the wasm");
  if (fails) throw new Error("offline checks failed, nothing proposed");

  const before = { status: await view(P, "get_status"), rules: await view(P, "get_rules"), base: await view(P, "get_next_nonce", { chain_id: 84532 }), eth: await view(P, "get_next_nonce", { chain_id: 11155111 }) };
  say(`live: build ${before.status.build}, version ${before.status.version}, code sha256 ${sha(live).slice(0, 16)}...`);

  // 2) propose: the bytes go into the contract state, the delay starts
  if (!before.status.proposed) {
    const stake = BigInt(B.length + 1000) * 10n ** 19n;
    const out = await owner().signAndSendTransaction({ receiverId: P, actions: [actions.functionCall("propose_upgrade", B, teraToGas("300"), stake)] });
    kfLogs(out);
    say(`  proposed ${explorer(out.transaction.hash)}`);
    await wait(3);
  }
  // 3) the guardian's check: read the stored bytes from the chain
  const shown = Buffer.from(await view(P, "get_proposed_code"), "base64");
  check(sha(shown) === want, `guardian reads the proposed code from the chain: ${shown.length} bytes, sha256 == the reproducible build`);
  const apply = () => owner().callFunctionRaw({ contractId: P, methodName: "apply_upgrade", args: {}, gas: teraToGas("300") });
  try { await apply(); check(false, "apply before the delay was allowed"); }
  catch (e) { check(String(e.message || e).includes("upgrade delay not over"), "apply before the delay -> upgrade delay not over"); }
  const readyAt = (await view(P, "get_status")).proposed[1];
  const s = Math.max(0, readyAt - Date.now() / 1000) + 5;
  say(`waiting ${Math.ceil(s)} s for the upgrade delay`);
  await wait(s);
  const up = await apply();
  kfLogs(up);
  await wait(3);

  // 4) after: the new code runs, nothing else changed
  const st = await view(P, "get_status");
  const now = await liveCode();
  check(sha(now) === want, `upgraded WITHOUT a key: the account's code sha256 == the reproducible build; build ${st.build}, version ${st.version}  ${explorer(up.transaction.hash)}`);
  check(st.proposed === null && (await keys()) === 0, "proposal cleared, policy still has 0 keys");
  const rules = await view(P, "get_rules");
  check(JSON.stringify(rules.allowed_code.sort()) === JSON.stringify(before.rules.allowed_code.sort())
    && (await view(P, "get_next_nonce", { chain_id: 84532 })) === before.base && (await view(P, "get_next_nonce", { chain_id: 11155111 })) === before.eth,
    `state kept: ${rules.allowed_code.length} allowed codes, next nonce Base ${before.base}, Ethereum ${before.eth}`);
  try {
    await view(P, "preview", { chain_id: 84532, init_code_hex: "0x6000", gas_limit: 100000, max_fee_per_gas: 1000000000, max_priority_fee_per_gas: 1000000, salt_hex: null, via_factory: null });
    check(false, "a code that was never allowed passed the preview");
  } catch (e) { check(String(e.message || e).includes("code not on the allow list"), "a refusal still says why: code not on the allow list"); }
} catch (e) {
  check(false, `stopped: ${String(e.message || e).replace(/\s+/g, " ").slice(0, 300)}`);
}
save();
process.exit(fails ? 1 : 0);
