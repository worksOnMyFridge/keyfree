// The "Run your own policy" page (start/index.html) in a real browser: its keccak256 must equal viem's, the hash of the
// Counter demo must be the one a live policy allows, argument encoding must be strict, the emitted config must have
// the example file's keys in order, and the page must never touch the network.
//   cd explorer && npm ci --ignore-scripts && BROWSER=chromium node --test start.test.mjs
// SHOTS=<dir> also saves full-page screenshots (1100 px and 360 px wide) with the Counter loaded.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as pw from "playwright";

const NAME = process.env.BROWSER ?? "chromium";
const ROOT = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const COUNTER = ROOT("packages/keyfree/demo/out/Counter.sol/Counter.json");
const counter = JSON.parse(fs.readFileSync(COUNTER, "utf8"));
const EXAMPLE = JSON.parse(fs.readFileSync(ROOT("setup/config.example.json"), "utf8"));
const PAGE = fs.readFileSync(ROOT("start/index.html"));
const LIVE_HASH = "1fa27a804d8eed04058fc03f9f4c48b8b098a8aeea1173e447f020b1553e3ed2";

// viem from the repository root's node_modules, whatever this directory's own dependencies are.
const rootRequire = createRequire(new URL("../package.json", import.meta.url));
const viem = await import(pathToFileURL(rootRequire.resolve("viem")).href);
const refHash = (hex) => viem.keccak256(hex.startsWith("0x") ? hex : `0x${hex}`).slice(2);

let browser, server, base;
before(async () => {
  browser = await pw[NAME].launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {});
  server = http.createServer((q, r) => {
    if (new URL(q.url, "http://x").pathname !== "/start/") { r.statusCode = 404; return r.end(); }
    r.setHeader("content-type", "text/html; charset=utf-8");
    r.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/start/`;
});
after(async () => { await browser?.close(); server?.close(); });

async function open(t, viewport = { width: 1000, height: 900 }, scheme = "light") {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, acceptDownloads: true });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const problems = [], requests = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
  page.on("request", (r) => { if (r.url() !== base) requests.push(`${r.method()} ${r.url()}`); });
  await page.goto(base);
  await page.waitForFunction(() => document.body.dataset.state === "done", null, { timeout: 45000 });
  return { page, problems, requests, ctx };
}
const hashOf = (page) => page.locator("#hash").innerText();
const loadCounter = async (page) => { await page.setInputFiles("#file", COUNTER); await page.locator("#arg-0").waitFor(); };
const cfgOf = async (page) => JSON.parse(await page.locator("#config").innerText());

// Deterministic "random" bytes so a failure repeats.
function pseudo(len, seed) {
  const out = Buffer.alloc(len);
  let x = seed;
  for (let i = 0; i < len; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; out[i] = x >>> 24; }
  return out;
}

test("keccak256: the three known vectors", async (t) => {
  const { page, problems } = await open(t);
  const h = (hex) => page.evaluate((x) => window.keyfreeStart.keccak256Hex(x), hex);
  assert.equal(await h(""), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(await h("0x616263"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  const word1 = "0".repeat(63) + "1";
  assert.equal(await h(counter.bytecode.object + word1), LIVE_HASH);
  assert.deepEqual(problems, []);
});

test("keccak256: 20 inputs of varied length agree with viem", async (t) => {
  const { page } = await open(t);
  const lengths = [1, 2, 31, 32, 55, 100, 134, 135, 136, 137, 200, 271, 272, 273, 300, 408, 500, 543, 599, 600];
  const inputs = lengths.map((n, i) => pseudo(n, 7 + i).toString("hex"));
  const got = await page.evaluate((xs) => xs.map((x) => window.keyfreeStart.keccak256Hex(x)), inputs);
  inputs.forEach((x, i) => assert.equal(got[i], refHash(x), `length ${lengths[i]}`));
  // Also as a byte array, and a length that is not a multiple of anything convenient.
  const bytes = [...pseudo(333, 99)];
  assert.equal(await page.evaluate((b) => window.keyfreeStart.keccak256Hex(b), bytes), refHash(Buffer.from(bytes).toString("hex")));
});

test("pasting the Counter init code shows the hash a live policy allows", async (t) => {
  const { page, problems } = await open(t);
  assert.match(await hashOf(page), /Give a valid contract/);
  await page.locator("#init").fill(`0x${counter.bytecode.object.slice(2)}${"0".repeat(63)}1`);
  assert.equal(await hashOf(page), LIVE_HASH);
  assert.match(await page.locator("#size").innerText(), new RegExp(`^Init code: ${(counter.bytecode.object.length - 2) / 2 + 32} bytes`));
  assert.equal(await page.locator("#size-warn").innerText(), "");
  assert.deepEqual(problems, []);
});

test("bad pasted code: a clear error and no hash", async (t) => {
  const { page } = await open(t);
  const init = page.locator("#init");
  await init.fill("0x60806040zz");
  assert.match(await page.locator("#init-msg").innerText(), /Not hex/);
  assert.match(await hashOf(page), /Give a valid contract/);
  await init.fill("0x608");
  assert.match(await page.locator("#init-msg").innerText(), /odd number/i);
  assert.equal(await page.locator("#copy-hash").isDisabled(), true);
  await init.fill("0x6080__$0123456789abcdef0123456789abcdef01$__6040");
  assert.match(await page.locator("#init-msg").innerText(), /unlinked library/i);
  assert.match(await hashOf(page), /Give a valid contract/);
  await init.fill("0x6080 6040\n52");
  assert.equal(await page.locator("#init-msg").innerText(), "");
  assert.equal(await hashOf(page), refHash("608060405" + "2"));
});

test("init code over the EIP-3860 limit gets a warning", async (t) => {
  const { page } = await open(t);
  await page.locator("#init").fill("0x" + "60".repeat(49153));
  assert.match(await page.locator("#size-warn").innerText(), /49152/);
  assert.match(await page.locator("#size").innerText(), /49153 bytes/);
  await page.locator("#init").fill("0x" + "60".repeat(49152));
  assert.equal(await page.locator("#size-warn").innerText(), "");
});

test("the Counter artifact: a field for start; 1 gives the live hash, 999 gives viem's", async (t) => {
  const { page, problems } = await open(t);
  await loadCounter(page);
  assert.match(await page.locator("#ctor label").innerText(), /start\s+uint256/);
  assert.match(await hashOf(page), /Give a valid contract/);
  await page.locator("#arg-0").fill("1");
  assert.equal(await hashOf(page), LIVE_HASH);
  await page.locator("#arg-0").fill("999");
  const want = refHash(viem.encodeDeployData({ abi: counter.abi, bytecode: counter.bytecode.object, args: [999n] }));
  assert.equal(await hashOf(page), want);
  assert.notEqual(want, LIVE_HASH);
  await page.locator("#arg-0").fill("-1");
  assert.match(await page.locator("#arg-msg-0").innerText(), /whole number/);
  assert.match(await hashOf(page), /Give a valid contract/);
  await page.locator("#arg-0").fill((2n ** 256n).toString());
  assert.match(await page.locator("#arg-msg-0").innerText(), /Too large/);
  assert.match(await hashOf(page), /Give a valid contract/);
  assert.deepEqual(problems, []);
});

test("artifact errors: not JSON, no bytecode, library placeholders", async (t) => {
  const { page } = await open(t);
  // The file is read asynchronously: wait for the hash line or the message to settle on the expected state.
  const up = async (name, body, until) => {
    await page.setInputFiles("#file", { name, mimeType: "application/json", buffer: Buffer.from(body) });
    await page.waitForFunction(until[0], until[1], { timeout: 10000 });
  };
  const msg = (re) => [(src) => new RegExp(src, "i").test(document.getElementById("art-msg").textContent), re];
  await up("a.json", "not json", msg("not JSON"));
  await up("b.json", JSON.stringify({ abi: [], bytecode: { object: "0x" } }), msg("no bytecode"));
  await up("c.json", JSON.stringify({ abi: [], bytecode: { object: "0x6080__$abcdefabcdefabcdefabcdefabcdefabcd$__6040" } }), msg("unlinked library"));
  assert.match(await hashOf(page), /Give a valid contract/);
  await up("d.json", JSON.stringify({ abi: [], bytecode: "0x60806040" }), [() => document.getElementById("hash").textContent.length === 64, null]);   // Hardhat shape, no constructor
  assert.equal(await page.locator("#art-msg").innerText(), "");
  assert.equal(await hashOf(page), refHash("0x60806040"));
});

test("a constructor with a string: no guessing, an ABI-encoded hex field instead", async (t) => {
  const { page } = await open(t);
  const abi = [{ type: "constructor", inputs: [{ name: "name", type: "string" }, { name: "n", type: "uint256" }] }];
  await page.setInputFiles("#file", { name: "t.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ abi, bytecode: { object: "0x6080" } })) });
  await page.locator("#arg-0").waitFor();
  assert.equal(await page.locator("#ctor [data-arg]").count(), 1);
  assert.equal(await page.locator("label[for=arg-0]").innerText(), "ABI-encoded constructor arguments (hex)");
  const hint = await page.locator("#ctor .hint").innerText();
  assert.ok(hint.includes('cast abi-encode "constructor(string,uint256)" "name" 1'));
  assert.ok(hint.includes("keyfree hash --artifact <file> --args '[...]'"));
  assert.match(await hashOf(page), /Give a valid contract/);
  const args = viem.encodeAbiParameters(viem.parseAbiParameters("string, uint256"), ["name", 1n]);
  await page.locator("#arg-0").fill(args);
  assert.equal(await hashOf(page), refHash("0x6080" + args.slice(2)));
  await page.locator("#arg-0").fill("0x1234");
  assert.match(await page.locator("#arg-msg-0").innerText(), /32-byte words/);
  assert.match(await hashOf(page), /Give a valid contract/);
});

test("argument encoding: address, bool, int8, bytes4, uint256 max, and strict rejection", async (t) => {
  const { page } = await open(t);
  const enc = (types, values) => page.evaluate(([a, b]) => { try { return { ok: window.keyfreeStart.encodeArgs(a, b) }; } catch (e) { return { err: e.message }; } }, [types, values]);
  const addr = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const cases = [
    [["address"], [addr], ["address"]],
    [["address"], [addr.toLowerCase()], ["address"]],
    [["bool", "bool"], ["true", "false"], ["bool", "bool"]],
    [["int8"], ["-1"], ["int8"]],
    [["int8", "int8"], ["127", "-128"], ["int8", "int8"]],
    [["int256"], ["-5"], ["int256"]],
    [["bytes4"], ["0xdeadbeef"], ["bytes4"]],
    [["bytes32"], ["0x" + "ab".repeat(32)], ["bytes32"]],
    [["uint256"], [(2n ** 256n - 1n).toString()], ["uint256"]],
    [["uint8", "uint64", "uint"], ["255", "18446744073709551615", "0x10"], ["uint8", "uint64", "uint256"]],
  ];
  for (const [types, values, abiTypes] of cases) {
    const parsed = types.map((ty, i) => {
      if (ty.startsWith("bool")) return values[i] === "true";
      if (ty.startsWith("int") || ty.startsWith("uint")) return BigInt(values[i]);
      return values[i];
    });
    const want = viem.encodeAbiParameters(abiTypes.map((type) => ({ type })), parsed).slice(2);
    assert.deepEqual(await enc(types, values), { ok: want }, `${types} ${values}`);
  }
  const bad = [
    ["uint8", "256"], ["uint8", "-1"], ["uint8", "1.5"], ["uint8", ""], ["uint8", "1e3"], ["uint256", (2n ** 256n).toString()],
    ["int8", "128"], ["int8", "-129"], ["int256", (2n ** 255n).toString()],
    ["address", "0x123"], ["address", "5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"], ["address", "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"],
    ["bool", "1"], ["bool", "True"],
    ["bytes4", "0xdeadbe"], ["bytes4", "0xdeadbeef00"], ["bytes4", "deadbeef"], ["bytes4", "0xdeadbeeg"],
    ["string", "x"], ["uint7", "1"], ["uint264", "1"], ["bytes33", "0x00"], ["uint256[]", "1"],
  ];
  for (const [ty, v] of bad) assert.ok("err" in (await enc([ty], [v])), `${ty} ${JSON.stringify(v)} must be refused`);
  // A number beyond 2^53 stays exact.
  assert.deepEqual(await enc(["uint256"], ["9007199254740993"]), { ok: (9007199254740993n).toString(16).padStart(64, "0") });
});

test("the page shows an inline error for an out-of-range typed argument, per field", async (t) => {
  const { page } = await open(t);
  const abi = [{ type: "constructor", inputs: [{ name: "owner", type: "address" }, { name: "flag", type: "bool" }, { name: "delta", type: "int8" }, { name: "tag", type: "bytes4" }] }];
  await page.setInputFiles("#file", { name: "t.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ abi, bytecode: "0x6080" })) });
  await page.locator("#arg-3").waitFor();
  await page.locator("#arg-0").fill("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
  await page.locator("#arg-1").fill("true");
  await page.locator("#arg-2").fill("-1");
  await page.locator("#arg-3").fill("0xdeadbeef");
  const want = refHash(viem.encodeDeployData({ abi: [{ type: "constructor", stateMutability: "nonpayable", inputs: [{ name: "owner", type: "address" }, { name: "flag", type: "bool" }, { name: "delta", type: "int8" }, { name: "tag", type: "bytes4" }] }], bytecode: "0x6080", args: ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", true, -1, "0xdeadbeef"] }));
  assert.equal(await hashOf(page), want);
  await page.locator("#arg-2").fill("128");
  assert.match(await page.locator("#arg-msg-2").innerText(), /Out of range for int8/);
  assert.equal(await page.locator("#arg-msg-0").innerText(), "");
  assert.match(await hashOf(page), /Give a valid contract/);
});

test("the emitted config has the example's keys in order, the example's fixed values, and follows the fields", async (t) => {
  const { page, problems } = await open(t);
  let cfg = await cfgOf(page);
  assert.deepEqual(Object.keys(cfg), Object.keys(EXAMPLE));
  assert.deepEqual(cfg, EXAMPLE);                       // the defaults are the example
  assert.deepEqual(Object.keys(cfg.chains[0]), Object.keys(EXAMPLE.chains[0]));
  await page.locator("#owner").fill("alice.testnet");
  assert.equal(await page.locator("#policy").inputValue(), "policy.alice.testnet");   // follows the owner until typed by hand
  await page.locator("#guardian").fill("guard-1.testnet");
  await page.locator("#reserve").fill("spare_2.testnet");
  await page.locator("#rules-h").fill("2");
  await page.locator("#upgrade-h").fill("48");
  await page.locator("#gas-cap").fill("123456");
  await page.locator("#fee-cap").fill("9007199254740993");
  await page.locator("#base-tx").fill("7");
  await page.locator("#base-wei").fill("12345678901234567890");
  await page.locator("#chain-eth").check();
  await page.locator("#eth-tx").fill("3");
  cfg = await cfgOf(page);
  assert.deepEqual(Object.keys(cfg), Object.keys(EXAMPLE));
  assert.equal(cfg.owner, "alice.testnet");
  assert.equal(cfg.policy, "policy.alice.testnet");
  assert.equal(cfg.agent, "agent.alice.testnet");
  assert.equal(cfg.guardian, "guard-1.testnet");
  assert.equal(cfg.reserve, "spare_2.testnet");
  assert.equal(cfg.rules_delay_sec, 7200);
  assert.equal(cfg.upgrade_delay_sec, 172800);
  assert.equal(cfg.max_gas_limit, "123456");
  assert.equal(cfg.max_fee_cap, "9007199254740993");
  assert.equal(cfg.chains.length, 2);
  assert.deepEqual(cfg.chains[0], { ...EXAMPLE.chains[0], max_tx_per_day: 7, max_wei_per_day: "12345678901234567890" });
  assert.deepEqual(cfg.chains[1], { name: "ethereum-sepolia", chain_id: 11155111, rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io", fee_floor_wei: "1000000", max_wei_per_day: "500000000000000", max_tx_per_day: 3 });
  for (const k of ["policy_near", "agent_near", "council_near", "mpc", "path", "near_rpc", "reference_policy", "wasm_sha256", "expect_build"]) assert.equal(cfg[k], EXAMPLE[k], k);
  await page.locator("#chain-base").uncheck();
  assert.deepEqual((await cfgOf(page)).chains.map((c) => c.name), ["ethereum-sepolia"]);
  assert.deepEqual(problems, []);
});

test("invalid fields blank the config and the commands, with a message next to the field", async (t) => {
  const { page } = await open(t);
  const blank = async (why) => {
    assert.match(await page.locator("#config").innerText(), /Fix the fields/, why);
    assert.equal(await page.locator("#download").isDisabled(), true, why);
    assert.equal(await page.locator("#copy-config").isDisabled(), true, why);
    assert.equal(await page.locator("#cmds pre").count(), 0, why);
  };
  assert.ok(await page.locator("#cmds pre").count() > 5);
  for (const bad of ["Alice.testnet", "alice.near", "a", "alice..testnet", "-alice.testnet", "al ice.testnet", "x".repeat(60) + ".testnet", "testnet"]) {
    await page.locator("#owner").fill(bad);
    await blank(`owner ${bad}`);
    assert.notEqual(await page.locator("#owner-msg").innerText(), "", bad);
  }
  await page.locator("#owner").fill("alice.testnet");
  assert.ok(await page.locator("#cmds pre").count() > 5);
  await page.locator("#policy").fill("policy.bob.testnet");
  await blank("policy not under the owner");
  assert.match(await page.locator("#policy-msg").innerText(), /sub-account of the owner/);
  await page.locator("#policy").fill("policy.alice.testnet");
  await page.locator("#guardian").fill("GUARD.testnet");
  await blank("guardian");
  await page.locator("#guardian").fill("guardian.alice.testnet");
  for (const [id, v] of [["rules-h", "0"], ["rules-h", "abc"], ["upgrade-h", "-1"], ["gas-cap", "0"], ["gas-cap", "1.5"], ["fee-cap", ""], ["base-tx", "0"], ["base-tx", "4294967296"], ["base-wei", "1e9"], ["base-floor", "-1"]]) {
    await page.locator(`#${id}`).fill(v);
    await blank(`${id}=${v}`);
    assert.notEqual(await page.locator(`#${id}-msg`).innerText(), "", `${id}=${v}`);
    await page.locator(`#${id}`).fill({ "rules-h": "1", "upgrade-h": "24", "gas-cap": "10000000", "fee-cap": "50000000000", "base-tx": "10", "base-wei": "500000000000000", "base-floor": "1000000" }[id]);
  }
  await page.locator("#chain-base").uncheck();
  await blank("no chain");
  assert.match(await page.locator("#chains-msg").innerText(), /at least one chain/i);
  await page.locator("#chain-base").check();
  assert.ok(await page.locator("#cmds pre").count() > 5);
});

test("a rules delay under one hour shows the warning; one hour does not", async (t) => {
  const { page } = await open(t);
  assert.equal(await page.locator("#rules-h-note").innerText(), "");
  await page.locator("#rules-h").fill("0.5");
  assert.match(await page.locator("#rules-h-note").innerText(), /a delay protects only while someone can react/i);
  assert.equal((await cfgOf(page)).rules_delay_sec, 1800);
  await page.locator("#rules-h").fill("1");
  assert.equal(await page.locator("#rules-h-note").innerText(), "");
});

test("the commands: in order, each copyable, the allow-code one carries the hash and the owner", async (t) => {
  const { page } = await open(t);
  assert.match(await page.locator("#cmds").innerText(), /commands that allow your contract appear here once/);
  await page.locator("#owner").fill("alice.testnet");
  await loadCounter(page);
  await page.locator("#arg-0").fill("1");
  const cmds = await page.locator("#cmds pre").allInnerTexts();
  assert.deepEqual(cmds, [
    "npm install", "node setup/policy.mjs plan", "node setup/policy.mjs wasm", "node setup/policy.mjs accounts", "node setup/policy.mjs install",
    "node setup/policy.mjs apply", "node setup/policy.mjs factory base-sepolia", "node setup/policy.mjs apply",
    "node setup/policy.mjs keyfree", "node setup/policy.mjs check",
    `keyfree rules allow-code ${LIVE_HASH} --as alice.testnet --config setup/keyfree.json`,
    "keyfree rules apply <id> --as alice.testnet --config setup/keyfree.json",
  ]);
  assert.equal(await page.locator("#cmds .step button").count(), cmds.length);
  await page.locator("#chain-eth").check();
  assert.ok((await page.locator("#cmds pre").allInnerTexts()).includes("node setup/policy.mjs factory ethereum-sepolia"));
});

test("the watch link opens the explorer on the policy named in the form, and hides while a field is wrong", async (t) => {
  const { page } = await open(t);
  await page.locator("#owner").fill("alice.testnet");
  const { policy } = await cfgOf(page);
  assert.match(policy, /\.alice\.testnet$/);
  assert.equal(await page.locator("#watch").isVisible(), true);
  assert.equal(await page.locator("#watch-link").getAttribute("href"), `../explorer/?policy=${policy}`);
  await page.locator("#owner").fill("Alice.testnet");
  assert.equal(await page.locator("#watch").isVisible(), false);
});

test("copy buttons put the text on the clipboard", async (t) => {
  const { page, ctx } = await open(t);
  try { await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(base).origin }); } catch { t.skip("no clipboard permission in this browser"); return; }
  await page.locator("#init").fill("0x6080");
  await page.locator("#copy-hash").click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), refHash("0x6080"));
  assert.equal(await page.locator("#copy-hash").innerText(), "Copied");
  await page.locator("#copy-config").click();
  assert.equal(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).owner, "you.testnet");
  await page.locator("#cmds .step button").first().click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "npm install");
});

test("Download config.json works under the page's CSP and the file is the config", async (t) => {
  const { page, problems } = await open(t);
  await page.locator("#owner").fill("alice.testnet");
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.locator("#download").click()]);
  assert.equal(dl.suggestedFilename(), "config.json");
  const text = fs.readFileSync(await dl.path(), "utf8");
  assert.equal(text, (await page.locator("#config").innerText()) .replace(/\n*$/, "\n"));
  assert.equal(JSON.parse(text).owner, "alice.testnet");
  assert.deepEqual(problems, []);
});

test("the page makes zero network requests, and its CSP cannot allow one", async (t) => {
  const { page, requests, problems } = await open(t);
  await loadCounter(page);
  await page.locator("#arg-0").fill("1");
  await page.locator("#chain-eth").check();
  await page.locator("#download").click().catch(() => {});
  await page.waitForTimeout(500);
  assert.deepEqual(requests.filter((r) => !r.startsWith("GET blob:")), []);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  assert.equal(csp, "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'");
  assert.ok(!/connect-src/.test(csp));
  // The CSP itself refuses a fetch, whatever the page's code tries.
  const r = await page.evaluate(() => fetch("http://127.0.0.1:1/x").then(() => "sent", (e) => String(e.message)));
  assert.notEqual(r, "sent");
  assert.deepEqual(problems.filter((p) => !/Content Security Policy|Failed to fetch/i.test(p)), []);
  assert.equal(await page.locator('link[rel=icon]').getAttribute("href"), "data:,");
  assert.equal(await page.locator('meta[name=referrer]').getAttribute("content"), "no-referrer");
});

test("markup typed into any field never becomes an element", async (t) => {
  const { page } = await open(t);
  const evil = '<img src=x onerror="window.pwned=1"><b id="inj">x</b>';
  await page.locator("#init").fill(evil);
  await page.locator("#owner").fill(evil);
  await page.locator("#guardian").fill(evil);
  await page.locator("#rules-h").fill(evil);
  await page.locator("#base-tx").fill(evil);
  await page.setInputFiles("#file", { name: "x.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ abi: [{ type: "constructor", inputs: [{ name: evil, type: "uint8" }] }], bytecode: "0x6080" })) });
  await page.locator("#arg-0").waitFor();
  await page.locator("#arg-0").fill(evil);
  assert.equal(await page.locator("#inj").count(), 0);
  assert.equal(await page.locator("main img").count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.ok((await page.locator("#ctor label").innerText()).includes("<img"));   // shown as text
});

test("360px wide: no horizontal scroll, with the Counter loaded and a bad owner", async (t) => {
  const { page } = await open(t, { width: 360, height: 800 });
  const wide = () => page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth, body: document.body.scrollWidth }));
  let w = await wide();
  assert.ok(w.doc <= w.win && w.body <= w.win, JSON.stringify(w));
  await loadCounter(page);
  await page.locator("#arg-0").fill("1");
  await page.locator("#chain-eth").check();
  w = await wide();
  assert.ok(w.doc <= w.win && w.body <= w.win, JSON.stringify(w));
  await page.locator("#owner").fill("x".repeat(80));
  w = await wide();
  assert.ok(w.doc <= w.win && w.body <= w.win, JSON.stringify(w));
});

test("light and dark: the same colour tokens as the explorer", async (t) => {
  const explorer = fs.readFileSync(ROOT("explorer/index.html"), "utf8");
  const tokens = (src) => ({ light: /:root \{([^}]*)\}/.exec(src)[1].replace(/\s+/g, " ").trim(), dark: /prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/.exec(src)[1].replace(/\s+/g, " ").trim() });
  assert.deepEqual(tokens(PAGE.toString()), tokens(explorer));
  const bg = async (scheme) => { const { page } = await open(t, { width: 1000, height: 700 }, scheme); return page.evaluate(() => getComputedStyle(document.body).backgroundColor); };
  assert.equal(await bg("light"), "rgb(247, 247, 245)");
  assert.equal(await bg("dark"), "rgb(18, 20, 23)");
});

test("screenshots", { skip: !process.env.SHOTS }, async (t) => {
  fs.mkdirSync(process.env.SHOTS, { recursive: true });
  for (const [w, scheme] of [[1100, "light"], [360, "light"], [360, "dark"]]) {
    const { page } = await open(t, { width: w, height: 900 }, scheme);
    await page.locator("#owner").fill("alice.testnet");
    await loadCounter(page);
    await page.locator("#arg-0").fill("1");
    await page.locator("#chain-eth").check();
    await page.screenshot({ path: `${process.env.SHOTS}/start-${w}-${scheme}.png`, fullPage: true });
  }
});
