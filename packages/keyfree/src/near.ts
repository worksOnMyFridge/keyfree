// Talking to the policy contract on NEAR: views (optimistic, so a read sees the call just made) and calls.
import { Account, JsonRpcProvider, teraToGas } from "near-api-js";
import type { Config } from "./config.js";

// Text that comes from outside (RPC errors, revert strings) loses control and direction characters, so it
// can neither rewrite the terminal (ANSI escapes) nor hide or reorder what the human reads (bidi marks).
export function clean(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "");
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

export class Policy {
  readonly provider: JsonRpcProvider;

  constructor(readonly cfg: Config) {
    this.provider = new JsonRpcProvider({ url: cfg.near_rpc });
  }

  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.provider.callFunction({ contractId: this.cfg.policy, method, args, blockQuery: { finality: "optimistic" } });
    return r as T;
  }

  account(id: string, key: string): Account {
    return new Account(id, this.provider, key as ConstructorParameters<typeof Account>[2]);
  }

  async call<T>(who: Account, methodName: string, args: Record<string, unknown> | Uint8Array, gasTera = 30, deposit = 0n): Promise<CallResult<T>> {
    let out: Outcome;
    try {
      out = (await who.callFunctionRaw({ contractId: this.cfg.policy, methodName, args, gas: teraToGas(gasTera), deposit })) as unknown as Outcome;
    } catch (e) {
      throw asRefusal(e);
    }
    const logs = out.receipts_outcome.flatMap((r) => r.outcome.logs).filter((l) => l.startsWith("keyfree"));
    const raw = out.status.SuccessValue ? Buffer.from(out.status.SuccessValue, "base64").toString() : "";
    return { value: raw ? (JSON.parse(raw) as T) : null, logs, txHash: out.transaction.hash };
  }

  tx(hash: string): string {
    return `${this.cfg.near_explorer}/txns/${hash}`;
  }
}

// Turn a NEAR error into the policy's reason when there is one, so the agent reads why, not a stack.
export function asRefusal(e: unknown): Error {
  const m = String((e as Error)?.message ?? e).replace(/\s+/g, " ");
  const panic = /Smart contract panicked: (.*?)(?:$|"|\\")/.exec(m);
  if (panic) return new PolicyRefusal(panic[1].trim());
  if (/does not allow method|MethodNameMismatch/.test(m)) return new PolicyRefusal(`this key may not call that method (${m.slice(0, 120)})`);
  if (/Not enough allowance/.test(m)) return new Error(`The agent key's gas allowance is too small for this call. Give the agent a key without an allowance. (${m.slice(0, 160)})`);
  return new Error(clean(m));
}
