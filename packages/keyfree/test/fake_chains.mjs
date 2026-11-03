// Two local JSON-RPC servers that can fail on demand, for testing what the tool does when a network goes wrong.
// fakeEvm is an EVM node with a mempool and receipts. fakeNear is a NEAR node with a small model of the policy:
// it follows the contract's states (pending, stuck, signed lines) but not its rules, which sandbox/ tests on the
// real contract. A test key stands in for the MPC. Faults, per server:
//   faults.all = mode            every request
//   faults[method] = mode        one RPC method; for NEAR also a contract method ("view:get_rules", "call:retry")
//   mode: "down" (connection dropped) | 500 | 502 | 503 | 429 | "html" | "hang" | "lost" (done, the answer is dropped)
//         | a function (params) => value, whose return is the answer; it may throw to answer with an RPC error
import http from "node:http";
import { createHash } from "node:crypto";
import { baseEncode, decodeSignedTransaction, encodeTransaction } from "near-api-js";
import {
  concat, decodeFunctionData, encodeAbiParameters, encodeEventTopics, getContractAddress, keccak256, parseTransaction, recoverTransactionAddress,
  serializeTransaction, toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { FACTORY_ABI, PROXY_ABI, ADMIN_SLOT, IMPLEMENTATION_SLOT } from "../dist/evm.js";

const ZERO32 = `0x${"0".repeat(64)}`;
const ZERO20 = `0x${"0".repeat(40)}`;
export class RpcFail extends Error {}

function serve(onCall) {
  const sockets = new Set();
  const held = new Set();
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", async () => {
      const m = JSON.parse(body);
      const reply = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...o })); };
      const act = {
        fail: (mode) => {
          if (mode === "down" || mode === "lost") return req.socket.destroy();
          if (mode === "hang") return held.add(res);
          if (mode === "html") { res.setHeader("content-type", "text/html"); return res.end("<html>Bad gateway</html>"); }
          res.statusCode = mode;
          res.end("the node says no");
        },
        reply,
      };
      try {
        await onCall(m, act);
      } catch (e) {
        if (e instanceof RpcFail) reply({ error: e.rpc ?? { code: -32000, message: e.message } });
        else reply({ error: { code: -32603, message: String(e?.message ?? e) } });
      }
    });
  });
  srv.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`,
    close: () => new Promise((r) => { for (const h of held) h.destroy?.(); for (const s of sockets) s.destroy(); srv.close(() => r()); }),
  })));
}

export async function fakeEvm({ chainId = 84532, factory, proxy, signer }) {
  const st = {
    chainId, baseFee: 1_000_000n, prio: 1_000_000n, estimate: 120_000n, balance: 10n ** 18n, count: 0, height: 1000, safe: 1000,
    pool: new Map(), mined: new Map(), code: new Map([[factory, "0x60"]]), served: signer, sent: [], factory, proxy, admin: signer, impl: ZERO20,
    faults: {},
  };
  const mine = async (raw, tx) => {
    const hash = keccak256(raw);
    const logs = [];
    let contractAddress = null;
    const logAt = (address, abi, eventName, args, data) => logs.push({
      address, topics: encodeEventTopics({ abi, eventName, args }), data: data ?? "0x", logIndex: "0x0", transactionIndex: "0x0",
      transactionHash: hash, blockHash: ZERO32, blockNumber: toHex(st.height + 1), removed: false,
    });
    if (tx.to?.toLowerCase() === factory.toLowerCase()) {
      const { args: [salt, initCode] } = decodeFunctionData({ abi: FACTORY_ABI, data: tx.data });
      const addr = st.deployTo ?? getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecode: initCode });
      logAt(factory, FACTORY_ABI, "Deployed", { addr, codeHash: keccak256(initCode) }, encodeAbiParameters([{ type: "bytes32" }], [salt]));
    } else if (tx.to?.toLowerCase() === proxy?.toLowerCase()) {
      const { args: [implementation] } = decodeFunctionData({ abi: PROXY_ABI, data: tx.data });
      st.impl = implementation;
      logAt(proxy, PROXY_ABI, "Upgraded", { implementation });
    } else if (!tx.to) {
      contractAddress = getContractAddress({ from: signer, nonce: BigInt(tx.nonce) });
    }
    st.height += 1;
    st.count = tx.nonce + 1;
    st.mined.set(hash, {
      tx, raw,
      receipt: {
        transactionHash: hash, transactionIndex: "0x0", blockHash: ZERO32, blockNumber: toHex(st.height), from: signer, to: tx.to ?? null, contractAddress,
        cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: toHex(st.baseFee), logs, logsBloom: `0x${"0".repeat(512)}`,
        status: st.revert ? "0x0" : "0x1", type: "0x2",
      },
    });
    for (const [h, p] of st.pool) if (p.tx.nonce === tx.nonce) st.pool.delete(h);
  };
  const handlers = {
    eth_chainId: () => toHex(st.chainId),
    eth_blockNumber: () => toHex(st.height),
    eth_maxPriorityFeePerGas: () => toHex(st.prio),
    eth_getBalance: () => toHex(st.balance),
    eth_getCode: ([a]) => st.code.get(a.toLowerCase()) ?? st.code.get(a) ?? "0x",
    eth_getStorageAt: ([, slot]) => (slot === ADMIN_SLOT ? `0x${"0".repeat(24)}${st.admin.slice(2).toLowerCase()}` : slot === IMPLEMENTATION_SLOT ? `0x${"0".repeat(24)}${st.impl.slice(2).toLowerCase()}` : ZERO32),
    eth_call: () => encodeAbiParameters([{ type: "address" }], [st.served]),
    eth_estimateGas: () => {
      if (st.simulationFails) throw new RpcFail(`execution reverted: ${st.simulationFails}`);
      return toHex(st.estimate);
    },
    eth_getTransactionCount: ([, tag]) => {
      if (tag !== "pending") return toHex(st.count);
      let n = st.count;
      while ([...st.pool.values()].some((p) => p.tx.nonce === n)) n++;
      return toHex(n);
    },
    eth_getBlockByNumber: ([tag]) => {
      const n = tag === "safe" ? st.safe : st.height;
      return {
        number: toHex(n), hash: ZERO32, parentHash: ZERO32, nonce: "0x0000000000000000", sha3Uncles: ZERO32, logsBloom: `0x${"0".repeat(512)}`, transactionsRoot: ZERO32,
        stateRoot: ZERO32, receiptsRoot: ZERO32, miner: ZERO20, difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x0",
        timestamp: toHex(st.height), transactions: [], uncles: [], baseFeePerGas: toHex(st.baseFee), mixHash: ZERO32,
      };
    },
    eth_getTransactionReceipt: ([h]) => st.mined.get(h)?.receipt ?? null,
    eth_getTransactionByHash: ([h]) => {
      const m = st.mined.get(h) ?? st.pool.get(h);
      if (!m) return null;
      const { tx } = m;
      return {
        hash: h, type: "0x2", chainId: toHex(tx.chainId), nonce: toHex(tx.nonce), from: signer, to: tx.to ?? null, input: tx.data ?? "0x", value: "0x0", gas: toHex(tx.gas),
        maxFeePerGas: toHex(tx.maxFeePerGas), maxPriorityFeePerGas: toHex(tx.maxPriorityFeePerGas), r: tx.r, s: tx.s, v: "0x0", yParity: "0x0",
        blockHash: m.receipt?.blockHash ?? null, blockNumber: m.receipt?.blockNumber ?? null, transactionIndex: m.receipt ? "0x0" : null, accessList: [],
      };
    },
    eth_sendRawTransaction: async ([raw]) => {
      const tx = parseTransaction(raw);
      const hash = keccak256(raw);
      st.sent.push(hash);
      const from = (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase();
      if (from !== signer.toLowerCase()) throw new RpcFail("invalid sender");
      if (st.mined.has(hash) || st.pool.has(hash)) throw new RpcFail("already known");
      if (tx.nonce < st.count) throw new RpcFail("nonce too low");
      if (st.balance < tx.gas * tx.maxFeePerGas) throw new RpcFail("insufficient funds for gas * price + value");
      for (const p of st.pool.values()) {
        if (p.tx.nonce === tx.nonce && (tx.maxFeePerGas * 10n < p.tx.maxFeePerGas * 11n || tx.maxPriorityFeePerGas * 10n < p.tx.maxPriorityFeePerGas * 11n)) throw new RpcFail("replacement transaction underpriced");
      }
      for (const [h, p] of st.pool) if (p.tx.nonce === tx.nonce) st.pool.delete(h);
      if (tx.nonce > st.count || tx.maxFeePerGas < st.baseFee || st.noMining) st.pool.set(hash, { tx, raw });
      else await mine(raw, tx);
      return hash;
    },
  };
  const server = await serve(async (m, act) => {
    const mode = st.faults.all ?? st.faults[m.method];
    if (typeof mode === "function") return act.reply({ result: await mode(m.params) });
    if (mode === "lost") { await handlers[m.method]?.(m.params); return act.fail("lost"); }
    if (mode !== undefined) return act.fail(mode);
    const h = handlers[m.method];
    if (!h) throw new Error(`fake EVM: no ${m.method}`);
    act.reply({ result: await h(m.params) });
  });
  return { ...server, st, mineAll: async () => { for (const [, p] of [...st.pool]) await mine(p.raw, p.tx); } };
}

// A small model of the policy, enough for the agent's flows: request, sign, stuck, retry, release, re-sign.
export async function fakeNear({ policy, agent, agentPublicKey, factory, proxy, allowedCode, mpcKey = generatePrivateKey() }) {
  const signerKey = privateKeyToAccount(mpcKey);
  const st = {
    next: 0, lines: new Map(), pending: null, stuck: null, paused: false, mpc: "ok", calls: [], faults: {}, overrides: {}, keyNonce: 100,
    rules: { allowed_code: [...allowedCode], allowed_proxy_upgrades: [], max_gas_limit: 5_000_000, max_fee_cap: 50_000_000_000, rules_delay_sec: 60, proposals: [] },
    permission: { FunctionCall: { receiver_id: policy, method_names: ["request_deploy", "request_proxy_upgrade", "resign", "resign_proxy_upgrade", "retry", "release", "confirm", "confirm_stuck"], allowance: null } },
    noBalance: false, releaseReady: false, outcomes: new Map(),
  };
  const panic = (msg) => { const e = new Error(msg); e.panic = msg; throw e; };
  const fieldsOf = (r) => ({
    type: "eip1559", chainId: r.chain_id, nonce: r.nonce, to: r.to ?? undefined, data: r.data, value: 0n, gas: BigInt(r.gas_limit),
    maxFeePerGas: BigInt(r.max_fee_per_gas), maxPriorityFeePerGas: BigInt(r.max_priority_fee_per_gas),
  });
  const limits = (a) => {
    if (st.paused) panic("paused");
    if (BigInt(a.gas_limit ?? 0) > BigInt(st.rules.max_gas_limit)) panic("gas limit over the cap");
    if (BigInt(a.max_fee_per_gas) > BigInt(st.rules.max_fee_cap)) panic("gas price over the cap");
  };
  const buildDeploy = (a) => {
    limits(a);
    const code = keccak256(a.init_code_hex).slice(2);
    if (!st.rules.allowed_code.includes(code)) panic("code not on the allow list");
    const salt = a.salt_hex ?? ZERO32;
    const data = a.via_factory ? encodeDeploy(salt, a.init_code_hex) : a.init_code_hex;
    return {
      ...a, nonce: st.next, to: a.via_factory ? factory : null, data, kind: "deploy", code_hash: code, salt: a.via_factory ? salt : ZERO32, factory: a.via_factory ? factory : ZERO20,
      address: a.via_factory ? getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecode: a.init_code_hex }).toLowerCase() : ZERO20,
    };
  };
  const encodeDeploy = (salt, init) => encodeFn(FACTORY_ABI, "deploy", [salt, init]);
  const encodeFn = (abi, functionName, args) => {
    const sel = keccak256(toHex(functionName === "deploy" ? "deploy(bytes32,bytes)" : "upgradeTo(address)")).slice(0, 10);
    const types = functionName === "deploy" ? [{ type: "bytes32" }, { type: "bytes" }] : [{ type: "address" }];
    return concat([sel, encodeAbiParameters(types, args)]);
  };
  const buildUpgrade = (a) => {
    limits(a);
    const k = `${a.chain_id}:${a.proxy_hex.toLowerCase()}:${a.implementation_hex.toLowerCase()}`;
    if (!st.rules.allowed_proxy_upgrades.includes(k)) panic("proxy upgrade not on the allow list");
    return { ...a, nonce: st.next, to: a.proxy_hex, data: encodeFn(PROXY_ABI, "upgradeTo", [a.implementation_hex]), kind: "proxy_upgrade", proxy: a.proxy_hex.toLowerCase(), implementation: a.implementation_hex.toLowerCase() };
  };
  // The signature step every request ends in; st.mpc decides how the "MPC" answers.
  const sign = async (r) => {
    if (st.mpc === "none") {
      if (!(st.lines.get(r.nonce)?.status === "signed")) st.stuck = r;
      return null;
    }
    if (st.mpc === "hang") { st.pending = r; return null; }
    const raw = await (st.signWith ?? signerKey).signTransaction(fieldsOf(st.signOverride ? { ...r, ...st.signOverride } : r));
    st.lines.set(r.nonce, { ...lineOf(r), status: "signed", tx_hash: keccak256(raw) });
    st.next = Math.max(st.next, r.nonce + 1);
    return raw;
  };
  const lineOf = (r) => (r.kind === "proxy_upgrade"
    ? { kind: r.kind, proxy: r.proxy, implementation: r.implementation }
    : { kind: r.kind, address: r.address, factory: r.factory, code_hash: r.code_hash, salt: r.salt });
  const views = {
    get_status: () => ({ build: "fake", version: 1, paused: st.paused, upgrade_delay_sec: 180, proposed: null }),
    get_roles: () => ({ agent, owner: "owner.test", guardian: "guardian.test", reserve: "reserve.test", retiring: false, role_changes: [] }),
    get_rules: () => st.rules,
    get_eth_address: () => signerKey.address.toLowerCase(),
    get_next_nonce: () => st.next,
    get_budget: () => null,
    get_open: () => ({ pending: st.pending?.nonce ?? null, stuck: st.stuck?.nonce ?? null, chain_id: (st.pending ?? st.stuck)?.chain_id ?? null }),
    get_entry: (a) => st.lines.get(a.nonce) ?? (st.stuck?.nonce === a.nonce || st.pending?.nonce === a.nonce ? { ...lineOf(st.stuck ?? st.pending), status: "requested", tx_hash: ZERO32 } : null),
    preview: (a) => {
      const r = buildDeploy(a);
      const unsigned = st.previewBytes ?? serializeTransaction(fieldsOf(r));
      return { unsigned, hash: keccak256(unsigned).slice(2), nonce: r.nonce, expected_address: a.via_factory ? r.address : null, min_gas: 60_000 };
    },
    preview_proxy_upgrade: (a) => {
      const r = buildUpgrade(a);
      const unsigned = st.previewBytes ?? serializeTransaction(fieldsOf(r));
      return { unsigned, hash: keccak256(unsigned).slice(2), nonce: r.nonce, to: r.to, data: r.data, min_gas: 40_000 };
    },
  };
  const open = () => { if (st.pending) panic("another request is being signed"); if (st.stuck) panic("an earlier request did not finish: retry it or wait for release"); };
  const calls = {
    request_deploy: (a) => { open(); const r = buildDeploy(a); return sign(r); },
    request_proxy_upgrade: (a) => {
      open();
      const r = buildUpgrade(a);
      st.rules.allowed_proxy_upgrades = st.rules.allowed_proxy_upgrades.filter((k) => k !== `${a.chain_id}:${a.proxy_hex.toLowerCase()}:${a.implementation_hex.toLowerCase()}`);
      return sign(r);
    },
    retry: (a) => {
      if (st.pending) panic("another request is being signed");
      if (!st.stuck) panic("nothing to retry");
      limits(a);
      const r = { ...st.stuck, max_fee_per_gas: a.max_fee_per_gas, max_priority_fee_per_gas: a.max_priority_fee_per_gas };
      st.stuck = null;
      return sign(r);
    },
    resign: (a) => {
      open();
      const e = st.lines.get(a.nonce);
      if (!e || e.kind !== "deploy") panic("no such deploy");
      if (e.status !== "signed") panic("only a signed, unconfirmed deploy can be re-signed");
      if (keccak256(a.init_code_hex).slice(2) !== e.code_hash) panic("init code differs from the journal");
      limits(a);
      const via = e.factory !== ZERO20;
      return sign({ ...a, kind: "deploy", code_hash: e.code_hash, salt: e.salt, factory: e.factory, address: e.address, to: via ? factory : null, data: via ? encodeDeploy(e.salt, a.init_code_hex) : a.init_code_hex });
    },
    resign_proxy_upgrade: (a) => {
      open();
      const e = st.lines.get(a.nonce);
      if (!e || e.kind !== "proxy_upgrade") panic("no such proxy upgrade");
      if (e.status !== "signed") panic("only a signed, unconfirmed proxy upgrade can be re-signed");
      limits(a);
      return sign({ ...a, kind: e.kind, proxy: e.proxy, implementation: e.implementation, to: e.proxy, data: encodeFn(PROXY_ABI, "upgradeTo", [e.implementation]) });
    },
    release: () => {
      if (!st.pending) panic("nothing pending");
      if (!st.releaseReady) panic("still waiting for the MPC");
      st.stuck = st.pending;
      st.pending = null;
      return null;
    },
    pause: () => { st.paused = true; return null; },
  };
  const outcomeOk = (value, hash) => ({
    final_execution_status: "EXECUTED_OPTIMISTIC",
    status: { SuccessValue: value === null || value === undefined ? "" : Buffer.from(JSON.stringify(value)).toString("base64") },
    transaction: { hash },
    transaction_outcome: { id: "4".repeat(44), block_hash: "4".repeat(44), outcome: { logs: [], status: { SuccessReceiptId: "4".repeat(44) } } },
    receipts_outcome: [{ id: "4".repeat(44), outcome: { logs: [], status: { SuccessValue: "" } } }],
  });
  const outcomeFail = (panicMsg, hash) => ({
    final_execution_status: "EXECUTED_OPTIMISTIC",
    status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${panicMsg}` } } } } },
    transaction: { hash },
    transaction_outcome: { id: "4".repeat(44), block_hash: "4".repeat(44), outcome: { logs: [], status: { SuccessReceiptId: "4".repeat(44) } } },
    receipts_outcome: [],
  });
  const server = await serve(async (m, act) => {
    if (st.faults.all !== undefined) return act.fail(st.faults.all);
    if (st.faults[m.method] !== undefined && st.faults[m.method] !== "lost") return act.fail(st.faults[m.method]);
    if (m.method === "block") return act.reply({ result: { header: { hash: "4".repeat(44), height: 1000, timestamp: 1 }, chunks: [] } });
    if (m.method === "query") {
      const p = m.params;
      if (p.request_type === "view_access_key_list") {
        return act.reply({ result: { keys: st.noKey ? [] : [{ public_key: agentPublicKey, access_key: { nonce: st.keyNonce, permission: st.permission } }], block_hash: "4".repeat(44), block_height: 1000 } });
      }
      if (p.request_type === "view_access_key") {
        return act.reply({ result: { nonce: st.keyNonce, permission: st.permission, block_hash: "4".repeat(44), block_height: 1000 } });
      }
      if (p.request_type === "call_function") {
        const name = p.method_name;
        const fault = st.faults[`view:${name}`];
        if (typeof fault === "function") return act.reply({ result: { result: [...Buffer.from(JSON.stringify(fault()))], logs: [], block_hash: "4".repeat(44), block_height: 1000 } });
        if (fault === "not_json") return act.reply({ result: { result: [...Buffer.from("not json")], logs: [], block_hash: "4".repeat(44), block_height: 1000 } });
        if (fault !== undefined) return act.fail(fault);
        const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString() || "{}");
        try {
          const v = await views[name](args);
          return act.reply({ result: { result: [...Buffer.from(JSON.stringify(v))], logs: [], block_hash: "4".repeat(44), block_height: 1000 } });
        } catch (e) {
          if (!e.panic) throw e;
          return act.reply({ result: { error: `wasm execution failed with error: HostError(GuestPanic { panic_msg: "${e.panic}" })`, logs: [], block_hash: "4".repeat(44), block_height: 1000 } });
        }
      }
    }
    if (m.method === "tx") {
      const known = st.outcomes.get(m.params.tx_hash);
      if (!known) throw Object.assign(new RpcFail("unknown"), { rpc: { name: "HANDLER_ERROR", code: -32000, message: "Server error", cause: { name: "UNKNOWN_TRANSACTION", info: { requested_transaction_hash: m.params.tx_hash } } } });
      return act.reply({ result: known });
    }
    if (m.method === "send_tx") {
      const signed = decodeSignedTransaction(Buffer.from(m.params.signed_tx_base64, "base64"));
      const hash = baseEncode(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());
      const fc = signed.transaction.actions[0].functionCall;
      const name = fc.methodName;
      st.calls.push(name);
      if (st.noBalance) throw Object.assign(new RpcFail("no balance"), { rpc: { name: "HANDLER_ERROR", code: -32000, message: "Server error", cause: { name: "INVALID_TRANSACTION", info: {} }, data: { TxExecutionError: { InvalidTxError: { NotEnoughBalance: { signer_id: agent, balance: "0", cost: "1" } } } } } });
      const args = JSON.parse(Buffer.from(fc.args).toString() || "{}");
      const fault = st.faults[`call:${name}`];
      if (fault !== undefined && fault !== "lost") return act.fail(fault);
      let value;
      try {
        value = await calls[name](args);
      } catch (e) {
        if (!e.panic) throw e;
        st.outcomes.set(hash, outcomeFail(e.panic, hash));
        return act.reply({ result: st.outcomes.get(hash) });
      }
      st.outcomes.set(hash, outcomeOk(value, hash));
      if (fault === "lost" || st.faults.send_tx === "lost") return act.fail("lost");
      return act.reply({ result: st.outcomes.get(hash) });
    }
    throw new Error(`fake NEAR: no ${m.method}`);
  });
  return { ...server, st, signer: signerKey.address.toLowerCase() };
}
