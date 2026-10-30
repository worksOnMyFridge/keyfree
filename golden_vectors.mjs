// Golden vectors for the contract's own transaction builder (spec R10, audit v2 Н14): viem serializes the
// same EIP-1559 deploys the contract builds, offline, and the Rust tests compare bytes/hashes with these.
// Init code is a fixed pattern: byte i = (i * 7 + 3) mod 256. Signature r/s are fixed test values.
// Run: node golden_vectors.mjs  ->  evidence/golden_rlp.json
import fs from "node:fs";
import { keccak256, serializeTransaction, encodeFunctionData, toHex } from "./tools/evm.mjs";

const init = (n) => toHex(Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff));
const R = "0xc82ea247999e197432c89e62fdb8395b960b091b7c5128cbd6f58b1278aef4c8";
const S = "0x0fd87334c82dcab810a383fb049e9a28c8c50721ca503a578e4024356f7adca6";
const SALT = "0x" + "11".repeat(32);
const FACTORY = "0xe744243604e31d7be8b76e0c8bdff4ec5f560ffd";
const deployAbi = [{ type: "function", name: "deploy", stateMutability: "nonpayable", inputs: [{ name: "salt", type: "bytes32" }, { name: "initCode", type: "bytes" }], outputs: [{ type: "address" }] }];

const fee = { chainId: 84532, gas: 3_000_000n, maxFeePerGas: 14_000_000n, maxPriorityFeePerGas: 1_000_000n, type: "eip1559" };
const cases = [
  { name: "plain_1k", nonce: 9, size: 1024, factory: false },
  { name: "factory_24k", nonce: 10, size: 24 * 1024, factory: true },
  { name: "factory_48k", nonce: 11, size: 48 * 1024, factory: true },
];

// v14: the one call the policy signs, upgradeTo(implementation) on a proxy.
const PROXY = "0x" + "22".repeat(20);
const IMPLEMENTATION = "0x" + "33".repeat(20);
const upgradeAbi = [{ type: "function", name: "upgradeTo", stateMutability: "nonpayable", inputs: [{ name: "implementation", type: "address" }], outputs: [] }];

const out = cases.map((c) => {
  const code = init(c.size);
  const data = c.factory ? encodeFunctionData({ abi: deployAbi, functionName: "deploy", args: [SALT, code] }) : code;
  const tx = { ...fee, nonce: c.nonce, to: c.factory ? FACTORY : undefined, data };
  const unsigned = serializeTransaction(tx);
  const signed = serializeTransaction(tx, { r: R, s: S, yParity: 0 });
  return {
    name: c.name, nonce: c.nonce, size: c.size, factory: c.factory,
    data_keccak: keccak256(data), unsigned_len: (unsigned.length - 2) / 2, unsigned_keccak: keccak256(unsigned),
    signed_len: (signed.length - 2) / 2, signed_keccak: keccak256(signed),
    ...(c.size <= 1024 ? { unsigned_hex: unsigned } : {}),
  };
});
{
  const data = encodeFunctionData({ abi: upgradeAbi, functionName: "upgradeTo", args: [IMPLEMENTATION] });
  const tx = { ...fee, gas: 100_000n, nonce: 12, to: PROXY, data };
  const unsigned = serializeTransaction(tx);
  const signed = serializeTransaction(tx, { r: R, s: S, yParity: 0 });
  out.push({ name: "proxy_upgrade", nonce: 12, proxy: PROXY, implementation: IMPLEMENTATION, data, data_keccak: keccak256(data),
    unsigned_len: (unsigned.length - 2) / 2, unsigned_keccak: keccak256(unsigned), signed_len: (signed.length - 2) / 2, signed_keccak: keccak256(signed), unsigned_hex: unsigned });
}
fs.writeFileSync(new URL("./evidence/golden_rlp.json", import.meta.url), JSON.stringify({ viem: "2.57.11", salt: SALT, factory: FACTORY, r: R, s: S, cases: out }, null, 2) + "\n");
for (const c of out) console.log(c.name, "unsigned", c.unsigned_len, "B", c.unsigned_keccak, "signed", c.signed_keccak);
