// Compile contracts/*.sol into out/<File>.sol/<Contract>.json (Foundry layout).
const fs = require("fs");
const path = require("path");
const solc = require("solc");
const names = ["TreasuryProxy", "TreasuryV1", "TreasuryV2"];
const sources = Object.fromEntries(names.map((n) => [`${n}.sol`, { content: fs.readFileSync(path.join(__dirname, "contracts", `${n}.sol`), "utf8") }]));
const input = { language: "Solidity", sources,
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
for (const e of out.errors || []) console.log(e.severity, e.formattedMessage);
for (const n of names) {
  const c = out.contracts[`${n}.sol`][n];
  const dir = path.join(__dirname, "out", `${n}.sol`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify({ abi: c.abi, bytecode: { object: "0x" + c.evm.bytecode.object } }, null, 1));
  console.log(n, "bytecode bytes:", c.evm.bytecode.object.length / 2);
}
