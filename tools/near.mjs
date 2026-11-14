// Small NEAR testnet helper for the scripts in this repository: load a key from ~/.near-credentials (never
// printed) and talk to testnet.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Account, JsonRpcProvider, KeyPair, teraToGas, parseNearAmount, actions } from "near-api-js";
export { Account, KeyPair, teraToGas, parseNearAmount, actions };

// The account the early spikes (spike2-8.mjs, run.mjs) ran from.
export const ACCOUNT = "nearmancer-spike.testnet";
export const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC || "https://test.rpc.fastnear.com" });

export function loadAccount(accountId = ACCOUNT) {
  const f = path.join(os.homedir(), ".near-credentials", "testnet", `${accountId}.json`);
  // Said in words: a missing key is the first thing a newcomer meets, and a bare ENOENT does not say what to do.
  if (!fs.existsSync(f)) throw new Error(`no key for ${accountId}: this step signs as that account and reads its key from ~/.near-credentials/testnet/${accountId}.json`);
  const { private_key } = JSON.parse(fs.readFileSync(f, "utf8"));
  return new Account(accountId, provider, private_key);
}

export const explorer = (hash) => `https://testnet.nearblocks.io/txns/${hash}`;
export const gasUsed = (out) => {
  const all = [out.transaction_outcome, ...(out.receipts_outcome || [])];
  return all.reduce((s, o) => s + Number(o.outcome.gas_burnt || 0), 0);
};

export const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args });
export const accountInfo = (accountId) => provider.viewAccount({ accountId });
