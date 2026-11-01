// Tests of KeyfreeFactory on an in-process EVM (EthereumJS), offline: node --test factory/
// The factory is the one built by factory/build.cjs (factory/factory.json), the bytes the live policy deployed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createEVM } from "@ethereumjs/evm";
import { createAddressFromString, hexToBytes, bytesToHex } from "@ethereumjs/util";
import { encodeDeployData, encodeFunctionData, decodeEventLog, getContractAddress, keccak256, toHex } from "viem";

const F = JSON.parse(fs.readFileSync(new URL("./factory.json", import.meta.url)));
const COUNTER = JSON.parse(fs.readFileSync(new URL("../packages/keyfree/demo/out/Counter.sol/Counter.json", import.meta.url)));
const KEYFREE = "0x43e3cb8d471680307f0c232e5ac190828681fcb0";
const STRANGER = "0x00000000000000000000000000000000000000aa";
const GAS = 10_000_000n;
const addr = (a) => createAddressFromString(a);
const counterInit = (n) => encodeDeployData({ abi: COUNTER.abi, bytecode: COUNTER.bytecode.object, args: [n] });

async function setup() {
  const evm = await createEVM();
  const init = encodeDeployData({ abi: F.abi, bytecode: F.bytecode, args: [KEYFREE] });
  const r = await evm.runCall({ caller: addr(KEYFREE), data: hexToBytes(init), gasLimit: GAS });
  assert.equal(r.execResult.exceptionError, undefined, "the factory deploys");
  const factory = r.createdAddress.toString();
  const call = (caller, salt, initCode) => evm.runCall({
    caller: addr(caller), to: addr(factory), gasLimit: GAS,
    data: hexToBytes(encodeFunctionData({ abi: F.abi, functionName: "deploy", args: [salt, initCode] })),
  });
  return { evm, factory, call };
}
const revertReason = (r) => {
  const out = bytesToHex(r.execResult.returnValue);
  return out.length > 138 ? Buffer.from(out.slice(138), "hex").toString().replace(/\0+$/, "") : out;
};

test("the factory remembers the one caller it serves", async () => {
  const { evm, factory } = await setup();
  const r = await evm.runCall({ caller: addr(STRANGER), to: addr(factory), gasLimit: GAS,
    data: hexToBytes(encodeFunctionData({ abi: F.abi, functionName: "keyfree" })) });
  assert.equal(bytesToHex(r.execResult.returnValue).slice(-40), KEYFREE.slice(2));
});

test("a stranger cannot deploy through the factory", async () => {
  const { call } = await setup();
  const r = await call(STRANGER, keccak256(toHex("s1")), counterInit(1n));
  assert.ok(r.execResult.exceptionError, "reverted");
  assert.equal(revertReason(r), "only keyfree");
});

test("the keyfree address deploys at the CREATE2 address and the factory logs it", async () => {
  const { evm, factory, call } = await setup();
  const salt = keccak256(toHex("s2"));
  const init = counterInit(1n);
  const r = await call(KEYFREE, salt, init);
  assert.equal(r.execResult.exceptionError, undefined);
  const want = getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecode: init }).toLowerCase();
  assert.equal(`0x${bytesToHex(r.execResult.returnValue).slice(-40)}`, want, "returns the address");
  const code = await evm.stateManager.getCode(addr(want));
  assert.ok(code.length > 0, "code is there");
  const logs = r.execResult.logs ?? [];
  assert.equal(logs.length, 1, "one log");
  const [emitter, topics, data] = logs[0];
  assert.equal(bytesToHex(emitter), factory);
  const ev = decodeEventLog({ abi: F.abi, topics: topics.map(bytesToHex), data: bytesToHex(data) });
  assert.equal(ev.eventName, "Deployed");
  assert.equal(ev.args.addr.toLowerCase(), want);
  assert.equal(ev.args.codeHash, keccak256(init), "codeHash is keccak of the whole init code, arguments included");
  assert.equal(ev.args.salt, salt);
});

test("the same salt and code cannot be deployed twice", async () => {
  const { call } = await setup();
  const salt = keccak256(toHex("s3"));
  assert.equal((await call(KEYFREE, salt, counterInit(1n))).execResult.exceptionError, undefined);
  const again = await call(KEYFREE, salt, counterInit(1n));
  assert.ok(again.execResult.exceptionError, "the second deploy reverts");
  assert.equal(revertReason(again), "deploy failed");
  assert.equal((again.execResult.logs ?? []).length, 0, "and leaves no log");
});

test("other constructor arguments give another address and another code hash", async () => {
  const { factory, call } = await setup();
  const salt = keccak256(toHex("s4"));
  const r1 = await call(KEYFREE, salt, counterInit(1n));
  const r2 = await call(KEYFREE, salt, counterInit(999n));
  assert.equal(r1.execResult.exceptionError, undefined);
  assert.equal(r2.execResult.exceptionError, undefined);
  const a1 = getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecode: counterInit(1n) });
  const a2 = getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecode: counterInit(999n) });
  assert.notEqual(a1, a2);
  assert.notEqual(keccak256(counterInit(1n)), keccak256(counterInit(999n)));
});

test("init code that reverts leaves no contract and no log", async () => {
  const { call } = await setup();
  const reverting = "0x60006000fd"; // PUSH1 0 PUSH1 0 REVERT
  const r = await call(KEYFREE, keccak256(toHex("s5")), reverting);
  assert.ok(r.execResult.exceptionError, "reverted");
  assert.equal(revertReason(r), "deploy failed");
  assert.equal((r.execResult.logs ?? []).length, 0);
});
