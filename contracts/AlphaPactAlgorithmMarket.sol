// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {AlphaPactCopySignalExecutor} from "./AlphaPactCopySignalExecutor.sol";
import {AlphaPactStrategyAccount} from "./AlphaPactStrategyAccount.sol";
import {AlphaPactTestnetAccount, AlphaPactPracticeAsset, AlphaPactPracticeRouter} from "./AlphaPactTestnetService.sol";
import {AlphaPactFixedTestQuote} from "./AlphaPactCopyMarket.sol";

/// @notice Fixed, synthetic ETH/USD closes. No account can modify or choose the candle presented to a rule.
contract AlphaPactCandleReplay {
    uint64 public constant INTERVAL = 120;
    uint64 public immutable epoch = uint64(block.timestamp);

    function snapshot() external view returns (uint64 sequence, uint64 openedAt, uint24[8] memory closes) {
        uint64 elapsed = uint64(block.timestamp) - epoch;
        uint64 candle = elapsed / INTERVAL;
        sequence = candle + 1;
        openedAt = epoch + candle * INTERVAL;
        uint24[12] memory tape = [
            uint24(200_000), 198_400, 194_000, 192_500, 197_800, 204_000,
            210_000, 211_500, 208_200, 201_500, 195_000, 192_000
        ];
        for (uint256 i; i < closes.length; ++i) closes[i] = tape[(candle + tape.length - i) % tape.length];
    }
}

/// @notice Immutable, gas-bounded conditions evaluated against the published replay contract.
/// @dev Opcodes: close u8, constant u24, SMA u8/u8, >, <, AND, OR, NOT. No external calls from program data.
contract AlphaPactAlgorithmRule is IERC1271 {
    enum Decision { HOLD, BUY, SELL }

    AlphaPactCopySignalExecutor public immutable executor;
    AlphaPactCandleReplay public immutable replay;
    AlphaPactFixedTestQuote public immutable quote;
    uint128 public immutable amount;
    bytes32 public immutable strategyVersion;
    bytes public buyCondition;
    bytes public sellCondition;

    error InvalidProgram();
    error NoOrder();

    constructor(AlphaPactCopySignalExecutor executor_, AlphaPactCandleReplay replay_, AlphaPactFixedTestQuote quote_,
        uint128 amount_, bytes memory buy_, bytes memory sell_) {
        (,, uint24[8] memory closes) = replay_.snapshot();
        _condition(buy_, closes);
        _condition(sell_, closes);
        executor = executor_;
        replay = replay_;
        quote = quote_;
        amount = amount_;
        buyCondition = buy_;
        sellCondition = sell_;
        strategyVersion = keccak256(abi.encode(address(replay_), amount_, buy_, sell_));
    }

    function decision() public view returns (Decision side, uint64 sequence, uint64 openedAt, uint24 close) {
        uint24[8] memory closes;
        (sequence, openedAt, closes) = replay.snapshot();
        bool buy = _condition(buyCondition, closes);
        bool sell = _condition(sellCondition, closes);
        side = buy == sell ? Decision.HOLD : buy ? Decision.BUY : Decision.SELL;
        close = closes[0];
    }

    function currentSignal() public view returns (AlphaPactCopySignalExecutor.CopySignal memory signal) {
        (Decision side, uint64 sequence, uint64 openedAt,) = decision();
        if (side == Decision.HOLD) revert NoOrder();
        bool buy = side == Decision.BUY;
        address tokenIn = buy ? quote.budget() : quote.position();
        address tokenOut = buy ? quote.position() : quote.budget();
        uint256 amountIn = amount;
        if (!buy) (amountIn,) = quote.quote(tokenOut, tokenIn, amountIn);
        (uint256 output,) = quote.quote(tokenIn, tokenOut, amountIn);
        signal = AlphaPactCopySignalExecutor.CopySignal(strategyVersion, tokenIn, tokenOut, amountIn, output * 99 / 100,
            sequence, openedAt, openedAt + replay.INTERVAL());
    }

    function execute(AlphaPactStrategyAccount account) external returns (uint256) {
        return executor.execute(account, address(this), currentSignal(), "");
    }

    function isValidSignature(bytes32 hash, bytes calldata) external view override returns (bytes4) {
        return hash == executor.hashSignal(currentSignal()) ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    function _condition(bytes memory code, uint24[8] memory closes) private pure returns (bool) {
        if (code.length == 0 || code.length > 112) revert InvalidProgram();
        uint256[24] memory stack;
        bool[24] memory logical;
        uint256 size;
        uint256 cursor;
        while (cursor < code.length) {
            uint8 op = uint8(code[cursor++]);
            if (op >= 1 && op <= 3) {
                uint256 value;
                if (size == stack.length || cursor >= code.length) revert InvalidProgram();
                uint8 i = uint8(code[cursor++]);
                if (op == 1) {
                    if (i >= 8) revert InvalidProgram();
                    value = closes[i];
                } else if (op == 2) {
                    if (cursor + 1 >= code.length) revert InvalidProgram();
                    value = (uint256(i) << 16) | (uint256(uint8(code[cursor])) << 8) | uint8(code[cursor + 1]);
                    cursor += 2;
                } else {
                    if (cursor >= code.length) revert InvalidProgram();
                    uint256 length = uint8(code[cursor++]);
                    if (length < 2 || uint256(i) + length > 8) revert InvalidProgram();
                    for (uint256 j; j < length; ++j) value += closes[uint256(i) + j];
                    value /= length;
                }
                logical[size] = false;
                stack[size++] = value;
            } else if (op == 8) {
                if (size < 1 || !logical[size - 1]) revert InvalidProgram();
                stack[size - 1] = 1 - stack[size - 1];
            } else {
                if (size < 2 || op < 4 || op > 7) revert InvalidProgram();
                uint256 right = --size;
                uint256 left = size - 1;
                if (logical[left] != (op >= 6) || logical[right] != (op >= 6)) revert InvalidProgram();
                uint256 x = stack[left];
                uint256 y = stack[right];
                bool result = op == 4 ? x > y : op == 5 ? x < y : op == 6 ? x == 1 && y == 1 : x == 1 || y == 1;
                stack[left] = result ? 1 : 0;
                logical[left] = true;
            }
        }
        if (size != 1 || !logical[0]) revert InvalidProgram();
        return stack[0] == 1;
    }
}

contract AlphaPactAlgorithmAccountFactory {
    address private immutable _market = msg.sender;

    function open(address owner, address budget, address position, address router, address quote,
        AlphaPactStrategyAccount.Session calldata permission) external returns (address) {
        require(msg.sender == _market, "MARKET_REQUIRED");
        return address(new AlphaPactTestnetAccount(owner, budget, position, router, quote, permission));
    }
}

/// @notice Registers creator-authored rules and opens independent GIWA Sepolia follower accounts.
contract AlphaPactAlgorithmMarket is EIP712, ReentrancyGuard {
    bytes32 public constant REGISTER_TYPEHASH = keccak256(
        "RegisterAlgorithm(address creator,string name,uint128 amount,bytes32 programHash,uint64 deadline)"
    );
    bytes32 public constant FOLLOW_TYPEHASH = keccak256(
        "FollowStrategy(address owner,uint256 strategyId,uint128 maxTradeBudget,uint128 maxRollingDayBudget,uint64 expiresAt,uint64 deadline)"
    );
    uint256 public constant INITIAL_BUDGET = 10_000e6;

    struct Strategy {
        address creator;
        string name;
        uint128 amount;
        uint64 interval;
        address rule;
        bytes32 programHash;
        bytes buyCondition;
        bytes sellCondition;
    }
    struct Subscription { address owner; uint256 strategyId; address account; address rule; uint64 startsAt; }
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
    AlphaPactCandleReplay public immutable replay;
    AlphaPactAlgorithmAccountFactory private immutable _accountFactory;
    Strategy[] private _strategies;
    Subscription[] private _subscriptions;
    mapping(bytes32 => uint256) private _strategyIds;
    mapping(address => mapping(uint256 => uint256)) public subscriptionIdOf;
    mapping(address => uint256[]) private _subscriptionsOf;

    event AlgorithmRegistered(uint256 indexed strategyId, address indexed creator, address rule, bytes32 programHash);
    event StrategyFollowed(uint256 indexed subscriptionId, uint256 indexed strategyId, address indexed owner, address account, address rule);

    constructor(AlphaPactCopySignalExecutor executor_) EIP712("AlphaPactAlgorithmMarket", "1") {
        require((block.chainid == 91342 || block.chainid == 31337) && address(executor_).code.length != 0, "TESTNET_ONLY");
        executor = executor_;
        replay = new AlphaPactCandleReplay();
        budget = new AlphaPactPracticeAsset("AlphaPact Algorithm Test USD", "tUSD", 6);
        position = new AlphaPactPracticeAsset("AlphaPact Algorithm Test Ether", "tETH", 18);
        referenceQuote = new AlphaPactFixedTestQuote(address(budget), address(position));
        router = new AlphaPactPracticeRouter(address(referenceQuote));
        _accountFactory = new AlphaPactAlgorithmAccountFactory();
        budget.seedTestVenue(address(router));
        position.seedTestVenue(address(router));
    }

    function strategyIdOf(address creator, string calldata name, uint128 amount, bytes32 programHash) external view returns (uint256) {
        return _strategyIds[keccak256(abi.encode(creator, keccak256(bytes(name)), amount, programHash))];
    }

    function registerAlgorithm(address creator, string calldata name, uint128 amount, bytes calldata buyCondition,
        bytes calldata sellCondition, uint64 deadline, bytes calldata signature) external nonReentrant returns (uint256 id) {
        _checkDeadline(deadline);
        require(creator != address(0) && bytes(name).length > 0 && bytes(name).length <= 108 &&
            amount >= 10e6 && amount <= 2_500e6 && buyCondition.length <= 112 && sellCondition.length <= 112, "ALGORITHM_INVALID");
        bytes32 programHash = keccak256(abi.encode(buyCondition, sellCondition));
        bytes32 nameHash = keccak256(bytes(name));
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(REGISTER_TYPEHASH, creator, nameHash, amount, programHash, deadline)));
        require(SignatureChecker.isValidSignatureNow(creator, digest, signature), "CREATOR_SIGNATURE_INVALID");
        bytes32 key = keccak256(abi.encode(creator, nameHash, amount, programHash));
        id = _strategyIds[key];
        if (id != 0) return id;
        address rule = address(new AlphaPactAlgorithmRule(executor, replay, referenceQuote, amount, buyCondition, sellCondition));
        _strategies.push(Strategy(creator, name, amount, replay.INTERVAL(), rule, programHash, buyCondition, sellCondition));
        id = _strategies.length;
        _strategyIds[key] = id;
        emit AlgorithmRegistered(id, creator, rule, programHash);
    }

    function follow(Follow calldata request, bytes calldata signature) external nonReentrant returns (uint256 id) {
        _checkDeadline(request.deadline);
        (, uint64 openedAt,) = replay.snapshot();
        uint64 startsAt = openedAt + replay.INTERVAL();
        require(request.owner != address(0) && request.expiresAt > startsAt && request.expiresAt <= block.timestamp + 7 days &&
            request.maxTradeBudget >= 10e6 && request.maxTradeBudget <= 2_500e6 &&
            request.maxRollingDayBudget >= request.maxTradeBudget && request.maxRollingDayBudget <= 5_000e6, "FOLLOW_LIMITS_INVALID");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(FOLLOW_TYPEHASH, request)));
        require(SignatureChecker.isValidSignatureNow(request.owner, digest, signature), "FOLLOWER_SIGNATURE_INVALID");
        id = subscriptionIdOf[request.owner][request.strategyId];
        if (id != 0) return id;
        address rule = _strategies[request.strategyId - 1].rule;
        bytes32 version = AlphaPactAlgorithmRule(rule).strategyVersion();
        address account = _accountFactory.open(
            request.owner, address(budget), address(position), address(router), address(referenceQuote),
            AlphaPactStrategyAccount.Session(address(executor), request.expiresAt, request.maxTradeBudget,
                request.maxRollingDayBudget, 100, executor.strategyBinding(rule, version))
        );
        if (budget.factory() == address(0)) budget.setFactory(address(this));
        budget.issueToAccount(account, INITIAL_BUDGET);
        _subscriptions.push(Subscription(request.owner, request.strategyId, account, rule, startsAt));
        id = _subscriptions.length;
        subscriptionIdOf[request.owner][request.strategyId] = id;
        _subscriptionsOf[request.owner].push(id);
        emit StrategyFollowed(id, request.strategyId, request.owner, account, rule);
    }

    function strategyCount() external view returns (uint256) { return _strategies.length; }
    function strategyAt(uint256 id) external view returns (Strategy memory) { return _strategies[id - 1]; }
    function subscriptionAt(uint256 id) external view returns (Subscription memory) { return _subscriptions[id - 1]; }
    function ownerSubscriptionCount(address owner) external view returns (uint256) { return _subscriptionsOf[owner].length; }
    function ownerSubscriptionAt(address owner, uint256 index) external view returns (uint256) { return _subscriptionsOf[owner][index]; }

    function _checkDeadline(uint64 deadline) private view {
        require(deadline >= block.timestamp && deadline <= block.timestamp + 15 minutes, "AUTHORIZATION_EXPIRED");
    }
}
