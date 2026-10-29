// Check our borsh layout of an EvmLog payload against the real MPC: take an old finalized Base Sepolia
// tx that has logs, ask Read MPC (Log extractor, no expected hash) and compare its payload_hash with
// ours under a few spellings of the `data` string. Testnet only.
import crypto from "node:crypto";
import { loadAccount, teraToGas, explorer } from "../tools/near.mjs";

const RPC = "https://sepolia.base.org";
const rpc = async (method, params) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const h = (x) => Buffer.from(x.replace(/^0x/, ""), "hex");

function payload(tx, log, finality, data) {
  return crypto.createHash("sha256").update(Buffer.concat([
    Buffer.from([0, 6]), h(tx), u32(1), Buffer.from([1]), u64(parseInt(log.logIndex, 16)), Buffer.from([finality]),
    u32(1), Buffer.from([1, 1, log.removed ? 1 : 0]), u64(parseInt(log.logIndex, 16)), u64(parseInt(log.transactionIndex, 16)),
    h(log.transactionHash), h(log.blockHash), u64(parseInt(log.blockNumber, 16)), h(log.address),
    u32(Buffer.byteLength(data)), Buffer.from(data), u32(log.topics.length), ...log.topics.map(h),
  ])).digest("hex");
}

const fin = await rpc("eth_getBlockByNumber", ["finalized", false]);
let tx, lg;
for (let n = parseInt(fin.number, 16) - 50; !tx; n--) {
  const b = await rpc("eth_getBlockByNumber", ["0x" + n.toString(16), false]);
  for (const t of b.transactions.slice(1)) {
    const rc = await rpc("eth_getTransactionReceipt", [t]);
    if (rc.status === "0x1" && rc.logs.length && rc.logs[0].data.length > 2) { tx = t; lg = rc.logs[0]; break; }
  }
}
console.log("tx", tx, "log", parseInt(lg.logIndex, 16), "data", lg.data.slice(0, 20) + "…");
const args = { request: { request: { Base: { tx_id: tx.slice(2), extractors: [{ Log: { log_index: parseInt(lg.logIndex, 16) } }], finality: "Finalized" } }, domain_id: 3, payload_version: 1 } };
const out = await loadAccount("keyfree-lab.testnet").callFunctionRaw({ contractId: "v1.signer-prod.testnet", methodName: "verify_foreign_transaction", deposit: 1n, gas: teraToGas("100"), args });
const mpc = JSON.parse(Buffer.from(out.status.SuccessValue, "base64").toString()).payload_hash;
console.log("MPC payload_hash", mpc, explorer(out.transaction.hash));
for (const [name, d] of [["0x + lowercase hex (as RPC)", lg.data], ["no 0x", lg.data.slice(2)], ["0x + UPPER", "0x" + lg.data.slice(2).toUpperCase()]])
  console.log(payload(tx, lg, 2, d) === mpc ? "MATCH" : "no   ", name);
