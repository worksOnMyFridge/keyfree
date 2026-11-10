// The "Take the agent's key" page (challenge/index.html) in a real browser, with NEAR stubbed: what it must never do is
// sign bytes NEAR would read differently, call a network error a refusal, count something that got through as
// refused, or let text from a node run as code.
//   cd explorer && npm ci --ignore-scripts && BROWSER=chromium node --test challenge.test.mjs
// LIVE=1 also presses "Try all" against the real policy: 15 real transactions, gas from the agent's account.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import * as pw from "playwright";

const NAME = process.env.BROWSER ?? "chromium";
const FILES = {
  "/": [fs.readFileSync(fileURLToPath(new URL("../challenge/index.html", import.meta.url))), "text/html; charset=utf-8"],
  "/published-agent-key.json": [fs.readFileSync(fileURLToPath(new URL("../challenge/published-agent-key.json", import.meta.url))), "application/json"],
};
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
const nearHosts = ["test.rpc.fastnear.com", "near-testnet.drpc.org", "rpc.testnet.near.org"];

let browser, server, base;
before(async () => {
  browser = await pw[NAME].launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {});
  server = http.createServer((q, r) => {
    const f = FILES[new URL(q.url, "http://x").pathname];
    if (!f) { r.statusCode = 404; return r.end(); }
    r.setHeader("content-type", f[1]);
    r.end(f[0]);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
});
after(async () => { await browser?.close(); server?.close(); });

const ok = (result) => JSON.stringify({ jsonrpc: "2.0", id: "kf", result });
const bytes = (text) => [...Buffer.from(text)];
const panic = (msg) => ok({ status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${msg}` } } } } }, transaction: {}, receipts_outcome: [] });
const invalid = (inner) => JSON.stringify({ jsonrpc: "2.0", id: "kf", error: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION", info: {} }, code: -32000, message: "Server error", data: { TxExecutionError: { InvalidTxError: inner } } } });
const success = ok({ status: { SuccessValue: "" }, transaction: {}, receipts_outcome: [] });

// sendTx(body, n) answers the n-th send_tx; "down" makes every node refuse the connection.
function stubs({ sendTx = () => panic("code not on the allow list"), down = false, keys = "[]" } = {}) {
  const seen = { sends: 0 };
  return { seen, handler: async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (!nearHosts.includes(url.hostname)) return route.abort("blockedbyclient");
    if (down) return route.abort("connectionrefused");
    const answer = (text) => route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: text });
    const body = JSON.parse(req.postData());
    const p = body.params;
    if (body.method === "block") return answer(ok({ header: { hash: "11111111111111111111111111111111" } }));
    if (body.method === "send_tx") return answer(sendTx(body, seen.sends++));
    if (p.request_type === "view_access_key") return answer(ok({ nonce: 41, permission: "FullAccess" }));
    if (p.request_type === "view_access_key_list") return answer(ok({ keys: JSON.parse(keys) }));
    if (p.request_type === "view_account") return answer(ok({ amount: "1191012632627488400000000" }));
    if (p.method_name === "get_rules") return answer(ok({ result: bytes(`{"allowed_code":["aa"]}`) }));
    return answer(JSON.stringify({ jsonrpc: "2.0", id: "kf", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN" } } }));
  } };
}

async function open(t, opts = {}, viewport = { width: 1000, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  const s = stubs(opts);
  if (!process.env.LIVE || opts.stub) await page.route("**/*", s.handler);
  await page.goto(base);
  await page.waitForFunction(() => document.body.dataset.state === "done", null, { timeout: 45000 });
  return { page, seen: s.seen, problems };
}
const card = (page, what) => page.locator(".attempt", { hasText: what });
const press = async (page, what) => {
  const c = card(page, what);
  await c.getByRole("button", { name: "Try" }).click();
  await page.waitForFunction((w) => {
    const el = [...document.querySelectorAll(".attempt")].find((e) => e.textContent.includes(w));
    const r = el?.querySelector(".result");
    return r && r.textContent && !r.classList.contains("busy");
  }, what, { timeout: 90000 });
  return c.locator(".result");
};

test("the page's transaction bytes and hashes are exactly what near-api-js produces", { skip: Boolean(process.env.LIVE) }, async (t) => {
  // Reference: near-api-js 7.3.1 createTransaction + KeyPairSigner, key from the test seed 1..32, nonce 123456789012,
  // block hash 32 bytes of 7. The key is made here at run time; no secret key is written in this file.
  const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
  const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(crypto.createPublicKey(priv).export({ format: "jwk" }).x, "base64url");
  const { page, problems } = await open(t, { stub: true });
  const out = await page.evaluate(async ([secret]) => {
    const k = window.keyfreeChallenge;
    const key = await k.importKey(`ed25519:${k.b58encode(new Uint8Array(secret))}`);
    const common = { signer: "challenge-agent.keyfree-lab.testnet", nonce: 123456789012n, blockHash: new Uint8Array(32).fill(7) };
    return Promise.all([
      k.signTx(key, { ...common, receiver: "challenge.keyfree-lab.testnet", actions: [{ call: "request_deploy", args: { chain_id: 84532, init_code_hex: "0x60006000f3", salt_hex: null }, gas: 250n * 10n ** 12n }] }),
      k.signTx(key, { ...common, receiver: "keyfree-lab.testnet", actions: [{ transfer: 10n ** 23n }] }),
      k.signTx(key, { ...common, receiver: "challenge-agent.keyfree-lab.testnet", actions: [{ addFullAccessKey: new Uint8Array(32).fill(9) }] }),
      k.signTx(key, { ...common, receiver: "challenge-agent.keyfree-lab.testnet", actions: [{ deleteAccount: "keyfree-lab.testnet" }] }),
    ]);
  }, [[...seed, ...pub]]);
  const want = [
    ["4TRNwY6o1MnRLp9czwYngL8T3vJH9FraEvmze6V2NHeb", "IwAAAGNoYWxsZW5nZS1hZ2VudC5rZXlmcmVlLWxhYi50ZXN0bmV0AHm1Vi6P5lT5QHixEuipi6eQH4U65pW+1+DjkQutBJZkFBqZvhwAAAAdAAAAY2hhbGxlbmdlLmtleWZyZWUtbGFiLnRlc3RuZXQHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwEAAAACDgAAAHJlcXVlc3RfZGVwbG95QQAAAHsiY2hhaW5faWQiOjg0NTMyLCJpbml0X2NvZGVfaGV4IjoiMHg2MDAwNjAwMGYzIiwic2FsdF9oZXgiOm51bGx9AKAxqV/jAAAAAAAAAAAAAAAAAAAAAAAAAMW5LTlv2aehdVyY+y5FLmyBTTomQyEgqk4AITH0lnptoJ6LAcV9fqbLOh8uKOqJReTasAPcAJDLh0Ez+l6S9wU="],
    ["4x4Jvupncomnk5x3h3t3pNqL37e5jjaqN1t4iHWcsdWd", "IwAAAGNoYWxsZW5nZS1hZ2VudC5rZXlmcmVlLWxhYi50ZXN0bmV0AHm1Vi6P5lT5QHixEuipi6eQH4U65pW+1+DjkQutBJZkFBqZvhwAAAATAAAAa2V5ZnJlZS1sYWIudGVzdG5ldAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHAQAAAAMAAID2SuHHAi0VAAAAAAAAAKjXjVlRomA+BeqpsXG5VbeFLnfG2aBxcbmzq9EicORXG2QqpvFCsB6hCbY0Jayal9DzzEgTpSLfPDs3bydyHAs="],
    ["BykfCzu4Xgr7vtfnAnFiSfSFsFHnAMUaepztQS6P3UXP", "IwAAAGNoYWxsZW5nZS1hZ2VudC5rZXlmcmVlLWxhYi50ZXN0bmV0AHm1Vi6P5lT5QHixEuipi6eQH4U65pW+1+DjkQutBJZkFBqZvhwAAAAjAAAAY2hhbGxlbmdlLWFnZW50LmtleWZyZWUtbGFiLnRlc3RuZXQHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwEAAAAFAAkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJAAAAAAAAAAABAHVg1h/0w1o120Xv7KyLW4HdafRuhlnfnL03B5NYa83nIS4pe3tz6LqSym2svosyquikHkNGH1aKLGQgvvtIaQs="],
    ["2PBJ4zVkzsuj5f8joZfJ8i1MLvqdyjvMpkMKm6eDsKPR", "IwAAAGNoYWxsZW5nZS1hZ2VudC5rZXlmcmVlLWxhYi50ZXN0bmV0AHm1Vi6P5lT5QHixEuipi6eQH4U65pW+1+DjkQutBJZkFBqZvhwAAAAjAAAAY2hhbGxlbmdlLWFnZW50LmtleWZyZWUtbGFiLnRlc3RuZXQHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwEAAAAHEwAAAGtleWZyZWUtbGFiLnRlc3RuZXQAf/PyIlHTyst/gVIBqbDOQw3hiwHgR/OAJj+wukdLIM5wuaiKyKEIJcm2XSj5htVrhrji/AsmwgrdDiTl3ihlBg=="],
  ];
  assert.deepEqual(out.map((x) => [x.hash, x.signed]), want);
  assert.deepEqual(problems, []);
});

test("loaded: the published key is shown, the live state is filled, every button is ready", { skip: Boolean(process.env.LIVE) }, async (t) => {
  const { page, problems } = await open(t);
  assert.match(await page.locator("#pubkey").innerText(), /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  assert.equal(await page.locator("#keys").innerText(), "0");
  assert.equal(await page.locator("#allowed").innerText(), "1");
  assert.equal(await page.locator("#balance").innerText(), "1.191");
  assert.equal(await page.locator(".attempt button:enabled").count(), 15);
  assert.deepEqual(problems, []);
});

test("a policy refusal links its transaction; a refusal by NEAR says no transaction exists", { skip: Boolean(process.env.LIVE) }, async (t) => {
  const { page } = await open(t, { sendTx: (body, n) => n === 0 ? panic("code not on the allow list")
    : invalid({ InvalidAccessKeyError: { MethodNameMismatch: { method_name: "propose_rule" } } }) });
  const a = await press(page, "Deploy code of my own");
  assert.match(await a.innerText(), /^REFUSED.*the policy refused it: code not on the allow list/);
  assert.match(await a.locator("a").getAttribute("href"), /^https:\/\/testnet\.nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  const b = await press(page, "Allow my code in the rules");
  assert.match(await b.innerText(), /^REFUSED.*may not call propose_rule.*No transaction exists/);
  assert.equal(await b.locator("a").count(), 0);
  assert.equal(await page.locator("#score").innerText(), "2 of 2");
});

test("every node down: not called a refusal, not counted", { skip: Boolean(process.env.LIVE) }, async (t) => {
  const { page } = await open(t, { down: true });
  assert.equal(await page.locator("#keys").innerText(), "unknown");
  const r = await press(page, "Send the agent's NEAR away");
  assert.match(await r.innerText(), /^NOT SENT.*could not reach NEAR testnet/);
  assert.equal(await page.locator("#score").innerText(), "0 of 0");
});

test("something that gets through is shown red and counted against the policy", { skip: Boolean(process.env.LIVE) }, async (t) => {
  const { page } = await open(t, { sendTx: () => success });
  const r = await press(page, "Make myself the owner");
  assert.match(await r.innerText(), /^GOT THROUGH.*please report it/);
  assert.match(await r.getAttribute("class"), /through/);
  assert.equal(await page.locator("#score").innerText(), "0 of 1");
});

test("the allowed code is signed and said to be allowed, not a break and not a refusal", { skip: Boolean(process.env.LIVE) }, async (t) => {
  const { page } = await open(t, { sendTx: () => success });
  const code = await page.evaluate(() => document.querySelector("script").textContent.match(/const COUNTER = "(0x[0-9a-f]+)"/)[1]);
  await page.locator("#code").fill(`${code}${"1".padStart(64, "0")}`);
  await page.locator("#own").click();
  await page.waitForFunction(() => /SIGNED/.test(document.getElementById("own-result").textContent));
  assert.match(await page.locator("#own-result").innerText(), /the one code the rules allow.*Not a break/);
  assert.equal(await page.locator("#score").innerText(), "0 of 0");
  await page.locator("#code").fill("hello");
  await page.locator("#own").click();
  assert.match(await page.locator("#own-result").innerText(), /^NOT SENT.*paste init code as hex/);
});

test("someone else used the key at the same moment: the page builds it again with a fresh nonce", { skip: Boolean(process.env.LIVE) }, async (t) => {
  const { page, seen } = await open(t, { sendTx: (body, n) => n === 0 ? invalid({ InvalidNonce: { tx_nonce: 42, ak_nonce: 42 } }) : panic("chain not allowed") });
  const r = await press(page, "Deploy on a chain the rules do not open");
  assert.match(await r.innerText(), /^REFUSED.*chain not allowed/);
  assert.equal(seen.sends, 2);
});

test("the agent out of gas money: said so, not counted as a refusal", { skip: Boolean(process.env.LIVE) }, async (t) => {
  const { page } = await open(t, { sendTx: () => invalid({ NotEnoughBalance: { signer_id: "x", balance: "0", cost: "1" } }) });
  const r = await press(page, "Pause the policy");
  assert.match(await r.innerText(), /^NOT SENT.*out of NEAR for gas/);
  assert.equal(await page.locator("#score").innerText(), "0 of 0");
});

test("text from a node never runs: a panic message with markup is shown as text", { skip: Boolean(process.env.LIVE) }, async (t) => {
  const { page, problems } = await open(t, { sendTx: () => panic(`<img src=x onerror="document.body.dataset.owned=1">`) });
  const r = await press(page, "Pay for more gas than the cap");
  assert.match(await r.innerText(), /<img src=x onerror=/);
  assert.equal(await page.locator("img").count(), 0);
  assert.equal(await page.evaluate(() => document.body.dataset.owned), undefined);
  assert.deepEqual(problems, []);
});

test("a phone-sized window: nothing runs off the side", { skip: Boolean(process.env.LIVE) }, async (t) => {
  const { page } = await open(t, {}, { width: 360, height: 780 });
  await press(page, "Upgrade a proxy to my code");
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(wide <= 0, `the page scrolls sideways by ${wide}px`);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/challenge-phone-${NAME}.png`, fullPage: true });
});

test("the challenge through the real nodes: every attempt refused", { skip: !process.env.LIVE, timeout: 900000 }, async (t) => {
  const { page, problems } = await open(t);
  assert.equal(await page.locator("#keys").innerText(), "0");
  await page.locator("#all").click();
  await page.waitForFunction(() => {
    const r = [...document.querySelectorAll(".attempt .result")];
    return r.length === 15 && r.every((x) => x.textContent && !x.classList.contains("busy")) && !document.getElementById("all").disabled;
  }, null, { timeout: 900000, polling: 2000 });
  const results = await page.locator(".attempt .result").allInnerTexts();
  for (const [i, r] of results.entries()) console.log(`${String(i + 1).padStart(2)} ${r.replace(/\s+/g, " ").slice(0, 150)}`);
  assert.equal(results.filter((r) => r.startsWith("REFUSED")).length, 15, "every attempt refused");
  assert.equal(await page.locator("#score").innerText(), "15 of 15");
  assert.equal(await page.locator("#keys").innerText(), "0");
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/challenge-live-${NAME}.png`, fullPage: true });
  assert.deepEqual(problems, []);
});
