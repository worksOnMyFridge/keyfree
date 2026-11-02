// Offline CLI tests: every malformed command stops before any network call or signature, with a plain
// message and exit code 1; exact integers survive reading. The config is the example; nothing reaches NEAR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseExact } from "../dist/near.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "dist", "cli.js");
const CONFIG = path.join(here, "..", "keyfree.example.json");
// No ~/.near-credentials: a check that slipped past the parser would stop at the missing key, not sign.
const HOME = os.tmpdir();

function run(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--config", CONFIG], {
    encoding: "utf8", env: { ...process.env, HOME, USERPROFILE: HOME }, timeout: 20000,
  });
  return { code: r.status, err: r.stderr };
}

const CASES = [
  [["preview", "--chain", "base-sepolia", "--artifact", "x.json", "--arg", "[1]"], /has no flag --arg/],
  [["preview", "--chain", "base-sepolia", "--artifact", "x.json", "--args"], /--args needs a value/],
  [["preview", "--artifact", "x.json"], /Missing <chain>/],
  [["preview", "--chain", "base-sepolia", "--artifact", "x.json", "--args", "[1"], /must be a JSON array/],
  [["preview", "--chain", "base-sepolia", "--artifact", "x.json", "--args", '{"a":1}'], /must be a JSON array/],
  [["deploy", "--chain", "base-sepolia", "--artifact", "x.json", "--salt", "0xzz"], /<salt> must be 0x and 64 hex/],
  [["journal"], /Missing <chain>/],
  [["journal", "--chain", "base-sepolia", "--limit", "abc"], /<limit> must be a whole number/],
  [["confirm", "--chain", "base-sepolia", "--nonce", "-1"], /<nonce> must be a whole number/],
  [["rules", "allow-code", "xyz"], /<hash> must be 64 hex/],
  [["rules", "allow-chain", "base-sepolia"], /Missing <nonce>/],
  [["rules", "set-budget", "base-sepolia", "1.5", "3"], /<wei_per_day> must be a whole number/],
  [["rules", "set-budget", "base-sepolia", "1", "4294967296"], /<tx_per_day> must be a whole number from 0 to 4294967295/],
  [["rules", "set-factory", "base-sepolia", "0x12"], /<address> must be 0x and 40 hex/],
  [["rules", "allow-upgrade", "base-sepolia", "0x" + "1".repeat(40)], /Missing <implementation>/],
  [["rules", "apply"], /Missing <id>/],
  [["rules", "frobnicate"], /Unknown rules command/],
  [["lower-limits", "10"], /Missing <fee_wei>/],
  [["remove-code"], /Missing <hash>/],
  [["disable-chain", "nowhere"], /Chain "nowhere" is not in keyfree.json/],
  [["cancel-role"], /Missing <proposer>/],
  [["pause", "--chain", "x"], /"pause" has no flag --chain/],
  [["bogus"], /Unknown command "bogus"/],
];

for (const [args, want] of CASES) {
  test(`cli: keyfree ${args.join(" ")} -> error before anything is signed`, () => {
    const r = run(...args);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, want);
    assert.doesNotMatch(r.err, /wasm execution|HostError|Smart contract panicked|fetch failed/);
  });
}

test("exact integers: values above 2^53 are read as decimal strings, strings and small numbers untouched", () => {
  const v = parseExact(String.raw`{"wei":12345678901234567891,"n":7,"s":"a 12345678901234567891 \" b","l":[9007199254740993]}`);
  assert.deepEqual(v, { wei: "12345678901234567891", n: 7, s: 'a 12345678901234567891 " b', l: ["9007199254740993"] });
});
