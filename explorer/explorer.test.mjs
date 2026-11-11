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
  get_entry: `{"kind":"deploy","status":"confirmed","tx_hash":"0x${"ab".repeat(32)}","address":"0x${"cd".repeat(20)}","factory":"0x${"ef".repeat(20)}","code_hash":"aa","salt":"0x00"}`,
});

const nearHosts = ["test.rpc.fastnear.com", "near-testnet.drpc.org", "rpc.testnet.near.org"];
const baseHosts = ["sepolia.base.org", "base-sepolia-rpc.publicnode.com"];
const ethHosts = ["ethereum-sepolia-rpc.publicnode.com", "ethereum-sepolia.gateway.tatum.io"];

// faults[host] or faults["*near"] / faults["*evm"]: "down" | a status | "html" | "hang" | a function(body) => JSON text.
function stubs(faults = {}, over = {}, previewAnswer) {
  const seen = { hosts: new Set(), calls: [] };
  const table = { ...views(), ...over };
  return { seen, handler: async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === new URL(base).origin) return route.continue();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const host = url.hostname;
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
    const p = body.params;
    if (p.request_type === "view_access_key_list") return answer(`{"jsonrpc":"2.0","id":1,"result":{"keys":${over.keys ?? "[]"},"block_hash":"x","block_height":1}}`);
    if (p.request_type === "view_account") return answer(`{"jsonrpc":"2.0","id":1,"result":{"amount":"1","code_hash":"${over.code_hash ?? "8jdpF6XEkVQ3Hun6pJrGzSEmPeGQk6JyZBuk2eRDtp6P"}","block_hash":"x","block_height":1}}`);
    const name = p.method_name;
    if (name === "preview") {
      const a = previewAnswer ?? ((args) => (args.init_code_hex.endsWith("1")
        ? `{"unsigned":"0x02","hash":"${"12".repeat(32)}","nonce":2,"expected_address":"0x${"77".repeat(20)}","min_gas":60000}`
        : { panic: "code not on the allow list" }));
      const out = a(JSON.parse(atob(p.args_base64)));
      if (out?.panic) return answer(`{"jsonrpc":"2.0","id":1,"result":{"error":"wasm execution failed with error: HostError(GuestPanic { panic_msg: \\"${out.panic}\\" })","logs":[],"block_hash":"x","block_height":1}}`);
      return answer(`{"jsonrpc":"2.0","id":1,"result":{"result":[${[...Buffer.from(out)].join(",")}],"logs":[],"block_hash":"x","block_height":1}}`);
    }
    const text = table[name];
    if (text === undefined || text === "fail") return answer(`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Server error","name":"HANDLER_ERROR","cause":{"name":"TIMEOUT_ERROR"}}}`);
    return answer(`{"jsonrpc":"2.0","id":1,"result":{"result":[${[...Buffer.from(text)].join(",")}],"logs":[],"block_hash":"x","block_height":1}}`);
  } };
}

async function open(t, { faults, over, previewAnswer, viewport = { width: 1100, height: 800 }, colorScheme = "light", wait = true } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  const s = stubs(faults, over, previewAnswer);
  await page.route("**/*", s.handler);
  await page.goto(base);
  if (wait) await page.waitForFunction(() => document.body.dataset.state === "done", null, { timeout: 45000 });
  return { page, seen: s.seen, problems, text: (id) => page.locator(`#${id}`).innerText() };
}
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
