// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract EthBridge is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidToken();
    error InvalidAmount();
    error InvalidRecipient();
    error UnsupportedTargetChain();
    error InvalidRelayer();
    error NotRelayer(address caller);
    error UnknownNonce(uint64 nonce);
    error AlreadyRelayed(uint64 nonce);
    error ZeroReceived();

    event Locked(
        uint64 indexed nonce,
        address indexed sender,
        bytes32 recipient,
        address token,
        uint256 amount,
        string sourceChain,
        string targetChain,
        bytes32 sourceTxHash
    );

    event Relayed(uint64 indexed nonce, bytes32 solanaTxHash);
    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);

    struct Deposit {
        address sender;
        bytes32 recipient;
        address token;
        uint256 amount;
        string sourceChain;
        string targetChain;
        bytes32 sourceTxHash;
        uint40 timestamp;
    }

    uint64 public nextNonce;
    address public relayer;

    mapping(uint64 => Deposit) public deposits;
    mapping(uint64 => bool) public relayed;

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer(msg.sender);
        _;
    }

    constructor(address initialOwner, address initialRelayer)
        Ownable(initialOwner)
    {
        if (initialRelayer == address(0)) revert InvalidRelayer();
        relayer = initialRelayer;
        nextNonce = 1;
    }

    function setRelayer(address newRelayer) external onlyOwner {
        if (newRelayer == address(0)) revert InvalidRelayer();
        address old = relayer;
        relayer = newRelayer;
        emit RelayerUpdated(old, newRelayer);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function lockTokens(
        bytes32 recipient,
        address token,
        uint256 amount,
        string memory targetChain
    ) external whenNotPaused nonReentrant returns (uint64 nonce, bytes32 sourceTxHash) {
        if (recipient == bytes32(0)) revert InvalidRecipient();
        if (token == address(0)) revert InvalidToken();
        if (amount == 0) revert InvalidAmount();
        if (keccak256(bytes(targetChain)) != keccak256(bytes("solana"))) {
            revert UnsupportedTargetChain();
        }

        nonce = nextNonce;
        unchecked {
            nextNonce = nonce + 1;
        }

        IERC20 erc20 = IERC20(token);
        uint256 beforeBal = erc20.balanceOf(address(this));
        erc20.safeTransferFrom(msg.sender, address(this), amount);
        uint256 afterBal = erc20.balanceOf(address(this));

        uint256 received = afterBal - beforeBal;
        if (received == 0) revert ZeroReceived();

        sourceTxHash = keccak256(
            abi.encodePacked(
                block.chainid,
                address(this),
                msg.sender,
                recipient,
                token,
                received,
                nonce,
                block.timestamp
            )
        );

        deposits[nonce] = Deposit({
            sender: msg.sender,
            recipient: recipient,
            token: token,
            amount: received,
            sourceChain: "ethereum",
            targetChain: targetChain,
            sourceTxHash: sourceTxHash,
            timestamp: uint40(block.timestamp)
        });

        emit Locked(
            nonce,
            msg.sender,
            recipient,
            token,
            received,
            "ethereum",
            targetChain,
            sourceTxHash
        );
    }

    function markRelayed(uint64 nonce, bytes32 solanaTxHash) external onlyRelayer {
        if (deposits[nonce].sender == address(0)) revert UnknownNonce(nonce);
        if (relayed[nonce]) revert AlreadyRelayed(nonce);

        relayed[nonce] = true;
        emit Relayed(nonce, solanaTxHash);
    }

    function lockedBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
}