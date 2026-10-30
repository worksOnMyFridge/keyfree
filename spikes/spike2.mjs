// Spike S12, experiment 2: the policy contract builds and gets MPC-signed two real deploys on
// Base Sepolia from its keyless address: a plain CREATE and a CREATE2 through the deterministic
// proxy (address known before signing). We broadcast them and check address, code and a call.
import fs from "node:fs";
import { keccak256, toHex, getContractAddress, createPublicClient, http, baseSepolia, formatEther, recoverTransactionAddress } from "../tools/evm.mjs";
import { loadAccount, ACCOUNT, provider, explorer, view, KeyPair, teraToGas, Account } from "../tools/near.mjs";

const CONTRACT = `keyfree.${ACCOUNT}`, CHAIN = baseSepolia.id;
const INIT = "0x600a600c600039600a6000f3602a60005260206000f3", RUNTIME = "0x602a60005260206000f3";
const PROXY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const SALT = keccak256(toHex(process.env.KF_SALT || "keyfree-spike-1"));
const scan = (h) => `https://sepolia.basescan.org/tx/${h}`;
const owner = loadAccount();
const kp = KeyPair.fromString(JSON.parse(fs.readFileSync(new URL("../keyfree_contract_key.json", import.meta.url))).private_key);
const contract = new Account(CONTRACT, provider, kp.toString());
const base = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const ethAddr = await view(CONTRACT, "get_eth_address");
const log = [];
const say = (s) => { console.log(s); log.push(s); };

if (process.argv[2] !== "skip-deploy") {
  const o = await contract.deployContract(fs.readFileSync(new URL("../keyfree.opt.wasm", import.meta.url)));
  say(`code updated ${explorer(o.transaction.hash)}`);
}
const nonce = await base.getTransactionCount({ address: ethAddr });
await owner.callFunctionRaw({ contractId: CONTRACT, methodName: "allow_chain", args: { chain_id: CHAIN, next_nonce: nonce }, gas: teraToGas("30") });
say(`from ${ethAddr}: ${formatEther(await base.getBalance({ address: ethAddr }))} ETH, nonce ${nonce} (synced into the contract)`);

async function deploy(label, salt) {
  const fees = await base.estimateFeesPerGas();
  const args = { chain_id: CHAIN, init_code_hex: INIT, gas_limit: 150000, max_fee_per_gas: Number(fees.maxFeePerGas * 2n), max_priority_fee_per_gas: Number(fees.maxPriorityFeePerGas), salt_hex: salt };
  const pv = await view(CONTRACT, "preview", args);
  const t0 = Date.now();
  const out = await owner.callFunctionRaw({ contractId: CONTRACT, methodName: "request_deploy", args, gas: teraToGas("200") });
  const raw = JSON.parse(Buffer.from(out.status.SuccessValue, "base64").toString());
  const signedIn = ((Date.now() - t0) / 1000).toFixed(1);
  const from = await recoverTransactionAddress({ serializedTransaction: raw });
  const hash = await base.sendRawTransaction({ serializedTransaction: raw });
  const rc = await base.waitForTransactionReceipt({ hash, timeout: 120_000 });
  const expected = salt
    ? getContractAddress({ opcode: "CREATE2", from: PROXY, salt, bytecode: INIT })
    : getContractAddress({ from, nonce: BigInt(pv.nonce) });
  const code = await base.getCode({ address: expected });
  const answer = await base.call({ to: expected }).then((r) => BigInt(r.data)).catch((e) => `call failed: ${e.shortMessage}`);
  const res = {
    label, near_tx: explorer(out.transaction.hash), signed_in_s: Number(signedIn), base_tx: scan(hash), status: rc.status,
    from_is_keyless_address: from.toLowerCase() === ethAddr, nonce: pv.nonce,
    contract_promised_address: pv.create2_address, expected, receipt_address: rc.contractAddress ?? null,
    address_matches: salt ? pv.create2_address === expected.toLowerCase() : rc.contractAddress?.toLowerCase() === expected.toLowerCase(),
    code_is_runtime: code === RUNTIME, call_returns: String(answer), gas_used: Number(rc.gasUsed),
    cost_eth: formatEther(rc.gasUsed * rc.effectiveGasPrice),
  };
  say(JSON.stringify(res, null, 1));
  return res;
}

await deploy("plain CREATE", null);
await deploy("CREATE2 via proxy", SALT);
say(`contract nonce now ${await view(CONTRACT, "get_next_nonce", { chain_id: CHAIN })}, Base nonce ${await base.getTransactionCount({ address: ethAddr })}`);
fs.appendFileSync(new URL("../evidence/spike2.log", import.meta.url), `--- ${new Date().toISOString()}\n${log.join("\n")}\n`);
