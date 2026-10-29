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
  assert.equal(asRefusal(new Error("socket hang up")).message, "socket hang up");
});

test("chains by name or id, unknown ones listed", () => {
  const cfg = { chains: [{ name: "base-sepolia", chain_id: 84532, rpc: "", explorer: "" }] };
  assert.equal(findChain(cfg, "base-sepolia").chain_id, 84532);
  assert.equal(findChain(cfg, 84532).name, "base-sepolia");
  assert.throws(() => findChain(cfg, "arbitrum"), (e) => e instanceof ConfigError && /base-sepolia \(84532\)/.test(e.message));
});
