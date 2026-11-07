// One-off: move testnet NEAR from a project's guardian account to its owner, so the owner can pay the code-storage
// deposit of a keyless upgrade. Both accounts belong to the same test project. Keys are read, never printed.
//   node v14/topup_owner.mjs <key file of the sender> <sender> <receiver> <NEAR>
import fs from "node:fs";
import { provider, explorer, Account, actions, parseNearAmount } from "../tools/near.mjs";

const [file, from, to, near] = process.argv.slice(2);
if (!file || !from || !to || !/^\d+(\.\d+)?$/.test(near ?? "")) { console.log("usage: node v14/topup_owner.mjs <key file> <from> <to> <NEAR>"); process.exit(2); }
const key = JSON.parse(fs.readFileSync(file, "utf8")).private_key;
const out = await new Account(from, provider, key).signAndSendTransaction({ receiverId: to, actions: [actions.transfer(BigInt(parseNearAmount(near)))] });
console.log(`OK   ${near} NEAR ${from} -> ${to} ${explorer(out.transaction.hash)}`);
