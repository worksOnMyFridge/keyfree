// The explorer page in real browsers, with the network stubbed: nodes that are down, slow, or lie; numbers above
// 2^53; a phone-sized window. What it must never do: show a guess as a fact, call a network error a refusal, stay on
// "loading…" for ever, or let text from a node run as code.
//   cd explorer && npm ci --ignore-scripts && BROWSER=chromium npm test
// BROWSER: chromium, firefox or webkit (`npx playwright install` fetches them); CHANNEL=chrome or msedge uses an
// installed browser instead. LIVE=1 reads the real policy through the real nodes instead of stubs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import * as pw from "playwright";

const NAME = process.env.BROWSER ?? "chromium";
const HTML = fs.readFileSync(fileURLToPath(new URL("index.html", import.meta.url)));
const ETH_ADDR = "0x43e3cb8d471680307f0c232e5ac190828681fcb0";
const POLICY = "policy13.keyfree-lab.testnet";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
const txOk = (logs = [], status = { SuccessValue: "" }) => ({ result: { status, receipts_outcome: [{ outcome: { logs, status: { SuccessValue: "" } } }] } });
const txFail = (msg) => ({ result: { status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${msg}` } } } } }, receipts_outcome: [] } });
const BIG_WEI = "12345678901234567891"; // above 2^53: exact or wrong

let browser, server, base;
before(async () => {
  browser = await pw[NAME].launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {});
  server = http.createServer((_q, r) => { r.setHeader("content-type", "text/html; charset=utf-8"); r.end(HTML); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
});
after(async () => { await browser?.close(); server?.close(); });

// One line per journal entry, as the contract writes them. Budgets go out as raw JSON text so a long number stays long.
const views = () => ({
  get_status: `{"build":"v20","version":10,"paused":false,"upgrade_delay_sec":180,"proposed":null}`,
  get_roles: `{"owner":"owner.testnet","guardian":"guard.testnet","reserve":"reserve.testnet","agent":"agent.testnet","retiring":false,"role_changes":[]}`,
  get_rules: `{"allowed_code":["aa","bb"],"allowed_proxy_upgrades":[],"max_gas_limit":10000000,"max_fee_cap":50000000000,"rules_delay_sec":60,"proposals":[]}`,
  get_eth_address: JSON.stringify(ETH_ADDR),
  contract_source_metadata: `{"version":"v20","link":"https://github.com/worksOnMyFridge/keyfree/tree/29fa5c886b8d9838011cf80c3e4f082ca88fdc2e"}`,
  get_next_nonce: "2",
  get_budget: `{"max_wei_per_day":${BIG_WEI},"max_tx_per_day":10,"used_wei_today":1234567890123456789,"used_tx_today":3}`,
  get_open: `{"pending":null,"stuck":null,"chain_id":null}`,
  get_entry: `{"kind":"deploy","status":"confirmed","tx_hash":"0x${"ab".repeat(32)}","address":"0x${"cd".repeat(20)}","factory":"0x${"ef".repeat(20)}","code_hash":"aa","salt":"0x00"}`,
});

const nearHosts = ["test.rpc.fastnear.com", "near-testnet.drpc.org", "rpc.testnet.near.org", "archival-rpc.testnet.fastnear.com", "archival-rpc.testnet.near.org"];
const INDEXER_HOST = "api-testnet.nearblocks.io";
const baseHosts = ["sepolia.base.org", "base-sepolia-rpc.publicnode.com"];
const ethHosts = ["ethereum-sepolia-rpc.publicnode.com", "ethereum-sepolia.gateway.tatum.io"];

// faults[host] or faults["*near"] / faults["*evm"]: "down" | a status | "html" | "hang" | a function(body) => JSON text.
// `more` is kept by the caller and may be changed while the page runs:
//   feed: the indexer's answer: an array of rows, {data, meta}, "down" | a status | "html" | "shape" | "hang", or a function(n) of those
//   tx: { [hash]: function(host) => {result} | {error} }; no entry or undefined: the node has no such transaction (UNKNOWN_TRANSACTION)
//   amounts: { [account]: yoctoNEAR } for view_account; missing: accounts the node says do not exist
const TX_DEFAULT = () => txOk();
function stubs(faults = {}, over = {}, previewAnswer, more = {}) {
  const seen = { hosts: new Set(), calls: [], indexer: [], tx: [], queries: [] };
  const table = () => ({ ...views(), ...over });
  return { seen, handler: async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const host = url.hostname;
    if (host === INDEXER_HOST) {
      seen.indexer.push(req.url());
      let f = typeof more.feed === "function" ? more.feed(seen.indexer.length) : more.feed ?? [];
      if (f === "down") return route.abort("connectionrefused");
      if (f === "hang") return;
      if (f === "html") return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/html" }, body: "<html>Bad gateway</html>" });
      if (typeof f === "number") return route.fulfill({ status: f, headers: CORS, body: "no" });
      if (f === "shape") f = { data: "nope" };
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(Array.isArray(f) ? { data: f } : f) });
    }
    const isNear = nearHosts.includes(host);
    const fault = faults[host] ?? faults[isNear ? "*near" : "*evm"];
    const answer = (text) => route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: text });
    if (fault === "down") return route.abort("connectionrefused");
    if (fault === "hang") return; // never answered
    if (fault === "html") return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/html" }, body: "<html>Bad gateway</html>" });
    if (typeof fault === "number") return route.fulfill({ status: fault, headers: CORS, body: "no" });
    const body = JSON.parse(req.postData());
    seen.hosts.add(host);
    seen.calls.push(body.method === "query" ? body.params.method_name ?? body.params.request_type : body.method);
    if (typeof fault === "function") return answer(fault(body));
    if (!isNear) {
      if (body.method === "eth_getBalance") return answer(`{"jsonrpc":"2.0","id":1,"result":"0xb5e620f48000"}`); // 0.0002 ETH
      return answer(`{"jsonrpc":"2.0","id":1,"result":null}`);
    }
    if (body.method === "tx") {
      seen.tx.push({ host, hash: body.params.tx_hash });
      const f = body.params.tx_hash in (more.tx ?? {}) ? more.tx[body.params.tx_hash] : TX_DEFAULT;
      const out = f(host);
      return answer(JSON.stringify(out ? { jsonrpc: "2.0", id: 1, ...out } : { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Server error", name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION", info: {} } } }));
    }
    const p = body.params;
    seen.queries.push({ host, type: p.request_type, account: p.account_id, name: p.method_name });
    if (more.missing?.includes(p.account_id)) return answer(`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Server error","name":"HANDLER_ERROR","cause":{"name":"UNKNOWN_ACCOUNT","info":{"requested_account_id":"${p.account_id}"}}}}`);
    if (p.request_type === "view_access_key_list") return answer(`{"jsonrpc":"2.0","id":1,"result":{"keys":${over.keys ?? "[]"},"block_hash":"x","block_height":1}}`);
    if (p.request_type === "view_account") return answer(`{"jsonrpc":"2.0","id":1,"result":{"amount":"${more.amounts?.[p.account_id] ?? "5000000000000000000000000"}","code_hash":"${over.code_hash ?? "8jdpF6XEkVQ3Hun6pJrGzSEmPeGQk6JyZBuk2eRDtp6P"}","block_hash":"x","block_height":1}}`);
    const name = p.method_name;
    if (name === "preview") {
      const a = previewAnswer ?? ((args) => (args.init_code_hex.endsWith("1")
        ? `{"unsigned":"0x02","hash":"${"12".repeat(32)}","nonce":2,"expected_address":"0x${"77".repeat(20)}","min_gas":60000}`
        : { panic: "code not on the allow list" }));
      const out = a(JSON.parse(atob(p.args_base64)));
      if (out?.panic) return answer(`{"jsonrpc":"2.0","id":1,"result":{"error":"wasm execution failed with error: HostError(GuestPanic { panic_msg: \\"${out.panic}\\" })","logs":[],"block_hash":"x","block_height":1}}`);
      return answer(`{"jsonrpc":"2.0","id":1,"result":{"result":[${[...Buffer.from(out)].join(",")}],"logs":[],"block_hash":"x","block_height":1}}`);
    }
    const text = table()[name];
    if (text === "refuse") return answer(`{"jsonrpc":"2.0","id":1,"result":{"error":"wasm execution failed with error: FunctionCallError(MethodResolveError(MethodNotFound))","logs":[],"block_hash":"x","block_height":1}}`);
    if (text === undefined || text === "fail") return answer(`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Server error","name":"HANDLER_ERROR","cause":{"name":"TIMEOUT_ERROR"}}}`);
    return answer(`{"jsonrpc":"2.0","id":1,"result":{"result":[${[...Buffer.from(text)].join(",")}],"logs":[],"block_hash":"x","block_height":1}}`);
  } };
}

// query: what goes after the page's address; clock: Playwright's clock, so a test can move time instead of waiting;
// more: see stubs(). Returns the same objects the page talks to, so a test can change them while the page runs.
async function open(t, { faults, over = {}, previewAnswer, viewport = { width: 1100, height: 800 }, colorScheme = "light", wait = true, waitFeed = true, query = "", clock = false, more = {} } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const problems = [], dialogs = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
  const s = stubs(faults, over, previewAnswer, more);
  await page.route("**/*", s.handler);
  if (clock) await page.clock.install();
  await page.goto(base + query);
  if (wait) await page.waitForFunction(() => document.body.dataset.state === "done", null, { timeout: 45000 });
  if (wait && waitFeed) await page.waitForFunction(() => document.body.dataset.feed === "done", null, { timeout: 45000 });
  return { page, seen: s.seen, problems, dialogs, over, more, text: (id) => page.locator(`#${id}`).innerText() };
}
const reads = (page) => page.evaluate(() => Number(document.body.dataset.reads));
const readsAbove = (page, n) => page.waitForFunction((n) => Number(document.body.dataset.reads) > n, n, { timeout: 20000 });
const noLoading = async (page) => {
  const all = await page.locator("main").innerText();
  assert.doesNotMatch(all, /loading…|^…$/m, "a panel was left on its placeholder");
};

test("all well: every panel is filled, numbers are exact, no script error", async (t) => {
  const { page, problems, text } = await open(t);
  await noLoading(page);
  assert.equal(await text("keys"), "0");
  assert.match(await text("build"), /v20, version 10/);
  assert.match(await text("codehash"), /the reproducible build of 29fa5c/);
  assert.match(await text("paused"), /running/);
  assert.match(await text("chains"), /Base Sepolia/);
  assert.match(await text("chains"), /3 of 10 transactions/);
  assert.match(await text("chains"), /0\.0002 ETH/);
  assert.match(await text("pending"), /Nothing is waiting/);
  assert.match(await text("journal"), /confirmed/);
  assert.match(await text("caps"), /10,000,000/);
  assert.match(await text("caps"), /50 gwei/);
  assert.match(await text("nodes"), /test\.rpc\.fastnear\.com/);
  assert.equal(await page.locator("#banner").count() ? await page.locator("#banner").isVisible() : false, false);
  assert.deepEqual(problems, []);
});

test("numbers above 2^53 stay exact, and a small amount is never shown as zero", async (t) => {
  const { page, text } = await open(t);
  // 12345678901234567891 wei exactly; through a JavaScript number it would come out 12345678901234567000-something.
  assert.match(await text("chains"), /12\.3456 ETH/);
  const titles = await page.locator("#chains [title]").evaluateAll((els) => els.map((e) => e.title));
  assert.ok(titles.some((x) => x.includes(`${BIG_WEI} wei`)), `no exact amount in ${titles}`);
  assert.ok(titles.some((x) => x.includes("1234567890123456789 wei")), `no exact use in ${titles}`);
  const small = await open(t, { over: { get_budget: `{"max_wei_per_day":500000000000000,"max_tx_per_day":10,"used_wei_today":300000000000,"used_tx_today":1}` } });
  assert.match(await small.text("chains"), /0\.0000003 ETH/);
});

test("a council member lowered the budget to zero: the page shows it, it does not die on a division", async (t) => {
  const { page, problems, text } = await open(t, { over: { get_budget: `{"max_wei_per_day":0,"max_tx_per_day":0,"used_wei_today":0,"used_tx_today":0}` } });
  await noLoading(page);
  assert.match(await text("chains"), /0 of 0 transactions/);
  assert.match(await text("journal"), /confirmed/);
  assert.deepEqual(problems, []);
});

test("keys on the policy are shown red, and the note does not say there are none", async (t) => {
  const { text, page } = await open(t, { over: { keys: `[{"public_key":"ed25519:x","access_key":{"permission":"FullAccess"}}]` } });
  assert.equal(await text("keys"), "1");
  assert.doesNotMatch(await text("keys-note"), /There is none/);
  assert.match(await page.locator("#keys span").getAttribute("style"), /--no/);
});

for (const mode of ["down", 502, 429, "html", "hang"]) {
  test(`the first NEAR node ${mode}: the next node serves, the page says which`, async (t) => {
    const { page, seen, text } = await open(t, { faults: { "test.rpc.fastnear.com": mode } });
    await noLoading(page);
    assert.equal(await text("keys"), "0");
    assert.ok(seen.hosts.has("near-testnet.drpc.org"), [...seen.hosts].join());
    assert.match(await text("nodes"), /near-testnet\.drpc\.org/);
  });
}

for (const mode of ["down", 500, "html"]) {
  test(`every NEAR node ${mode}: a plain banner, unknown instead of guesses, and the page recovers on request`, async (t) => {
    const faults = { "*near": mode };
    const { page, text, problems } = await open(t, { faults });
    await noLoading(page);
    assert.match(await text("banner"), /none of the public NEAR nodes answered/i);
    assert.notEqual(await text("keys"), "0");
    assert.doesNotMatch(await text("keys-note"), /There is none/);
    assert.doesNotMatch(await text("paused"), /running/);
    assert.doesNotMatch(await text("pending"), /Nothing is waiting/);
    assert.doesNotMatch(await text("chains"), /none set/);
    assert.doesNotMatch(await text("journal"), /no lines/);
    // The policy was not asked, so nothing may be called a refusal.
    await page.locator("button[data-arg='1']").click();
    await page.waitForFunction(() => /answer (warn|ok|no)/.test(document.getElementById("answer").innerHTML));
    assert.doesNotMatch(await text("answer"), /Refused by the policy/);
    assert.match(await text("answer"), /says nothing about the policy/);
    // The nodes come back.
    delete faults["*near"];
    await page.locator("#reload").click();
    await page.waitForFunction(() => document.getElementById("keys").innerText === "0" && document.body.dataset.state === "done", null, { timeout: 45000 });
    assert.equal(await page.locator("#banner").isVisible(), false);
    assert.match(await text("nodes"), /NEAR test\.rpc/);
    // And go down again: the footer must not keep naming the node that answered last time.
    faults["*near"] = mode;
    await page.locator("#reload").click();
    await page.waitForFunction(() => document.getElementById("keys").innerText !== "0" && document.body.dataset.state === "done", null, { timeout: 45000 });
    assert.match(await text("nodes"), /no NEAR node answered/);
    assert.deepEqual(problems, []);
  });
}

test("one view fails on every node: that part is unknown, the rest stands, no false 'none set'", async (t) => {
  const { page, text } = await open(t, { over: { get_budget: "fail", get_entry: "fail" } });
  await noLoading(page);
  assert.equal(await text("keys"), "0");
  assert.doesNotMatch(await text("chains"), /none set/);
  assert.match(await text("chains"), /unknown/);
  assert.doesNotMatch(await text("journal"), /no lines/);
  assert.match(await text("journal"), /could not read/);
});

test("a contract with no budget set says so", async (t) => {
  const { text } = await open(t, { over: { get_budget: "null" } });
  assert.match(await text("chains"), /none set/);
});

test("an EVM node down: the fallback serves; every EVM node down: the balance is unknown, the rest stands", async (t) => {
  const one = await open(t, { faults: { "sepolia.base.org": "down" } });
  assert.match(await one.text("chains"), /0\.0002 ETH/);
  assert.ok(one.seen.hosts.has("base-sepolia-rpc.publicnode.com"));
  const all = await open(t, { faults: { "*evm": "down" } });
  await noLoading(all.page);
  assert.match(await all.text("chains"), /unknown/);
  assert.equal(await all.text("keys"), "0");
});

test("the preview: allowed, refused in the policy's words, buttons usable again", async (t) => {
  const { page, text } = await open(t);
  await page.locator("button[data-arg='1']").click();
  await page.waitForFunction(() => document.querySelector("#answer .ok"));
  assert.match(await text("answer"), /Allowed/);
  await page.locator("button[data-arg='999']").click();
  await page.waitForFunction(() => document.querySelector("#answer .no"));
  assert.match(await text("answer"), /Refused by the policy: code not on the allow list/);
  assert.equal(await page.locator("button[data-arg='1']").isDisabled(), false);
});

test("text from a node never runs: markup is shown as text, a script link is not a link", async (t) => {
  const evil = "<img src=x onerror=window.__pwned=1>";
  const { page, problems } = await open(t, { over: {
    get_rules: JSON.stringify({ allowed_code: [], allowed_proxy_upgrades: [], max_gas_limit: 1, max_fee_cap: 1, rules_delay_sec: 60, proposals: [{ id: 1, change: { x: evil }, ready_at: 1 }] }),
    get_roles: JSON.stringify({ owner: evil, guardian: "g", reserve: "r", agent: "a", role_changes: [{ role: evil, account: evil, proposer: "p", ready_at: null }] }),
    contract_source_metadata: JSON.stringify({ link: "javascript:window.__pwned=1//tree/x" }),
    get_entry: JSON.stringify({ kind: "deploy", status: evil, tx_hash: `0x${"ab".repeat(32)}"><script>window.__pwned=1</script>`, address: `0x${"cd".repeat(20)}` }),
  } });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator("main img, main script").count(), 0);
  assert.equal(await page.locator("#source a").count(), 0, "a javascript: link was made");
  assert.deepEqual(problems, []);
});

test("nonsense from a node: unknown, no script error, nothing left loading", async (t) => {
  const { page, problems } = await open(t, { over: { get_rules: `{"nothing":"here"}`, get_status: "7", get_roles: "null", get_budget: `{"max_wei_per_day":"abc"}`, get_entry: `"x"` } });
  await noLoading(page);
  assert.deepEqual(problems, []);
});

// Pending changes: the council's working place. Answers for the three views the panel reads.
const nowSec = () => Math.floor(Date.now() / 1000);
const HASH = "ab".repeat(32);
const rulesWith = (proposals) => JSON.stringify({ allowed_code: ["aa"], allowed_proxy_upgrades: [], max_gas_limit: 10000000, max_fee_cap: 50000000000, rules_delay_sec: 60, proposals });
const rolesWith = (role_changes) => JSON.stringify({ owner: "owner.testnet", guardian: "guard.testnet", reserve: "reserve.testnet", agent: "agent.testnet", role_changes });
const statusWith = (proposed) => JSON.stringify({ build: "v20", version: 10, paused: false, upgrade_delay_sec: 180, proposed });
const AS = "--as <your council account>";
const secondsIn = (s) => { const m = s.match(/ready in (?:(\d+) h )?(?:(\d+) min )?(\d+) s/); return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3]) : null; };
const threeItems = () => ({
  get_rules: rulesWith([{ id: 7, change: { AllowCode: { code_hash: HASH } }, ready_at: nowSec() + 2530 }]),
  get_roles: rolesWith([{ role: "guardian", account: "new-guard.testnet", proposer: "reserve.testnet", ready_at: null }]),
  get_status: statusWith([HASH, nowSec() + 7300]),
});

test("a pending rule: plain words, a live countdown, the exact cancel command", async (t) => {
  const { page, text, problems } = await open(t, { over: threeItems() });
  const all = await text("pending");
  assert.match(all, /3 changes are waiting/);
  assert.match(all, /Rule 7: allow new code ababababab…abababab/);
  assert.match(all, /ready in 4\d min \d+ s/);
  const cmds = await page.locator("#pending .cmd code").allInnerTexts();
  assert.ok(cmds.includes(`keyfree rules cancel 7 ${AS}`), cmds.join("|"));
  assert.match(await page.locator("#pending details code").first().textContent(), /"AllowCode"/);
  assert.equal(await page.locator("#pending button.copy").count(), 3);
  assert.match(await page.locator("section", { hasText: "Waiting for their delay" }).innerText(), /Any council member \(owner, guardian, reserve\) can cancel it until it is applied/);
  assert.deepEqual(problems, []);
});

test("every rule variant is told in words", async (t) => {
  const h = `0x${"11".repeat(20)}`, g = `0x${"22".repeat(20)}`;
  const changes = [
    [{ AllowChain: { chain_id: 84532, next_nonce: 0, min_fee_per_gas: 1 } }, /open chain 84532/],
    [{ EnableChain: { chain_id: 84532 } }, /re-enable chain 84532/],
    [{ SetFactory: { chain_id: 84532, factory_hex: h } }, new RegExp(`set the factory on chain 84532 to ${h}`)],
    [{ SetLimits: { max_gas_limit: 5000000, max_fee_cap: "12345678901234567890" } }, /raise the caps to gas 5000000, fee 12345678901234567890 wei/],
    [{ AllowProxyUpgrade: { chain_id: 84532, proxy_hex: h, implementation_hex: g } }, new RegExp(`allow one upgrade of proxy ${h} to ${g} on chain 84532`)],
    [{ SetBudget: { chain_id: 84532, max_wei_per_day: "99999999999999999999", max_tx_per_day: 4 } }, /set the daily budget on chain 84532 to 4 transactions, 99999999999999999999 wei/],
  ];
  const { text } = await open(t, { over: { get_rules: rulesWith(changes.map(([change], i) => ({ id: i + 1, change, ready_at: nowSec() + 100 }))) } });
  const all = await text("pending");
  for (const [, re] of changes) assert.match(all, re);
});

test("a role change with no second approval yet, and a pending policy upgrade, carry their cancel commands", async (t) => {
  const { page, text } = await open(t, { over: threeItems() });
  const all = await text("pending");
  assert.match(all, /make new-guard\.testnet the guardian, proposed by reserve\.testnet/);
  assert.match(all, /waiting for a second approval/);
  assert.match(all, /replace the policy's code with sha256 ababababab…abababab/);
  const cmds = await page.locator("#pending .cmd code").allInnerTexts();
  assert.ok(cmds.includes(`keyfree cancel-role reserve.testnet ${AS}`), cmds.join("|"));
  assert.ok(cmds.includes(`keyfree cancel-upgrade ${AS}`), cmds.join("|"));
});

test("the countdown ticks without reading the chain again; a delay that has passed says so", async (t) => {
  const { page, seen, text } = await open(t, { over: { get_rules: rulesWith([
    { id: 1, change: { EnableChain: { chain_id: 1 } }, ready_at: nowSec() + 600 },
    { id: 2, change: { EnableChain: { chain_id: 2 } }, ready_at: nowSec() - 30 },
  ]) } });
  const reads = seen.calls.length;
  const first = secondsIn(await page.locator("#pending .count").first().innerText());
  assert.ok(first > 0 && first <= 600, `first ${first}`);
  await page.waitForTimeout(2200);
  const later = secondsIn(await page.locator("#pending .count").first().innerText());
  assert.ok(later < first, `${later} is not smaller than ${first}`);
  assert.equal(seen.calls.length, reads, "the chain was read again");
  const due = page.locator("#pending .count").nth(1);
  assert.match(await due.innerText(), /the delay has passed: it can be applied now/);
  assert.match(await due.getAttribute("class"), /warn/);
  assert.doesNotMatch(await page.locator("#pending .count").first().getAttribute("class"), /warn/);
  assert.match(await text("pending"), /2 changes are waiting/);
});

test("reading again replaces the countdown: one clock, not two", async (t) => {
  const { page } = await open(t, { over: { get_rules: rulesWith([{ id: 1, change: { EnableChain: { chain_id: 1 } }, ready_at: nowSec() + 600 }]) } });
  await page.evaluate(() => { window.__n = 0; const old = setInterval; window.setInterval = (...a) => { window.__n++; return old(...a); }; });
  await page.locator("#reload").click();
  await page.waitForFunction(() => document.body.dataset.state === "done");
  assert.equal(await page.evaluate(() => window.__n), 1);
});

test("an unknown rule variant is shown as its JSON, nothing is dropped", async (t) => {
  const { page, text } = await open(t, { over: { get_rules: rulesWith([
    { id: 5, change: { FutureThing: { x: 1, y: "two" } }, ready_at: nowSec() + 100 },
    { id: 6, change: "weird", ready_at: nowSec() + 100 },
  ]) } });
  const all = await text("pending");
  assert.match(all, /2 changes are waiting/);
  assert.match(all, /Rule 5: unknown kind of change \{"FutureThing":\{"x":1,"y":"two"\}\}/);
  assert.match(all, /Rule 6: unknown kind of change "weird"/);
  const cmds = await page.locator("#pending .cmd code").allInnerTexts();
  assert.ok(cmds.includes(`keyfree rules cancel 5 ${AS}`) && cmds.includes(`keyfree rules cancel 6 ${AS}`));
});

test("hostile values from the node: no element, no command carrying them, an 'unexpected value' note", async (t) => {
  const { page, text, problems } = await open(t, { over: {
    get_rules: rulesWith([{ id: "7; rm -rf ~<img src=x onerror=window.__pwned=1>", change: { AllowCode: { code_hash: HASH } }, ready_at: nowSec() + 100 }]),
    get_roles: rolesWith([
      { role: "guardian", account: "a.testnet", proposer: "x; rm -rf ~", ready_at: null },
      { role: "owner", account: "b.testnet", proposer: "<img src=x onerror=window.__pwned=1>", ready_at: nowSec() + 100 },
    ]),
  } });
  assert.equal(await page.locator("main img, main script").count(), 0);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  const cmds = await page.locator("#pending .cmd code").allInnerTexts();
  assert.deepEqual(cmds, [], "a command was built from a hostile value");
  assert.equal((await text("pending")).match(/nexpected value from the node/g).length, 3);
  assert.match(await text("pending"), /x; rm -rf ~/); // shown as text only
  assert.deepEqual(problems, []);
});

test("one of the three views fails: the pending panel says unknown, never 'Nothing is waiting'", async (t) => {
  for (const view of ["get_rules", "get_roles", "get_status"]) {
    const { text } = await open(t, { over: { [view]: "fail" } });
    const all = await text("pending");
    assert.match(all, /unknown/, view);
    assert.match(all, /does not mean nothing is waiting/, view);
    assert.doesNotMatch(all, /Nothing is waiting\./, view);
  }
});

test("three pending items at 360px: no sideways scroll, long commands wrap", async (t) => {
  const { page } = await open(t, { viewport: { width: 360, height: 800 }, over: {
    ...threeItems(),
    get_roles: rolesWith([{ role: "guardian", account: "x".repeat(60) + ".testnet", proposer: "reserve-with-a-very-long-account-name.testnet", ready_at: null }]),
  } });
  const m = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth, win: innerWidth,
    cut: [...document.querySelectorAll("#pending *")].filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > el.closest(".panel").getBoundingClientRect().right + 1).map((el) => el.tagName),
  }));
  assert.ok(m.doc <= m.win, `page ${m.doc} wider than ${m.win}`);
  assert.deepEqual(m.cut, []);
  if (process.env.SHOTS) {
    await page.screenshot({ path: `${process.env.SHOTS}/pending-360.png`, fullPage: true });
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.screenshot({ path: `${process.env.SHOTS}/pending-1100.png`, fullPage: true });
  }
});

for (const [name, viewport] of [["phone", { width: 375, height: 812 }], ["small phone", { width: 320, height: 640 }], ["tablet", { width: 768, height: 1024 }]]) {
  for (const colorScheme of ["light", "dark"]) {
    test(`${name}, ${colorScheme}: no sideways scroll of the page, the panels fit`, async (t) => {
      const { page } = await open(t, { viewport, colorScheme });
      await noLoading(page);
      const { doc, win, wide, cut } = await page.evaluate(() => {
        const inside = [...document.querySelectorAll(".panel *")].filter((el) => el.getClientRects().length && el.getBoundingClientRect().width > 0);
        return {
          doc: document.documentElement.scrollWidth, win: innerWidth,
          wide: [...document.querySelectorAll(".panel")].filter((p) => p.getBoundingClientRect().right > innerWidth + 1).length,
          // Nothing may stick out of its panel, where the page would clip it: a table's scrolled column counts too.
          cut: inside.filter((el) => el.getBoundingClientRect().right > el.closest(".panel").getBoundingClientRect().right + 1).map((el) => `${el.tagName} ${el.textContent.slice(0, 40)}`).slice(0, 5),
        };
      });
      assert.ok(doc <= win, `page ${doc} wider than the window ${win}`);
      assert.equal(wide, 0, "a panel leaves the window");
      assert.deepEqual(cut, [], "cut off at the panel's edge");
      if (viewport.width <= 640) {
        // A phone shows every column as a labelled line. The label is CSS attr(): browsers report its computed value
        // differently, so the check is that a ::before exists on each cell and the cell carries the text.
        const labels = await page.evaluate(() => [...document.querySelectorAll("#chains tr:first-child td, #journal tr:first-child td")].map((td) => ({
          label: td.dataset.label, before: getComputedStyle(td, "::before").content, right: td.getBoundingClientRect().right, stacked: getComputedStyle(td).display !== "table-cell",
        })));
        assert.ok(labels.every((l) => l.stacked && l.right <= win && !["none", "normal"].includes(l.before)), JSON.stringify(labels));
        for (const want of ["Daily budget", "ETH on the address", "Contract", "Transaction"]) assert.ok(labels.some((l) => l.label.includes(want)), `no "${want}" label`);
      }
      if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${NAME}-${name.replace(" ", "_")}-${colorScheme}.png`, fullPage: true });
    });
  }
}

test("the page sends nothing but RPC reads, and names no secrets", async (t) => {
  const { seen } = await open(t);
  const writes = seen.calls.filter((c) => /send|broadcast|sendRaw/i.test(c));
  assert.deepEqual(writes, []);
  assert.ok(HTML.includes(POLICY));
});

test("code that is not the build the page names is said to be so, whatever it says about itself", async (t) => {
  const { page, text } = await open(t, { over: { code_hash: "H3cFJqHCGSabcdefghijklmnopqrKEuM2aFD" } });
  await noLoading(page);
  assert.match(await text("codehash"), /not the build the README names/);
  assert.doesNotMatch(await text("codehash"), /the reproducible build/);
});

test("the real policy through the real nodes", { skip: !process.env.LIVE }, async (t) => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  // A plain local address for the page; everything else goes to the real network.
  await page.goto(base);
  await page.waitForFunction(() => document.body.dataset.state === "done", null, { timeout: 90000 });
  await noLoading(page);
  assert.equal(await page.locator("#keys").innerText(), "0");
  assert.match(await page.locator("#build").innerText(), /v20/);
  assert.match(await page.locator("#codehash").innerText(), /the reproducible build of 29fa5c/);
  assert.match(await page.locator("#source").innerText(), /29fa5c/);
  assert.match(await page.locator("#journal").innerText(), /confirmed/);
  // The tiles read from the chain; the list of calls is not asserted here: the indexer limits requests by address.
  assert.match(await page.locator("#g-signed").innerText(), /^\d+ of \d+$/);
  assert.match(await page.locator("#g-gas").innerText(), /NEAR/);
  assert.match(await page.locator("#g-open").innerText(), /^none$|nonce \d+/);
  await page.locator("button[data-arg='1']").click();
  await page.waitForFunction(() => document.querySelector("#answer .ok, #answer .no, #answer .warn:not(.muted)"), null, { timeout: 60000 });
  await page.waitForFunction(() => /Allowed|Refused|says nothing/.test(document.getElementById("answer").innerText), null, { timeout: 60000 });
  assert.match(await page.locator("#answer").innerText(), /Allowed/);
  await page.locator("button[data-arg='999']").click();
  await page.waitForFunction(() => /Refused|says nothing/.test(document.getElementById("answer").innerText), null, { timeout: 60000 });
  assert.match(await page.locator("#answer").innerText(), /Refused by the policy: code not on the allow list/);
  assert.deepEqual(problems, []);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${NAME}-live.png`, fullPage: true });
});

// ---- Which policy, the activity feed, the glance tiles, the auto-refresh ----
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const H = (i) => B58[i % 58].repeat(22) + B58[Math.floor(i / 58) % 58].repeat(22); // a well-formed transaction id
const NS = (msAgo) => String(BigInt(Date.now() - msAgo) * 1000000n);
// One row as the indexer lists it.
const frow = ({ signer = "agent.testnet", method = "request_deploy", ok = true, ago = 60000, hash, receiver = POLICY, actions } = {}) => ({
  actions: actions ?? [{ action: "FUNCTION_CALL", method }], block_timestamp: NS(ago), outcomes: { status: ok },
  receiver_account_id: receiver, signer_account_id: signer, transaction_hash: hash,
});
const notAPolicy = () => Object.fromEntries(Object.keys(views()).map((k) => [k, "refuse"]));
const feedText = (page) => page.locator("#activity").textContent();
const waitText = (page, id, re) => page.waitForFunction(([id, src]) => new RegExp(src).test(document.getElementById(id).innerText), [id, re.source], { timeout: 20000 });
const sleep = (page, ms = 400) => page.waitForTimeout(ms);

test("no address parameter: the demo policy, said to be a demo, and every view call goes to it", async (t) => {
  const { page, seen, text } = await open(t);
  assert.equal(await text("w-pill"), "demo policy");
  assert.equal(await text("w-account"), POLICY);
  assert.equal(await page.locator("#w-back").isVisible(), false);
  assert.equal(await page.locator("#param-banner").isVisible(), false);
  const calls = seen.queries.filter((q) => q.type === "call_function");
  assert.ok(calls.length > 5);
  assert.ok(calls.every((q) => q.account === POLICY), JSON.stringify(calls.filter((q) => q.account !== POLICY)));
  assert.ok(seen.queries.every((q) => q.account === POLICY || q.account === "agent.testnet"));
  assert.match(seen.indexer[0], /\/v3\/accounts\/policy13\.keyfree-lab\.testnet\/txns\?limit=100$/);
  assert.match(await page.locator("#ask-text").innerText(), /Counter\(1\) is on the allow list/);
});

test("?policy=other.testnet: every query names it, the footer follows, the Ask paragraph no longer claims the demo's allow list", async (t) => {
  const { page, seen, text } = await open(t, { query: "?policy=other.testnet" });
  assert.equal(await text("w-pill"), "chosen policy");
  assert.equal(await text("w-account"), "other.testnet");
  assert.equal(await page.locator("#w-back").isVisible(), true);
  assert.equal(await page.locator("#w-back").getAttribute("href"), "/");
  assert.ok(seen.queries.filter((q) => q.type === "call_function").every((q) => q.account === "other.testnet"));
  assert.ok(seen.queries.every((q) => q.account === "other.testnet" || q.account === "agent.testnet"));
  assert.match(seen.indexer[0], /\/v3\/accounts\/other\.testnet\/txns\?limit=100$/);
  assert.equal(await page.locator("#foot-scan").getAttribute("href"), "https://testnet.nearblocks.io/address/other.testnet");
  assert.match(await page.locator("#account a").getAttribute("href"), /address\/other\.testnet$/);
  const ask = await page.locator("#ask-text").innerText();
  assert.doesNotMatch(ask, /is on the allow list/);
  assert.match(ask, /same two previews \(Counter\(1\) and Counter\(999\) on Base Sepolia\) are asked of this policy, and it answers by its own rules/);
  await page.locator("button[data-arg='1']").click();
  await page.waitForFunction(() => document.querySelector("#answer .ok"));
  assert.equal(seen.queries.find((q) => q.name === "preview").account, "other.testnet");
});

test("a bad ?policy= value: the demo is shown with a banner, and nothing the value says runs", async (t) => {
  const evil = "<img src=x onerror=window.__pwned=1>";
  for (const bad of ["POLICY13.keyfree-lab.testnet", "has space.testnet", evil, "policy13.near", "x.testnet.evil", ".testnet", `${"a".repeat(200)}.near`]) {
    const { page, problems, dialogs, text } = await open(t, { query: `?policy=${encodeURIComponent(bad)}` });
    assert.equal(await text("w-account"), POLICY, bad);
    assert.equal(await text("w-pill"), "demo policy");
    const banner = await text("param-banner");
    assert.match(banner, /is not a NEAR testnet account/);
    assert.match(banner, /demo policy is shown instead/);
    assert.ok(banner.includes(bad.slice(0, 80)), banner);
    assert.ok(bad.length <= 80 || !banner.includes(bad.slice(0, 81)), "the value was not cut to 80 characters");
    assert.equal(await page.locator("main img, main script").count(), 0);
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    assert.deepEqual(dialogs, []);
    assert.deepEqual(problems, []);
  }
});

test("an account that does not exist is said so after one answer; one that is not a policy is told apart from it", async (t) => {
  const none = await open(t, { query: "?policy=nobody.testnet", more: { missing: ["nobody.testnet"] } });
  assert.match(await none.text("banner"), /No such account on NEAR testnet: nobody\.testnet/);
  assert.equal(new Set(none.seen.queries.map((q) => q.host)).size, 1, "a definite answer was asked of more than one node");
  assert.match(await none.text("activity"), /Nothing to list: there is no such account\./);
  // Two chains are asked about their nonce and budget; any other question is asked once, not once per node.
  const tally = {};
  for (const q of none.seen.queries) tally[`${q.type}/${q.name}`] = (tally[`${q.type}/${q.name}`] ?? 0) + 1;
  for (const [k, n] of Object.entries(tally)) assert.ok(n <= (/get_next_nonce|get_budget/.test(k) ? 2 : 1), `${k} was asked ${n} times`);
  await noLoading(none.page);

  // Such an account has transactions of its own; they are not shown as a policy's record, and nothing is counted from them.
  const plain = await open(t, { query: "?policy=plain.testnet", over: notAPolicy(), more: { feed: [frow({ receiver: "plain.testnet", ok: false, hash: H(1) })] } });
  assert.match(await plain.text("activity"), /Not listed: this account does not answer as a Keyfree policy\./);
  assert.doesNotMatch(await plain.text("activity"), /REFUSED/);
  assert.match(await plain.text("g-refused"), /unknown/);
  assert.equal(await plain.page.locator("#feed-controls").isVisible(), false);
  assert.match(await plain.text("banner"), /plain\.testnet does not answer as a Keyfree policy\./);
  assert.doesNotMatch(await plain.text("banner"), /No such account/);
  assert.doesNotMatch(await plain.text("chains"), /none set/);
  assert.match(await plain.text("g-signed"), /unknown/);
  assert.doesNotMatch(await plain.text("pending"), /Nothing is waiting/);

  const down = await open(t, { faults: { "*near": "down" } });
  assert.match(await down.text("banner"), /none of the public NEAR nodes answered/i);
});

test("the Watch box goes to a valid testnet account on the button and on Enter, and stays put for anything else", async (t) => {
  const { page, text } = await open(t);
  await page.fill("#w-input", "mine.testnet");
  await page.locator("#w-go").click();
  await page.waitForURL(/\?policy=mine\.testnet$/);
  await page.waitForFunction(() => document.body.dataset.state === "done");
  assert.equal(await text("w-account"), "mine.testnet");
  assert.equal(await text("w-pill"), "chosen policy");
  await page.fill("#w-input", "other.testnet");
  await page.press("#w-input", "Enter");
  await page.waitForURL(/\?policy=other\.testnet$/);
  await page.waitForFunction(() => document.body.dataset.state === "done");
  const at = page.url();
  for (const bad of ["Mine.testnet", "mine.near", "<b>x</b>.testnet", "", "a b.testnet", "x.testnet/../y"]) {
    await page.fill("#w-input", bad);
    await page.locator("#w-go").click();
    await sleep(page, 150);
    assert.equal(page.url(), at, bad);
    assert.match(await text("w-msg"), /not a NEAR testnet account/, bad);
  }
});

test("the feed: sender by role, plain words, the refusal's reason from the chain, the policy's own lines, a signed link only for a known chain", async (t) => {
  const h = { dep: H(1), bad: H(2), prop: H(3), odd: H(4), tr: H(5), self: H(6), lost: H(7), pause: H(9) };
  const rows = [
    frow({ hash: h.dep }), frow({ hash: h.bad, ok: false }), frow({ signer: "owner.testnet", method: "propose_rule", hash: h.prop }),
    frow({ signer: "stranger.testnet", method: "weird_method", hash: h.odd }), frow({ signer: "funder.testnet", actions: [{ action: "TRANSFER" }], hash: h.tr }),
    frow({ signer: POLICY, method: "sweep", hash: h.self }), frow({ ok: false, hash: h.lost }),
    frow({ signer: "guard.testnet", method: "pause", hash: h.pause }),
    frow({ receiver: "other.testnet", method: "revoke_agent", hash: H(8) }),
  ];
  const more = { feed: rows, tx: {
    // The archival nodes have no such transaction (UNKNOWN_TRANSACTION): the ask goes on to the next node.
    [h.bad]: (host) => (host.startsWith("archival") ? undefined : txFail("chain not allowed")),
    [h.prop]: () => txOk([`keyfree: signed chain 84532 nonce 7 tx 0x${"ab".repeat(32)}`, `keyfree: signed chain 999 nonce 1 tx 0x${"cd".repeat(32)}`, "other: not the policy's", "keyfree: proposal 3 recorded"]),
    [h.lost]: () => undefined,
  } };
  const { page, seen, text, problems } = await open(t, { more });
  await waitText(page, "activity", /chain not allowed/);
  await waitText(page, "activity", /reason not read \(no node answered\)/);
  const all = await text("activity");
  assert.match(all, /ACCEPTED/);
  assert.match(all, /REFUSED\s+asked to deploy a contract\s+request_deploy\s+— chain not allowed/);
  assert.match(all, /agent\s+agent\.testnet/);
  assert.match(all, /owner\s+owner\.testnet/);
  assert.match(all, /guardian\s+guard\.testnet/);
  assert.match(all, /someone else\s+stranger\.testnet/);
  assert.equal(await page.locator(`#activity [title="${POLICY}"]`).count(), 1);
  assert.match(all, /the policy itself/);
  assert.match(all, /proposed a rule change/);
  assert.match(all, /paused the policy/);
  assert.match(all, /cleaned old journal lines/);
  assert.match(all, /weird_method/);
  assert.doesNotMatch(all, /asked to weird|revoked the agent/);
  assert.match(all, /sent NEAR to the policy/);
  assert.match(all, /just now|1 min ago/);
  // The reason: the next node was asked after the archival ones had no such transaction.
  const hosts = seen.tx.filter((x) => x.hash === h.bad).map((x) => x.host);
  assert.ok(hosts.includes("archival-rpc.testnet.fastnear.com") && hosts.includes("archival-rpc.testnet.near.org") && hosts.includes("test.rpc.fastnear.com"), hosts.join());
  // The policy's own lines, as text; the signed link for the chain this page knows.
  const raw = await feedText(page);
  assert.match(raw, /What the policy wrote/);
  assert.match(raw, /keyfree: proposal 3 recorded/);
  assert.doesNotMatch(raw, /other: not the policy's/);
  assert.match(all, /Signed: nonce 7 on Base Sepolia/);
  assert.equal(await page.locator("#activity a[href*='basescan']").getAttribute("href"), `https://sepolia.basescan.org/tx/0x${"ab".repeat(32)}`);
  assert.equal(await page.locator("#activity a[href*='cdcdcd']").count(), 0);
  assert.equal((all.match(/Signed:/g) ?? []).length, 1);
  assert.equal(await page.locator(`#activity a[href="https://testnet.nearblocks.io/txns/${h.dep}"]`).count(), 1);
  assert.match(await text("activity-panel"), /Accepted means the call ran\. Whether a signature came out is in its details and in the Journal\./);
  assert.deepEqual(problems, []);
});

test("the feed with hostile data: markup is text, bad rows are dropped or unnamed, a malformed id gets no link", async (t) => {
  const evil = "<img src=x onerror=window.__pwned=1>";
  const rows = [
    frow({ hash: H(1) }), frow({ signer: evil, hash: H(2) }), frow({ method: "<b>x</b>", hash: H(3) }), frow({ method: "constructor", hash: H(4) }),
    frow({ method: "__proto__", hash: H(5) }), frow({ method: "a".repeat(20000), hash: H(6) }),
    { ...frow({ hash: H(7) }), block_timestamp: "12abc" },
    frow({ hash: `"><script>window.__pwned=1</script>` }), frow({ hash: `javascript:alert(1)${"A".repeat(30)}` }), frow({ hash: `http://evil.example/${"A".repeat(30)}` }),
    frow({ hash: H(8), ok: false }), null, "x", 5, { actions: 7, outcomes: 3 }, { signer_account_id: { a: 1 }, receiver_account_id: POLICY },
    frow({ actions: [{ action: evil }], hash: H(10) }),
  ];
  const more = { feed: rows, tx: {
    [H(1)]: () => txOk([`keyfree: ${evil}`, "keyfree: signed chain 84532 nonce 1 tx 0xZZ<script>window.__pwned=1</script>", `keyfree: ${"x".repeat(1000)}`]),
    [H(8)]: () => txFail(`${evil} "><script>window.__pwned=1</script>`),
  } };
  const { page, problems, dialogs } = await open(t, { more });
  await waitText(page, "activity", /Smart contract panicked|<img src=x onerror=window/);
  await sleep(page);
  assert.equal(await page.locator("main img, main script").count(), 0);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  const raw = await feedText(page);
  assert.ok(raw.includes(`keyfree: ${evil}`), "the log line is shown as text");
  assert.ok(!raw.includes("x".repeat(301)), "a log line was not cut");
  assert.match(raw, /constructor/);
  assert.match(raw, /__proto__/);
  assert.match(raw, /method name could not be read/);
  assert.match(raw, /time unknown/);
  assert.match(raw, /2 could not be understood and are left out/);
  const hrefs = await page.locator("#activity a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  assert.ok(hrefs.length >= 5);
  assert.ok(hrefs.every((x) => /^https:\/\/testnet\.nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(x)), hrefs.join("\n"));
  assert.equal(await page.locator("#activity a[href*='sepolia']").count(), 0, "a signed link was made from a malformed hash");
  assert.deepEqual(dialogs, []);
  assert.deepEqual(problems, []);
});

for (const mode of ["down", 500, 429, "html", "shape"]) {
  test(`indexer ${mode}: the feed and its tile say unknown, the rest of the page stands, a later good answer replaces it`, async (t) => {
    const { page, more, seen, text, problems } = await open(t, { clock: true, more: { feed: mode } });
    assert.equal(await page.evaluate(() => document.body.dataset.state), "done");
    assert.match(await text("g-refused"), /unknown/);
    assert.match(await text("activity"), /unknown/);
    assert.match(await text("activity"), /does not depend on it/);
    assert.equal(await text("keys"), "0");
    assert.match(await text("build"), /v20/);
    await noLoading(page);
    // An indexer that is not heard is never a count of zero.
    assert.doesNotMatch(await text("activity"), /No transactions seen yet/);
    more.feed = [frow({ hash: H(1) }), frow({ hash: H(2), ok: false })];
    await page.clock.fastForward(60000);
    await waitText(page, "activity", /asked to deploy a contract/);
    assert.equal((await text("g-refused")).trim().split("\n")[0], "1");
    assert.doesNotMatch(await text("activity"), /unknown|as of/);
    // Then it fails again: the last good answer stays, said to be old.
    more.feed = mode;
    await page.clock.fastForward(60000);
    await waitText(page, "activity", /as of \d\d:\d\d UTC; the indexer did not answer just now/);
    assert.match(await text("activity"), /asked to deploy a contract/);
    assert.match(await text("g-refused"), /^1\b/);
    assert.match(await text("g-refused-note"), /as of \d\d:\d\d UTC/);
    assert.ok(seen.indexer.length >= 3);
    assert.deepEqual(problems, []);
  });
}

test("the indexer is asked once per page view within a minute: a reload and a click on Read again use the kept answer", async (t) => {
  const { page, seen, text } = await open(t, { more: { feed: [frow({ hash: H(1) })] } });
  assert.equal(seen.indexer.length, 1);
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.state === "done" && document.body.dataset.feed === "done");
  assert.match(await text("activity"), /asked to deploy a contract/);
  assert.equal(seen.indexer.length, 1, "a reload asked the indexer again");
  await page.locator("#reload").click();
  await page.waitForFunction(() => document.body.dataset.state === "done");
  assert.equal(seen.indexer.length, 1);
});

test("the 30 s clock re-reads the chain every time but asks the indexer only once a minute", async (t) => {
  const { page, seen } = await open(t, { clock: true, more: { feed: [frow({ hash: H(1) })] } });
  let n = await reads(page);
  await page.clock.fastForward(30000);
  await readsAbove(page, n);
  assert.equal(seen.indexer.length, 1);
  n = await reads(page);
  await page.clock.fastForward(30000);
  await readsAbove(page, n);
  for (let i = 0; i < 50 && seen.indexer.length < 2; i++) await sleep(page, 100);
  assert.equal(seen.indexer.length, 2);
});

test("feed filters and Show more: twelve rows, twelve more, and a filter sorts by who sent it", async (t) => {
  const who = (i) => (i % 5 === 0 ? "owner.testnet" : i % 5 === 1 ? "guard.testnet" : i % 5 === 2 ? "stranger.testnet" : "agent.testnet");
  const rows = Array.from({ length: 30 }, (_, i) => frow({ signer: who(i), ok: i % 4 !== 0, ago: 60000 * (i + 1), hash: H(i + 1) }));
  const { page } = await open(t, { more: { feed: rows } });
  const count = () => page.locator("#activity li.ev").count();
  assert.equal(await count(), 12);
  assert.equal(await page.locator("#feed-more").isVisible(), true);
  await page.locator("#feed-more").click();
  assert.equal(await count(), 24);
  await page.locator("#feed-more").click();
  assert.equal(await count(), 30);
  assert.equal(await page.locator("#feed-more").isVisible(), false);
  const pressed = () => page.locator("#feed-controls button").evaluateAll((bs) => bs.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.f));
  assert.deepEqual(await pressed(), ["all"]);
  const only = async (f, want, role) => {
    await page.locator(`#feed-controls [data-f="${f}"]`).click();
    assert.deepEqual(await pressed(), [f]);
    assert.equal(await count(), want, f);
    if (role) assert.ok((await page.locator("#activity li.ev").allInnerTexts()).every((x) => role.test(x)), f);
  };
  await only("agent", 12, /agent\s+agent\.testnet/);
  await only("council", 12, /(owner|guardian)\s/);
  await only("refused", 8, /REFUSED/);
  await only("all", 12);
  // Roles that could not be read: the sender filters say so instead of showing nothing as if nothing matched.
  const lost = await open(t, { over: { get_roles: "fail" }, more: { feed: rows } });
  await lost.page.locator('#feed-controls [data-f="agent"]').click();
  assert.match(await lost.text("activity"), /unknown/);
  assert.match(await lost.text("activity"), /roles could not be read/);
  assert.doesNotMatch(await lost.text("activity"), /owner|someone else/);
});

test("glance: signed today, refused in 24 h, gas, changes waiting and the request in flight", async (t) => {
  const { page, text } = await open(t, { more: { feed: [frow({ ok: false, hash: H(1) }), frow({ ok: false, ago: 3600000, hash: H(2), signer: "owner.testnet" }), frow({ ok: false, ago: 30 * 3600000, hash: H(3) }), frow({ hash: H(4) })] } });
  assert.match(await text("glance"), /At a glance/);
  assert.equal(await text("g-signed"), "6 of 20");
  assert.equal(await text("g-signed-note"), "UTC day");
  assert.equal((await text("g-refused")).trim(), "2");
  assert.match(await page.locator("#g-refused span").getAttribute("style"), /--no/);
  assert.equal(await text("g-gas"), "5 NEAR");
  assert.equal(await page.locator("#g-gas .pill").count(), 0);
  assert.equal(await text("g-waiting"), "0");
  assert.equal(await text("g-open"), "none");
  const w = await open(t, { over: threeItems() });
  assert.equal(await w.text("g-waiting"), "3");
  assert.equal(await w.page.locator("#g-waiting a").getAttribute("href"), "#pending-panel");
  assert.equal(await w.page.locator("#pending-panel").count(), 1);
});

test("glance: the refused count says 'at least' when the answer does not reach back 24 h, and is unknown without an answer", async (t) => {
  const recent = [frow({ ok: false, hash: H(1) }), frow({ ok: false, ago: 7200000, hash: H(2) })];
  const more = await open(t, { more: { feed: { data: recent, meta: { next_page: "abc123" } } } });
  assert.match(await more.text("g-refused"), /at least 2/);
  assert.match(await more.text("activity"), /Read the latest 2 transactions on the policy; there are older ones/);
  const reaches = await open(t, { more: { feed: { data: [...recent, frow({ ok: false, ago: 30 * 3600000, hash: H(3) })], meta: { next_page: "abc123" } } } });
  assert.equal((await reaches.text("g-refused")).trim().split("\n")[0], "2");
  assert.doesNotMatch(await reaches.text("g-refused"), /at least/);
  const none = await open(t, { more: { feed: "down" } });
  assert.match(await none.text("g-refused"), /unknown/);
  const empty = await open(t, { more: { feed: [] } });
  assert.match(await empty.text("activity"), /No transactions seen yet\./);
  assert.equal((await empty.text("g-refused")).trim().split("\n")[0], "0");
});

test("glance: the agent's gas is exact above 2^53, 'low' under 0.1 NEAR, none without an agent, unknown unless read", async (t) => {
  const big = await open(t, { more: { amounts: { "agent.testnet": "12345678901234567890123456789" } } });
  assert.match(await big.text("g-gas"), /^12345\.6789 NEAR$/);
  assert.match(await big.page.locator("#g-gas [title]").getAttribute("title"), /^12345678901234567890123456789 yoctoNEAR$/);
  const exact = await open(t, { more: { amounts: { "agent.testnet": "1180000000000000000000000" } } });
  assert.equal(await exact.text("g-gas"), "1.18 NEAR");
  const low = await open(t, { more: { amounts: { "agent.testnet": "50000000000000000000000" } } });
  assert.match(await low.text("g-gas"), /^0\.05 NEAR\s+low$/);
  assert.match(await low.page.locator("#g-gas .pill").getAttribute("class"), /warn/);
  const edge = await open(t, { more: { amounts: { "agent.testnet": "100000000000000000000000" } } });
  assert.equal(await edge.page.locator("#g-gas .pill").count(), 0);
  const gone = await open(t, { over: { get_roles: rolesWith([]).replace('"agent.testnet"', '""') } });
  assert.equal(await gone.text("g-gas"), "no agent");
  const unread = await open(t, { over: { get_roles: "fail" } });
  assert.match(await unread.text("g-gas"), /unknown/);
  const nobody = await open(t, { more: { missing: ["agent.testnet"] } });
  assert.match(await nobody.text("g-gas"), /agent account not found/);
});

test("glance: the request in flight has three states and is unknown when it was not read", async (t) => {
  const cases = [
    [`{"pending":5,"stuck":null,"chain_id":84532}`, /^nonce 5 is being signed$/, 0],
    [`{"pending":null,"stuck":4,"chain_id":84532}`, /^nonce 4 did not finish$/, 1],
    [`{"pending":null,"stuck":null,"chain_id":null}`, /^none$/, 0],
    ["fail", /unknown/, 1], [`{"pending":"x","stuck":null}`, /unknown/, 1], [`7`, /unknown/, 1],
  ];
  for (const [answer, re, pills] of cases) {
    const o = await open(t, { over: { get_open: answer } });
    assert.match(await o.text("g-open"), re, answer);
    assert.equal(await o.page.locator("#g-open .pill").count(), pills, answer);
    if (/stuck":4/.test(answer)) assert.match(await o.text("g-open-note"), /the agent retries it: keyfree retry/);
  }
  const none = await open(t, { over: notAPolicy() });
  assert.match(await none.text("g-open"), /unknown/);
});

test("glance: signed today is unknown when a budget or the rules were not read, and says nothing can be signed with no budget", async (t) => {
  const no = await open(t, { over: { get_budget: "null" } });
  assert.equal(await no.text("g-signed"), "0 of 0");
  assert.match(await no.text("g-signed-note"), /no budget set: nothing can be signed/);
  const failed = await open(t, { over: { get_budget: "fail" } });
  assert.match(await failed.text("g-signed"), /unknown/);
  const rules = await open(t, { over: { get_rules: "fail" } });
  assert.match(await rules.text("g-signed"), /unknown/);
  assert.match(await rules.text("g-waiting"), /unknown/);
  const bad = await open(t, { over: { get_budget: `{"max_wei_per_day":"abc"}` } });
  assert.match(await bad.text("g-signed"), /unknown/);
  const big = await open(t, { over: { get_budget: `{"max_wei_per_day":5,"max_tx_per_day":12345678901234567890,"used_wei_today":1,"used_tx_today":9007199254740993}` } });
  assert.equal(await big.text("g-signed"), "18014398509481986 of 24691357802469135780");
});

test("a chain in the budgets that this page has no node for is listed, named by its id, and its journal has no explorer link", async (t) => {
  const budgets = [{ chain_id: 84532, max_wei_per_day: 5, max_tx_per_day: 2 }, { chain_id: 777, max_wei_per_day: "5", max_tx_per_day: 2 }, { chain_id: 1.5 }, { chain_id: "x" }, { chain_id: 777 }, null, { chain_id: -1 }, { chain_id: 9007199254740993 }];
  const { page, text, problems } = await open(t, { over: { get_rules: JSON.stringify({ ...JSON.parse(rulesWith([])), budgets }) } });
  const chains = await text("chains");
  assert.equal((chains.match(/chain 777/g) ?? []).length, 1);
  assert.equal((chains.match(/no public node for this chain on this page/g) ?? []).length, 1);
  assert.equal(await page.locator("#chains tr").count(), 3);
  assert.match(await text("g-signed"), /^9 of 30$/);
  const journal = await page.evaluate(() => [...document.querySelectorAll("#journal tr")].filter((r) => r.cells[0].textContent === "chain 777").map((r) => r.querySelectorAll("a").length));
  assert.ok(journal.length > 0 && journal.every((n) => n === 0), JSON.stringify(journal));
  assert.match(await text("journal"), /0x(cdcd|abab)/);
  assert.deepEqual(problems, []);
});

test("auto-refresh: after 30 s the policy is read again without the page saying it is reading", async (t) => {
  const { page, seen } = await open(t, { clock: true });
  await page.evaluate(() => {
    window.__states = []; window.__disabled = [];
    new MutationObserver((ms) => ms.forEach(() => window.__states.push(document.body.dataset.state))).observe(document.body, { attributes: true, attributeFilter: ["data-state"] });
    new MutationObserver(() => window.__disabled.push(document.getElementById("reload").disabled)).observe(document.getElementById("reload"), { attributes: true });
  });
  assert.ok((await page.locator("#auto").isChecked()), "the box is on by default");
  const n = await reads(page);
  const before = seen.calls.filter((c) => c === "get_status").length;
  const when = await page.locator("#when").innerText();
  await page.clock.fastForward(30000);
  await readsAbove(page, n);
  assert.equal(seen.calls.filter((c) => c === "get_status").length, before + 1);
  assert.equal(await reads(page), n + 1);
  assert.ok(!(await page.evaluate(() => window.__states)).includes("reading"), "a background read flipped the state to reading");
  assert.ok(!(await page.evaluate(() => window.__disabled)).includes(true), "the Read again button was disabled");
  assert.notEqual(await page.locator("#when").innerText(), when);
});

test("auto-refresh: the box turns it off, and is remembered", async (t) => {
  const { page, seen } = await open(t, { clock: true });
  await page.locator("#auto").uncheck();
  const n = await reads(page);
  for (let i = 0; i < 3; i++) { await page.clock.fastForward(30000); await sleep(page); }
  assert.equal(await reads(page), n);
  assert.equal(seen.calls.filter((c) => c === "get_status").length, 1);
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.state === "done");
  assert.equal(await page.locator("#auto").isChecked(), false);
  await page.locator("#auto").check();
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.state === "done");
  assert.equal(await page.locator("#auto").isChecked(), true);
});

test("auto-refresh: a hidden tab does not read, and reads at once when it comes back after more than 30 s", async (t) => {
  const { page } = await open(t, { clock: true });
  const setVisible = (v) => page.evaluate((v) => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v }); document.dispatchEvent(new Event("visibilitychange")); }, v);
  const n = await reads(page);
  await setVisible("hidden");
  await page.clock.fastForward(40000);
  await sleep(page, 600);
  assert.equal(await reads(page), n);
  await setVisible("visible");
  await readsAbove(page, n);
});

test("auto-refresh with nothing changed: an open <details>, a selected command and the preview answer stay", async (t) => {
  const { page, text } = await open(t, { clock: true, over: threeItems() });
  await page.locator("#pending details summary").first().click();
  await page.locator("button[data-arg='1']").click();
  await waitText(page, "answer", /Allowed/);
  const cmd = await page.locator("#pending .cmd code").first().innerText();
  await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector("#pending .cmd code")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  const n = await reads(page);
  await page.clock.fastForward(30000);
  await readsAbove(page, n);
  assert.equal(await page.locator("#pending details").first().evaluate((d) => d.open), true);
  assert.equal(await page.evaluate(() => getSelection().toString()), cmd);
  assert.match(await text("answer"), /Allowed/);
  assert.match(await text("pending"), /3 changes are waiting/);
});

test("auto-refresh with new data: a pending proposal and a new feed row appear by themselves, the row marked new until the next answer", async (t) => {
  const a = frow({ hash: H(1) }), b = frow({ hash: H(2), method: "retry" });
  const { page, over, more, seen, text } = await open(t, { clock: true, more: { feed: [a] } });
  assert.match(await text("pending"), /Nothing is waiting/);
  assert.equal(await page.locator("#activity .info").count(), 0, "the first answer's rows are not new");
  over.get_rules = rulesWith([{ id: 3, change: { EnableChain: { chain_id: 1 } }, ready_at: nowSec() + 999 }]);
  await page.clock.fastForward(30000);
  await waitText(page, "pending", /1 change is waiting/);
  assert.equal(await text("g-waiting"), "1");
  assert.equal(seen.indexer.length, 1, "30 s is not a minute");
  more.feed = [b, a];
  await page.clock.fastForward(30000);
  await waitText(page, "activity", /retried an unfinished request/);
  const fresh = page.locator("#activity li.ev", { hasText: "retried an unfinished request" });
  assert.match(await fresh.innerText(), /\bnew\b/);
  assert.equal(await page.locator("#activity .info").count(), 1);
  await page.clock.fastForward(60000);
  await page.waitForFunction(() => !document.querySelector("#activity .info"));
  assert.equal(seen.indexer.length, 3);
});

for (const colorScheme of ["light", "dark"]) {
  test(`phone 375, ${colorScheme}: the new panels, long names and an open log do not scroll the page sideways`, async (t) => {
    const long = `${"x".repeat(50)}.testnet`;
    const rows = [frow({ signer: long, method: "a_very_long_method_name_that_nobody_wrote_in_the_contract", hash: H(1) }), frow({ ok: false, hash: H(2) }), frow({ signer: "owner.testnet", method: "propose_rule", hash: H(3) }), frow({ signer: long, actions: [{ action: "ADD_KEY" }], hash: H(4) })];
    const more = { feed: rows, amounts: { "agent.testnet": "50000000000000000000000" }, tx: {
      [H(2)]: () => txFail("x".repeat(200)), [H(3)]: () => txOk([`keyfree: signed chain 84532 nonce 7 tx 0x${"ab".repeat(32)}`, `keyfree: ${"y".repeat(280)}`]),
    } };
    const budgets = [{ chain_id: 777, max_wei_per_day: "5", max_tx_per_day: 2 }];
    const { page } = await open(t, { viewport: { width: 375, height: 812 }, colorScheme, more, over: { ...threeItems(), get_rules: JSON.stringify({ ...JSON.parse(threeItems().get_rules), budgets }), get_open: `{"pending":null,"stuck":12,"chain_id":84532}` } });
    await waitText(page, "activity", /What the policy wrote/);
    await page.evaluate(() => document.querySelectorAll("#activity details").forEach((d) => { d.open = true; }));
    await sleep(page, 200);
    const m = await page.evaluate(() => {
      const inside = [...document.querySelectorAll(".panel *, .watching *")].filter((el) => el.getClientRects().length && el.getBoundingClientRect().width > 0);
      const box = (el) => el.closest(".panel, .watching").getBoundingClientRect().right;
      return {
        doc: document.documentElement.scrollWidth, win: innerWidth,
        cut: inside.filter((el) => el.getBoundingClientRect().right > box(el) + 1).map((el) => `${el.tagName} ${el.textContent.slice(0, 40)}`).slice(0, 5),
        tiles: document.querySelectorAll(".tile").length,
      };
    });
    assert.ok(m.doc <= m.win, `page ${m.doc} wider than ${m.win}`);
    assert.deepEqual(m.cut, []);
    assert.equal(m.tiles, 5);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${NAME}-feed-375-${colorScheme}.png`, fullPage: true });
  });
}
