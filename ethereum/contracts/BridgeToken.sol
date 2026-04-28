// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title BridgeToken
 * @notice A simple ERC-20 token that can be locked in the EthBridge contract.
 *         In production you would bridge an existing token; this contract is
 *         provided so the test-suite has something to work with on Sepolia.
 */
contract BridgeToken is ERC20, Ownable {
    constructor(
        string memory name,
        string memory symbol,
        uint256 initialSupply
    ) ERC20(name, symbol) Ownable(msg.sender) {
        _mint(msg.sender, initialSupply * 10 ** decimals());
    }

    /// @notice Owner can mint additional supply (useful for test faucets)
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
