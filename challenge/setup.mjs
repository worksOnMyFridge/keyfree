// How the open challenge's policy was built. Kept for the record: it needs the owner's key, which is not published.
//   node challenge/setup.mjs install    create the agent and the policy, delete the policy's key, propose the rules
//   node challenge/setup.mjs apply      after the rules delay: apply them
// The policy runs the same code as the demo policy and allows one thing: creating Counter(1) on Base Sepolia.
// Its address holds no ETH on purpose. The agent's balance is the cap on what the published key can spend.
import fs from "node:fs";
import crypto from "node:crypto";
import { encodeDeployData, keccak256 } from "../tools/evm.mjs";
import { loadAccount, provider, explorer, KeyPair, teraToGas, parseNearAmount, actions, Account } from "../tools/near.mjs";

const OWNER = "keyfree-lab.testnet";
const POLICY = `challenge.${OWNER}`;
const AGENT = `challenge-agent.${OWNER}`;
const GUARDIAN = `guard13b.${OWNER}`;
const RESERVE = `reserve13.${OWNER}`;
const MPC = "v1.signer-prod.testnet";
const PATH = "keyfree-1";
const SHA256 = "72edd42bc4f18be81824ab7697ac74f885ede59d8c393325513b3cdb8f6db14c"; // the v20 reproducible build
const BASE_SEPOLIA = 84532;
const AGENT_METHODS = ["request_deploy", "request_proxy_upgrade", "resign", "resign_proxy_upgrade", "retry", "release", "confirm", "confirm_stuck"];

const here = (f) => new URL(`./${f}`, import.meta.url);
const stateFile = here("state.json"); // gitignored
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : { proposed: [] };
const keep = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
const owner = () => loadAccount(OWNER);
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
const view = async (method, args = {}) => {
  const r = await provider.callFunctionRaw({ contractId: POLICY, method, args, blockQuery: { finality: "optimistic" } });
  return JSON.parse(Buffer.from(r.result).toString());
};
const value = (out) => JSON.parse(Buffer.from(out.status.SuccessValue ?? "", "base64").toString() || "null");
const exact = (args) => new TextEncoder().encode(JSON.stringify(args, (_k, x) => (typeof x === "bigint" ? `__int__${x}` : x)).replace(/"__int__(\d+)"/g, "$1"));
const call = (methodName, args, gas = "30") => owner().callFunctionRaw({ contractId: POLICY, methodName, args: exact(args), gas: teraToGas(gas), deposit: 0n });

const counterInit = () => {
  const a = JSON.parse(fs.readFileSync(new URL("../packages/keyfree/demo/out/Counter.sol/Counter.json", import.meta.url)));
  return encodeDeployData({ abi: a.abi, bytecode: a.bytecode.object ?? a.bytecode, args: [1n] });
};

const stage = process.argv[2];
if (stage === "install") {
  const r = await provider.query({ request_type: "view_code", account_id: "policy13.keyfree-lab.testnet", finality: "final" });
  const code = Buffer.from(r.code_base64, "base64");
  if (crypto.createHash("sha256").update(code).digest("hex") !== SHA256) throw new Error("the code is not the v20 build");

  const agentKey = KeyPair.fromRandom("ed25519");
  await owner().signAndSendTransaction({ receiverId: AGENT, actions: [
    actions.createAccount(), actions.transfer(BigInt(parseNearAmount("1.2"))),
    actions.addFunctionCallAccessKey(agentKey.getPublicKey(), POLICY, AGENT_METHODS),
  ] });
  fs.writeFileSync(here("published-agent-key.json"), `${JSON.stringify({ account_id: AGENT, private_key: agentKey.toString() }, null, 2)}\n`);
  console.log(`agent ${AGENT} created, its only key is a function-call key`);

  const policyKey = KeyPair.fromRandom("ed25519");
  await owner().signAndSendTransaction({ receiverId: POLICY, actions: [
    actions.createAccount(), actions.transfer(BigInt(parseNearAmount("4.4"))), actions.addFullAccessKey(policyKey.getPublicKey()),
  ] });
  const out = await new Account(POLICY, provider, policyKey.toString()).signAndSendTransaction({ receiverId: POLICY, actions: [
    actions.deployContract(code),
    actions.functionCall("new", { owner: OWNER, agent: AGENT, guardian: GUARDIAN, reserve: RESERVE, mpc: MPC, path: PATH, upgrade_delay_sec: 86400, rules_delay_sec: 3600 }, teraToGas("30"), 0n),
    actions.deleteKey(policyKey.getPublicKey()),
  ] });
  console.log(`installed, key deleted in the same transaction ${explorer(out.transaction.hash)}`);
  state.install = out.transaction.hash;
  await wait(3);

  state.address = value(await call("setup", {}, "60"));
  console.log(`ETH address from the MPC: ${state.address}`);
  keep();

  for (const change of [
    { AllowChain: { chain_id: BASE_SEPOLIA, next_nonce: 0, min_fee_per_gas: 1000000n } },
    { SetBudget: { chain_id: BASE_SEPOLIA, max_wei_per_day: 500000000000000n, max_tx_per_day: 5 } },
    { SetLimits: { max_gas_limit: 1000000n, max_fee_cap: 50000000000n } },
    { AllowCode: { code_hash: keccak256(counterInit()).slice(2) } },
  ]) {
    const id = value(await call("propose_rule", { change }));
    state.proposed.push(id);
    console.log(`rule ${id} proposed: ${Object.keys(change)[0]}`);
    keep();
  }
} else if (stage === "apply") {
  for (const id of state.proposed) {
    const out = await call("apply_rule", { id });
    console.log(`rule ${id} applied ${explorer(out.transaction.hash)}`);
  }
  state.proposed = [];
  keep();
} else {
  console.log("usage: node challenge/setup.mjs install | apply");
}
