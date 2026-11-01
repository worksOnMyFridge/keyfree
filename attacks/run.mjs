// npm run attacks: run every attack in attacks/catalog.json offline and print "attack -> refused -> why".
// Contract attacks run the real policy code on near-sdk's mocked chain (cargo test); tool and MCP attacks run
// the built keyfree package (node --test). No network, no keys. Writes evidence/attacks.md. Exit 1 on any miss.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const catalog = JSON.parse(fs.readFileSync(path.join(root, "attacks", "catalog.json"), "utf8"));
const run = (cmd, args, cwd, env = {}) => {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 << 20 });
  return { code: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
};

console.error("1/3 contract attacks: cargo test (the policy code on a mocked chain)...");
// MSVC builds of near-sdk's test deps need a prebuilt NASM on Windows; harmless elsewhere
const cargo = run("cargo", ["test", "--", "--test-threads=1"], path.join(root, "contract"), { AWS_LC_SYS_PREBUILT_NASM: "1" });
const rustOk = new Set([...cargo.out.matchAll(/^test tests::(\w+)(?: - should panic)? \.\.\. ok$/gm)].map((m) => m[1]));
if (rustOk.size === 0) { console.error(cargo.out.slice(-3000)); throw new Error("cargo test produced no results: is Rust installed?"); }

console.error("2/3 tool and MCP attacks: build keyfree, node --test...");
const pkg = path.join(root, "packages", "keyfree");
if (!fs.existsSync(path.join(pkg, "node_modules"))) throw new Error("Run `npm install` in packages/keyfree first.");
const build = run(process.execPath, [path.join(pkg, "node_modules", "typescript", "bin", "tsc")], pkg);
if (build.code !== 0) { console.error(build.out); throw new Error("keyfree build failed"); }
const node = run(process.execPath, ["--test", "--test-reporter=tap", "test/attacks.test.mjs"], pkg);
const nodeOk = new Set([...node.out.matchAll(/^\s*ok \d+ - (.+)$/gm)].map((m) => m[1].trim()));

console.error("3/3 table\n");
let total = 0, refused = 0, liveOnly = 0;
const md = ["# Attack bench", "", `Run: \`npm run attacks\` (offline).`, "",
  "Contract attacks run the real policy code on near-sdk's mocked chain; tool attacks run the built keyfree package. \"Seen live\" points to the testnet run.", ""];
for (const g of catalog.groups) {
  md.push(`## ${g.who}`, "", "| # | Attack | Result | Refusal | Test | Seen live |", "|---|---|---|---|---|---|");
  console.log(`\n${g.who}`);
  for (const a of g.attacks) {
    total++;
    let ok, test;
    if (a.liveOnly) { ok = null; test = "live only"; liveOnly++; }
    else if (a.rust) { ok = rustOk.has(a.rust); test = `\`${a.rust}\``; }
    else { const names = [a.node].flat(); ok = names.every((n) => nodeOk.has(n)); test = `tool: ${names.length} test${names.length > 1 ? "s" : ""}`; }
    if (ok) refused++;
    const mark = ok === null ? "LIVE" : ok ? "REFUSED" : "MISSED";
    console.log(`  ${mark.padEnd(7)} ${a.id.padEnd(4)} ${a.attack}  ->  ${a.refusal}`);
    md.push(`| ${a.id} | ${a.attack} | ${ok === null ? "refused live (protocol)" : ok ? "refused" : "**MISSED**"} | ${a.refusal} | ${test} | ${a.live ?? ""} |`);
  }
  md.push("");
}
const ran = total - liveOnly;
const summary = `${refused} of ${ran} attacks refused offline${liveOnly ? `, ${liveOnly} more refused live by the NEAR protocol` : ""}.`;
md.splice(4, 0, `**${summary}**`, "");
fs.writeFileSync(path.join(root, "evidence", "attacks.md"), md.join("\n"));
console.log(`\n${summary}  Table: evidence/attacks.md`);
if (refused !== ran) process.exitCode = 1;
