// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AlphaPactStrategyAccount} from "./AlphaPactStrategyAccount.sol";

/// @notice Submit a signed strategy signal to an account that has authorized its publisher and version.
/// @dev Accounts must delegate to this contract. Token amounts and quote values use raw units.
contract AlphaPactCopySignalExecutor is EIP712, ReentrancyGuard {
    uint64 public constant MAX_SIGNAL_TTL = 3 minutes;
    bytes32 public constant SIGNAL_TYPEHASH = keccak256(
        "CopySignal(bytes32 strategyVersion,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint64 sequence,uint64 issuedAt,uint64 expiresAt)"
    );

    struct CopySignal {
        bytes32 strategyVersion;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint64 sequence;
        uint64 issuedAt;
        uint64 expiresAt;
    }

    // Keep the high-water mark even if an owner later follows the same version again.
    mapping(address account => mapping(bytes32 strategy => uint64 sequence)) public lastExecutedSequence;

    error UnsupportedNetwork();
    error InvalidSignal();
    error InvalidSignature();
    error StrategyNotAuthorized();
    error SignalAlreadyPassed();
    error SignalPredatesSession();
    error UnsupportedPair();
    error NoSpendCapacity();
    error QuoteUnavailable();
    error SignalPriceMoved();

    constructor() EIP712("AlphaPactCopySignalExecutor", "1") {
        if (block.chainid != 31337 && block.chainid != 91342) revert UnsupportedNetwork();
    }

    function strategyBinding(address publisher, bytes32 strategyVersion) public pure returns (bytes32) {
        return keccak256(abi.encode(publisher, strategyVersion));
    }

    function hashSignal(CopySignal calldata signal) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            SIGNAL_TYPEHASH, signal.strategyVersion, signal.tokenIn, signal.tokenOut, signal.amountIn,
            signal.minAmountOut, signal.sequence, signal.issuedAt, signal.expiresAt
        )));
    }

    function execute(
        AlphaPactStrategyAccount account,
        address publisher,
        CopySignal calldata signal,
        bytes calldata signature
    ) external nonReentrant returns (uint256 amountOut) {
        if (publisher == address(0) || signal.strategyVersion == bytes32(0) ||
            signal.amountIn == 0 || signal.minAmountOut == 0 || signal.sequence == 0 ||
            signal.issuedAt == 0 || signal.issuedAt > block.timestamp ||
            signal.expiresAt <= block.timestamp || signal.expiresAt - signal.issuedAt > MAX_SIGNAL_TTL) {
            revert InvalidSignal();
        }

        (address executor, uint64 sessionExpiry, uint128 tradeCap, uint128 dayCap, uint16 slippageBps, bytes32 binding) =
            account.session();
        if (executor != address(this) || sessionExpiry <= block.timestamp ||
            binding != strategyBinding(publisher, signal.strategyVersion)) revert StrategyNotAuthorized();
        if (signal.sequence <= lastExecutedSequence[address(account)][binding]) revert SignalAlreadyPassed();
        if (signal.issuedAt <= account.sessionGrantedAt()) revert SignalPredatesSession();

        bytes32 digest = hashSignal(signal);
        if (!SignatureChecker.isValidSignatureNow(publisher, digest, signature)) revert InvalidSignature();

        address budget = address(account.budgetToken());
        address position = address(account.positionToken());
        bool buy = signal.tokenIn == budget && signal.tokenOut == position;
        if (!buy && (signal.tokenIn != position || signal.tokenOut != budget)) revert UnsupportedPair();

        uint256 spent = account.rollingDaySpent();
        if (spent >= dayCap) revert NoSpendCapacity();
        uint256 budgetCap = Math.min(tradeCap, dayCap - spent);
        (uint256 amountIn, uint256 referenceOut) = _sizeOrder(account, signal, buy, budgetCap);

        uint256 signedMinimum = Math.mulDiv(signal.minAmountOut, amountIn, signal.amountIn, Math.Rounding.Ceil);
        if (referenceOut < signedMinimum) revert SignalPriceMoved();
        uint256 accountMinimum = Math.mulDiv(referenceOut, 10_000 - slippageBps, 10_000, Math.Rounding.Ceil);

        // Reverting swaps roll back the sequence, allowing a retry within the signal's lifetime.
        lastExecutedSequence[address(account)][binding] = signal.sequence;
        return account.swap(
            buy, amountIn, Math.max(signedMinimum, accountMinimum),
            account.sessionId(), account.nextNonce(), signal.expiresAt, digest
        );
    }

    function _sizeOrder(
        AlphaPactStrategyAccount account,
        CopySignal calldata signal,
        bool buy,
        uint256 budgetCap
    ) private view returns (uint256 amountIn, uint256 referenceOut) {
        amountIn = Math.min(signal.amountIn, IERC20(signal.tokenIn).balanceOf(address(account)));
        if (buy) amountIn = Math.min(amountIn, budgetCap);
        referenceOut = _freshQuote(account, signal, amountIn);

        // Sell caps use the budget token's value. Requote the resized order before dispatch.
        if (!buy && referenceOut > budgetCap) {
            amountIn = Math.mulDiv(amountIn, budgetCap, referenceOut);
            referenceOut = _freshQuote(account, signal, amountIn);
        }
    }

    function _freshQuote(AlphaPactStrategyAccount account, CopySignal calldata signal, uint256 amountIn)
        private view returns (uint256 amountOut)
    {
        if (amountIn == 0) revert NoSpendCapacity();
        uint64 observedAt;
        (amountOut, observedAt) = account.referenceQuote().quote(signal.tokenIn, signal.tokenOut, amountIn);
        if (amountOut == 0 || observedAt == 0 || observedAt > block.timestamp ||
            block.timestamp - observedAt > account.MAX_QUOTE_AGE()) revert QuoteUnavailable();
    }
}
