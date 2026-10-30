// Predict the Read MPC payload hash for a Base tx with the BlockHash extractor:
// sha256(borsh(ForeignTxSignPayload::V1 { request: Base(EvmRpcRequest{tx, [BlockHash], Finalized}), values: [Evm(BlockHash(h))] }))
// Layout from near/mpc crates/near-mpc-contract-interface/src/types/foreign_chain.rs (Base = variant 6).
import crypto from "node:crypto";
export function basePayloadHash(txHex, blockHashHex) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const buf = Buffer.concat([
    Buffer.from([0, 6]), Buffer.from(txHex.replace(/^0x/, ""), "hex"),
    u32(1), Buffer.from([0]), Buffer.from([2]),
    u32(1), Buffer.from([1, 0]), Buffer.from(blockHashHex.replace(/^0x/, ""), "hex"),
  ]);
  return crypto.createHash("sha256").update(buf).digest("hex");
}
if (process.argv[2]) console.log(basePayloadHash(process.argv[2], process.argv[3]));
