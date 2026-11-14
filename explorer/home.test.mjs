// The home page (index.html at the repository root) in a real browser, with NEAR stubbed: every number is read from
// chain or says "unknown", text from a node never becomes markup, and the page asks nothing except the NEAR nodes.
//   cd explorer && CHANNEL=msedge BROWSER=chromium node --test home.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import * as pw from "playwright";

const NAME = process.env.BROWSER ?? "chromium";
const PAGE = fs.readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)));
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
const nearHosts = ["test.rpc.fastnear.com", "near-testnet.drpc.org", "rpc.testnet.near.org"];

let browser, server, base;
before(async () => {
  browser = await pw[NAME].launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {});
  server = http.createServer((q, r) => {
    if (new URL(q.url, "http://x").pathname !== "/") { r.statusCode = 404; return r.end(); }
    r.setHeader("content-type", "text/html; charset=utf-8");
    r.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
});
after(async () => { await browser?.close(); server?.close(); });

const ok = (result) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });
const bytes = (value) => [...Buffer.from(JSON.stringify(value))];
const call = (value) => ok({ result: bytes(value) });
const notFound = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN" } } });

// nonces: chain id -> next nonce (a missing chain is unreadable)
function stub({ keys = [], status = { build: "v20", paused: false }, nonces = { 84532: 7, 11155111: 5 }, down = false } = {}) {
  const requests = [];
  const handler = async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === new URL(base).origin) return route.continue();
    requests.push(req.url());
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (!nearHosts.includes(url.hostname)) return route.abort("blockedbyclient");
    if (down) return route.abort("connectionrefused");
    const answer = (text) => route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: text });
    const p = JSON.parse(req.postData()).params;
    if (p.request_type === "view_access_key_list") return answer(ok({ keys }));
    if (p.method_name === "get_status") return answer(call(status));
    if (p.method_name === "get_next_nonce") {
      const n = nonces[JSON.parse(Buffer.from(p.args_base64, "base64").toString()).chain_id];
      return answer(n === undefined ? notFound : call(n));
    }
    return answer(notFound);
  };
  return { handler, requests };
}

async function open(t, opts = {}, viewport = { width: 1100, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  const s = stub(opts);
  await page.route("**/*", s.handler);
  await page.goto(base);
  await page.waitForFunction(() => document.body.dataset.state === "done", null, { timeout: 45000 });
  return { page, problems, requests: s.requests };
}
const text = (page, id) => page.locator(`#${id}`).innerText();

test("all well: keys 0 in green, build v20, signed is the sum of both nonces, running", async (t) => {
  const { page, problems } = await open(t);
  assert.equal(await text(page, "keys"), "0");
  assert.match(await page.locator("#keys").getAttribute("class"), /good/);
  assert.equal(await text(page, "build"), "v20");
  assert.equal(await text(page, "signed"), "12");
  assert.equal(await text(page, "paused"), "running");
  assert.deepEqual(problems, []);
  if (process.env.SHOTS) {
    await page.screenshot({ path: `${process.env.SHOTS}/home-1100-${NAME}.png`, fullPage: true });
    await page.setViewportSize({ width: 360, height: 780 });
    await page.screenshot({ path: `${process.env.SHOTS}/home-360-${NAME}.png`, fullPage: true });
  }
});

test("a key on the policy is shown and marked red", async (t) => {
  const { page } = await open(t, { keys: [{ public_key: "ed25519:x", access_key: {} }, { public_key: "ed25519:y", access_key: {} }] });
  assert.equal(await text(page, "keys"), "2");
  assert.match(await page.locator("#keys").getAttribute("class"), /bad/);
});

test("a paused policy says paused, in red", async (t) => {
  const { page } = await open(t, { status: { build: "v20", paused: true } });
  assert.equal(await text(page, "paused"), "paused");
  assert.match(await page.locator("#paused").getAttribute("class"), /bad/);
});

test("every node down: each number says unknown and nothing stays on a placeholder", async (t) => {
  const { page } = await open(t, { down: true });
  for (const id of ["keys", "build", "signed", "paused"]) {
    assert.equal(await text(page, id), "unknown", id);
  }
  assert.equal(await page.evaluate(() => document.body.dataset.state), "done");
  assert.doesNotMatch(await page.locator(".stats").innerText(), /…/);
});

test("one chain's nonce unreadable: the total says unknown, not a partial sum", async (t) => {
  const { page } = await open(t, { nonces: { 84532: 7 } });
  assert.equal(await text(page, "signed"), "unknown");
  assert.equal(await text(page, "keys"), "0");
  assert.equal(await text(page, "build"), "v20");
});

test("markup in a node answer is shown as text and creates no element", async (t) => {
  const evil = `<img src=x onerror="document.body.dataset.owned=1">`;
  const { page, problems } = await open(t, { status: { build: evil, paused: false } });
  assert.match(await text(page, "build"), /<img src=x onerror=/);
  assert.equal(await page.locator("img").count(), 0);
  assert.equal(await page.evaluate(() => document.body.dataset.owned), undefined);
  assert.deepEqual(problems, []);
});

test("the three doors link to challenge/, explorer/ and start/", async (t) => {
  const { page } = await open(t);
  const hrefs = await page.locator("a.door").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  assert.deepEqual(hrefs, ["challenge/", "explorer/", "start/"]);
});

test("no video button while VIDEO_URL is empty", async (t) => {
  const { page } = await open(t);
  assert.equal(await page.locator("a.video").count(), 0);
  assert.doesNotMatch(await page.locator("body").innerText(), /demo|video/i);
});

test("the facts and footer are there, with the sources link", async (t) => {
  const { page } = await open(t);
  const body = await page.locator("body").innerText();
  for (const s of ["Wasabi Protocol, April 2026", "Zoth, March 2025", "DeltaPrime, September 2024", "Testnet only. Not professionally audited. Apache-2.0."]) assert.ok(body.includes(s), s);
  assert.equal(await page.getByRole("link", { name: "sources" }).getAttribute("href"), "https://github.com/worksOnMyFridge/keyfree#why-now");
});

test("a phone-sized window: nothing runs off the side", async (t) => {
  const { page } = await open(t, {}, { width: 360, height: 780 });
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(wide <= 0, `the page scrolls sideways by ${wide}px`);
});

test("the page requests nothing except the NEAR RPC hosts", async (t) => {
  const { requests } = await open(t);
  assert.ok(requests.length > 0);
  for (const u of requests) assert.ok(nearHosts.includes(new URL(u).hostname), `unexpected request: ${u}`);
});
