// Spike S12, experiment 3: ask NEAR "Read MPC" (verify_foreign_transaction) on testnet whether our
// keyless Base Sepolia deploy is finalized (BlockHash extractor only: a bare deploy emits no logs).
// Optional EXPECTED=<hex> adds expected_payload_hash to see whether testnet accepts the field.
import fs from "node:fs";
import { loadAccount, teraToGas, explorer } from "../tools/near.mjs";

const TX = process.argv[2] || "0x336f748bc346238fe3bca1a8785085113cc8c1091efbe764946144b78ccedb76";
const RPC = "https://sepolia.base.org";
const rpc = async (method, params) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
const rc = await rpc("eth_getTransactionReceipt", [TX]);
console.log("Base Sepolia tx", TX, "block", parseInt(rc.blockNumber, 16), "hash", rc.blockHash, "status", rc.status);

const request = { request: { Base: { tx_id: TX.slice(2), extractors: ["BlockHash"], finality: "Finalized" } }, domain_id: 3, payload_version: 1 };
if (process.env.EXPECTED) request.expected_payload_hash = process.env.EXPECTED;
const t0 = Date.now();
let line;
try {
  const out = await loadAccount().callFunctionRaw({ contractId: "v1.signer-prod.testnet", methodName: "verify_foreign_transaction", deposit: 1n, gas: teraToGas("100"), args: { request } });
  const resp = Buffer.from(out.status.SuccessValue, "base64").toString();
  line = `answered in ${((Date.now() - t0) / 1000).toFixed(1)} s  ${explorer(out.transaction.hash)}\n${resp.slice(0, 800)}`;
} catch (e) { line = `error after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${String(e.message).replace(/\s+/g, " ").slice(0, 400)}`; }
console.log(line);
fs.appendFileSync(new URL("../evidence/spike3.log", import.meta.url), `--- ${new Date().toISOString()} ${TX} expected=${process.env.EXPECTED || "-"}\n${line}\n`);
