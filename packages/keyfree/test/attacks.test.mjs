// Offline attacks on the tool itself: what it broadcasts, and what the MCP server accepts. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { checkSigned } from "../dist/core.js";
import { FACTORY_ABI } from "../dist/evm.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const policy = privateKeyToAccount(generatePrivateKey()); // stands in for the policy's MPC address
const FACTORY = "0x4b78615d2ab691cf8e05fe0b7fca7ecb8c063e2f";
const want = {
  type: "eip1559", chainId: 84532, nonce: 7, to: FACTORY, value: 0n, gas: 200000n, maxFeePerGas: 8400000n, maxPriorityFeePerGas: 1000000n,
  data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "deploy", args: [`0x${"11".repeat(32)}`, "0x600a600c600039600a6000f3602a60005260206000f3"] }),
};

test("tool: the checked transaction, signed by the policy's address, passes", async () => {
  await checkSigned(await policy.signTransaction(want), want, policy.address);
});

test("tool: a signed transaction with other calldata (swapped init code) is not broadcast", async () => {
  const swapped = { ...want, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "deploy", args: [`0x${"11".repeat(32)}`, "0x6000"] }) };
  await assert.rejects(checkSigned(await policy.signTransaction(swapped), want, policy.address), /not the one that was checked/);
});

test("tool: a signed transaction to another target, nonce or chain is not broadcast", async () => {
  for (const change of [{ to: "0x000000000000000000000000000000000000dEaD" }, { nonce: 8 }, { chainId: 8453 }]) {
    await assert.rejects(checkSigned(await policy.signTransaction({ ...want, ...change }), want, policy.address), /not the one that was checked/, JSON.stringify(change));
  }
});

test("tool: a signed transaction that sends value is not broadcast", async () => {
  await assert.rejects(checkSigned(await policy.signTransaction({ ...want, value: 1n }), want, policy.address), /not the one that was checked/);
});

test("tool: the right transaction signed by another key is not broadcast", async () => {
  const other = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(checkSigned(await other.signTransaction(want), want, policy.address), /not by the policy's address/);
});

test("tool: garbage instead of a signed transaction is not broadcast", async () => {
  await assert.rejects(checkSigned("0x02deadbeef", want, policy.address), /does not parse|not the one/);
});

test("mcp: the agent gets no owner tools, and a private_key argument is rejected before the handler", async () => {
  const client = new Client({ name: "keyfree-attacks", version: "0.1.0" });
  await client.connect(new StdioClientTransport({
    command: "node", args: [path.join(root, "dist", "mcp.js")],
    env: { ...getDefaultEnvironment(), KEYFREE_CONFIG: path.join(root, "keyfree.example.json"), KEYFREE_AGENT_KEY: "" },
    stderr: "ignore",
  }));
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.equal(names.length, 7);
    assert.ok(!names.some((n) => /rule|role|pause|upgrade|allow|retire|sweep/.test(n)), names.join(","));
    const r = await client.callTool({ name: "keyfree_code_hash", arguments: { init_code_hex: "0x6000", private_key: "0x1234" } });
    assert.equal(r.isError, true);
    assert.match(r.content.map((c) => c.text).join(" "), /private_key|Unrecognized/);
  } finally {
    await client.close();
  }
});
