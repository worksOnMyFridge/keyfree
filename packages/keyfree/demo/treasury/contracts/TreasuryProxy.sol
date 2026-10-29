// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// ERC-1967 proxy for a treasury. Its money and address stay; its code can be replaced, and only by the
/// admin: the keyless Keyfree address, so every upgrade is one the Keyfree council allowed.
/// There is no way to change the admin.
contract TreasuryProxy {
    // bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
    bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    // bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1)
    bytes32 private constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    event Upgraded(address indexed implementation);
    event AdminChanged(address previousAdmin, address newAdmin);

    constructor(address implementation_, address admin_) {
        require(admin_ != address(0), "admin is zero");
        _setImplementation(implementation_);
        assembly { sstore(ADMIN_SLOT, admin_) }
        emit AdminChanged(address(0), admin_);
    }

    function upgradeTo(address implementation_) external {
        require(msg.sender == _admin(), "only admin");
        _setImplementation(implementation_);
    }

    function _setImplementation(address implementation_) private {
        require(implementation_.code.length > 0, "implementation has no code");
        assembly { sstore(IMPLEMENTATION_SLOT, implementation_) }
        emit Upgraded(implementation_);
    }

    function _admin() private view returns (address a) {
        assembly { a := sload(ADMIN_SLOT) }
    }

    fallback() external payable { _delegate(); }

    receive() external payable { _delegate(); }

    function _delegate() private {
        assembly {
            let impl := sload(IMPLEMENTATION_SLOT)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
