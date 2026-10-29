// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Treasury, version 1 (runs behind TreasuryProxy): anyone can fund it, only the owner can withdraw.
/// The owner is in the code (immutable), so it is part of the allowed code hash of this version.
contract TreasuryV1 {
    address public immutable owner;

    event Withdrawn(address indexed to, uint256 amount);

    constructor(address owner_) {
        require(owner_ != address(0), "owner is zero");
        owner = owner_;
    }

    receive() external payable {}

    function version() external pure returns (uint256) {
        return 1;
    }

    function withdraw(uint256 amount) external {
        require(msg.sender == owner, "only owner");
        emit Withdrawn(owner, amount);
        (bool ok, ) = owner.call{value: amount}("");
        require(ok, "transfer failed");
    }
}
