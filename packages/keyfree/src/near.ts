// Talking to the policy contract on NEAR: views (optimistic, so a read sees the call just made) and calls.
import { createHash } from "node:crypto";
import { Account, JsonRpcProvider, actions, baseEncode, encodeTransaction, teraToGas } from "near-api-js";
import type { Config } from "./config.js";

// Text that comes from outside (RPC errors, revert strings) loses control and direction characters, so it
// can neither rewrite the terminal (ANSI escapes) nor hide or reorder what the human reads (bidi marks).
export function clean(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, "");
}

// One readable line for an error from a library. An RPC address often carries an API key, so only its host
// is ever printed; viem's long multi-line messages shrink to their short form and the node's own words.
export function reason(e: unknown): string {
  const err = e as { shortMessage?: string; details?: string; message?: string };
  const text = err?.shortMessage ? `${err.shortMessage}${err.details ? ` ${err.details}` : ""}` : String(err?.message ?? e);
  return clean(text.replace(/\b\w+:\/\/[^\s"'<>)]+/g, (u) => { try { return new URL(u).host; } catch { return "the node"; } }));
}

// The policy said no. `reason` is its own words; the caller must not try to route around it.
export class PolicyRefusal extends Error {
  readonly reason: string;
  constructor(reason: string) {
    const r = clean(reason);
    super(`Refused by the policy: ${r}`);
    this.reason = r;
  }
}

// A call whose outcome is unknown: the node failed, the transaction may or may not be running.
export class NearFault extends Error {}

// The policy writes u64 and u128 values as plain JSON numbers. JSON.parse would round any above 2^53 (a daily
// budget of 0.0123 ETH in wei already is), so integers of 16 digits or more are read as exact decimal strings.
export function parseExact(text: string): unknown {
  return JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|-?\d{16,}/g, (m) => (m.startsWith('"') ? m : `"${m}"`)));
}

export interface CallResult<T> {
  value: T | null;
  logs: string[];
  txHash: string;
}

interface Outcome {
  status: { SuccessValue?: string; Failure?: unknown };
  transaction: { hash: string };
  receipts_outcome: { outcome: { logs: string[] } }[];
}

// near-api-js has no timeout of its own: a node that accepts the connection and stays silent would hold the
// tool for minutes. A view gets rpc_timeout_ms; sending a transaction may legitimately wait for the MPC.
// With near_rpc_fallbacks, what one node fails goes to the next, which then stays in front for this run. A signed
// transaction sent twice is one transaction (same hash). 408 is a node still waiting for the outcome, not a failure.
const SEND_TIMEOUT_MS = 120_000;
const plainFetch = globalThis.fetch;
function guardFetch(nodes: string[], timeoutMs: number) {
  let front = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input) !== nodes[0]) return plainFetch(input, init);
    const sending = String(init?.body ?? "").includes('"method":"send_tx"');
    const ms = sending ? Math.max(timeoutMs, SEND_TIMEOUT_MS) : timeoutMs;
    const start = front;
    let failure: unknown;
    for (let i = 0; i < nodes.length; i++) {
      const at = (start + i) % nodes.length;
      const last = i === nodes.length - 1;
      try {
        const res = await plainFetch(nodes[at], { ...init, signal: AbortSignal.timeout(ms) });
        if (!last && (res.status >= 500 || res.status === 429 || !/json/.test(res.headers.get("content-type") ?? ""))) continue;
        front = at;
        return res;
      } catch (e) {
        failure = e;
      }
    }
    throw failure;
  };
}

export class Policy {
  readonly provider: JsonRpcProvider;

  constructor(readonly cfg: Config) {
    guardFetch([cfg.near_rpc, ...(cfg.near_rpc_fallbacks ?? [])], cfg.rpc_timeout_ms ?? 60_000);
    // 8 tries on 408/500/503 with the default backoff: about 25 s of waiting before a dead node is called dead.
    this.provider = new JsonRpcProvider({ url: cfg.near_rpc }, { retries: 8 });
  }

  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    let bytes: Uint8Array | number[];
    try {
      bytes = (await this.provider.callFunctionRaw({ contractId: this.cfg.policy, method, args, blockQuery: { finality: "optimistic" } })).result;
    } catch (e) {
      // A contract panic stays as it is: the caller reads the policy's words out of it.
      if (/panic/i.test(String((e as Error)?.message))) throw e;
      throw new Error(`The NEAR node did not answer ${method}: ${reason(e)}. Nothing was signed.`);
    }
    try {
      return parseExact(Buffer.from(bytes).toString()) as T;
    } catch {
      throw new Error(`The NEAR node's answer to ${method} is not JSON. Nothing was signed.`);
    }
  }

  async accessKeys(accountId: string): Promise<{ public_key: string; access_key: { permission: unknown } }[]> {
    try {
      return (await this.provider.viewAccessKeyList({ accountId })).keys;
    } catch (e) {
      throw new Error(`The NEAR node did not list the keys of ${accountId}: ${reason(e)}. Nothing was signed.`);
    }
  }

  account(id: string, key: string): Account {
    return new Account(id, this.provider, key as ConstructorParameters<typeof Account>[2]);
  }

  // The transaction is signed here, not inside near-api-js, so its hash is known before it is sent. A node can fail
  // after the transaction went through, and for a request the answer is the MPC's signature: it is looked up by that
  // hash, not asked for again (a second signature would cost another place in the day's budget). And a call is never
  // re-signed under a new nonce on a mere node error, which could run it twice.
  async call<T>(who: Account, methodName: string, args: Record<string, unknown> | Uint8Array, gasTera = 30, deposit = 0n): Promise<CallResult<T>> {
    let out: Outcome | null = null;
    let signer = who;
    for (let attempt = 0; !out; attempt++) {
      const signed = await signer.createSignedTransaction({ receiverId: this.cfg.policy, actions: [actions.functionCall(methodName, args as Uint8Array, teraToGas(gasTera), deposit)] });
      const hash = baseEncode(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());
      try {
        out = (await this.provider.sendTransactionUntil(signed, "EXECUTED_OPTIMISTIC")) as unknown as Outcome;
      } catch (e) {
        const stale = /InvalidNonce/.test(String((e as Error)?.constructor?.name));
        const err = asRefusal(e, who.accountId);
        if (!stale && !(err instanceof NearFault)) throw err;
        out = await this.outcome(hash, who.accountId, stale ? 3000 : (this.cfg.rpc_timeout_ms ?? 60_000) * 2);
        if (out) break;
        if (!stale || attempt >= 2) throw err;
        // The key's nonce moved on elsewhere and this transaction never ran: only then is a new one safe.
        signer = new Account(who.accountId, this.provider, signer.getSigner() as ConstructorParameters<typeof Account>[2]);
      }
    }
    if (out.status.Failure) throw asFailure(out.status.Failure);
    const logs = out.receipts_outcome.flatMap((r) => r.outcome.logs).filter((l) => l.startsWith("keyfree"));
    const raw = out.status.SuccessValue ? Buffer.from(out.status.SuccessValue, "base64").toString() : "";
    return { value: raw ? (parseExact(raw) as T) : null, logs, txHash: out.transaction.hash };
  }

  private async outcome(txHash: string, accountId: string, withinMs: number): Promise<Outcome | null> {
    const until = Date.now() + withinMs;
    while (Date.now() < until) {
      try {
        return (await this.provider.viewTransactionStatus({ txHash, accountId, waitUntil: "EXECUTED_OPTIMISTIC" })) as unknown as Outcome;
      } catch {
        await new Promise((r) => setTimeout(r, Math.min(3000, withinMs / 3)));
      }
    }
    return null;
  }

  tx(hash: string): string {
    return `${this.cfg.near_explorer}/txns/${hash}`;
  }
}

// Turn a NEAR error into the policy's reason when there is one, so the agent reads why, not a stack.
export function asRefusal(e: unknown, account = "the signer"): Error {
  // near-api-js says what happened in the class of its errors as much as in the text.
  const m = `${(e as Error)?.constructor?.name ?? ""} ${String((e as Error)?.message ?? e)}`.replace(/\s+/g, " ");
  const panic = /Smart contract panicked: (.*?)(?:$|"|\\")/.exec(m);
  if (panic) return new PolicyRefusal(panic[1].trim());
  if (/does not allow method|MethodNameMismatch/.test(m)) return new PolicyRefusal(`this key may not call that method (${m.slice(0, 120)})`);
  if (/Not enough allowance|allowance is not enough|NotEnoughAllowance/i.test(m)) return new Error(`The agent key's gas allowance is too small for this call. Give the agent a key without an allowance. (${m.slice(0, 160)})`);
  if (/enough balance|NotEnoughBalance/i.test(m)) return new Error(`${account} has too little NEAR to pay for this call (a call reserves its whole gas up front). Top up the account; nothing happened on the policy.`);
  return new NearFault(`The NEAR node failed on this call: ${reason(e)}.`);
}

// The chain's own verdict on a transaction that ran: certain, unlike a node's error.
function asFailure(failure: unknown): Error {
  const m = JSON.stringify(failure);
  const panic = /Smart contract panicked: (.*?)(?:$|"|\\")/.exec(m);
  if (panic) return new PolicyRefusal(panic[1].trim());
  if (/LackBalanceForState/.test(m)) return new Error("The policy account has too little NEAR for its storage, so nothing changed and the MPC was not asked. Anyone can send it NEAR; then ask again.");
  return new Error(`The call failed on NEAR: ${clean(m.slice(0, 300))}`);
}
