// What the tool does when a network goes wrong: the real CLI and MCP server against two local nodes that fail on
// purpose (test/fake_chains.mjs). The promises under test: a fault never signs what was not checked, never loses a
// nonce for good, always ends with a plain message and a way forward, and never prints a key or an RPC secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadCode } from "../dist/code.js";
import { fakeEvm, fakeNear } from "./fake_chains.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "dist", "cli.js");
const ARTIFACT = path.join(here, "..", "demo", "out", "Counter.sol", "Counter.json");
const COUNTER = ["--artifact", ARTIFACT, "--args", "[1]"];
const OTHER = ["--artifact", ARTIFACT, "--args", "[2]"];
const FACTORY = "0x4b78615d2ab691cf8e05fe0b7fca7ecb8c063e2f";
const PROXY = "0x2222222222222222222222222222222222222222";
const IMPL = "0x3333333333333333333333333333333333333333";
const UPGRADE = ["--proxy", PROXY, "--implementation", IMPL];
const CHAIN = ["--chain", "base-sepolia"];
const hashOf = (n) => loadCode({ artifact: ARTIFACT, constructor_args: [n] }).hash;
const SECRET = "SECRETKEY123";

async function world(t, { evmUrl } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyfree-faults-"));
  const key = KeyPair.fromRandom("ed25519");
  const keyFile = path.join(dir, "agent_key.json");
  fs.writeFileSync(keyFile, JSON.stringify({ private_key: key.toString() }));
  const mpcKey = generatePrivateKey();
  const near = await fakeNear({
    policy: "policy.test", agent: "agent.test", agentPublicKey: key.getPublicKey().toString(), factory: FACTORY, proxy: PROXY, allowedCode: [hashOf(1)], mpcKey,
  });
  const evm = await fakeEvm({ factory: FACTORY, proxy: PROXY, signer: privateKeyToAccount(mpcKey).address.toLowerCase() });
  evm.st.code.set(IMPL, "0x60");
  near.st.rules.allowed_proxy_upgrades = [`84532:${PROXY}:${IMPL}`];
  const config = path.join(dir, "keyfree.json");
  const write = (over = {}) => fs.writeFileSync(config, JSON.stringify({
    near_network: "testnet", near_rpc: near.url, near_explorer: "https://near.example", policy: "policy.test", agent: "agent.test", owner: "owner.test", fee_multiplier: 1.2,
    rpc_timeout_ms: 1500, receipt_timeout_ms: 2500,
    chains: [{ name: "base-sepolia", chain_id: 84532, rpc: `${evmUrl ?? evm.url}/${SECRET}`, explorer: "https://evm.example" }],
    ...over,
  }));
  write();
  t.after(async () => { await near.close(); await evm.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const run = (...args) => new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(process.execPath, [CLI, ...args, "--config", config], {
      env: { ...process.env, HOME: dir, USERPROFILE: dir, KEYFREE_AGENT_KEY: keyFile, KEYFREE_COUNCIL_KEY: keyFile },
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => {
      assert.ok(!(out + err).includes(SECRET), `an RPC secret reached the output: ${out}${err}`);
      assert.ok(!(out + err).includes(key.toString()), "a key reached the output");
      assert.doesNotMatch(err, /^\s+at .*:\d+:\d+\)?$/m, `a stack trace reached the user: ${err}`);
      resolve({ code, out, err, ms: Date.now() - started, json: () => JSON.parse(out) });
    });
  });
  return { near, evm, run, write, dir };
}

const signed = (w) => w.near.st.calls.filter((c) => /request_|retry|resign/.test(c));

// A node that fails before anything is signed: exit 1, a plain message, nothing asked of the MPC.
for (const mode of ["down", 500, 429, "html", "hang"]) {
  test(`evm node ${mode} during preview and deploy: nothing is signed`, async (t) => {
    const w = await world(t);
    w.evm.st.faults.all = mode;
    for (const cmd of ["preview", "deploy"]) {
      const r = await w.run(cmd, ...CHAIN, ...COUNTER);
      assert.equal(r.code, 1, r.err);
      assert.deepEqual(signed(w), [], `${cmd} asked for a signature`);
      assert.ok(r.ms < 30000, `took ${r.ms} ms`);
    }
  });
}

test("evm node is another chain: nothing is signed, and the message says which", async (t) => {
  const w = await world(t);
  w.evm.st.chainId = 8453;
  const r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /8453/);
  assert.deepEqual(signed(w), []);
});

test("evm node lies about the factory or the balance: nothing is signed", async (t) => {
  const w = await world(t);
  w.evm.st.served = "0x000000000000000000000000000000000000dead";
  let r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /does not serve/);
  w.evm.st.served = w.near.signer;
  w.evm.st.balance = 0n;
  r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /Not enough ETH/);
  assert.deepEqual(signed(w), []);
});

test("the factory cannot be read: the message says so, not that it serves someone else", async (t) => {
  const w = await world(t);
  w.evm.st.faults.eth_call = 500;
  const r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.doesNotMatch(r.err, /does not serve/);
  assert.deepEqual(signed(w), []);
});

test("the simulation says it would fail: nothing is signed, the node's reason is shown", async (t) => {
  const w = await world(t);
  w.evm.st.simulationFails = "constructor said no";
  const r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /would fail/);
  assert.match(r.err, /constructor said no/);
  assert.deepEqual(signed(w), []);
});

test("a deploy needs more gas than the cap: stopped before signing, not burnt on chain", async (t) => {
  const w = await world(t);
  w.evm.st.estimate = 6_000_000n;
  const r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /6000000/);
  assert.match(r.err, /5000000/);
  assert.deepEqual(signed(w), []);
});

test("gas spike: a fee over the cap is refused by the policy, with nothing signed", async (t) => {
  const w = await world(t);
  w.evm.st.baseFee = 60_000_000_000n;
  const r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /REFUSED\s+gas price over the cap/);
  assert.deepEqual(signed(w), []);
});

test("a fee too large to be exact (a lying node): stopped, never rounded", async (t) => {
  const w = await world(t);
  w.evm.st.baseFee = 10n ** 22n;
  const r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /fee estimate/);
  assert.deepEqual(signed(w), []);
});

// The NEAR node, before signing.
for (const mode of ["down", 502, 429, "html", "hang"]) {
  test(`near node ${mode}: plain message, nothing signed`, async (t) => {
    const w = await world(t);
    w.near.st.faults.all = mode;
    const r = await w.run("deploy", ...CHAIN, ...COUNTER);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /NEAR/);
    assert.ok(r.ms < 30000, `took ${r.ms} ms`);
  });
}

test("near node keeps answering 503: gives up within a minute with a plain message", async (t) => {
  const w = await world(t);
  w.near.st.faults.all = 503;
  const r = await w.run("status");
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /NEAR/);
  assert.ok(r.ms < 60000, `took ${r.ms} ms`);
});

test("near node lies: other bytes in the preview stop the deploy before signing", async (t) => {
  const w = await world(t);
  w.near.st.previewBytes = "0x02c0";
  const r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.deepEqual(signed(w), []);
});

test("near node answers nonsense to a view: plain message, nothing signed", async (t) => {
  const w = await world(t);
  w.near.st.faults["view:get_rules"] = "not_json";
  let r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /NEAR/);
  w.near.st.faults["view:get_rules"] = () => ({ nothing: "here" });
  r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.doesNotMatch(r.err, /Cannot read prop|undefined/);
  assert.deepEqual(signed(w), []);
});

test("near node hands back a transaction signed by someone else, or with other content: not broadcast", async (t) => {
  const w = await world(t);
  w.near.st.signWith = privateKeyToAccount(generatePrivateKey());
  let r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /Not broadcasting/);
  assert.deepEqual(w.evm.st.sent, []);
  const w2 = await world(t);
  w2.near.st.signOverride = { to: "0x000000000000000000000000000000000000dEaD" };
  r = await w2.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /Not broadcasting/);
  assert.deepEqual(w2.evm.st.sent, []);
});

// The agent's NEAR account.
test("the agent has no NEAR: plain message that says top up, nothing else happens", async (t) => {
  const w = await world(t);
  w.near.st.noBalance = true;
  const r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /agent\.test/);
  assert.match(r.err, /NEAR/);
  assert.match(r.err, /[Tt]op up|[Ff]und/);
});

test("the local key is not on the agent's account: not signing", async (t) => {
  const w = await world(t);
  w.near.st.noKey = true;
  const r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /not on that account/);
  assert.deepEqual(signed(w), []);
});

// Signed, then the broadcast fails: the worst moment, the nonce is used on NEAR and nothing is on the EVM chain.
test("signed but the node refuses the broadcast: the tool says so, blocks new work, and retry recovers the same deploy", async (t) => {
  const w = await world(t);
  w.evm.st.faults.eth_sendRawTransaction = 500;
  let r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /[Ss]igned/);
  assert.match(r.err, /retry/);
  assert.equal(w.near.st.next, 1);
  assert.equal(w.evm.st.count, 0);
  const salt = w.near.st.lines.get(0).salt;
  const address = w.near.st.lines.get(0).address;
  delete w.evm.st.faults.eth_sendRawTransaction;

  // A new deploy would sit behind the gap for ever: refused before it costs a signature.
  const before = signed(w).length;
  w.near.st.rules.allowed_code.push(hashOf(2));
  r = await w.run("deploy", ...CHAIN, ...OTHER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /nonce 0/i);
  assert.match(r.err, /retry/);
  assert.equal(signed(w).length, before);

  // Retry needs the code for a deploy line (the journal holds only its hash) and takes only the same code.
  r = await w.run("retry", ...CHAIN);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /artifact/);
  r = await w.run("retry", ...CHAIN, ...OTHER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /differs|not the code/);
  assert.equal(signed(w).length, before);

  r = await w.run("retry", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 0, r.err);
  const res = r.json();
  assert.equal(res.nonce, 0);
  assert.equal(res.address, address);
  assert.equal(w.near.st.lines.get(0).salt, salt);
  assert.equal(w.evm.st.count, 1);

  // And the chain moves on.
  r = await w.run("deploy", ...CHAIN, ...OTHER);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().nonce, 1);
  r = await w.run("retry", ...CHAIN);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /Nothing is stuck/);
});

test("signed proxy upgrade, broadcast refused: retry needs no code and lands the same upgrade", async (t) => {
  const w = await world(t);
  w.evm.st.faults.eth_sendRawTransaction = "down";
  let r = await w.run("upgrade", ...CHAIN, ...UPGRADE);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /retry/);
  delete w.evm.st.faults.eth_sendRawTransaction;
  r = await w.run("retry", ...CHAIN);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().address, PROXY);
  assert.equal(w.evm.st.impl.toLowerCase(), IMPL);
});

test("the node took the broadcast but the answer was lost: the tool finds it on chain, no second signature", async (t) => {
  const w = await world(t);
  w.evm.st.faults.eth_sendRawTransaction = "lost";
  const r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 0, r.err);
  assert.equal(w.evm.st.count, 1);
  assert.equal(signed(w).length, 1);
});

test("not enough ETH at broadcast (spent in the meantime): retry works after funding", async (t) => {
  const w = await world(t);
  const real = w.evm.st.balance;
  // The balance passes the tool's check and is gone when the node looks.
  let reads = 0;
  w.evm.st.faults.eth_getBalance = () => { reads += 1; return "0xde0b6b3a7640000"; };
  w.evm.st.balance = 0n;
  let r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /insufficient funds/);
  assert.match(r.err, /retry/);
  assert.ok(reads > 0);
  w.evm.st.balance = real;
  r = await w.run("retry", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 0, r.err);
  assert.equal(w.evm.st.count, 1);
});

// Gas spike after the broadcast.
test("fee overtaken by a spike: the tool reports it as sent and pending, retry replaces it with a higher fee", async (t) => {
  const w = await world(t);
  w.evm.st.noMining = true;
  let r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /0x[0-9a-f]{64}/);
  assert.match(r.err, /retry/);
  assert.equal(w.evm.st.pool.size, 1);
  const old = [...w.evm.st.pool.values()][0].tx.maxFeePerGas;
  // A pending line is not a gap: nothing new is built on top of an unknown outcome by accident, and the retry bumps the fee.
  r = await w.run("retry", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  const fresh = [...w.evm.st.pool.values()][0].tx.maxFeePerGas;
  assert.ok(fresh * 10n >= old * 11n, `replacement ${fresh} under the 10 % bump over ${old}`);
  w.evm.st.noMining = false;
  w.evm.st.baseFee = 2_000_000n;
  r = await w.run("retry", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 0, r.err);
  assert.equal(w.evm.st.count, 1);
  assert.equal(w.evm.st.pool.size, 0);
});

test("the node dies while waiting for the receipt: the message gives the transaction, the deploy is not repeated", async (t) => {
  const w = await world(t);
  w.evm.st.faults.eth_getTransactionReceipt = 500;
  w.evm.st.faults.eth_getBlockByNumber = undefined;
  const r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /0x[0-9a-f]{64}/);
  assert.equal(signed(w).length, 1);
});

test("a receipt with another address or a revert is reported, not called success", async (t) => {
  const w = await world(t);
  w.evm.st.deployTo = "0x000000000000000000000000000000000000dEaD";
  let r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /promised/);
  const w2 = await world(t);
  w2.evm.st.revert = true;
  r = await w2.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 0, r.err);
  assert.match(r.json().next, /reverted/);
  assert.equal(r.json().address, null);
});

// The MPC side, seen from the tool.
test("the MPC does not sign: the message says retry, and retry lands the same deploy with new fees", async (t) => {
  const w = await world(t);
  w.near.st.mpc = "none";
  let r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /did not sign in time/);
  r = await w.run("retry", ...CHAIN);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /Still not signed/);
  w.near.st.mpc = "ok";
  r = await w.run("retry", ...CHAIN);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().nonce, 0);
  assert.equal(w.evm.st.count, 1);
});

test("a retry that hands back other content than the journal line is not broadcast", async (t) => {
  const w = await world(t);
  w.near.st.mpc = "none";
  await w.run("deploy", ...CHAIN, ...COUNTER);
  w.near.st.mpc = "ok";
  w.near.st.signOverride = { to: "0x000000000000000000000000000000000000dEaD" };
  const r = await w.run("retry", ...CHAIN);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /Not broadcasting/);
  assert.deepEqual(w.evm.st.sent, []);
});

test("still being signed: retry waits, and after the timeout it releases the request and carries on", async (t) => {
  const w = await world(t);
  w.near.st.mpc = "hang";
  let r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  w.near.st.mpc = "ok";
  r = await w.run("retry", ...CHAIN);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /still being signed/);
  w.near.st.releaseReady = true;
  r = await w.run("retry", ...CHAIN);
  assert.equal(r.code, 0, r.err);
  assert.equal(w.evm.st.count, 1);
});

test("the NEAR answer to the request is lost: the tool looks its transaction up and uses that signature, with no second one", async (t) => {
  const w = await world(t);
  w.near.st.faults["call:request_deploy"] = "lost";
  const r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().nonce, 0);
  assert.deepEqual(signed(w), ["request_deploy"]);
  assert.equal(w.evm.st.count, 1);
});

test("the NEAR answer is lost and the node cannot find the transaction either: the signed line is picked up by retry, not signed anew under another nonce", async (t) => {
  const w = await world(t);
  w.near.st.faults["call:request_deploy"] = "lost";
  w.near.st.faults.tx = 502;
  let r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /journal|retry/);
  assert.equal(w.near.st.next, 1);
  assert.deepEqual(signed(w), ["request_deploy"], "the call was not repeated");
  delete w.near.st.faults["call:request_deploy"];
  delete w.near.st.faults.tx;
  r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /retry/);
  r = await w.run("retry", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().nonce, 0);
});

test("a stuck nonce already used on chain: retry says so instead of spending a signature", async (t) => {
  const w = await world(t);
  w.near.st.mpc = "none";
  await w.run("deploy", ...CHAIN, ...COUNTER);
  w.near.st.mpc = "ok";
  w.evm.st.count = 1;
  const before = signed(w).length;
  const r = await w.run("retry", ...CHAIN);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /already used/);
  assert.equal(signed(w).length, before);
});

test("the address's nonce is ahead of the policy's: stopped before signing", async (t) => {
  const w = await world(t);
  w.evm.st.count = 3;
  const r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /ahead/);
  assert.deepEqual(signed(w), []);
});

// A second node in the config: a dead first one costs nothing but a moment.
test("a dead NEAR or EVM node with a fallback in the config: the deploy simply goes through", async (t) => {
  const w = await world(t);
  const DEAD = "http://127.0.0.1:9";
  w.write({ near_rpc: DEAD, near_rpc_fallbacks: [w.near.url], chains: [{ name: "base-sepolia", chain_id: 84532, rpc: DEAD, rpc_fallbacks: [w.evm.url], explorer: "https://evm.example" }] });
  const r = await w.run("deploy", ...CHAIN, ...COUNTER);
  assert.equal(r.code, 0, r.err);
  assert.equal(w.evm.st.count, 1);
});

test("a NEAR node that answers an error page, or hangs, with a fallback: the next node serves", async (t) => {
  const w = await world(t);
  for (const mode of ["html", "hang", 502]) {
    const bad = await fakeNear({ policy: "x", agent: "y", agentPublicKey: "z", factory: FACTORY, proxy: PROXY, allowedCode: [] });
    t.after(() => bad.close());
    bad.st.faults.all = mode;
    w.write({ near_rpc: bad.url, near_rpc_fallbacks: [w.near.url] });
    const r = await w.run("status");
    assert.equal(r.code, 0, `${mode}: ${r.err}`);
    assert.equal(r.json().policy, "policy.test");
  }
});

// What must keep working when one side is down.
test("evm node down: status still shows the policy, journal works, the council's brake works", async (t) => {
  const w = await world(t);
  w.evm.st.faults.all = "down";
  let r = await w.run("status");
  assert.equal(r.code, 0, r.err);
  const s = r.json();
  assert.equal(s.policy, "policy.test");
  assert.equal(s.chains[0].balance_wei, null);
  assert.ok(s.chains[0].rpc_error);
  r = await w.run("journal", ...CHAIN);
  assert.equal(r.code, 0, r.err);
  r = await w.run("pause", "--as", "agent.test");
  assert.equal(r.code, 0, r.err);
  assert.equal(w.near.st.paused, true);
});

test("the MCP server reports a lost broadcast to the model, and keyfree_retry recovers it with the code", async (t) => {
  const w = await world(t);
  const { Client } = await import("@modelcontextprotocol/client");
  const { getDefaultEnvironment, StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");
  const client = new Client({ name: "keyfree-faults", version: "0.1.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(here, "..", "dist", "mcp.js")],
    env: { ...getDefaultEnvironment(), KEYFREE_CONFIG: path.join(w.dir, "keyfree.json"), KEYFREE_AGENT_KEY: path.join(w.dir, "agent_key.json"), HOME: w.dir, USERPROFILE: w.dir },
    stderr: "ignore",
  }));
  try {
    w.evm.st.faults.eth_sendRawTransaction = 500;
    const args = { chain: "base-sepolia", artifact: ARTIFACT, constructor_args: [1] };
    let res = await client.callTool({ name: "keyfree_deploy", arguments: args });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /keyfree_retry/);
    assert.ok(!res.content[0].text.includes(SECRET));
    delete w.evm.st.faults.eth_sendRawTransaction;
    res = await client.callTool({ name: "keyfree_retry", arguments: args });
    assert.notEqual(res.isError, true, res.content[0].text);
    assert.equal(JSON.parse(res.content[0].text).nonce, 0);
    assert.equal(w.evm.st.count, 1);
  } finally {
    await client.close();
  }
});

// ---- v19 (fifth review): Z3 the MPC check, Z8 no salt from the model, Z9 artifacts only in the project ----
import { b58 } from "./b58.mjs";

test("Z3: status names the MPC and checks the policy's address against it; a look-alike MPC or address is called out", async (t) => {
  const w = await world(t);
  const key = (pub) => `secp256k1:${b58(pub.slice(4))}`;
  w.near.st.faults["view:get_config"] = () => ({ mpc: "v1.signer-prod.testnet", path: "keyfree-1", rules_delay_sec: 60, upgrade_delay_sec: 180 });
  w.near.st.faults["view:derived_public_key"] = () => key(w.near.signerPublicKey);
  let r = await w.run("status");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().mpc.address_matches, true);
  assert.doesNotMatch(r.json().warning ?? "", /derives|MPC/);
  const other = privateKeyToAccount(generatePrivateKey());
  w.near.st.faults["view:derived_public_key"] = () => key(other.publicKey);
  r = await w.run("status");
  assert.equal(r.json().mpc.address_matches, false);
  assert.match(r.json().warning, /is not the one v1\.signer-prod\.testnet derives/);
  w.near.st.faults["view:get_config"] = () => ({ mpc: "evil-mpc.testnet", path: "keyfree-1" });
  r = await w.run("status");
  assert.match(r.json().warning, /signs through evil-mpc\.testnet, not the network's MPC/);
  delete w.near.st.faults["view:get_config"];
  r = await w.run("status");
  assert.equal(r.json().mpc.checked, false, "an older policy: said, not guessed");
});

test("Z8 and Z9: the MCP tools take no salt and no artifact outside the project", async (t) => {
  const w = await world(t);
  const { Client } = await import("@modelcontextprotocol/client");
  const { getDefaultEnvironment, StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");
  const client = new Client({ name: "keyfree-v19", version: "0.1.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(here, "..", "dist", "mcp.js")],
    env: { ...getDefaultEnvironment(), KEYFREE_CONFIG: path.join(w.dir, "keyfree.json"), KEYFREE_AGENT_KEY: path.join(w.dir, "agent_key.json"), HOME: w.dir, USERPROFILE: w.dir },
    stderr: "ignore",
  }));
  try {
    const salt = `0x${"ab".repeat(32)}`;
    for (const name of ["keyfree_deploy", "keyfree_preview"]) {
      const res = await client.callTool({ name, arguments: { chain: "base-sepolia", artifact: ARTIFACT, constructor_args: [1], salt } });
      assert.equal(res.isError, true, `${name} took a salt`);
    }
    const outside = path.join(w.dir, "agent_key.json"); // a real file, outside the project
    for (const name of ["keyfree_code_hash", "keyfree_preview", "keyfree_deploy"]) {
      const res = await client.callTool({ name, arguments: name === "keyfree_code_hash" ? { artifact: outside } : { chain: "base-sepolia", artifact: outside } });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /must be inside this project's folder/);
    }
    assert.equal(signed(w).length, 0, "nothing was asked of the policy");
  } finally {
    await client.close();
  }
});
