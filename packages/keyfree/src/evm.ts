// The EVM side: read chains, check what the policy built against viem, broadcast what it signed.
import { createPublicClient, fallback, http, keccak256, toHex, type Hex, type PublicClient } from "viem";
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

// ERC-1967 proxy: the one call the policy signs, and the log Read MPC confirms.
export const PROXY_ABI = [
  { type: "event", name: "Upgraded", anonymous: false, inputs: [{ indexed: true, name: "implementation", type: "address" }] },
  { type: "function", name: "upgradeTo", stateMutability: "nonpayable", inputs: [{ name: "implementation", type: "address" }], outputs: [] },
] as const;
export const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
export const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as const;

export const slotAddress = (word: Hex | undefined) => (word ? `0x${word.slice(-40)}`.toLowerCase() : null);

const clients = new Map<number, PublicClient>();
export function evm(chain: ChainConfig, timeout = 20_000): PublicClient {
  let c = clients.get(chain.chain_id);
  if (!c) {
    // Two retries at most, so a silent node is called dead within a minute; a fallback is tried instead of retrying.
    const more = chain.rpc_fallbacks ?? [];
    const node = (url: string) => http(url, { timeout, retryCount: more.length ? 0 : 2 });
    c = createPublicClient({ transport: more.length ? fallback([chain.rpc, ...more].map(node)) : node(chain.rpc) });
    clients.set(chain.chain_id, c);
  }
  return c;
}

export const txLink = (chain: ChainConfig, hash: string) => `${chain.explorer}/tx/${hash}`;
export const addressLink = (chain: ChainConfig, addr: string) => `${chain.explorer}/address/${addr}`;

export function randomSalt(): Hex {
  return keccak256(toHex(`keyfree:${Date.now()}:${Math.random()}`));
}
