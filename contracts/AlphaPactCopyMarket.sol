// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AlphaPactStrategyAccount, IStrategyReferenceQuote} from "./AlphaPactStrategyAccount.sol";
import {AlphaPactPracticeAsset, AlphaPactPracticeRouter, AlphaPactTestnetAccount} from "./AlphaPactTestnetService.sol";
import {AlphaPactCopySignalExecutor} from "./AlphaPactCopySignalExecutor.sol";
import {AlphaPactScheduledCopyRule} from "./AlphaPactScheduledCopyRule.sol";

/// @notice Deterministic quote for valueless test assets only.
contract AlphaPactFixedTestQuote is IStrategyReferenceQuote {
    uint256 public constant TEST_PRICE = 2_000;
    address public immutable budget;
    address public immutable position;

    constructor(address budget_, address position_) {
        budget = budget_;
        position = position_;
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256, uint64) {
        if (tokenIn == budget && tokenOut == position) return (amountIn * 1e12 / TEST_PRICE, uint64(block.timestamp));
        require(tokenIn == position && tokenOut == budget, "PAIR_UNSUPPORTED");
        return (amountIn * TEST_PRICE / 1e12, uint64(block.timestamp));
    }
}

/// @notice Open registry and signed follower accounts using the GIWA Sepolia practice venue.
contract AlphaPactCopyMarket is EIP712, ReentrancyGuard {
    bytes32 public constant REGISTER_TYPEHASH = keccak256(
        "RegisterStrategy(address creator,string name,uint128 amount,uint64 interval,uint64 deadline)"
    );
    bytes32 public constant FOLLOW_TYPEHASH = keccak256(
        "FollowStrategy(address owner,uint256 strategyId,uint128 maxTradeBudget,uint128 maxRollingDayBudget,uint64 expiresAt,uint64 deadline)"
    );
    uint64 public constant FIRST_TRADE_DELAY = 60;
    uint256 public constant INITIAL_BUDGET = 10_000e6;

    struct Strategy {
        address creator;
        string name;
        uint128 amount;
        uint64 interval;
    }

    struct Subscription {
        address owner;
        uint256 strategyId;
        address account;
        address rule;
        uint64 startsAt;
    }

    struct Follow {
        address owner;
        uint256 strategyId;
        uint128 maxTradeBudget;
        uint128 maxRollingDayBudget;
        uint64 expiresAt;
        uint64 deadline;
    }

    AlphaPactPracticeAsset public immutable budget;
    AlphaPactPracticeAsset public immutable position;
    AlphaPactFixedTestQuote public immutable referenceQuote;
    AlphaPactPracticeRouter public immutable router;
    AlphaPactCopySignalExecutor public immutable executor;

    Strategy[] private _strategies;
    Subscription[] private _subscriptions;
    mapping(bytes32 => uint256) private _strategyIds;
    mapping(address => mapping(uint256 => uint256)) public subscriptionIdOf;
    mapping(address => uint256[]) private _subscriptionsOf;

    event StrategyRegistered(uint256 indexed strategyId, address indexed creator, string name, uint128 amount, uint64 interval);
    event StrategyFollowed(uint256 indexed subscriptionId, uint256 indexed strategyId, address indexed owner, address account, address rule);

    constructor() EIP712("AlphaPactCopyMarket", "1") {
        require(block.chainid == 91342 || block.chainid == 31337, "TESTNET_ONLY");
        budget = new AlphaPactPracticeAsset("AlphaPact Copy Test USD", "tUSD", 6);
        position = new AlphaPactPracticeAsset("AlphaPact Copy Test Ether", "tETH", 18);
        referenceQuote = new AlphaPactFixedTestQuote(address(budget), address(position));
        router = new AlphaPactPracticeRouter(address(referenceQuote));
        executor = new AlphaPactCopySignalExecutor();
        budget.seedTestVenue(address(router));
        position.seedTestVenue(address(router));
    }

    function register(address creator, string calldata name, uint128 amount, uint64 interval, uint64 deadline, bytes calldata signature)
        external nonReentrant returns (uint256 id)
    {
        _checkDeadline(deadline);
        require(creator != address(0) && bytes(name).length > 0 && bytes(name).length <= 108 &&
            amount >= 10e6 && amount <= 2_500e6 && interval >= 15 minutes && interval <= 1 days, "STRATEGY_INVALID");
        bytes32 nameHash = keccak256(bytes(name));
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(REGISTER_TYPEHASH, creator, nameHash, amount, interval, deadline)));
        require(SignatureChecker.isValidSignatureNow(creator, digest, signature), "CREATOR_SIGNATURE_INVALID");
        bytes32 key = keccak256(abi.encode(creator, nameHash, amount, interval));
        id = _strategyIds[key];
        if (id != 0) return id;
        _strategies.push(Strategy(creator, name, amount, interval));
        id = _strategies.length;
        _strategyIds[key] = id;
        emit StrategyRegistered(id, creator, name, amount, interval);
    }

    function follow(Follow calldata request, bytes calldata signature) external nonReentrant returns (uint256 id) {
        _checkDeadline(request.deadline);
        uint64 startsAt = uint64(block.timestamp) + FIRST_TRADE_DELAY;
        require(request.owner != address(0) && request.expiresAt > startsAt && request.expiresAt <= block.timestamp + 7 days &&
            request.maxTradeBudget >= 10e6 && request.maxTradeBudget <= 2_500e6 &&
            request.maxRollingDayBudget >= request.maxTradeBudget && request.maxRollingDayBudget <= 5_000e6, "FOLLOW_LIMITS_INVALID");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(FOLLOW_TYPEHASH, request)));
        require(SignatureChecker.isValidSignatureNow(request.owner, digest, signature), "FOLLOWER_SIGNATURE_INVALID");
        id = subscriptionIdOf[request.owner][request.strategyId];
        if (id != 0) return id;
        Strategy storage strategy = _strategies[request.strategyId - 1];
        (address account, address rule) = _openAccount(request, strategy, startsAt);
        _subscriptions.push(Subscription(request.owner, request.strategyId, account, rule, startsAt));
        id = _subscriptions.length;
        subscriptionIdOf[request.owner][request.strategyId] = id;
        _subscriptionsOf[request.owner].push(id);
        emit StrategyFollowed(id, request.strategyId, request.owner, account, rule);
    }

    function _openAccount(Follow calldata request, Strategy storage strategy, uint64 startsAt)
        private returns (address account, address rule)
    {
        (uint256 output,) = referenceQuote.quote(address(budget), address(position), strategy.amount);
        AlphaPactScheduledCopyRule schedule = new AlphaPactScheduledCopyRule(executor, AlphaPactScheduledCopyRule.Schedule({
            tokenIn: address(budget), tokenOut: address(position), amountIn: strategy.amount,
            minAmountOut: output * 99 / 100, startsAt: startsAt, interval: strategy.interval
        }));
        rule = address(schedule);
        account = address(new AlphaPactTestnetAccount(
            request.owner, address(budget), address(position), address(router), address(referenceQuote),
            AlphaPactStrategyAccount.Session({
                strategist: address(executor), expiresAt: request.expiresAt, maxTradeBudget: request.maxTradeBudget,
                maxRollingDayBudget: request.maxRollingDayBudget, maxSlippageBps: 100,
                strategyHash: executor.strategyBinding(rule, schedule.strategyVersion())
            })
        ));
        if (budget.factory() == address(0)) budget.setFactory(address(this));
        budget.issueToAccount(account, INITIAL_BUDGET);
    }

    function strategyCount() external view returns (uint256) { return _strategies.length; }
    function strategyAt(uint256 id) external view returns (Strategy memory) { return _strategies[id - 1]; }
    function subscriptionCount() external view returns (uint256) { return _subscriptions.length; }
    function subscriptionAt(uint256 id) external view returns (Subscription memory) { return _subscriptions[id - 1]; }
    function ownerSubscriptionCount(address owner) external view returns (uint256) { return _subscriptionsOf[owner].length; }
    function ownerSubscriptionAt(address owner, uint256 index) external view returns (uint256) { return _subscriptionsOf[owner][index]; }

    function _checkDeadline(uint64 deadline) private view {
        require(deadline >= block.timestamp && deadline <= block.timestamp + 15 minutes, "AUTHORIZATION_EXPIRED");
    }
}
