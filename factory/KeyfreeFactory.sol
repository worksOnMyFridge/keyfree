// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Deploys contracts with CREATE2 for exactly one caller: the keyless Keyfree address.
/// Nobody else can use it, so nobody can take a planned address first, and every deploy
/// emits Deployed, which NEAR Read MPC can confirm (a reverted deploy leaves no log).
contract KeyfreeFactory {
    event Deployed(address indexed addr, bytes32 indexed codeHash, bytes32 salt);

    address public immutable keyfree;

    constructor(address keyfree_) {
        keyfree = keyfree_;
    }

    function deploy(bytes32 salt, bytes calldata initCode) external returns (address addr) {
        require(msg.sender == keyfree, "only keyfree");
        bytes memory code = initCode;
        assembly {
            addr := create2(0, add(code, 0x20), mload(code), salt)
        }
        require(addr != address(0), "deploy failed");
        emit Deployed(addr, keccak256(initCode), salt);
    }
}
