// The daily budget (R8) on the live policy (v15). One stage per call, results appended to evidence/v14.log.
//   node v14/budget.mjs set      the agent's key cannot set a budget; the council sets a strict one on Base Sepolia
//                                 (1 transaction a day) and one on Ethereum Sepolia, through the rules delay
//   node v14/budget.mjs demo     the agent deploys Counter(1) through the keyfree tool; a second request the same UTC
//                                 day is refused by the tool's preview and by the contract itself (tool bypassed)
//   node v14/budget.mjs raise    a working budget through the delay, then another council member lowers it at once
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { encodeDeployData, keccak256, toHex, createPublicClient, http, baseSepolia } from "../tools/evm.mjs";
import { loadAccount, provider, explorer, view, teraToGas, Account } from "../tools/near.mjs";

const top = (f) => new URL(`../${f}`, import.meta.url);
const here = (f) => new URL(`./${f}`, import.meta.url);
const CFG = JSON.parse(fs.readFileSync(here("config.json")));
const P = CFG.policy;
const BASE = 84532, ETH = 11155111;
const COUNTER = JSON.parse(fs.readFileSync(top("packages/keyfree/demo/out/Counter.sol/Counter.json")));
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
const log = [];
let oks = 0, fails = 0;
const say = (s) => { console.log(s); log.push(s); };
const check = (ok, s) => { ok ? oks++ : fails++; say(`${ok ? "OK  " : "FAIL"} ${s}`); return ok; };
const save = () => fs.appendFileSync(top("evidence/v14.log"), `--- ${new Date().toISOString()} budget ${process.argv[2]} (${oks} ok, ${fails} fail)\n${log.join("\n")}\n`);

// Signers as in v14/run.mjs (keys never printed, *_key.json is gitignored).
const keyFile = (role) => [here(`${role}_key.json`), top(`v13/${role}_key.json`)].find((f) => fs.existsSync(f));
const signer = (role) => {
  if (role === "owner") return (CFG.signers.owner ?? "local") === "credentials" ? loadAccount(CFG.lab) : new Account(CFG.lab, provider, JSON.parse(fs.readFileSync(keyFile("owner"))).private_key);
  if (role === "guardian") return new Account(CFG.guardian2, provider, JSON.parse(fs.readFileSync(keyFile("guardian2"))).private_key);
  return new Account(CFG.agent, provider, JSON.parse(fs.readFileSync(keyFile("agent"))).private_key);
};
const result = (out) => JSON.parse(Buffer.from(out.status.SuccessValue ?? "", "base64").toString() || "null");
const kfLogs = (out) => { for (const r of out.receipts_outcome) for (const l of r.outcome.logs) if (l.startsWith("keyfree")) say(`  log: ${l}`); };
async function act(role, methodName, args, gas = "30") {
  const out = await signer(role).callFunctionRaw({ contractId: P, methodName, args, gas: teraToGas(gas) });
  kfLogs(out);
  return out;
}
async function refused(name, fn, reasons) {
  try { await fn(); check(false, `${name}: was allowed`); }
  catch (e) { const m = String(e.message || e).replace(/\s+/g, " "); check([reasons].flat().some((r) => m.includes(r)), `${name} -> ${m.slice(0, 200)}`); }
}
async function rules(changes) {
  const ids = [];
  for (const change of changes) ids.push(result(await act("owner", "propose_rule", { change })));
  say(`proposed rules ${ids.join(", ")}`);
  await refused("apply before the rules delay", () => act("owner", "apply_rule", { id: ids[0] }), "rule delay not over");
  say(`waiting ${CFG.rules_delay_sec + 5} s for the rules delay`);
  await wait(CFG.rules_delay_sec + 5);
  for (const id of ids) await act("owner", "apply_rule", { id });
  await wait(3);
  return ids;
}
const budget = (chain) => view(P, "get_budget", { chain_id: chain });
// The keyfree CLI as the agent runs it, from packages/keyfree/demo with the agent's key.
function cli(...args) {
  const r = spawnSync(process.execPath, ["../dist/cli.js", ...args], { cwd: top("packages/keyfree/demo"), encoding: "utf8",
    env: { ...process.env, KEYFREE_AGENT_KEY: new URL(keyFile("agent")).pathname.replace(/^\/([A-Za-z]:)/, "$1") } });
  return { code: r.status, out: (r.stdout + r.stderr).trim() };
}

const stage = process.argv[2];
try {
  if (stage === "set") {
    const strict = { SetBudget: { chain_id: BASE, max_wei_per_day: 10_000_000_000_000, max_tx_per_day: 1 } };
    await refused("the agent's key sets a budget", () => act("agent", "propose_rule", { change: strict }), ["does not allow method", "MethodNameMismatch"]);
    await rules([strict, { SetBudget: { chain_id: ETH, max_wei_per_day: 10_000_000_000_000_000, max_tx_per_day: 10 } }]);
    const b = await budget(BASE);
    check(b && b.max_tx_per_day === 1 && b.max_wei_per_day === "10000000000000", `Base Sepolia budget: ${b.max_tx_per_day} transaction and ${b.max_wei_per_day} wei a day, used today ${b.used_tx_today}`);
    check((await budget(ETH))?.max_tx_per_day === 10, "Ethereum Sepolia budget: 10 transactions and 0.01 ETH a day");
  } else if (stage === "demo") {
    const first = cli("deploy", "--chain", "base-sepolia", "--artifact", "out/Counter.sol/Counter.json", "--args", "[1]");
    const tx = first.out.match(/"evm_tx":\s*"(0x[0-9a-f]+)"/)?.[1];
    check(first.code === 0 && !!tx, `first deploy today through the tool: Counter(1), Base Sepolia tx ${tx ?? first.out.slice(-300)}`);
    const b = await budget(BASE);
    check(b.used_tx_today === 1, `budget used: ${b.used_tx_today} of ${b.max_tx_per_day} transactions, ${b.used_wei_today} of ${b.max_wei_per_day} wei`);
    const second = cli("preview", "--chain", "base-sepolia", "--artifact", "out/Counter.sol/Counter.json", "--args", "[1]");
    check(second.code !== 0 && second.out.includes("daily limit on chain 84532"), `second deploy, the tool's preview -> ${second.out.split("\n")[0].slice(0, 200)}`);
    // The tool is only a convenience: the contract refuses the request itself.
    const init = encodeDeployData({ abi: COUNTER.abi, bytecode: COUNTER.bytecode.object, args: [1n] });
    const salt = keccak256(toHex(`keyfree-budget-${Date.now()}`));
    await refused("second deploy straight to the contract, tool bypassed",
      () => act("agent", "request_deploy", { chain_id: BASE, init_code_hex: init, gas_limit: 300_000, max_fee_per_gas: 10_000_000, max_priority_fee_per_gas: 1_000_000, salt_hex: salt, via_factory: true }, "250"),
      "daily limit on chain 84532");
  } else if (stage === "second") {
    // The day's one transaction is used (journal line 13); a second request is refused by the tool and the contract.
    const b = await budget(BASE);
    check(b.used_tx_today === 1, `budget used today: ${b.used_tx_today} of ${b.max_tx_per_day} transactions, ${b.used_wei_today} of ${b.max_wei_per_day} wei`);
    const second = cli("preview", "--chain", "base-sepolia", "--artifact", "out/Counter.sol/Counter.json", "--args", "[1]");
    check(second.code !== 0 && second.out.includes("daily limit on chain 84532"), `second deploy today, the tool's preview -> ${second.out.split("\n")[0].slice(0, 200)}`);
    const init = encodeDeployData({ abi: COUNTER.abi, bytecode: COUNTER.bytecode.object, args: [1n] });
    const salt = keccak256(toHex(`keyfree-budget-second-${Date.now()}`));
    await refused("second deploy today straight to the contract, tool bypassed",
      () => act("agent", "request_deploy", { chain_id: BASE, init_code_hex: init, gas_limit: 300_000, max_fee_per_gas: 10_000_000, max_priority_fee_per_gas: 1_000_000, salt_hex: salt, via_factory: true }, "250"),
      "daily limit on chain 84532");
  } else if (stage === "raise") {
    await rules([{ SetBudget: { chain_id: BASE, max_wei_per_day: 1_000_000_000_000_000, max_tx_per_day: 20 } }]);
    let b = await budget(BASE);
    check(b.max_tx_per_day === 20, `raised through the delay: ${b.max_tx_per_day} transactions and ${b.max_wei_per_day} wei a day`);
    await refused("the guardian raises it at once", () => act("guardian", "lower_budget", { chain_id: BASE, max_wei_per_day: 1_000_000_000_000_000, max_tx_per_day: 21 }), "raising a budget is a rule proposal");
    await act("guardian", "lower_budget", { chain_id: BASE, max_wei_per_day: 500_000_000_000_000, max_tx_per_day: 10 });
    await wait(3);
    b = await budget(BASE);
    check(b.max_tx_per_day === 10, `the guardian lowered it at once: ${b.max_tx_per_day} transactions and ${b.max_wei_per_day} wei a day`);
  } else if (stage === "heal") {
    // Journal line 13 was signed when the first request of the day went straight to the contract; nobody had
    // broadcast it. resign gives the same nonce and content with fresh fees (it counts against the budget too).
    const e = await view(P, "get_entry", { chain_id: BASE, nonce: 13 });
    const init = encodeDeployData({ abi: COUNTER.abi, bytecode: COUNTER.bytecode.object, args: [1n] });
    check(e.status === "signed" && e.code_hash === keccak256(init).slice(2), `journal line 13: Counter(1) through the factory, ${e.status}, promised at ${e.address}`);
    const base = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
    const fee = (await base.estimateFeesPerGas()).maxFeePerGas * 2n;
    const out = await act("agent", "resign", { chain_id: BASE, nonce: 13, init_code_hex: init, gas_limit: 300_000, max_fee_per_gas: Number(fee > 10_000_000n ? fee : 10_000_000n), max_priority_fee_per_gas: 1_000_000 }, "250");
    const raw = result(out);
    if (!raw) throw new Error("resign: not signed");
    const hash = await base.sendRawTransaction({ serializedTransaction: raw });
    const rc = await base.waitForTransactionReceipt({ hash, timeout: 180_000 });
    check(rc.status === "success", `nonce 13 landed: Counter(1) at ${e.address}  ${explorer(out.transaction.hash)}  https://sepolia.basescan.org/tx/${hash}`);
    const b = await budget(BASE);
    say(`budget used today: ${b.used_tx_today} of ${b.max_tx_per_day} transactions, ${b.used_wei_today} of ${b.max_wei_per_day} wei`);
  } else {
    console.log("stages: set | demo | second | raise | heal");
  }
} catch (e) {
  check(false, `stopped: ${String(e.message || e).replace(/\s+/g, " ").slice(0, 300)}`);
}
save();
process.exit(fails ? 1 : 0);
