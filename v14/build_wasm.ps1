# Build the v14 policy (KF_BUILD=v14, the upgrade target for the live v13 policy) and shrink it with wasm-opt -Oz.
# Output: v14/keyfree_v14.opt.wasm (*.wasm is gitignored).
# cargo writes progress to stderr, so failures are checked by exit code, not by $ErrorActionPreference.
$root = Split-Path $PSScriptRoot -Parent
$opt = Join-Path $root "node_modules/binaryen/bin/wasm-opt"
$env:KF_BUILD = "v14"
$env:RUSTFLAGS = "--cfg near"
cargo build --manifest-path (Join-Path $root "contract/Cargo.toml") --target wasm32-unknown-unknown --release
if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
$raw = Join-Path $root "contract/target/wasm32-unknown-unknown/release/keyfree_spike.wasm"
$out = Join-Path $PSScriptRoot "keyfree_v14.opt.wasm"
node $opt -Oz $raw -o $out
if ($LASTEXITCODE -ne 0) { throw "wasm-opt failed" }
$h = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
"{0}: {1} bytes, sha256 {2}" -f (Split-Path $out -Leaf), (Get-Item $out).Length, $h
Remove-Item Env:KF_BUILD
