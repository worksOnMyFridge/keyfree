// Compile contracts/Vault.sol into out/Vault.sol/Vault.json (Foundry layout).
const fs = require("fs");
const path = require("path");
const solc = require("../../../../../tools/node_modules/solc");
const src = fs.readFileSync(path.join(__dirname, "contracts", "Vault.sol"), "utf8");
const input = { language: "Solidity", sources: { "Vault.sol": { content: src } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
for (const e of out.errors || []) console.log(e.severity, e.formattedMessage);
const c = out.contracts["Vault.sol"].Vault;
const dir = path.join(__dirname, "out", "Vault.sol");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "Vault.json"), JSON.stringify({ abi: c.abi, bytecode: { object: "0x" + c.evm.bytecode.object } }, null, 1));
console.log("Vault bytecode bytes:", c.evm.bytecode.object.length / 2);
