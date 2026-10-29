// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Treasury vault: anyone can fund it, only the owner can withdraw.
contract Vault {
    address public immutable owner;

    event Withdrawn(address indexed to, uint256 amount);

    constructor(address owner_) {
        require(owner_ != address(0), "owner is zero");
        owner = owner_;
    }

    receive() external payable {}

    function withdraw(uint256 amount) external {
        require(msg.sender == owner, "only owner");
        emit Withdrawn(owner, amount);
        (bool ok, ) = owner.call{value: amount}("");
        require(ok, "transfer failed");
    }
}
