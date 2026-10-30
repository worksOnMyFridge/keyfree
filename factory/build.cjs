// Compile KeyfreeFactory with solc-js and write factory.json {abi, bytecode}.
const fs = require("fs");
const solc = require("solc");
const input = { language: "Solidity", sources: { "KeyfreeFactory.sol": { content: fs.readFileSync(__dirname + "/KeyfreeFactory.sol", "utf8") } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
for (const e of out.errors || []) console.log(e.severity, e.formattedMessage);
const c = out.contracts["KeyfreeFactory.sol"].KeyfreeFactory;
fs.writeFileSync(__dirname + "/factory.json", JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 1));
console.log("bytecode bytes:", c.evm.bytecode.object.length / 2);
