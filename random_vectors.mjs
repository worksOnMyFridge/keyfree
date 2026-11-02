// Random transactions for the contract's builder (R10, N14), next to golden_vectors.mjs: viem serializes 400
// transactions with edge-heavy random fields (nonce, gas and fees up to 2^128-1, chain ids up to 2^64-1, init
// code of 0..1100 bytes, plain create / factory deploy / proxy upgrade, random r and s), and the Rust test
// random_transactions_encode_like_viem builds each one from the same fields and compares the hashes.
// Fixed seed, so the file is the same on every run. Run: node random_vectors.mjs -> evidence/random_txs.json
import fs from "node:fs";
import { keccak256, serializeTransaction, encodeFunctionData, toHex } from "./tools/evm.mjs";

let x = 0x2545f4914f6cdd1dn;
const next = () => { x ^= (x << 13n) & 0xffffffffffffffffn; x ^= x >> 7n; x ^= (x << 17n) & 0xffffffffffffffffn; return x; };
const below = (n) => Number(next() % BigInt(n));
const bytes = (n) => Uint8Array.from({ length: n }, () => below(256));
const pick = (xs) => xs[below(xs.length)];
const bits = (k) => { let v = 0n; for (let i = 0; i < k; i += 64) v = (v << 64n) | next(); return v & ((1n << BigInt(k)) - 1n); };
// Edges of RLP integer encoding (single byte, short string, length boundaries) and of the Rust field types.
const edge = (max) => pick([0n, 1n, 0x7fn, 0x80n, 0xffn, 0x100n, 0xffffn, 0x10000n, (1n << 32n) - 1n, 1n << 32n, (1n << 53n) + 1n, (1n << 64n) - 1n, 1n << 64n, (1n << 127n), (1n << 128n) - 1n].filter((v) => v <= max));
const value = (maxBits) => (below(3) === 0 ? edge((1n << BigInt(maxBits)) - 1n) : bits(1 + below(maxBits)));

const deployAbi = [{ type: "function", name: "deploy", stateMutability: "nonpayable", inputs: [{ name: "salt", type: "bytes32" }, { name: "initCode", type: "bytes" }], outputs: [{ type: "address" }] }];
const upgradeAbi = [{ type: "function", name: "upgradeTo", stateMutability: "nonpayable", inputs: [{ name: "implementation", type: "address" }], outputs: [] }];

// Init code is not stored: byte j of a case's code is the top byte of (init_seed + j * 0x9e3779b97f4a7c15) mod 2^64,
// which the Rust test recomputes. Only the plain and factory kinds use it.
const GOLDEN = 0x9e3779b97f4a7c15n;
const initOf = (seed, n) => Uint8Array.from({ length: n }, (_, j) => Number(((seed + BigInt(j) * GOLDEN) & 0xffffffffffffffffn) >> 56n));

const cases = [];
for (let i = 0; i < 400; i++) {
  const kind = pick(["plain", "factory", "proxy"]);
  let chainId = value(64);
  if (chainId === 0n) chainId = 1n; // viem refuses chain id 0; the policy only opens real chains
  const fee = value(128);
  const prio = fee === 0n ? 0n : value(128) % (fee + 1n); // viem refuses a tip above the fee cap
  const size = pick([0, 1, 31, 32, 33, 55, 56, 57, 255, 256, 1023, 1024, 1100, below(1100)]);
  const initSeed = next();
  const init = initOf(initSeed, size);
  const salt = bytes(32);
  const to = bytes(20);
  const implementation = bytes(20);
  let data, toHexAddr;
  if (kind === "plain") data = toHex(init);
  else if (kind === "factory") { data = encodeFunctionData({ abi: deployAbi, functionName: "deploy", args: [toHex(salt), toHex(init)] }); toHexAddr = toHex(to); }
  else { data = encodeFunctionData({ abi: upgradeAbi, functionName: "upgradeTo", args: [toHex(implementation)] }); toHexAddr = toHex(to); }
  const tx = { type: "eip1559", chainId: chainId <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(chainId) : chainId, nonce: value(64), gas: value(128), maxFeePerGas: fee, maxPriorityFeePerGas: prio, to: toHexAddr, data };
  // r and s: any 32 bytes, leading zero bytes included (both sides strip them)
  const r = toHex(Uint8Array.from(bytes(32), (b, j) => (j < below(3) ? 0 : b)));
  const s = toHex(Uint8Array.from(bytes(32), (b, j) => (j < below(3) ? 0 : b)));
  const yParity = below(2);
  const unsigned = serializeTransaction(tx);
  const signed = serializeTransaction(tx, { r, s, yParity });
  cases.push({ kind, chain_id: String(chainId), nonce: String(tx.nonce), gas_limit: String(tx.gas), max_fee_per_gas: String(fee), max_priority_fee_per_gas: String(prio),
    ...(kind === "proxy" ? { implementation: toHex(implementation) } : { init_seed: String(initSeed), init_len: size }),
    ...(kind === "factory" ? { salt: toHex(salt) } : {}), ...(kind === "plain" ? {} : { to: toHex(to) }), r, s, y_parity: yParity,
    unsigned_keccak: keccak256(unsigned), signed_keccak: keccak256(signed) });
}
fs.writeFileSync(new URL("./evidence/random_txs.json", import.meta.url), JSON.stringify({ viem: "2.57.11", seed: "0x2545f4914f6cdd1d", cases }) + "\n");
console.log(`${cases.length} transactions -> evidence/random_txs.json`);
