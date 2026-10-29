# Build the v13 policy twice (KF_BUILD=a and b, b is the upgrade target) and shrink with wasm-opt -Oz.
# Output: v13/keyfree_v13a.opt.wasm, v13/keyfree_v13b.opt.wasm (*.wasm is gitignored).
# cargo writes progress to stderr, so failures are checked by exit code, not by $ErrorActionPreference.
$root = Split-Path $PSScriptRoot -Parent
$opt = Join-Path $root "..\tools\node_modules\binaryen\bin\wasm-opt"
foreach ($b in "a", "b") {
    $env:KF_BUILD = $b
    $env:RUSTFLAGS = "--cfg near"
    cargo build --manifest-path (Join-Path $root "contract\Cargo.toml") --target wasm32-unknown-unknown --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed for $b" }
    $raw = Join-Path $root "contract\target\wasm32-unknown-unknown\release\keyfree_spike.wasm"
    $out = Join-Path $PSScriptRoot "keyfree_v13$b.opt.wasm"
    node $opt -Oz $raw -o $out
    if ($LASTEXITCODE -ne 0) { throw "wasm-opt failed for $b" }
    $h = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
    "{0}: {1} bytes, sha256 {2}" -f (Split-Path $out -Leaf), (Get-Item $out).Length, $h
}
Remove-Item Env:KF_BUILD
