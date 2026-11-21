// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {AlphaPactStrategyAccount, IStrategyReferenceQuote, IStrategySpotRouter} from "./AlphaPactStrategyAccount.sol";

interface IPythTestnet {
    struct Price { int64 price; uint64 conf; int32 expo; uint256 publishTime; }
    function getPriceUnsafe(bytes32 id) external view returns (Price memory);
    function getUpdateFee(bytes[] calldata data) external view returns (uint256);
    function updatePriceFeeds(bytes[] calldata data) external payable;
}

/// @notice Valueless GIWA Sepolia test asset. Not USDC, redeemable money or wrapped ETH.
contract AlphaPactPracticeAsset is ERC20 {
    uint8 private immutable _precision;
    address public immutable controller;
    address public factory;
    bool public venueSeeded;
    mapping(address => uint64) public lastClaimAt;
    constructor(string memory name_, string memory symbol_, uint8 precision_) ERC20(name_, symbol_) {
        require(block.chainid == 91342 || block.chainid == 31337, "TESTNET_ONLY");
        controller = msg.sender; _precision = precision_;
    }
    function decimals() public view override returns (uint8) { return _precision; }
    function setFactory(address factory_) external {
        require(msg.sender == controller && factory == address(0) && factory_.code.length > 0, "FACTORY_LOCKED");
        factory = factory_;
    }
    function issueToAccount(address account, uint256 amount) external {
        require(msg.sender == factory, "NOT_FACTORY");
        _mint(account, amount);
    }
    function seedTestVenue(address venue) external {
        require(msg.sender == controller && !venueSeeded && venue.code.length > 0, "VENUE_ALREADY_SEEDED");
        venueSeeded = true;
        _mint(venue, _precision == 6 ? 1_000_000_000e6 : 1_000_000e18);
    }
    function claim() external {
        require(lastClaimAt[msg.sender] == 0 || block.timestamp >= lastClaimAt[msg.sender] + 1 days, "CLAIM_COOLDOWN");
        lastClaimAt[msg.sender] = uint64(block.timestamp);
        _mint(msg.sender, _precision == 6 ? 10_000e6 : 5e18);
    }
}

/// @notice Reads Pyth's signed ETH/USD feed. No operator-written reference prices.
contract AlphaPactPythQuote is IStrategyReferenceQuote {
    address public immutable budget;
    address public immutable position;
    IPythTestnet public immutable pyth;
    bytes32 public immutable feedId;
    constructor(address budget_, address position_, address pyth_, bytes32 feedId_) {
        budget = budget_; position = position_; pyth = IPythTestnet(pyth_); feedId = feedId_;
    }
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256 amountOut, uint64 observedAt) {
        IPythTestnet.Price memory p = pyth.getPriceUnsafe(feedId);
        require(p.price > 0 && p.expo <= 0 && p.expo >= -12 && p.publishTime <= block.timestamp &&
            block.timestamp - p.publishTime <= 60 && uint256(p.conf) * 100 <= uint256(uint64(p.price)), "PRICE_UNAVAILABLE");
        uint256 scale = 10 ** uint32(-p.expo);
        uint256 value = uint256(uint64(p.price));
        if (tokenIn == budget && tokenOut == position) amountOut = Math.mulDiv(amountIn, 1e12 * scale, value);
        else {
            require(tokenIn == position && tokenOut == budget, "PAIR_UNSUPPORTED");
            amountOut = Math.mulDiv(amountIn, value, 1e12 * scale);
        }
        observedAt = uint64(p.publishTime);
    }
}

/// @notice Operator-published test price, NOT an independently verified oracle.
/// @dev Only valueless test assets. Public API source checks happen offchain and
///      are not proven by sourcesHash. Never use this adapter for customer money.
contract AlphaPactTestnetReferenceQuote is IStrategyReferenceQuote {
    address public immutable publisher;
    address public immutable budget;
    address public immutable position;
    uint256 public priceE8;
    uint64 public observedAt;
    bytes32 public sourcesHash;
    event TestPricePublished(uint256 priceE8, uint64 observedAt, bytes32 sourcesHash);
    constructor(address budget_, address position_) {
        require(block.chainid == 91342 || block.chainid == 31337, "TESTNET_ONLY");
        publisher = msg.sender; budget = budget_; position = position_;
    }
    function publish(uint256 priceE8_, uint64 observedAt_, bytes32 sourcesHash_) external {
        require(msg.sender == publisher, "NOT_PUBLISHER");
        require(priceE8_ > 0 && observedAt_ > observedAt && observedAt_ <= block.timestamp &&
            block.timestamp - observedAt_ <= 60 && sourcesHash_ != bytes32(0), "PRICE_UNAVAILABLE");
        priceE8 = priceE8_; observedAt = observedAt_; sourcesHash = sourcesHash_;
        emit TestPricePublished(priceE8_, observedAt_, sourcesHash_);
    }
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256 amountOut, uint64 at) {
        require(priceE8 > 0 && block.timestamp - observedAt <= 60, "PRICE_UNAVAILABLE");
        if (tokenIn == budget && tokenOut == position) amountOut = Math.mulDiv(amountIn, 1e20, priceE8);
        else {
            require(tokenIn == position && tokenOut == budget, "PAIR_UNSUPPORTED");
            amountOut = Math.mulDiv(amountIn, priceE8, 1e20);
        }
        at = observedAt;
    }
}

/// @notice A simulated test venue: real test token transfers at published reference minus 0.30%.
/// @dev Valueless assets only. This is NOT a market AMM, order book, liquidity or real execution proof.
contract AlphaPactPracticeRouter is IStrategySpotRouter {
    using SafeERC20 for IERC20;
    IStrategyReferenceQuote public immutable referenceQuote;
    uint16 public constant FEE_BPS = 30;
    constructor(address quote_) { referenceQuote = IStrategyReferenceQuote(quote_); }
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path,
        address to, uint256 deadline) external returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline && path.length == 2 && to == msg.sender && amountIn > 0, "INVALID_SWAP");
        (uint256 referenceOut,) = referenceQuote.quote(path[0], path[1], amountIn);
        uint256 output = Math.mulDiv(referenceOut, 10_000 - FEE_BPS, 10_000);
        require(output >= amountOutMin, "OUTPUT_TOO_LOW");
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(path[1]).safeTransfer(to, output);
        amounts = new uint256[](2); amounts[0] = amountIn; amounts[1] = output;
    }
}

/// @notice Adds owner-signed gas-sponsored controls; direct owner recovery always remains available.
contract AlphaPactTestnetAccount is AlphaPactStrategyAccount, EIP712 {
    bytes32 public constant ACTION_TYPEHASH = keccak256("OwnerAction(uint8 action,bytes32 sessionHash,uint256 sessionId,uint256 nonce,uint64 deadline)");
    uint256 public authorizationNonce;
    constructor(address owner_, address budget_, address position_, address router_, address quote_, Session memory initial)
        AlphaPactStrategyAccount(owner_, budget_, position_, router_, quote_) EIP712("AlphaPactAccount", "1") {
        _grantSession(initial);
    }
    function executeOwnerAction(uint8 action, Session calldata requested, uint256 expectedSessionId,
        uint256 nonce, uint64 deadline, bytes calldata signature) external nonReentrant {
        require(deadline >= block.timestamp && deadline <= block.timestamp + 15 minutes &&
            nonce == authorizationNonce && expectedSessionId == sessionId && action <= 2, "AUTHORIZATION_EXPIRED");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(ACTION_TYPEHASH, action,
            keccak256(abi.encode(requested)), expectedSessionId, nonce, deadline)));
        require(SignatureChecker.isValidSignatureNow(owner, digest, signature), "OWNER_SIGNATURE_INVALID");
        ++authorizationNonce;
        if (action == 0) _grantSession(requested);
        else if (action == 1) _revokeSession();
        else _revokeAndWithdraw();
    }
}

/// @notice User-signed, sponsored personal accounts. Factory has no owner/admin over user assets.
contract AlphaPactTestnetFactory is EIP712 {
    bytes32 public constant CREATE_TYPEHASH = keccak256("CreateAccount(address owner,uint8 strategyId,uint128 maxTradeBudget,uint128 maxRollingDayBudget,uint64 expiresAt,uint64 deadline)");
    address public immutable budget;
    address public immutable position;
    address public immutable router;
    address public immutable referenceQuote;
    address public immutable strategist;
    mapping(address => mapping(uint8 => address)) public accounts;
    mapping(address => bool) public isAccount;
    mapping(address => uint8) public strategyOf;
    address[] private _allAccounts;
    event AccountCreated(address indexed owner, address indexed account, uint8 indexed strategyId, uint256 initialBudget);
    constructor(address budget_, address position_, address router_, address quote_, address strategist_) EIP712("AlphaPactFactory", "1") {
        require(block.chainid == 91342 || block.chainid == 31337, "TESTNET_ONLY");
        budget = budget_; position = position_; router = router_; referenceQuote = quote_; strategist = strategist_;
    }
    function createAccount(address owner_, uint8 strategyId, uint128 maxTradeBudget, uint128 maxRollingDayBudget,
        uint64 expiresAt, uint64 deadline, bytes calldata signature) external returns (address deployed) {
        require(owner_ != address(0) && strategyId <= 1 && accounts[owner_][strategyId] == address(0), "ACCOUNT_EXISTS_OR_INVALID");
        require(deadline >= block.timestamp && deadline <= block.timestamp + 15 minutes &&
            expiresAt > block.timestamp && expiresAt <= block.timestamp + 7 days, "AUTHORIZATION_EXPIRED");
        require(maxTradeBudget >= 100e6 && maxTradeBudget <= 2_500e6 &&
            maxRollingDayBudget >= maxTradeBudget && maxRollingDayBudget <= 5_000e6, "LIMITS_INVALID");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CREATE_TYPEHASH, owner_, strategyId,
            maxTradeBudget, maxRollingDayBudget, expiresAt, deadline)));
        require(SignatureChecker.isValidSignatureNow(owner_, digest, signature), "OWNER_SIGNATURE_INVALID");
        AlphaPactStrategyAccount.Session memory initial = AlphaPactStrategyAccount.Session({
            strategist: strategist, expiresAt: expiresAt, maxTradeBudget: maxTradeBudget,
            maxRollingDayBudget: maxRollingDayBudget, maxSlippageBps: 100,
            strategyHash: keccak256(abi.encode("alphapact:public-rule:v1", strategyId))
        });
        deployed = address(new AlphaPactTestnetAccount(owner_, budget, position, router, referenceQuote, initial));
        accounts[owner_][strategyId] = deployed; isAccount[deployed] = true; strategyOf[deployed] = strategyId;
        _allAccounts.push(deployed);
        AlphaPactPracticeAsset(budget).issueToAccount(deployed, 10_000e6);
        emit AccountCreated(owner_, deployed, strategyId, 10_000e6);
    }
    function accountCount() external view returns (uint256) { return _allAccounts.length; }
    function accountAt(uint256 index) external view returns (address) { return _allAccounts[index]; }
}
