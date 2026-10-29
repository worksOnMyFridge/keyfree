// The EVM side: read chains, check what the policy built against viem, broadcast what it signed.
import { createPublicClient, http, keccak256, toHex, type Hex, type PublicClient } from "viem";
import type { ChainConfig } from "./config.js";

export const FACTORY_ABI = [
  {
    type: "event", name: "Deployed", anonymous: false,
    inputs: [
      { indexed: true, name: "addr", type: "address" },
      { indexed: true, name: "codeHash", type: "bytes32" },
      { indexed: false, name: "salt", type: "bytes32" },
    ],
  },
  {
    type: "function", name: "deploy", stateMutability: "nonpayable",
    inputs: [{ name: "salt", type: "bytes32" }, { name: "initCode", type: "bytes" }],
    outputs: [{ name: "addr", type: "address" }],
  },
  { type: "function", name: "keyfree", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

const clients = new Map<number, PublicClient>();
export function evm(chain: ChainConfig): PublicClient {
  let c = clients.get(chain.chain_id);
  if (!c) {
    c = createPublicClient({ transport: http(chain.rpc, { timeout: 30_000 }) });
    clients.set(chain.chain_id, c);
  }
  return c;
}

export const txLink = (chain: ChainConfig, hash: string) => `${chain.explorer}/tx/${hash}`;
export const addressLink = (chain: ChainConfig, addr: string) => `${chain.explorer}/address/${addr}`;

export function randomSalt(): Hex {
  return keccak256(toHex(`keyfree:${Date.now()}:${Math.random()}`));
}
