// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title EthBridge
 * @notice Lock ERC-20 tokens on Ethereum so that the relayer can mint
 *         wrapped SPL tokens on Solana.  Burning wrapped tokens on Solana
 *         triggers the relayer to call `unlock` here, returning funds.
 *
 * Security properties implemented:
 *   - Nonce tracking  → replay protection (each deposit gets a unique nonce)
 *   - k-of-n relayer committee → no single relayer can unlock funds
 *   - Reentrancy guard on state-changing externals
 *   - SafeERC20 for fee-on-transfer / non-standard tokens
 *
 * Trust model:
 *   - Users trust that ≥ k out of n relayers are honest.
 *   - A zkBridge upgrade could replace the committee with a ZK proof of
 *     Solana's validator signatures, making the bridge trustless.
 */
contract EthBridge is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice Minimum relayer signatures required to unlock funds (k-of-n)
    uint256 public threshold;

    /// @notice Set of authorised relayer addresses
    mapping(address => bool) public isRelayer;
    address[] public relayers;

    /// @notice Per-token deposit nonce (monotonically increasing)
    mapping(address => uint256) public depositNonce;

    /**
     * @notice Tracks which unlock messages have already been executed.
     *         key = keccak256(token, recipient, amount, solanaTxSig, nonce)
     */
    mapping(bytes32 => bool) public processedUnlocks;

    /// @notice Accumulated signatures for a pending unlock message
    mapping(bytes32 => mapping(address => bool)) public hasSigned;
    mapping(bytes32 => uint256) public signatureCount;

    // ─── Events ───────────────────────────────────────────────────────────────

    /**
     * @notice Emitted when a user locks tokens.
     * @param token       ERC-20 contract address
     * @param sender      Ethereum depositor
     * @param recipient   Base-58 Solana public key encoded as bytes32
     * @param amount      Token amount (in token's native decimals)
     * @param nonce       Unique deposit nonce for replay protection
     */
    event TokensLocked(
        address indexed token,
        address indexed sender,
        bytes32 indexed recipient,
        uint256 amount,
        uint256 nonce
    );

    /**
     * @notice Emitted when tokens are returned to an Ethereum address after
     *         the corresponding wrapped tokens were burned on Solana.
     */
    event TokensUnlocked(
        address indexed token,
        address indexed recipient,
        uint256 amount,
        bytes32 solanaTxSig
    );

    event RelayerAdded(address relayer);
    event RelayerRemoved(address relayer);
    event ThresholdUpdated(uint256 newThreshold);

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address[] memory _relayers, uint256 _threshold)
        Ownable(msg.sender)
    {
        require(_relayers.length > 0, "Bridge: no relayers");
        require(
            _threshold > 0 && _threshold <= _relayers.length,
            "Bridge: bad threshold"
        );

        for (uint256 i = 0; i < _relayers.length; i++) {
            address r = _relayers[i];
            require(r != address(0), "Bridge: zero address relayer");
            require(!isRelayer[r], "Bridge: duplicate relayer");
            isRelayer[r] = true;
            relayers.push(r);
        }
        threshold = _threshold;
    }

    // ─── User-facing ──────────────────────────────────────────────────────────

    /**
     * @notice Lock `amount` of `token` and request minting on Solana.
     * @param token     ERC-20 to lock
     * @param amount    Amount to lock (caller must approve first)
     * @param recipient Solana destination address encoded as bytes32
     *                  (little-endian 32-byte public key)
     */
    function lockTokens(
        address token,
        uint256 amount,
        bytes32 recipient
    ) external nonReentrant {
        require(amount > 0, "Bridge: zero amount");
        require(token != address(0), "Bridge: zero token");
        require(recipient != bytes32(0), "Bridge: zero recipient");

        uint256 nonce = depositNonce[token]++;

        // Transfer tokens into this contract (handles fee-on-transfer tokens)
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 actual = IERC20(token).balanceOf(address(this)) - balanceBefore;

        emit TokensLocked(token, msg.sender, recipient, actual, nonce);
    }

    // ─── Relayer-facing ───────────────────────────────────────────────────────

    /**
     * @notice Each relayer calls this once to cast a signature for an unlock.
     *         When `threshold` relayers have signed the same message, tokens
     *         are released automatically.
     *
     * @param token       ERC-20 to unlock
     * @param recipient   Ethereum address to receive tokens
     * @param amount      Amount to release
     * @param solanaTxSig 32-byte Solana transaction signature (burn tx)
     * @param nonce       Nonce from the original Solana burn instruction
     */
    function submitUnlock(
        address token,
        address recipient,
        uint256 amount,
        bytes32 solanaTxSig,
        uint256 nonce
    ) external nonReentrant {
        require(isRelayer[msg.sender], "Bridge: not a relayer");
        require(token != address(0) && recipient != address(0), "Bridge: zero address");
        require(amount > 0, "Bridge: zero amount");

        bytes32 msgHash = _unlockHash(token, recipient, amount, solanaTxSig, nonce);

        require(!processedUnlocks[msgHash], "Bridge: already processed");
        require(!hasSigned[msgHash][msg.sender], "Bridge: already signed");

        hasSigned[msgHash][msg.sender] = true;
        signatureCount[msgHash] += 1;

        if (signatureCount[msgHash] >= threshold) {
            processedUnlocks[msgHash] = true;
            IERC20(token).safeTransfer(recipient, amount);
            emit TokensUnlocked(token, recipient, amount, solanaTxSig);
        }
    }

    // ─── Owner admin ──────────────────────────────────────────────────────────

    function addRelayer(address relayer) external onlyOwner {
        require(relayer != address(0), "Bridge: zero address");
        require(!isRelayer[relayer], "Bridge: already relayer");
        isRelayer[relayer] = true;
        relayers.push(relayer);
        emit RelayerAdded(relayer);
    }

    function removeRelayer(address relayer) external onlyOwner {
        require(isRelayer[relayer], "Bridge: not a relayer");
        require(relayers.length - 1 >= threshold, "Bridge: would break threshold");
        isRelayer[relayer] = false;
        for (uint256 i = 0; i < relayers.length; i++) {
            if (relayers[i] == relayer) {
                relayers[i] = relayers[relayers.length - 1];
                relayers.pop();
                break;
            }
        }
        emit RelayerRemoved(relayer);
    }

    function setThreshold(uint256 _threshold) external onlyOwner {
        require(
            _threshold > 0 && _threshold <= relayers.length,
            "Bridge: invalid threshold"
        );
        threshold = _threshold;
        emit ThresholdUpdated(_threshold);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _unlockHash(
        address token,
        address recipient,
        uint256 amount,
        bytes32 solanaTxSig,
        uint256 nonce
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(token, recipient, amount, solanaTxSig, nonce)
        );
    }

    function getRelayers() external view returns (address[] memory) {
        return relayers;
    }

    /// @notice Emergency withdrawal by owner (governance time-lock recommended)
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }
}
