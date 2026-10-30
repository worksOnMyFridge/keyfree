// Compile demo/Counter.sol with solc-js into a Foundry-shaped artifact: demo/out/Counter.sol/Counter.json.
const fs = require("fs");
const path = require("path");
const solc = require("solc");
const src = fs.readFileSync(path.join(__dirname, "Counter.sol"), "utf8");
const input = { language: "Solidity", sources: { "Counter.sol": { content: src } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
for (const e of out.errors || []) console.log(e.severity, e.formattedMessage);
const c = out.contracts["Counter.sol"].Counter;
const dir = path.join(__dirname, "out", "Counter.sol");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "Counter.json"), JSON.stringify({ abi: c.abi, bytecode: { object: "0x" + c.evm.bytecode.object } }, null, 1));
console.log("Counter bytecode bytes:", c.evm.bytecode.object.length / 2);
