// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// The demo contract an AI agent deploys through Keyfree.
contract Counter {
    uint256 public number;

    constructor(uint256 start) {
        number = start;
    }

    function increment() external {
        number++;
    }
}
