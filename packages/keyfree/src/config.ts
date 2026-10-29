// Project config (keyfree.json) and where the signing keys come from. Keys are never printed or returned.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ChainConfig {
  name: string;
  chain_id: number;
  rpc: string;
  explorer: string;
}

export interface Config {
  near_network: "testnet" | "mainnet";
  near_rpc: string;
  near_explorer: string;
  policy: string;
  agent: string;
  owner?: string;
  chains: ChainConfig[];
  // x the viem fee estimate; the address must hold gas_limit x max fee up front
  fee_multiplier?: number;
}

export class ConfigError extends Error {}

export function loadConfig(file = process.env.KEYFREE_CONFIG ?? "keyfree.json"): Config {
  const full = path.resolve(file);
  if (!fs.existsSync(full)) {
    throw new ConfigError(`No ${file} here (${process.cwd()}). Create one (see keyfree.example.json) or set KEYFREE_CONFIG to its path.`);
  }
  const cfg = JSON.parse(fs.readFileSync(full, "utf8")) as Config;
  for (const k of ["near_network", "near_rpc", "policy", "agent", "chains"] as const) {
    if (!cfg[k]) throw new ConfigError(`${file}: "${k}" is missing.`);
  }
  return cfg;
}

export function findChain(cfg: Config, chain: string | number): ChainConfig {
  const c = cfg.chains.find((x) => x.name === String(chain) || x.chain_id === Number(chain));
  if (!c) throw new ConfigError(`Chain "${chain}" is not in keyfree.json. Known: ${cfg.chains.map((x) => `${x.name} (${x.chain_id})`).join(", ")}.`);
  return c;
}

function readKeyFile(file: string): string {
  const k = JSON.parse(fs.readFileSync(file, "utf8")) as { private_key?: string; secret_key?: string };
  const key = k.private_key ?? k.secret_key;
  if (!key) throw new ConfigError(`Key file ${file} has no private_key.`);
  return key;
}

function credentialsFile(cfg: Config, account: string): string {
  return path.join(os.homedir(), ".near-credentials", cfg.near_network, `${account}.json`);
}

// The agent's key: a function-call key that may only call the policy's request methods.
export function agentKey(cfg: Config): string {
  const file = process.env.KEYFREE_AGENT_KEY ?? credentialsFile(cfg, cfg.agent);
  if (!fs.existsSync(file)) {
    throw new ConfigError(`No key for the agent ${cfg.agent}. Set KEYFREE_AGENT_KEY to a key file, or put it in ${credentialsFile(cfg, cfg.agent)}.`);
  }
  return readKeyFile(file);
}

// A council member's key, for the human-only CLI commands. Never used by the MCP server.
export function councilKey(cfg: Config, account: string): string {
  const file = process.env.KEYFREE_COUNCIL_KEY ?? credentialsFile(cfg, account);
  if (!fs.existsSync(file)) throw new ConfigError(`No key for ${account}: expected ${file} (or set KEYFREE_COUNCIL_KEY).`);
  return readKeyFile(file);
}
