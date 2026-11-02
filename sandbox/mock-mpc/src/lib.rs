// Stand-in for the NEAR MPC contract (v1.signer-prod.testnet) in the sandbox tests, and nowhere else. It has
// the method names, arguments and answer shapes the policy uses; its secp256k1 key for (caller, path) comes
// from a fixed seed, so anyone can recompute it: never deploy this outside a local sandbox. `set_mode` makes it
// answer badly on purpose, the ways a real MPC network can fail.
use k256::ecdsa::SigningKey;
use k256::elliptic_curve::sec1::ToEncodedPoint;
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require, AccountId, CryptoHash, Gas, GasWeight, NearToken};

#[near(contract_state)]
#[derive(Default)]
pub struct MockMpc {
    // "" or "ok", "high_s", "other_key", "garbage", "not_json", "huge", "panic", "hang"
    sign_mode: String,
    // "" or "ok", "panic"
    verify_mode: String,
    signs: u32,
    verifies: u32,
    last_sign: String,
    last_verify: String,
    // the request a "hang" answer is holding, for resume_sign
    yield_id: String,
}

fn key_of(caller: &str, path: &str) -> SigningKey {
    let seed = env::sha256_array(format!("keyfree sandbox mock mpc|{caller}|{path}").as_bytes());
    SigningKey::from_bytes(&seed.into()).unwrap_or_else(|_| env::panic_str("seed is not a key"))
}

// "secp256k1:<base58 of x||y>", the format of the real derived_public_key.
fn public_of(k: &SigningKey) -> String {
    let p = k.verifying_key().as_affine().to_encoded_point(false);
    format!("secp256k1:{}", bs58::encode(&p.as_bytes()[1..]).into_string())
}

// The real answer shape: R as a compressed point, s, and the recovery id. k256 gives low s; `high_s` flips it
// the way the MPC may (both are valid ECDSA, Ethereum takes only the low one).
fn signature(k: &SigningKey, hash: &[u8; 32], high_s: bool) -> String {
    let (sig, rec) = k.sign_prehash_recoverable(hash).unwrap_or_else(|_| env::panic_str("signing failed"));
    let y_odd = rec.to_byte() & 1;
    let s = if high_s { -*sig.s() } else { *sig.s() };
    json!({
        "scheme": "Secp256k1",
        "big_r": { "affine_point": format!("{:02x}{}", 2 + y_odd, hex::encode(sig.r().to_bytes())) },
        "s": { "scalar": hex::encode(s.to_bytes()) },
        "recovery_id": y_odd ^ high_s as u8,
    })
    .to_string()
}

#[near]
impl MockMpc {
    pub fn set_mode(&mut self, sign: String, verify: String) {
        self.sign_mode = sign;
        self.verify_mode = verify;
    }

    pub fn derived_public_key(&self, path: String, predecessor: Option<AccountId>, domain_id: Option<u32>) -> String {
        require!(domain_id.unwrap_or(0) == 0, "domain 0 is secp256k1");
        let caller = predecessor.unwrap_or_else(env::predecessor_account_id);
        public_of(&key_of(caller.as_str(), &path))
    }

    // Signs payload_v2.Ecdsa with the key of (the calling contract, path), like the real contract.
    #[payable]
    pub fn sign(&mut self, request: Value) {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach at least 1 yoctoNEAR");
        self.signs += 1;
        self.last_sign = request.to_string();
        let hash: [u8; 32] = request["payload_v2"]["Ecdsa"].as_str().and_then(|h| hex::decode(h).ok()).and_then(|b| b.try_into().ok())
            .unwrap_or_else(|| env::panic_str("payload_v2.Ecdsa must be 32 bytes of hex"));
        require!(request["domain_id"].as_u64() == Some(0), "domain 0 is secp256k1");
        let path = request["path"].as_str().unwrap_or_default().to_string();
        let caller = env::predecessor_account_id();
        let answer = match self.sign_mode.as_str() {
            "" | "ok" => signature(&key_of(caller.as_str(), &path), &hash, false),
            "high_s" => signature(&key_of(caller.as_str(), &path), &hash, true),
            "other_key" => signature(&key_of("someone-else", &path), &hash, false),
            "garbage" => json!({ "big_r": { "affine_point": "02zz" }, "s": { "scalar": "00" }, "recovery_id": 9 }).to_string(),
            "not_json" => "this is not json".to_string(),
            "huge" => format!("\"{}\"", "a".repeat(20_000)),
            "panic" => env::panic_str("mock: the MPC network did not sign"),
            // Like the real contract: the request waits (yield) until the network answers (resume_sign) or the
            // runtime's yield timeout, about 200 blocks, fails it.
            "hang" => {
                let args = json!({ "hash": hex::encode(hash), "caller": caller, "path": path }).to_string();
                let p = env::promise_yield_create("on_resume", args.as_bytes(), Gas::from_tgas(20), GasWeight(0), 0);
                self.yield_id = hex::encode(env::read_register(0).unwrap_or_default());
                env::promise_return(p);
                return;
            }
            m => env::panic_str(&format!("unknown sign mode {m}")),
        };
        env::value_return(answer.as_bytes());
    }

    // The network answers the request a "hang" is holding.
    pub fn resume_sign(&mut self) -> bool {
        let id: CryptoHash = hex::decode(&self.yield_id).ok().and_then(|b| b.try_into().ok()).unwrap_or_else(|| env::panic_str("no request is waiting"));
        env::promise_yield_resume(&id, b"\"go\"")
    }

    #[private]
    pub fn on_resume(&mut self, hash: String, caller: AccountId, path: String) {
        match env::promise_result_checked(0, 100) {
            Ok(_) => {
                let h: [u8; 32] = hex::decode(hash).ok().and_then(|b| b.try_into().ok()).unwrap_or_else(|| env::panic_str("bad hash"));
                env::value_return(signature(&key_of(caller.as_str(), &path), &h, false).as_bytes());
            }
            Err(_) => env::panic_str("mock: the signature request timed out"),
        }
    }

    // Read MPC: answers for the expected payload hash it was given, or fails.
    #[payable]
    pub fn verify_foreign_transaction(&mut self, request: Value) {
        self.verifies += 1;
        self.last_verify = request.to_string();
        match self.verify_mode.as_str() {
            "" | "ok" => env::value_return(json!({ "payload_hash": request["request"]["expected_payload_hash"] }).to_string().as_bytes()),
            "panic" => env::panic_str("mock: the MPC network did not confirm"),
            m => env::panic_str(&format!("unknown verify mode {m}")),
        }
    }

    pub fn get_log(&self) -> Value {
        json!({ "sign_mode": self.sign_mode, "verify_mode": self.verify_mode, "signs": self.signs, "verifies": self.verifies,
            "last_sign": self.last_sign, "last_verify": self.last_verify })
    }
}
