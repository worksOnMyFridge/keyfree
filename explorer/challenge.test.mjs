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
const INDEXER_HOST = "api-testnet.nearblocks.io";
const AGENT = "challenge-agent.keyfree-lab.testnet", POLICY = "challenge.keyfree-lab.testnet", COUNCIL = "keyfree-lab.testnet";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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

// An indexer row. The hash is made of base58 letters, so it passes the page's own check.
const hash = (i) => "T".repeat(42) + B58[i % 58] + B58[(i * 7 + 3) % 58];
const ns = (minutesAgo) => String(BigInt(Date.now() - minutesAgo * 60000) * 1000000n);
const row = (i, { signer = AGENT, ok = false, method = "request_deploy", mins = i + 1, ...over } = {}) => ({
  actions: [{ action: "FUNCTION_CALL", method }], block: { block_height: String(1000 + i), block_timestamp: ns(mins) }, block_timestamp: ns(mins),
  outcomes: { status: ok }, receiver_account_id: POLICY, signer_account_id: signer, transaction_hash: hash(i), ...over,
});
const feedPage = (data, next) => ({ body: JSON.stringify({ data, meta: next ? { next_page: next } : {} }) });
// The default answer of the indexer: two refusals, one allowed request, one transaction of the council.
const smallFeed = () => feedPage([row(0, { method: "propose_rule" }), row(1, { signer: COUNCIL, ok: true, method: "add_rule" }), row(2, { ok: true, method: "request_deploy" }), row(3)]);

// sendTx(body, n) answers the n-th send_tx; "down" makes every node refuse the connection. indexer(n, url) answers the
// n-th request to the NearBlocks indexer with { status, body, type, delay, hang, abort }; seen.indexer lists the URLs asked.
function stubs({ sendTx = () => panic("code not on the allow list"), down = false, keys = "[]", indexer = smallFeed } = {}) {
  const seen = { sends: 0, indexer: [] };
  return { seen, handler: async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (url.hostname === INDEXER_HOST) {
      const a = indexer(seen.indexer.length, req.url());
      seen.indexer.push(req.url());
      if (a.hang) return new Promise(() => {});
      if (a.delay) await new Promise((r) => setTimeout(r, a.delay));
      if (a.abort) return route.abort("connectionrefused");
      return route.fulfill({ status: a.status ?? 200, headers: { ...CORS, "content-type": a.type ?? "application/json" }, body: a.body ?? "" });
    }
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
  if (!opts.noFeedWait && (!process.env.LIVE || opts.stub)) await page.waitForFunction(() => document.body.dataset.feed === "done", null, { timeout: 45000 });
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

// ---- the public record of attempts ----
const feedText = (page) => page.locator("#feed-body").innerText();
const rowsOf = (page) => page.locator(".feed-list li");

test("the record: the agent's refusals are counted, its allowed requests are said so, the council is left out", { skip: Boolean(process.env.LIVE) }, async (t) => {
  const data = [row(0), row(1), row(2, { signer: COUNCIL, ok: true, method: "add_rule" }), row(3, { method: "propose_rule" }), row(4, { ok: true, method: "request_deploy" }),
    row(5, { signer: COUNCIL, ok: true, method: "set_owner" }), row(6, { method: "pause" }), row(7, { method: "resign" })];
  const { page, seen, problems } = await open(t, { indexer: () => feedPage(data) });
  const text = await feedText(page);
  assert.match(text, /5 attempts refused by the policy/);
  assert.doesNotMatch(text, /at least/i);
  assert.match(text, /Succeeded: 1\b.*Counter\(1\).*Allowed by the rules, not a break/s);
  assert.equal(await rowsOf(page).count(), 6, "5 refused + 1 allowed, nothing of the council");
  const rows = await rowsOf(page).allInnerTexts();
  assert.equal(rows.filter((r) => r.startsWith("REFUSED")).length, 5);
  assert.equal(rows.filter((r) => r.startsWith("ALLOWED")).length, 1);
  assert.ok(!rows.some((r) => /add_rule|set_owner/.test(r)), "the council's methods are not listed");
  assert.match(rows[0], /^REFUSED\s+request_deploy\s+1 min ago\s+Open ↗/);
  assert.match(await rowsOf(page).first().locator("a").getAttribute("href"), /^https:\/\/testnet\.nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  const all = await page.locator("#feed").innerText();
  assert.match(all, /Only attempts that reached the policy are counted\. An attempt the key itself may not make is\s+turned away by NEAR before it runs and leaves no transaction, so the real number of refusals is higher\./);
  assert.match(all, /Source: NearBlocks indexer\./);
  assert.equal(seen.indexer.length, 1, "one request when there is no next page");
  assert.match(seen.indexer[0], /\/v3\/accounts\/challenge\.keyfree-lab\.testnet\/txns\?limit=100$/);
  assert.deepEqual(problems, []);
});

test("the record: at most the latest 8 are listed", { skip: Boolean(process.env.LIVE) }, async (t) => {
  const { page } = await open(t, { indexer: () => feedPage(Array.from({ length: 25 }, (_, i) => row(i))) });
  assert.equal(await rowsOf(page).count(), 8);
  assert.match(await feedText(page), /25 attempts refused by the policy/);
});

test("the record: more pages than were read means 'at least', and paging stops after 2 requests", { skip: Boolean(process.env.LIVE) }, async (t) => {
  const { page, seen } = await open(t, { indexer: (n) => feedPage(Array.from({ length: 25 }, (_, i) => row(n * 25 + i)), `cursor${n}`) });
  assert.equal(seen.indexer.length, 2);
  assert.match(seen.indexer[1], /[?&]next=cursor0$/);
  assert.match(await feedText(page), /At least 50 attempts refused by the policy/);
  assert.match(await feedText(page), /Succeeded: at least 0/);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(seen.indexer.length, 2, "no polling");
});

test("the record: a reload within a minute asks the indexer nothing and shows the same count", { skip: Boolean(process.env.LIVE) }, async (t) => {
  const { page, seen } = await open(t, { indexer: () => feedPage([row(0), row(1), row(2)]) });
  assert.equal(seen.indexer.length, 1);
  assert.match(await feedText(page), /^3 attempts refused by the policy/);
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.feed === "done");
  assert.match(await feedText(page), /^3 attempts refused by the policy/);
  assert.equal(seen.indexer.length, 1, "the kept answer was used");
});

test("the record: it stops when there is no next page", { skip: Boolean(process.env.LIVE) }, async (t) => {
  const { page, seen } = await open(t, { indexer: (n) => feedPage(Array.from({ length: 25 }, (_, i) => row(n * 25 + i)), n < 1 ? "cursor0" : undefined) });
  assert.equal(seen.indexer.length, 2);
  assert.match(await feedText(page), /^50 attempts refused by the policy/);
});

test("the record: a later page that fails still gives the part that was read, worded 'at least'", { skip: Boolean(process.env.LIVE) }, async (t) => {
  const { page } = await open(t, { indexer: (n) => n === 0 ? feedPage([row(0), row(1)], "cursor0") : { status: 500, body: "oops" } });
  assert.match(await feedText(page), /At least 2 attempts refused/);
});

for (const [name, answer] of [
  ["the indexer is down", { abort: true }],
  ["HTTP 500", { status: 500, body: `{"data":[]}` }],
  ["an HTML body", { type: "text/html", body: "<html><body>Bad gateway</body></html>" }],
  ["the wrong shape", { body: `{"txns":[1,2,3]}` }],
  ["rows nobody can read", { body: `{"data":[1,"x",null,{"a":1}]}` }],
  ["an empty first page", { body: `{"data":[]}` }],
]) {
  test(`the record unknown when ${name}: never a zero, and the buttons still work and count`, { skip: Boolean(process.env.LIVE) }, async (t) => {
    const { page, problems } = await open(t, { indexer: () => answer });
    const text = await feedText(page);
    assert.match(text, /^unknown: the indexer did not answer\. The buttons below work without it\./);
    assert.match(await page.locator("#feed-body .result").getAttribute("class"), /unknown/);
    assert.doesNotMatch(text, /\b0\b|refused by the policy/);
    assert.equal(await rowsOf(page).count(), 0);
    assert.equal(await page.locator("#keys").innerText(), "0", "the rest of the page is filled as before");
    const r = await press(page, "Deploy code of my own");
    assert.match(await r.innerText(), /^REFUSED.*the policy refused it/);
    assert.equal(await page.locator("#score").innerText(), "1 of 1");
    assert.deepEqual(problems, []);
  });
}

test("the record: a slow indexer is given up after 10 s, and the rest of the page is not held back", { skip: Boolean(process.env.LIVE), timeout: 60000 }, async (t) => {
  const { page } = await open(t, { indexer: () => ({ hang: true }), noFeedWait: true });
  assert.equal(await page.evaluate(() => document.body.dataset.feed), "loading");
  assert.equal(await page.locator("#keys").innerText(), "0");
  await page.waitForFunction(() => document.body.dataset.feed === "done", null, { timeout: 20000 });
  assert.match(await feedText(page), /^unknown: the indexer did not answer/);
});

test("the record: text from the indexer never becomes an element, a link or a number", { skip: Boolean(process.env.LIVE) }, async (t) => {
  const data = [
    row(0, { actions: [{ action: "FUNCTION_CALL", method: `<img src=x onerror="document.body.dataset.owned=1">` }] }),
    row(1, { transaction_hash: `<a href="javascript:alert(1)">x</a>` }),
    row(2, { transaction_hash: "javascript:alert(1)" }),
    row(3, { block_timestamp: "abc" }),
    row(4, { actions: [{ action: "TRANSFER" }] }),
    row(5, { actions: "nope", block_timestamp: { x: 1 } }),
    row(6, { method: "pause" }),
  ];
  const { page, problems } = await open(t, { indexer: () => feedPage(data) });
  assert.match(await feedText(page), /7 attempts refused by the policy/);
  assert.equal(await page.locator("#feed img").count(), 0);
  const hrefs = await page.locator("#feed-body a").evaluateAll((a) => a.map((x) => x.getAttribute("href")));
  assert.equal(hrefs.length, 5, "links only for hashes that are base58 of the right length");
  assert.ok(hrefs.every((h) => /^https:\/\/testnet\.nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(h)), hrefs.join());
  assert.equal(await page.evaluate(() => document.body.dataset.owned), undefined);
  const rows = await rowsOf(page).allInnerTexts();
  assert.match(rows[0], /unknown method/);
  assert.doesNotMatch(rows[0], /<img/);
  assert.match(rows[3], /time unknown/);
  assert.match(rows[4], /unknown method/);
  assert.match(rows[5], /unknown method.*time unknown/s);
  assert.equal(rows.length, 7);
  assert.deepEqual(problems, []);
});

test("the record: a time in the future or far in the past shows a UTC date", { skip: Boolean(process.env.LIVE) }, async (t) => {
  const { page } = await open(t, { indexer: () => feedPage([row(0, { mins: -600 }), row(1, { mins: 60 * 24 * 400 * 6 }), row(2, { mins: 130 }), row(3, { mins: 60 * 30 })]) });
  const rows = await rowsOf(page).allInnerTexts();
  assert.match(rows[0], /\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  assert.match(rows[1], /\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  assert.match(rows[2], /2 h ago/);
  assert.match(rows[3], /30 h ago/);
});

test("the record: Refresh is off while loading and for 10 s after, then asks again; a visitor's own attempt does not refetch", { skip: Boolean(process.env.LIVE), timeout: 60000 }, async (t) => {
  const { page, seen } = await open(t, { indexer: () => ({ ...smallFeed(), delay: 700 }), noFeedWait: true });
  const btn = page.locator("#feed-refresh");
  assert.equal(await btn.isDisabled(), true, "disabled while loading");
  await page.waitForFunction(() => document.body.dataset.feed === "done");
  assert.equal(await btn.isDisabled(), true, "still disabled right after a load");
  await press(page, "Pause the policy");
  assert.equal(seen.indexer.length, 1, "an attempt does not refetch");
  await page.waitForFunction(() => !document.getElementById("feed-refresh").disabled, null, { timeout: 15000 });
  await btn.click();
  assert.equal(await btn.isDisabled(), true);
  await page.waitForFunction(() => document.body.dataset.feed === "done");
  assert.equal(seen.indexer.length, 2);
  assert.match(await feedText(page), /2 attempts refused/);
});

test("the record at phone width with 8 rows: nothing runs off the side", { skip: Boolean(process.env.LIVE) }, async (t) => {
  const long = (i) => row(i, { method: "a_very_long_method_name_that_a_thief_might_make_up_to_see_what_breaks".slice(0, 64) });
  const { page } = await open(t, { indexer: () => feedPage(Array.from({ length: 8 }, (_, i) => i % 2 ? long(i) : row(i, { ok: i === 2, method: "request_proxy_upgrade" }))) }, { width: 360, height: 780 });
  assert.equal(await rowsOf(page).count(), 8);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(wide <= 0, `the page scrolls sideways by ${wide}px`);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/feed-360.png`, fullPage: true });
});

test("the record: a screenshot at 1000 px", { skip: !process.env.SHOTS || Boolean(process.env.LIVE) }, async (t) => {
  const data = [row(0, { method: "propose_rule", mins: 1 }), row(1, { ok: true, method: "request_deploy", mins: 4 }), row(2, { method: "request_deploy", mins: 12 }), row(3, { method: "pause", mins: 55 }),
    row(4, { method: "resign", mins: 130 }), row(5, { method: "propose_upgrade", mins: 60 * 30 }), row(6, { method: "request_proxy_upgrade", mins: 60 * 24 * 4 }), row(7, { method: "propose_role", mins: 60 * 24 * 9 })];
  const { page } = await open(t, { indexer: (n) => feedPage(data, "c") });
  await page.screenshot({ path: `${process.env.SHOTS}/feed-1000.png`, fullPage: true });
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
