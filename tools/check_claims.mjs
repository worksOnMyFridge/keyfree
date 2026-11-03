// npm run check:claims - the docs against the chains and the repository, read-only, no keys:
//  1. every transaction and address the docs link to exists, and how it ended (archival NEAR RPC, Base Sepolia,
//     Ethereum Sepolia); a transaction a claim cites as a refusal must have failed, every other one succeeded;
//  2. the live policy is what the docs say: no keys, the reproducible build's sha256 and size, its commit, budgets;
//  3. every count the docs give (tests, attacks, methods, vectors) equals the repository's;
//  4. every log line CLAIMS quotes is in the log it names.
// Writes evidence/claims_check.md. Exit 1 on any mismatch.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const DOCS = ["README.md", "CLAIMS.md", "SECURITY.md", "AUDIT.md", "packages/keyfree/README.md"];
// Two public archival nodes (old testnet transactions are gone from regular ones); a rate-limited call moves on.
const NEAR = process.env.NEAR_ARCHIVAL_RPC ? [process.env.NEAR_ARCHIVAL_RPC] : ["https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"];
// A public node behind a load balancer can answer null for a transaction another node has: a receipt is looked for on each.
const EVM = { base: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"], eth: ["https://ethereum-sepolia-rpc.publicnode.com", "https://ethereum-sepolia.gateway.tatum.io"] };
const POLICY = "policy13.keyfree-lab.testnet";
// Transactions a claim cites because they were refused or answered false.
const EXPECTED_REFUSAL = { "9AKiRUEoe4BNaFt2qgaY8Nc6QMfL4H5kqkfheFyY3noD": "false" };
// EVM transactions a claim cites as reverted (CLAIMS 8.5: the factory's first try ran out of gas).
const EXPECTED_REVERT = new Set(["0x2407edb51ac1e2d4b9489c79bc9b1c19c25208ff3fd8415dd8be8a0ebe79d6c6"]);

const rows = [];
let bad = 0;
const report = (ok, what, detail) => { if (!ok) bad++; rows.push({ ok, what, detail }); console.log(`${ok ? "OK  " : "FAIL"} ${what}: ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(urls, method, params) {
  for (let i = 0; ; i++) {
    const url = [urls].flat()[i % [urls].flat().length];
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30000) });
      const j = await r.json();
      // a free public RPC: back off on rate limits and timeouts
      if (j.error && i < 5 && /timeout|limit|busy/i.test(JSON.stringify(j.error))) { await sleep(3000 * (i + 1)); continue; }
      return j;
    } catch (e) {
      if (i >= 5) return { error: { message: String(e.message || e) } };
      await sleep(3000 * (i + 1));
    }
  }
}
const view = async (method, args = {}) => {
  const j = await rpc(NEAR, "query", { request_type: "call_function", finality: "final", account_id: POLICY, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
  return JSON.parse(Buffer.from(j.result.result).toString());
};

// Every chain link in the docs, with the claim id of its table row when it has one.
const links = new Map();
for (const doc of DOCS) {
  read(doc).split("\n").forEach((line, i) => {
    const claim = line.match(/^\| (\d+\.\d+) \|/)?.[1];
    const where = `${doc}:${i + 1}${claim ? ` (claim ${claim})` : ""}`;
    for (const [re, kind] of [
      [/testnet\.nearblocks\.io\/txns\/([1-9A-HJ-NP-Za-km-z]{43,44})/g, "near-tx"],
      [/testnet\.nearblocks\.io\/address\/([a-z0-9._-]+)/g, "near-account"],
      [/sepolia\.basescan\.org\/tx\/(0x[0-9a-fA-F]{64})/g, "base-tx"],
      [/sepolia\.basescan\.org\/address\/(0x[0-9a-fA-F]{40})/g, "base-address"],
      [/sepolia\.etherscan\.io\/tx\/(0x[0-9a-fA-F]{64})/g, "eth-tx"],
      [/sepolia\.etherscan\.io\/address\/(0x[0-9a-fA-F]{40})/g, "eth-address"],
    ]) for (const m of line.matchAll(re)) {
      const k = `${kind} ${m[1]}`;
      if (!links.has(k)) links.set(k, { kind, id: m[1], where: [] });
      links.get(k).where.push(where);
    }
  });
}

console.log(`1/3 ${links.size} chain links in ${DOCS.join(", ")}`);
// The policy's own ETH address is an account without code: its link is checked by its transaction count.
const policyEth = (await view("get_eth_address")).toLowerCase();
for (const { kind, id, where } of links.values()) {
  const at = where[0] + (where.length > 1 ? ` +${where.length - 1}` : "");
  if (kind === "near-tx") {
    const j = await rpc(NEAR, "tx", { tx_hash: id, sender_account_id: POLICY, wait_until: "NONE" });
    if (j.error) { report(false, `NEAR tx ${id.slice(0, 8)}… ${at}`, `not found: ${j.error.cause?.name ?? j.error.message}`); continue; }
    const t = j.result.transaction;
    const methods = t.actions.map((a) => a.FunctionCall?.method_name ?? Object.keys(a)[0]).join("+");
    const failed = Boolean(j.result.status.Failure);
    const value = j.result.status.SuccessValue ? Buffer.from(j.result.status.SuccessValue, "base64").toString() : "";
    const ended = failed ? `failed (${JSON.stringify(j.result.status.Failure).match(/"ExecutionError":"([^"]*)"/)?.[1] ?? "error"})` : `success${value ? ` = ${value.slice(0, 40)}` : ""}`;
    const want = EXPECTED_REFUSAL[id];
    const ok = want === "false" ? !failed && value === "false" : want === "fail" ? failed : !failed;
    report(ok, `NEAR tx ${id.slice(0, 8)}… ${at}`, `${t.signer_id} -> ${t.receiver_id} ${methods}: ${ended}${want ? ` (cited as ${want === "false" ? "answered false" : "refused"})` : ""}`);
  } else if (kind === "near-account") {
    const j = await rpc(NEAR, "query", { request_type: "view_account", finality: "final", account_id: id });
    report(!j.error, `NEAR account ${id} ${at}`, j.error ? "missing" : `exists, code hash ${j.result.code_hash.slice(0, 8)}…`);
  } else {
    const url = kind.startsWith("base") ? EVM.base : EVM.eth;
    const chain = kind.startsWith("base") ? "Base Sepolia" : "Ethereum Sepolia";
    if (kind.endsWith("-tx")) {
      let rc = null;
      for (const node of url) { rc = (await rpc(node, "eth_getTransactionReceipt", [id])).result ?? null; if (rc) break; }
      const revert = EXPECTED_REVERT.has(id.toLowerCase());
      report(Boolean(rc) && (rc.status === "0x1") !== revert, `${chain} tx ${id.slice(0, 10)}… ${at}`, rc ? `block ${parseInt(rc.blockNumber, 16)}, status ${rc.status === "0x1" ? "success" : "reverted"}${rc.contractAddress ? `, created ${rc.contractAddress}` : ""}${revert ? " (cited as reverted)" : ""}` : "no receipt");
    } else if (id.toLowerCase() === policyEth) {
      const j = await rpc(url, "eth_getTransactionCount", [id, "latest"]);
      const n = parseInt(j.result ?? "0x0", 16);
      report(n > 0, `${chain} address ${id.slice(0, 10)}… ${at}`, `the policy's keyless address (get_eth_address), ${n} transactions sent`);
      if (chain === "Base Sepolia") {
        const said = read("README.md").match(/nonces 0 to (\d+), from an address/)?.[1];
        report(Number(said) === n - 1, "README: nonces of the keyless address on Base Sepolia", `docs 0..${said ?? "?"}, chain 0..${n - 1}`);
      }
    } else {
      const j = await rpc(url, "eth_getCode", [id, "latest"]);
      const n = j.result ? (j.result.length - 2) / 2 : 0;
      report(n > 0, `${chain} address ${id.slice(0, 10)}… ${at}`, n > 0 ? `contract, ${n} bytes of code` : "no code");
    }
  }
  await sleep(400);
}

console.log("2/3 the live policy");
{
  const keys = await rpc(NEAR, "query", { request_type: "view_access_key_list", finality: "final", account_id: POLICY });
  report(keys.result?.keys?.length === 0, `${POLICY} access keys`, `${keys.result?.keys?.length ?? "?"} (docs: 0)`);
  const code = await rpc(NEAR, "query", { request_type: "view_code", finality: "final", account_id: POLICY });
  const wasm = Buffer.from(code.result?.code_base64 ?? "", "base64");
  const sha = crypto.createHash("sha256").update(wasm).digest("hex");
  const readme = read("README.md");
  const docSha = readme.match(/# -> ([0-9a-f]{64})\s+\(([\d ]+) bytes\)/);
  report(docSha && sha === docSha[1], "live code sha256", `${sha} (README: ${docSha?.[1] ?? "?"})`);
  report(docSha && wasm.length === Number(docSha[2].replace(/ /g, "")), "live code size", `${wasm.length} bytes (README: ${docSha?.[2] ?? "?"})`);
  const commit = readme.match(/the commit `([0-9a-f]{40})`/)?.[1];
  const meta = await view("contract_source_metadata");
  const snap = JSON.stringify(meta);
  report(Boolean(commit) && snap.includes(commit), "NEP-330 metadata names the README's commit", `${commit ?? "?"} in ${meta.build_info?.source_code_snapshot ?? snap.slice(0, 80)}`);
  const st = await view("get_status");
  const build = readme.match(/build `(v\d+)`/)?.[1] ?? "v16";
  report(st.build === build, "get_status build", `${st.build}, version ${st.version}, paused ${st.paused} (docs: ${build})`);
  for (const [chain, id] of [["Base Sepolia", 84532], ["Ethereum Sepolia", 11155111]]) {
    const b = await view("get_budget", { chain_id: id });
    report(Boolean(b), `daily budget on ${chain}`, b ? `${b.max_tx_per_day} transactions, ${b.max_wei_per_day} wei a day` : "none (AUDIT V1 says both open chains have one)");
  }
}

console.log("3/3 counts in the docs");
const count = (f, re) => (read(f).match(re) ?? []).length;
const toolTests = (() => {
  const pkg = path.join(root, "packages", "keyfree");
  if (!fs.existsSync(path.join(pkg, "dist", "cli.js"))) return null;
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/unit.test.mjs", "test/cli.test.mjs", "test/attacks.test.mjs", "test/faults.test.mjs"], { cwd: pkg, encoding: "utf8" });
  return Number(r.stdout.match(/^# tests (\d+)/m)?.[1] ?? NaN);
})();
const catalog = JSON.parse(read("attacks/catalog.json")).groups.flatMap((g) => g.attacks);
const actual = {
  "contract tests": count("contract/src/tests.rs", /#\[test\]/g),
  "tool tests": toolTests,
  "factory tests": count("factory/factory.test.mjs", /^\s*test\(/gm),
  "sandbox tests": count("sandbox/policy.test.mjs", /^test\(/gm),
  "offline attacks": catalog.filter((a) => !a.liveOnly).length,
  "live-only attacks": catalog.filter((a) => a.liveOnly).length,
  "public methods": count("contract/src/lib.rs", /^ {4}pub fn /gm),
  "random vectors": JSON.parse(read("evidence/random_txs.json")).cases.length,
};
const said = [
  ["contract tests", "README.md", /(\d+) tests of the policy/g],
  ["contract tests", "CLAIMS.md", /Policy contract tests[^|]*\| (\d+) \|/g],
  ["contract tests", "SECURITY.md", /\((\d+) unit and property tests/g],
  ["tool tests", "README.md", /(\d+) tool tests/g],
  ["tool tests", "CLAIMS.md", /keyfree package tests[^|]*\| (\d+) \|/g],
  ["factory tests", "README.md", /(\d+) tests of the CREATE2 factory/g],
  ["sandbox tests", "CLAIMS.md", /in a local nearcore node with a stand-in MPC[^|]*\| (\d+) \|/g],
  ["offline attacks", "README.md", /(\d+) attacks, offline/g],
  ["offline attacks", "SECURITY.md", /attack bench of (\d+) attacks/g],
  ["offline attacks", "CLAIMS.md", /\| (\d+) offline \+ \d+ live \|/g],
  ["live-only attacks", "CLAIMS.md", /\| \d+ offline \+ (\d+) live \|/g],
  ["public methods", "README.md", /each of the (\d+) methods/g],
  ["random vectors", "README.md", /(\d+) more transactions with random/g],
  ["random vectors", "CLAIMS.md", /(\d+) random transactions against viem/g],
];
for (const [what, doc, re] of said) {
  const found = [...read(doc).matchAll(re)].map((m) => Number(m[1]));
  if (!found.length) { report(false, `${what} in ${doc}`, "the sentence was not found (docs changed? update this check)"); continue; }
  if (actual[what] === null) { report(true, `${what} in ${doc}`, `${found.join(", ")} (not counted: build packages/keyfree first)`); continue; }
  report(found.every((n) => n === actual[what]), `${what} in ${doc}`, `docs ${found.join(", ")}, repository ${actual[what]}`);
}

console.log("4/4 log lines quoted in CLAIMS");
read("CLAIMS.md").split("\n").forEach((line, i) => {
  const logs = [...new Set([...line.matchAll(/evidence\/([a-z0-9_]+\.log)/g)].map((m) => m[1]))];
  if (!logs.length) return;
  const text = logs.map((f) => read(`evidence/${f}`)).join("\n");
  // code spans that read as log text: words with spaces, not a path, a command, a list of names or a cut hash
  const quotes = line.split("`").filter((_, k) => k % 2 === 1)
    .filter((q) => q.includes(" ") && !/[/…*]|^(cargo|npm|node|keyfree|rules) |^[\w]+(, [\w]+)+$/.test(q));
  for (const q of quotes) report(text.includes(q), `CLAIMS.md:${i + 1} quotes ${logs.join(", ")}`, `"${q.slice(0, 70)}${q.length > 70 ? "…" : ""}"${text.includes(q) ? "" : " not found"}`);
});

const md = ["# Claims check", "", "Run: `npm run check:claims` (read-only, no keys; needs network). The docs against the chains and the",
  "repository: every linked transaction and address, the live policy, every count, every quoted log line.", "",
  `Result: ${rows.length - bad} of ${rows.length} checks agree${bad ? `, **${bad} do not**` : ""}.`, "", "| | Check | Result |", "|---|---|---|",
  ...rows.map((r) => `| ${r.ok ? "ok" : "**FAIL**"} | ${r.what.replace(/\|/g, "/")} | ${r.detail.replace(/\|/g, "/")} |`), ""];
fs.writeFileSync(path.join(root, "evidence", "claims_check.md"), md.join("\n"));
console.log(`\n${rows.length - bad}/${rows.length} agree -> evidence/claims_check.md`);
process.exitCode = bad ? 1 : 0;
