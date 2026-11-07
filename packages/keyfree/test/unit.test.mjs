// Offline unit tests: what to deploy (code + hash), refusal parsing, config lookups. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeDeployData, keccak256 } from "viem";
import { loadCode } from "../dist/code.js";
import { asRefusal, PolicyRefusal } from "../dist/near.js";
import { findChain, ConfigError } from "../dist/config.js";

const TINY = "0x600a600c600039600a6000f3602a60005260206000f3";

test("raw init code: hash is keccak of the bytes, the one the live policy allows", () => {
  const c = loadCode({ init_code_hex: TINY });
  assert.equal(c.hash, "fb9fb2e46931e8f1035a5e589b31d7d69ea44e15806b1c71dfee37cebbbf6b16");
  assert.equal(loadCode({ init_code_hex: TINY.slice(2) }).hash, c.hash, "0x is optional");
});

test("artifact with constructor args: init = bytecode + encoded args, so args are part of what is allowed", () => {
  const abi = [{ type: "constructor", stateMutability: "nonpayable", inputs: [{ name: "start", type: "uint256" }] }];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kf-"));
  const file = path.join(dir, "Counter.json");
  fs.writeFileSync(file, JSON.stringify({ abi, bytecode: { object: "0x6080" } })); // Foundry shape
  const c = loadCode({ artifact: file, constructor_args: [7] });
  const want = encodeDeployData({ abi, bytecode: "0x6080", args: [7n] });
  assert.equal(c.init, want);
  assert.equal(c.hash, keccak256(want).slice(2));
  assert.notEqual(loadCode({ artifact: file, constructor_args: [8] }).hash, c.hash, "other args -> other hash");
  fs.writeFileSync(file, JSON.stringify({ abi, bytecode: "0x6080" })); // Hardhat shape
  assert.equal(loadCode({ artifact: file, constructor_args: [7] }).hash, c.hash);
});

test("bad code inputs are explained", () => {
  assert.throws(() => loadCode({}), /init_code_hex or artifact/);
  assert.throws(() => loadCode({ init_code_hex: "0xzz" }), /hex bytes/);
  assert.throws(() => loadCode({ init_code_hex: TINY, artifact: "x.json" }), /not both/);
  assert.throws(() => loadCode({ artifact: "no/such/file.json" }), /not found/);
});

test("contract panics become the policy's own reason", () => {
  const r = asRefusal(new Error('Server error: {"FunctionCallError":{"ExecutionError":"Smart contract panicked: code not on the allow list"}}'));
  assert.ok(r instanceof PolicyRefusal);
  assert.equal(r.reason, "code not on the allow list");
  const k = asRefusal(new Error("Access key does not allow method propose_rule"));
  assert.ok(k instanceof PolicyRefusal, "a function-call key refusal is a refusal too");
  assert.match(asRefusal(new Error("Not enough allowance for access key x")).message, /allowance is too small/);
  assert.match(asRefusal(new Error("socket hang up")).message, /NEAR node failed.*socket hang up/);
});

test("chains by name or id, unknown ones listed", () => {
  const cfg = { chains: [{ name: "base-sepolia", chain_id: 84532, rpc: "", explorer: "" }] };
  assert.equal(findChain(cfg, "base-sepolia").chain_id, 84532);
  assert.equal(findChain(cfg, 84532).name, "base-sepolia");
  assert.throws(() => findChain(cfg, "arbitrum"), (e) => e instanceof ConfigError && /base-sepolia \(84532\)/.test(e.message));
});

// ---- v19 (fifth review): Z1, Z3, Z9 ----
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { ethAddressOfKey } from "../dist/core.js";
import { localCouncilKeys } from "../dist/config.js";

import { b58 } from "./b58.mjs";

test("Z3: the EVM address of an MPC key is keccak of its point, the same as the account's address", () => {
  for (let i = 0; i < 5; i++) {
    const a = privateKeyToAccount(generatePrivateKey());
    assert.equal(ethAddressOfKey(`secp256k1:${b58(a.publicKey.slice(4))}`), a.address.toLowerCase());
  }
  assert.equal(ethAddressOfKey("ed25519:abc"), null);
  assert.equal(ethAddressOfKey("secp256k1:0OIl"), null, "not base58");
});

test("Z1: council keys next to the agent are found by account name, the keys themselves are never shown", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kf-council-"));
  fs.mkdirSync(path.join(dir, "setup"));
  fs.writeFileSync(path.join(dir, "setup", "guardian_key.json"), JSON.stringify({ account_id: "guardian.you.testnet", private_key: "ed25519:SECRETGUARDIAN" }));
  fs.writeFileSync(path.join(dir, "reserve_key.json"), JSON.stringify({ account_id: "reserve.you.testnet", private_key: "ed25519:SECRETRESERVE" }));
  fs.writeFileSync(path.join(dir, "agent_key.json"), JSON.stringify({ account_id: "agent.you.testnet", private_key: "ed25519:AGENT" }));
  fs.writeFileSync(path.join(dir, "broken_key.json"), "not json");
  const cwd = process.cwd();
  const prev = process.env.KEYFREE_COUNCIL_KEY;
  try {
    process.chdir(dir);
    delete process.env.KEYFREE_COUNCIL_KEY;
    const cfg = { near_network: "testnet" };
    const found = localCouncilKeys(cfg, ["you.testnet", "guardian.you.testnet", "reserve.you.testnet"]);
    assert.equal(found.length, 2, found.join(" | "));
    assert.ok(found.some((f) => f.startsWith("guardian.you.testnet in ")));
    assert.ok(found.some((f) => f.startsWith("reserve.you.testnet in ")));
    assert.ok(!found.join(" ").includes("SECRET"), "no key in the report");
    process.env.KEYFREE_COUNCIL_KEY = "/somewhere/owner.json";
    assert.ok(localCouncilKeys(cfg, ["you.testnet"]).some((f) => f.startsWith("KEYFREE_COUNCIL_KEY is set")));
  } finally {
    process.chdir(cwd);
    if (prev === undefined) delete process.env.KEYFREE_COUNCIL_KEY; else process.env.KEYFREE_COUNCIL_KEY = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Z9: a file that is not an artifact gives a plain message, never a piece of its content", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kf-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, "NEAR_PRIVATE_KEY=ed25519:SECRET\n");
  assert.throws(() => loadCode({ artifact: file }), (e) => /is not a Foundry or Hardhat JSON artifact/.test(e.message) && !e.message.includes("NEAR_PRIVA") && !e.message.includes("SECRET"));
  fs.rmSync(dir, { recursive: true, force: true });
});
