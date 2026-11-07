// Project config (keyfree.json) and where the signing keys come from. Keys are never printed or returned.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ChainConfig {
  name: string;
  chain_id: number;
  rpc: string;
  rpc_fallbacks?: string[]; // tried in order when `rpc` fails
  explorer: string;
}

export interface Config {
  // Not trusted: status always checks against the network's MPC (v1.signer-prod.testnet / v1.signer) and only
  // warns when this names another account.
  mpc_account?: string;
  near_network: "testnet" | "mainnet";
  near_rpc: string;
  near_rpc_fallbacks?: string[]; // tried in order when near_rpc fails: public nodes do go down
  near_explorer: string;
  policy: string;
  agent: string;
  owner?: string;
  chains: ChainConfig[];
  // x the viem fee estimate; the address must hold gas_limit x max fee up front
  fee_multiplier?: number;
  // How long one RPC request may take (default 60 s on NEAR, public testnet nodes can be that slow; 20 s on EVM), and the wait for a receipt (default 180 s).
  rpc_timeout_ms?: number;
  receipt_timeout_ms?: number;
}

export class ConfigError extends Error {}

// An empty variable counts as unset (".mcp.json" passes "${VAR:-}" when the user has not set it).
const env = (name: string) => process.env[name] || undefined;

export function loadConfig(file = env("KEYFREE_CONFIG") ?? "keyfree.json"): Config {
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

// Whether this machine holds a key for the account in the usual near-cli place. Only checks that the file exists.
export function hasLocalKey(cfg: Config, account: string): boolean {
  return fs.existsSync(credentialsFile(cfg, account));
}

// Every council key the agent's machine holds where the agent could read it (Z1): the near-cli place, a key
// file named by KEYFREE_COUNCIL_KEY, and *_key.json files next to the agent (the working folder and its setup/)
// that name a council account. Only account names and where they were found, never a key.
export function localCouncilKeys(cfg: Config, council: string[]): string[] {
  // Places are written short (~/..., or relative to the working folder) so no user name reaches a log.
  const found: string[] = [];
  for (const a of council) if (hasLocalKey(cfg, a)) found.push(`${a} in ~/.near-credentials/${cfg.near_network}/`);
  if (env("KEYFREE_COUNCIL_KEY")) found.push("KEYFREE_COUNCIL_KEY is set");
  // Next to the agent: its working folder, the folder of its keyfree.json, and their setup/ folders.
  const conf = env("KEYFREE_CONFIG");
  const bases = [process.cwd(), ...(conf ? [path.dirname(path.resolve(conf))] : [])];
  for (const dir of [...new Set(bases.flatMap((b) => [b, path.join(b, "setup")]))]) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith("_key.json")); } catch { continue; }
    for (const n of names) {
      try {
        const k = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as { account_id?: unknown };
        if (typeof k.account_id === "string" && council.includes(k.account_id)) found.push(`${k.account_id} in ${path.relative(process.cwd(), path.join(dir, n)).split(path.sep).join("/")}`);
      } catch { /* not a key file */ }
    }
  }
  return [...new Set(found)];
}

// The agent's key: a function-call key that may only call the policy's request methods.
export function agentKey(cfg: Config): string {
  const file = env("KEYFREE_AGENT_KEY") ?? credentialsFile(cfg, cfg.agent);
  if (!fs.existsSync(file)) {
    throw new ConfigError(`No key for the agent ${cfg.agent}. Set KEYFREE_AGENT_KEY to a key file, or put it in ${credentialsFile(cfg, cfg.agent)}.`);
  }
  return readKeyFile(file);
}

// A council member's key, for the human-only CLI commands. Never used by the MCP server.
export function councilKey(cfg: Config, account: string): string {
  const file = env("KEYFREE_COUNCIL_KEY") ?? credentialsFile(cfg, account);
  if (!fs.existsSync(file)) throw new ConfigError(`No key for ${account}: expected ${file} (or set KEYFREE_COUNCIL_KEY).`);
  return readKeyFile(file);
}
