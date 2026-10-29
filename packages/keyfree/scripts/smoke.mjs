// Self-check: start the built MCP server over stdio and use it the way Claude Code would.
// Read-only by default (status, hash, journal, a refused preview, bad arguments).
// KEYFREE_SMOKE_DEPLOY=1 also deploys demo/Counter(1) for real (its code hash must be on the allow list).
// Env: KEYFREE_CONFIG (keyfree.json), KEYFREE_AGENT_KEY (agent key file). Run: npm run build && npm run smoke
import { strict as assert } from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const artifact = path.join(root, "demo", "out", "Counter.sol", "Counter.json");
const client = new Client({ name: "keyfree-smoke", version: "0.1.0" });
await client.connect(new StdioClientTransport({
  command: "node", args: [path.join(root, "dist", "mcp.js")],
  env: { ...getDefaultEnvironment(), KEYFREE_CONFIG: process.env.KEYFREE_CONFIG ?? path.join(root, "demo", "keyfree.json"), KEYFREE_AGENT_KEY: process.env.KEYFREE_AGENT_KEY ?? "" },
}));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join("\n");
  return { error: r.isError === true, text, data: r.isError ? null : JSON.parse(text) };
};
const say = (s) => console.error(s);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
assert.deepEqual(names, ["keyfree_code_hash", "keyfree_confirm", "keyfree_deploy", "keyfree_journal", "keyfree_preview", "keyfree_retry", "keyfree_status"]);
assert.ok(!names.some((n) => /rule|role|pause|upgrade|allow/.test(n)), "no owner tools for the agent");
say(`OK   ${names.length} agent tools, no owner tools`);

const st = await call("keyfree_status", {});
assert.ok(!st.error, st.text);
assert.equal(st.data.policy_keys, 0);
say(`OK   status: ${st.data.policy}, keys ${st.data.policy_keys}, address ${st.data.address}, version ${st.data.version}`);

const h = await call("keyfree_code_hash", { artifact, constructor_args: [1] });
assert.ok(!h.error, h.text);
say(`OK   code hash of Counter(1): ${h.data.code_hash}`);
const allowed = st.data.allowed_code.includes(h.data.code_hash);

const other = await call("keyfree_preview", { chain: "base-sepolia", artifact, constructor_args: [999] });
assert.ok(other.error && /Refused by the policy: code not on the allow list/.test(other.text) && /do not try another way around it/.test(other.text), other.text);
say("OK   preview of Counter(999) refused by the policy, with the do-not-work-around rule");

const bad = await call("keyfree_deploy", { chain: "base-sepolia", artifact, private_key: "0x1234" });
assert.ok(bad.error && /private_key|Unrecognized/.test(bad.text), bad.text);
say("OK   unknown argument (private_key) rejected before the handler");

const j = await call("keyfree_journal", { chain: 84532, limit: 3 });
assert.ok(!j.error, j.text);
say(`OK   journal: next nonce ${j.data.next_nonce}, newest ${j.data.lines.map((l) => `${l.nonce}:${l.status}`).join(", ")}`);

if (allowed) {
  const pv = await call("keyfree_preview", { chain: "base-sepolia", artifact, constructor_args: [1] });
  assert.ok(!pv.error, pv.text);
  say(`OK   preview Counter(1): nonce ${pv.data.nonce}, address ${pv.data.expected_address}, gas ${pv.data.gas_limit}, needs ${pv.data.reserve_wei} wei of ${pv.data.balance_wei}, == viem`);
  if (process.env.KEYFREE_SMOKE_DEPLOY === "1") {
    const d = await call("keyfree_deploy", { chain: "base-sepolia", artifact, constructor_args: [1] });
    assert.ok(!d.error, d.text);
    say(`OK   deployed Counter(1) at ${d.data.address}, nonce ${d.data.nonce}\n     ${d.data.links.near}\n     ${d.data.links.evm}`);
  }
} else {
  say(`--   Counter(1) is not allowed yet: keyfree rules allow-code ${h.data.code_hash} (owner), then apply after the delay`);
}
await client.close();
say("Smoke test passed");
