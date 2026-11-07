// What to deploy: raw init code, or a Foundry / Hardhat artifact plus constructor arguments.
import fs from "node:fs";
import { encodeDeployData, keccak256, type Abi, type Hex } from "viem";

export interface CodeInput {
  init_code_hex?: string;
  artifact?: string;
  constructor_args?: unknown[];
}

export interface Code {
  init: Hex;
  hash: string; // keccak256 of the whole init code, without 0x: what the allow list holds
  source: string;
}

export function loadCode(input: CodeInput): Code {
  if (input.init_code_hex && input.artifact) throw new Error("Give either init_code_hex or artifact, not both.");
  if (input.init_code_hex) {
    const hex = (input.init_code_hex.startsWith("0x") ? input.init_code_hex : `0x${input.init_code_hex}`) as Hex;
    if (!/^0x([0-9a-fA-F]{2})+$/.test(hex)) throw new Error("init_code_hex must be hex bytes.");
    return { init: hex, hash: keccak256(hex).slice(2), source: "raw init code" };
  }
  if (!input.artifact) throw new Error("Give init_code_hex or artifact (a Foundry out/X.sol/X.json or Hardhat artifact).");
  if (!fs.existsSync(input.artifact)) throw new Error(`Artifact ${input.artifact} not found. Build the contract first (forge build).`);
  let a: { abi?: Abi; bytecode?: string | { object?: string }; contractName?: string };
  try {
    a = JSON.parse(fs.readFileSync(input.artifact, "utf8"));
  } catch {
    throw new Error(`${input.artifact} is not a Foundry or Hardhat JSON artifact.`);
  }
  const raw = typeof a.bytecode === "string" ? a.bytecode : a.bytecode?.object;
  if (!raw || raw === "0x") throw new Error(`${input.artifact} has no bytecode (an interface or abstract contract?).`);
  const bytecode = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  // The allow list holds the hash of the init code WITH constructor arguments, so arguments are part of what is allowed.
  const init = encodeDeployData({ abi: a.abi ?? [], bytecode, args: input.constructor_args ?? [] }) as Hex;
  return { init, hash: keccak256(init).slice(2), source: `${input.artifact}${input.constructor_args?.length ? ` with ${input.constructor_args.length} constructor args` : ""}` };
}
