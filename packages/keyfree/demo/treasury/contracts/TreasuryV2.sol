// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Treasury, version 2 (runs behind TreasuryProxy): the same owner, plus a daily withdrawal limit,
/// so even a stolen owner key can only take one day's limit before someone reacts.
contract TreasuryV2 {
    address public immutable owner;
    uint256 public immutable dailyLimit;

    // Proxy storage. Slot 0 and 1 are free: the proxy keeps its own data in ERC-1967 slots.
    uint256 public day;
    uint256 public spentToday;

    event Withdrawn(address indexed to, uint256 amount);

    constructor(address owner_, uint256 dailyLimit_) {
        require(owner_ != address(0), "owner is zero");
        owner = owner_;
        dailyLimit = dailyLimit_;
    }

    receive() external payable {}

    function version() external pure returns (uint256) {
        return 2;
    }

    function withdraw(uint256 amount) external {
        require(msg.sender == owner, "only owner");
        uint256 today = block.timestamp / 1 days;
        if (today != day) {
            day = today;
            spentToday = 0;
        }
        require(spentToday + amount <= dailyLimit, "over the daily limit");
        spentToday += amount;
        emit Withdrawn(owner, amount);
        (bool ok, ) = owner.call{value: amount}("");
        require(ok, "transfer failed");
    }
}
