// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev Quotes must use raw token units and an independent, fresh price source.
///      The adapter is a trust boundary; an attacker-controlled quote is not a price safeguard.
interface IStrategyReferenceQuote {
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        external view returns (uint256 amountOut, uint64 observedAt);
}

interface IStrategySpotRouter {
    function swapExactTokensForTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path,
        address to, uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @title AlphaPact personal strategy account — local/GIWA Sepolia prototype
/// @notice One owner, two ERC-20 assets, one fixed spot router, expiring trading permission.
/// @dev No pooled shares, generic calls, delegatecall, manager withdrawals, upgrades, or fees.
///      A rolling spend cap limits gross turnover, NOT market losses. Standard, non-rebasing
///      assets and a reviewed router/quote adapter are required. NOT audited or mainnet-ready.
contract AlphaPactStrategyAccount is ReentrancyGuard {
    using SafeERC20 for IERC20;

    bool public constant TESTNET_ONLY = true;
    uint64 public constant MAX_SESSION = 7 days;
    uint64 public constant MIN_TRADE_INTERVAL = 15 minutes;
    uint64 public constant MAX_QUOTE_AGE = 60;
    uint64 public constant MAX_DEADLINE = 5 minutes;
    uint16 public constant MAX_SLIPPAGE_BPS = 100;

    address public immutable owner;
    IERC20 public immutable budgetToken;
    IERC20 public immutable positionToken;
    IStrategySpotRouter public immutable router;
    IStrategyReferenceQuote public immutable referenceQuote;

    struct Session {
        address strategist;
        uint64 expiresAt;
        uint128 maxTradeBudget;
        uint128 maxRollingDayBudget;
        uint16 maxSlippageBps;
        bytes32 strategyHash;
    }

    struct Spend { uint64 at; uint192 budget; }
    Session public session;
    uint256 public sessionId;
    uint256 public nextNonce;
    uint64 public lastTradeAt;
    uint256 private _rollingSpend;
    uint256 private _head;
    uint256 private _tail;
    mapping(uint256 => Spend) private _spends;

    error UnsupportedNetwork();
    error InvalidConfiguration();
    error NotOwner();
    error NotStrategist();
    error SessionUnavailable();
    error InvalidSequence();
    error InvalidTrade();
    error TradeTooSoon();
    error QuoteUnavailable();
    error SpendLimitExceeded();
    error InsufficientOutput();
    error UnexpectedInputDelta();
    error NativeWithdrawalFailed();

    event SessionGranted(uint256 indexed sessionId, address indexed strategist,
        uint64 expiresAt, uint128 maxTradeBudget, uint128 maxRollingDayBudget,
        uint16 maxSlippageBps, bytes32 strategyHash);
    event SessionRevoked(uint256 indexed sessionId);
    event SwapExecuted(uint256 indexed sessionId, uint256 indexed nonce,
        bytes32 indexed signalHash, address tokenIn, uint256 amountIn,
        uint256 amountOut, uint256 budgetSpent, uint64 quoteObservedAt);
    event TokenWithdrawn(address indexed token, uint256 amount);
    event NativeWithdrawn(uint256 amount);

    constructor(address owner_, address budgetToken_, address positionToken_,
        address router_, address referenceQuote_) {
        if (block.chainid != 31337 && block.chainid != 91342) revert UnsupportedNetwork();
        if (owner_ == address(0) || owner_ == address(this) ||
            budgetToken_ == positionToken_ || budgetToken_.code.length == 0 ||
            positionToken_.code.length == 0 || router_.code.length == 0 ||
            referenceQuote_.code.length == 0 || owner_ == router_ || owner_ == referenceQuote_ ||
            owner_ == budgetToken_ || owner_ == positionToken_ || router_ == referenceQuote_ ||
            router_ == budgetToken_ || router_ == positionToken_ ||
            referenceQuote_ == budgetToken_ || referenceQuote_ == positionToken_) {
            revert InvalidConfiguration();
        }
        owner = owner_;
        budgetToken = IERC20(budgetToken_);
        positionToken = IERC20(positionToken_);
        router = IStrategySpotRouter(router_);
        referenceQuote = IStrategyReferenceQuote(referenceQuote_);
    }

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    /// @notice Only the owner changes trading permission; turnover history never resets here.
    function grantSession(Session calldata requested) external onlyOwner nonReentrant {
        _grantSession(requested);
    }

    function _grantSession(Session memory requested) internal {
        if (requested.strategist == address(0) || requested.strategist == address(this) ||
            requested.strategist == address(router) || requested.strategist == address(referenceQuote) ||
            requested.strategist == address(budgetToken) || requested.strategist == address(positionToken) ||
            requested.expiresAt <= block.timestamp || requested.expiresAt > block.timestamp + MAX_SESSION ||
            requested.maxTradeBudget == 0 || requested.maxRollingDayBudget < requested.maxTradeBudget ||
            requested.maxSlippageBps == 0 || requested.maxSlippageBps > MAX_SLIPPAGE_BPS ||
            requested.strategyHash == bytes32(0)) revert InvalidConfiguration();
        session = requested;
        ++sessionId;
        emit SessionGranted(sessionId, requested.strategist, requested.expiresAt,
            requested.maxTradeBudget, requested.maxRollingDayBudget,
            requested.maxSlippageBps, requested.strategyHash);
    }

    /// @notice Cancels future authority once mined; cannot undo an earlier mined swap.
    function revokeSession() external onlyOwner nonReentrant {
        _revokeSession();
    }

    /// @notice Gross input value over the trailing 24h, in raw budget-token units (not USD).
    function rollingDaySpent() public view returns (uint256 spent) {
        spent = _rollingSpend;
        for (uint256 i = _head; i < _tail && _spends[i].at + 1 days <= block.timestamp; ++i) {
            spent -= _spends[i].budget;
        }
    }

    /// @notice The strategist can only swap the fixed pair to THIS account through THIS router.
    function swap(bool buyPosition, uint256 amountIn, uint256 amountOutMin,
        uint256 expectedSessionId, uint256 expectedNonce, uint64 deadline,
        bytes32 signalHash) external nonReentrant returns (uint256 amountOut) {
        Session memory active = session;
        if (active.strategist == address(0) || block.timestamp >= active.expiresAt) revert SessionUnavailable();
        if (msg.sender != active.strategist) revert NotStrategist();
        if (expectedSessionId != sessionId || expectedNonce != nextNonce) revert InvalidSequence();
        if (amountIn == 0 || amountOutMin == 0 || signalHash == bytes32(0) ||
            deadline < block.timestamp || deadline > block.timestamp + MAX_DEADLINE) revert InvalidTrade();
        if (lastTradeAt != 0 && block.timestamp < lastTradeAt + MIN_TRADE_INTERVAL) revert TradeTooSoon();

        IERC20 tokenIn = buyPosition ? budgetToken : positionToken;
        IERC20 tokenOut = buyPosition ? positionToken : budgetToken;
        (uint256 referenceOut, uint64 observedAt) = referenceQuote.quote(address(tokenIn), address(tokenOut), amountIn);
        if (referenceOut == 0 || observedAt == 0 || observedAt > block.timestamp ||
            block.timestamp - observedAt > MAX_QUOTE_AGE) revert QuoteUnavailable();
        uint256 minimum = Math.mulDiv(referenceOut, 10_000 - active.maxSlippageBps, 10_000, Math.Rounding.Ceil);
        if (amountOutMin < minimum) revert InsufficientOutput();
        uint256 budgetSpent = buyPosition ? amountIn : referenceOut;
        _pruneSpends();
        if (budgetSpent > active.maxTradeBudget ||
            _rollingSpend + budgetSpent > active.maxRollingDayBudget) revert SpendLimitExceeded();

        uint256 beforeIn = tokenIn.balanceOf(address(this));
        uint256 beforeOut = tokenOut.balanceOf(address(this));
        _spends[_tail++] = Spend(uint64(block.timestamp), uint192(budgetSpent));
        _rollingSpend += budgetSpent;
        lastTradeAt = uint64(block.timestamp);
        ++nextNonce;

        address[] memory path = new address[](2);
        path[0] = address(tokenIn);
        path[1] = address(tokenOut);
        tokenIn.forceApprove(address(router), amountIn);
        router.swapExactTokensForTokens(amountIn, amountOutMin, path, address(this), deadline);
        tokenIn.forceApprove(address(router), 0);

        uint256 afterIn = tokenIn.balanceOf(address(this));
        uint256 afterOut = tokenOut.balanceOf(address(this));
        if (afterIn > beforeIn || beforeIn - afterIn != amountIn) revert UnexpectedInputDelta();
        if (afterOut < beforeOut || afterOut - beforeOut < amountOutMin) revert InsufficientOutput();
        amountOut = afterOut - beforeOut;
        emit SwapExecuted(sessionId, expectedNonce, signalHash, address(tokenIn), amountIn,
            amountOut, budgetSpent, observedAt);
    }

    /// @notice Independent of strategy, router, oracle and session status. Recipient is fixed.
    /// @dev Returns the held token, without promising a sale, fiat conversion or loss recovery.
    function withdrawToken(IERC20 token, uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidTrade();
        token.safeTransfer(owner, amount);
        emit TokenWithdrawn(address(token), amount);
    }

    /// @notice One atomic exit for the standard pair. No sale or oracle call is required.
    /// @dev If an asset itself blocks transfers, revokeSession and individual recovery remain
    ///      separate entry points; a frozen token can never be made redeemable by this account.
    function revokeAndWithdraw() external onlyOwner nonReentrant {
        _revokeAndWithdraw();
    }

    function _revokeAndWithdraw() internal {
        _revokeSession();
        uint256 budget = budgetToken.balanceOf(address(this));
        uint256 position = positionToken.balanceOf(address(this));
        if (budget != 0) { budgetToken.safeTransfer(owner, budget); emit TokenWithdrawn(address(budgetToken), budget); }
        if (position != 0) { positionToken.safeTransfer(owner, position); emit TokenWithdrawn(address(positionToken), position); }
    }

    function withdrawNative(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidTrade();
        (bool ok,) = payable(owner).call{value: amount}("");
        if (!ok) revert NativeWithdrawalFailed();
        emit NativeWithdrawn(amount);
    }

    receive() external payable {}

    function _revokeSession() internal {
        // Retain the owner's last limits as readable configuration, never authority.
        session.strategist = address(0);
        session.expiresAt = 0;
        ++sessionId;
        emit SessionRevoked(sessionId);
    }

    function _pruneSpends() private {
        // The 15-minute interval bounds live entries to 96, including across session changes.
        while (_head < _tail && _spends[_head].at + 1 days <= block.timestamp) {
            _rollingSpend -= _spends[_head].budget;
            delete _spends[_head++];
        }
    }
}
