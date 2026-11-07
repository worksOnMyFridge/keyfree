# Claims check

Run: `npm run check:claims` (read-only, no keys; needs network). The docs against the chains and the
repository: every linked transaction and address, the live policy, every count, every quoted log line.

Result: 128 of 128 checks agree.

| | Check | Result |
|---|---|---|
| ok | NEAR account policy13.keyfree-lab.testnet README.md:84 +1 | exists, code hash JCsHndCJ… |
| ok | NEAR tx 7iawPybU… README.md:86 +1 | policy13.keyfree-lab.testnet -> policy13.keyfree-lab.testnet DeployContract+new+DeleteKey: success |
| ok | Base Sepolia address 0x43e3cb8d… README.md:87 +1 | the policy's keyless address (get_eth_address), 14 transactions sent |
| ok | README: nonces of the keyless address on Base Sepolia | docs 0..13, chain 0..13 |
| ok | Base Sepolia tx 0x59ec9422… README.md:90 +1 | block 51898531, status success |
| ok | Ethereum Sepolia address 0x43e3cb8d… README.md:92 | the policy's keyless address (get_eth_address), 3 transactions sent |
| ok | Base Sepolia address 0x4b78615d… CLAIMS.md:15 | contract, 673 bytes of code |
| ok | Ethereum Sepolia address 0xca875b5d… CLAIMS.md:16 | contract, 673 bytes of code |
| ok | Base Sepolia address 0x5319b76f… CLAIMS.md:18 +1 | contract, 559 bytes of code |
| ok | NEAR tx o5Tb3Ny9… CLAIMS.md:27 (claim 1.4) | keyfree-lab.testnet -> agent14.keyfree-lab.testnet 0+Transfer+AddKey: success |
| ok | NEAR tx BqHPR1LD… CLAIMS.md:28 (claim 1.5) | keyfree-lab.testnet -> policy13.keyfree-lab.testnet apply_upgrade: success |
| ok | NEAR tx C3J8KRin… CLAIMS.md:28 (claim 1.5) | keyfree-lab.testnet -> policy13.keyfree-lab.testnet apply_upgrade: success |
| ok | NEAR tx F9bEhNYB… CLAIMS.md:29 (claim 1.6) | keyfree-lab.testnet -> policy13.keyfree-lab.testnet propose_upgrade: success |
| ok | NEAR tx Ac89k49K… CLAIMS.md:29 (claim 1.6) | keyfree-lab.testnet -> policy13.keyfree-lab.testnet apply_upgrade: success |
| ok | NEAR tx FDvo9LP4… CLAIMS.md:43 | agent13b.keyfree-lab.testnet -> policy13.keyfree-lab.testnet request_deploy: success = "0x02f9039e83014a3480830f424083d59f80830 |
| ok | Base Sepolia tx 0x054e1afd… CLAIMS.md:43 | block 51876726, status success, created 0x4b78615d2ab691cf8e05fe0b7fca7ecb8c063e2f |
| ok | NEAR tx BMihWFDJ… CLAIMS.md:44 | agent13b.keyfree-lab.testnet -> policy13.keyfree-lab.testnet request_deploy: success = "0x02f8f183014a3401830f424083d59f8083043 |
| ok | Base Sepolia tx 0x99dd5599… CLAIMS.md:44 | block 51877388, status success |
| ok | NEAR tx 8k2XU3w4… CLAIMS.md:45 | agent13b.keyfree-lab.testnet -> policy13.keyfree-lab.testnet request_deploy: success = "0x02f904d183014a3402830f424083d59f80830 |
| ok | Base Sepolia tx 0x30e807ce… CLAIMS.md:45 | block 51877428, status success |
| ok | NEAR tx 8n6k6y3A… CLAIMS.md:46 | agent13b.keyfree-lab.testnet -> policy13.keyfree-lab.testnet request_deploy: success = "0x02f95eb283014a3403830f424083d59f80835 |
| ok | Base Sepolia tx 0x97e35ec2… CLAIMS.md:46 | block 51877482, status success |
| ok | NEAR tx Hn3wgJVH… CLAIMS.md:47 | agent13b.keyfree-lab.testnet -> policy13.keyfree-lab.testnet request_deploy: success = "0x02f9c0d283014a3404830f4240836acfc0836 |
| ok | Base Sepolia tx 0x49cd9a5f… CLAIMS.md:47 | block 51878447, status success |
| ok | NEAR tx 8cbFAVWf… CLAIMS.md:53 (claim 3.1) | agent13b.keyfree-lab.testnet -> policy13.keyfree-lab.testnet request_deploy: success = "0x02f9021283014a3406830f424083802c80830 |
| ok | Base Sepolia address 0xc8210fd2… CLAIMS.md:53 (claim 3.1) | contract, 193 bytes of code |
| ok | NEAR tx 92UJ1wJR… CLAIMS.md:55 (claim 3.3) | keyfree-lab.testnet -> policy13.keyfree-lab.testnet propose_rule: success = 9 |
| ok | NEAR tx 5xLHXr4P… CLAIMS.md:55 (claim 3.3) | keyfree-lab.testnet -> policy13.keyfree-lab.testnet apply_rule: success |
| ok | NEAR tx FzFqivDY… CLAIMS.md:58 | agent.kf-outsider-494bd7.testnet -> policy.kf-outsider-494bd7.testnet request_deploy: success = "0x02f9045283014a3429830f4240838fe3f6830 |
| ok | Base Sepolia tx 0x537a735f… CLAIMS.md:58 | block 54080962, status success |
| ok | NEAR tx EirjwGS6… CLAIMS.md:75 (claim 5.1) | agent13b.keyfree-lab.testnet -> policy13.keyfree-lab.testnet confirm: success = true |
| ok | NEAR tx D8tp8LSa… CLAIMS.md:75 (claim 5.1) | agent13b.keyfree-lab.testnet -> policy13.keyfree-lab.testnet confirm: success = true |
| ok | NEAR tx 9AKiRUEo… CLAIMS.md:76 (claim 5.2) | agent13b.keyfree-lab.testnet -> policy13.keyfree-lab.testnet confirm: success = false (cited as answered false) |
| ok | NEAR tx 6hninm9Q… CLAIMS.md:95 | agent13b.keyfree-lab.testnet -> policy13.keyfree-lab.testnet request_deploy: success = "0x02f9047283014a3407830f4240836b9d0d830 |
| ok | Base Sepolia tx 0xe90a60da… CLAIMS.md:95 | block 51947561, status success |
| ok | Base Sepolia address 0xd52f1a3d… CLAIMS.md:95 | contract, 668 bytes of code |
| ok | NEAR tx BpPM6jUa… CLAIMS.md:96 | agent13b.keyfree-lab.testnet -> policy13.keyfree-lab.testnet request_deploy: success = "0x02f9055283014a3408830f4240836acfc0830 |
| ok | Base Sepolia tx 0x158eb231… CLAIMS.md:96 | block 51947607, status success |
| ok | NEAR tx kf2SfpMD… CLAIMS.md:97 | agent13b.keyfree-lab.testnet -> policy13.keyfree-lab.testnet request_deploy: success = "0x02f9063283014a3409830f4240836acfc0830 |
| ok | Base Sepolia tx 0xf880c963… CLAIMS.md:97 | block 51947652, status success |
| ok | Base Sepolia address 0x269bdae8… CLAIMS.md:97 | contract, 1029 bytes of code |
| ok | NEAR tx 3Hhip3r3… CLAIMS.md:103 (claim 7.3) | agent14.keyfree-lab.testnet -> policy13.keyfree-lab.testnet request_proxy_upgrade: success = "0x02f88f83014a340a830f424083802c8082a14 |
| ok | Base Sepolia tx 0xd9673701… CLAIMS.md:103 (claim 7.3) | block 51962615, status success |
| ok | NEAR tx 8PdE3yE5… CLAIMS.md:106 (claim 7.6) | agent14.keyfree-lab.testnet -> policy13.keyfree-lab.testnet confirm: success = true |
| ok | NEAR tx CaJnpGjZ… CLAIMS.md:106 (claim 7.6) | agent14.keyfree-lab.testnet -> policy13.keyfree-lab.testnet confirm: success = false |
| ok | Base Sepolia tx 0x664ab137… CLAIMS.md:107 (claim 7.7) | block 52040057, status success |
| ok | Base Sepolia tx 0x5fe08434… CLAIMS.md:107 (claim 7.7) | block 52053229, status success |
| ok | NEAR tx H1YpXsmC… CLAIMS.md:117 (claim 8.2) | agent14.keyfree-lab.testnet -> policy13.keyfree-lab.testnet request_deploy: success = "0x02f9039b83aa36a701038398968083180ea38 |
| ok | NEAR tx 8ofc8DLm… CLAIMS.md:117 (claim 8.2) | agent14.keyfree-lab.testnet -> policy13.keyfree-lab.testnet request_deploy: success = "0x02f9020f83aa36a7020383989680830c07859 |
| ok | Ethereum Sepolia tx 0x4bf7d487… CLAIMS.md:117 (claim 8.2) | block 12042548, status success, created 0xca875b5d982fb05d6699c61c10806f2470b9ccaa |
| ok | Ethereum Sepolia tx 0x02fec32b… CLAIMS.md:117 (claim 8.2) | block 12042560, status success |
| ok | Ethereum Sepolia address 0xc974ad58… CLAIMS.md:117 (claim 8.2) | contract, 193 bytes of code |
| ok | Ethereum Sepolia tx 0x2407edb5… CLAIMS.md:120 (claim 8.5) | block 12042528, status reverted, created 0x4b78615d2ab691cf8e05fe0b7fca7ecb8c063e2f (cited as reverted) |
| ok | NEAR tx 96qq9eJ3… CLAIMS.md:129 (claim 9.1) | keyfree-lab.testnet -> policy13.keyfree-lab.testnet propose_upgrade: success |
| ok | NEAR tx 9qdVZngM… CLAIMS.md:129 (claim 9.1) | keyfree-lab.testnet -> policy13.keyfree-lab.testnet apply_upgrade: success |
| ok | NEAR tx 2B6QQ5jy… CLAIMS.md:133 (claim 9.5) | agent14.keyfree-lab.testnet -> policy13.keyfree-lab.testnet resign: success = "0x02f9021283014a340d830f424083d59f80830 |
| ok | Base Sepolia tx 0xb22a858d… CLAIMS.md:133 (claim 9.5) | block 53218577, status success |
| ok | NEAR tx ACh6bvaL… CLAIMS.md:134 (claim 9.6) | keyfree-lab.testnet -> policy13.keyfree-lab.testnet propose_upgrade: success |
| ok | NEAR tx AV3zHMa6… CLAIMS.md:134 (claim 9.6) | keyfree-lab.testnet -> policy13.keyfree-lab.testnet apply_upgrade: success |
| ok | NEAR tx 3zWsU2qc… CLAIMS.md:135 (claim 9.7) | kf-outsider-494bd7.testnet -> policy.kf-outsider-494bd7.testnet apply_upgrade: success |
| ok | NEAR tx FtcwmXeq… CLAIMS.md:135 (claim 9.7) | keyfree-lab.testnet -> policy13.keyfree-lab.testnet propose_upgrade: success |
| ok | NEAR tx DurhkhAv… CLAIMS.md:135 (claim 9.7) | keyfree-lab.testnet -> policy13.keyfree-lab.testnet apply_upgrade: success |
| ok | NEAR tx 391dsLWV… CLAIMS.md:135 (claim 9.7) | guard13b.keyfree-lab.testnet -> policy13.keyfree-lab.testnet disable_chain: success |
| ok | NEAR tx B7aZj6dU… CLAIMS.md:136 (claim 9.8) | kf-outsider-494bd7.testnet -> policy.kf-outsider-494bd7.testnet apply_upgrade: success |
| ok | NEAR tx CqVtHL9o… CLAIMS.md:136 (claim 9.8) | keyfree-lab.testnet -> policy13.keyfree-lab.testnet propose_upgrade: success |
| ok | NEAR tx 8ZVyta6H… CLAIMS.md:136 (claim 9.8) | keyfree-lab.testnet -> policy13.keyfree-lab.testnet apply_upgrade: success |
| ok | NEAR tx GtE8rUyq… CLAIMS.md:137 (claim 9.9) | keyfree-lab.testnet -> policy13.keyfree-lab.testnet propose_upgrade: success |
| ok | NEAR tx GbcucxoJ… CLAIMS.md:137 (claim 9.9) | keyfree-lab.testnet -> policy13.keyfree-lab.testnet apply_upgrade: success |
| ok | NEAR tx 4h2CPgLw… CLAIMS.md:137 (claim 9.9) | kf-outsider-494bd7.testnet -> policy.kf-outsider-494bd7.testnet propose_upgrade: success |
| ok | NEAR tx EkrN29qc… CLAIMS.md:137 (claim 9.9) | kf-outsider-494bd7.testnet -> policy.kf-outsider-494bd7.testnet apply_upgrade: success |
| ok | NEAR tx 7Tf82q6f… CLAIMS.md:137 (claim 9.9) | guard13b.keyfree-lab.testnet -> policy13.keyfree-lab.testnet pause: success |
| ok | NEAR tx 8DKGFPi2… CLAIMS.md:148 (claim 10.3) | agent.kf-outsider-494bd7.testnet -> policy.kf-outsider-494bd7.testnet request_deploy: success = "0x02f9039e83014a3480830f424083d59f80830 |
| ok | NEAR tx w3i2zLjA… CLAIMS.md:148 (claim 10.3) | agent.kf-outsider-494bd7.testnet -> policy.kf-outsider-494bd7.testnet request_deploy: success = "0x02f9021283014a3401830f424083802c80830 |
| ok | Base Sepolia tx 0x7069d601… CLAIMS.md:148 (claim 10.3) | block 53375859, status success, created 0x7716a4bd3547d36153ec7b24a93e8349157fb766 |
| ok | Base Sepolia tx 0xbd514782… CLAIMS.md:148 (claim 10.3) | block 53376399, status success |
| ok | NEAR tx 678ZDWZ7… CLAIMS.md:149 (claim 10.4) | agent.kf-outsider-494bd7.testnet -> policy.kf-outsider-494bd7.testnet confirm: success = true |
| ok | Base Sepolia tx 0xcffaf4e6… CLAIMS.md:149 (claim 10.4) | block 55575989, status success |
| ok | Base Sepolia tx 0xc6925567… CLAIMS.md:149 (claim 10.4) | block 55576162, status success |
| ok | NEAR tx C1WcHCYc… CLAIMS.md:150 (claim 10.5) | agent.kf-outsider-494bd7.testnet -> policy.kf-outsider-494bd7.testnet resign: success = "0x02f9021283014a3431830f424083802c80830 |
| ok | NEAR tx FtB6TX6Q… CLAIMS.md:150 (claim 10.5) | agent.kf-outsider-494bd7.testnet -> policy.kf-outsider-494bd7.testnet resign_proxy_upgrade: success = "0x02f88f83014a3432830f424083802c8082d89 |
| ok | NEAR tx 2A12tDfu… CLAIMS.md:150 (claim 10.5) | agent.kf-outsider-494bd7.testnet -> policy.kf-outsider-494bd7.testnet resign: success = "0x02f9021283014a3410830f424083802c80830 |
| ok | Base Sepolia tx 0x635dd638… CLAIMS.md:150 (claim 10.5) | block 54106221, status success |
| ok | Base Sepolia tx 0x6c4c8c66… CLAIMS.md:150 (claim 10.5) | block 54106791, status success |
| ok | Base Sepolia tx 0x7fe60897… CLAIMS.md:150 (claim 10.5) | block 53798407, status success |
| ok | NEAR tx 7ZWDHjQS… CLAIMS.md:152 (claim 10.7) | agent.kf-outsider-494bd7.testnet -> policy.kf-outsider-494bd7.testnet request_deploy: success = "0x02f9021283014a3433830f424083802c80830 |
| ok | Base Sepolia tx 0xd49ebd7a… CLAIMS.md:152 (claim 10.7) | block 55461917, status success |
| ok | policy13.keyfree-lab.testnet access keys | 0 (docs: 0) |
| ok | live code sha256 | ffa0edd847232186c4eed41abb1c21cc868b0bed1bb2fbd1af55c7fbe2bf10d0 (README: ffa0edd847232186c4eed41abb1c21cc868b0bed1bb2fbd1af55c7fbe2bf10d0) |
| ok | live code size | 384853 bytes (README: 384 853) |
| ok | NEP-330 metadata names the README's commit | c6177248ea30c3662a0603ac900d6c928faae936 in git+https://github.com/worksOnMyFridge/keyfree?rev=c6177248ea30c3662a0603ac900d6c928faae936 |
| ok | the explorer's pinned build is the README's | c617724 JCsHndCJHwoJ256Dm4dARWsRDCwCjFY3k2meUq6wEMcB |
| ok | get_status build | v19, version 9, paused false (docs: v19) |
| ok | daily budget on Base Sepolia | 10 transactions, 500000000000000 wei a day |
| ok | daily budget on Ethereum Sepolia | 10 transactions, 10000000000000000 wei a day |
| ok | live run's steps in CLAIMS and README | 134 |
| ok | live fault run's steps in CLAIMS | 31 |
| ok | contract tests in README.md | docs 186, repository 186 |
| ok | contract tests in CLAIMS.md | docs 186, repository 186 |
| ok | contract tests in SECURITY.md | docs 186, repository 186 |
| ok | tool tests in README.md | docs 83, repository 83 |
| ok | tool tests in CLAIMS.md | docs 83, repository 83 |
| ok | factory tests in README.md | docs 6, repository 6 |
| ok | sandbox tests in CLAIMS.md | docs 17, repository 17 |
| ok | offline attacks in README.md | docs 65, repository 65 |
| ok | offline attacks in SECURITY.md | docs 65, repository 65 |
| ok | offline attacks in CLAIMS.md | docs 65, repository 65 |
| ok | live-only attacks in CLAIMS.md | docs 1, repository 1 |
| ok | public methods in README.md | docs 48, repository 48 |
| ok | random vectors in README.md | docs 400, repository 400 |
| ok | random vectors in CLAIMS.md | docs 400, repository 400 |
| ok | CLAIMS.md:25 quotes v13.log | "ETH address derived on-chain from the MPC" |
| ok | CLAIMS.md:27 quotes v13.log, v14.log | "Access key does not allow method propose_rule" |
| ok | CLAIMS.md:36 quotes v13.log | "unsigned tx built by the contract == viem" |
| ok | CLAIMS.md:65 quotes v13.log | "rule delay not over" |
| ok | CLAIMS.md:66 quotes v13.log | "one unpause vote is not enough" |
| ok | CLAIMS.md:66 quotes v13.log | "second vote (reserve) unpauses" |
| ok | CLAIMS.md:67 quotes v13.log | "needs 2 of 3 approvals" |
| ok | CLAIMS.md:67 quotes v13.log | "the old guardian alone cannot cancel its own replacement" |
| ok | CLAIMS.md:67 quotes v13.log | "role change delay not over" |
| ok | CLAIMS.md:67 quotes v13.log | "the old guardian pauses -> Smart contract panicked: only owner, guardi…" |
| ok | CLAIMS.md:68 quotes v13.log | "guardian cancelled: no proposal, no stored code" |
| ok | CLAIMS.md:102 quotes v14.log | "proxy upgrade not on the allow list" |
| ok | CLAIMS.md:102 quotes v14.log | "rule delay not over" |
| ok | CLAIMS.md:102 quotes v14.log | "Access key does not allow method propose_rule" |
| ok | CLAIMS.md:104 quotes v14.log | "proxy upgrade not on the allow list" |
| ok | CLAIMS.md:104 quotes v14.log | "the allowance is used up" |
| ok | CLAIMS.md:137 quotes v19_live.log | "paused: no rule is applied while paused" |
| ok | CLAIMS.md:150 quotes tool_faults_live.log | "gas price over the cap" |
