// Base58 for test keys: "secp256k1:<base58 of the 64-byte point>", the way NEAR MPC returns a derived key.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58(hex) {
  let n = BigInt(`0x${hex}`);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (let i = 0; i < hex.length && hex.slice(i, i + 2) === "00"; i += 2) s = `1${s}`;
  return s;
}
