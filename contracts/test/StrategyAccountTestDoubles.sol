// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStrategyReferenceQuote, IStrategySpotRouter} from "../AlphaPactStrategyAccount.sol";
import {IPythTestnet} from "../AlphaPactTestnetService.sol";

/// @dev Local test fixtures. Mutable prices and freely minted assets are NOT market evidence.
contract StrategyTestToken is ERC20 {
    uint8 private immutable _decimals;
    constructor(string memory symbol_, uint8 decimals_) ERC20(symbol_, symbol_) { _decimals = decimals_; }
    function decimals() public view override returns (uint8) { return _decimals; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract StrategyTestQuote is IStrategyReferenceQuote {
    address public immutable budget;
    address public immutable position;
    uint256 public price = 2_000e6;
    uint64 public observedAt;
    bool public broken;
    constructor(address budget_, address position_) {
        budget = budget_; position = position_; observedAt = uint64(block.timestamp);
    }
    function setQuote(uint256 price_, uint64 observedAt_) external { price = price_; observedAt = observedAt_; }
    function setBroken(bool value) external { broken = value; }
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256, uint64) {
        require(!broken, "TEST_ORACLE_UNAVAILABLE");
        if (price == 0) return (0, observedAt);
        if (tokenIn == budget && tokenOut == position) return (Math.mulDiv(amountIn, 1e18, price), observedAt);
        require(tokenIn == position && tokenOut == budget, "TEST_PAIR_INVALID");
        return (Math.mulDiv(amountIn, price, 1e18), observedAt);
    }
}

contract StrategyTestRouter is IStrategySpotRouter {
    IStrategyReferenceQuote public immutable referenceQuote;
    uint256 public outputBps = 10_000;
    uint256 public inputBps = 10_000;
    bool public broken;
    address public lastRecipient;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackSucceeded;
    bytes public callbackResult;

    constructor(address quote_) { referenceQuote = IStrategyReferenceQuote(quote_); }
    function setExecution(uint256 outputBps_, uint256 inputBps_, bool broken_) external {
        outputBps = outputBps_; inputBps = inputBps_; broken = broken_;
    }
    function setCallback(address target, bytes calldata data) external { callbackTarget = target; callbackData = data; }
    function pullLater(address token, address from, address to, uint256 amount) external {
        IERC20(token).transferFrom(from, to, amount);
    }
    function swapExactTokensForTokens(uint256 amountIn, uint256, address[] calldata path, address to, uint256)
        external returns (uint256[] memory amounts) {
        require(!broken, "TEST_ROUTER_UNAVAILABLE");
        require(path.length == 2, "TEST_PAIR_INVALID");
        lastRecipient = to;
        IERC20(path[0]).transferFrom(msg.sender, address(this), Math.mulDiv(amountIn, inputBps, 10_000));
        if (callbackTarget != address(0)) (callbackSucceeded, callbackResult) = callbackTarget.call(callbackData);
        (uint256 quoted,) = referenceQuote.quote(path[0], path[1], amountIn);
        uint256 output = Math.mulDiv(quoted, outputBps, 10_000);
        IERC20(path[1]).transfer(to, output);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = output;
    }
}

contract StrategyTestStrategist {
    function execute(address target, bytes calldata data) external returns (bytes memory result) {
        bool ok;
        (ok, result) = target.call(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
    }
}

contract ServiceTestPyth is IPythTestnet {
    Price private _price;
    constructor() { _price = Price(2500e8, 1000, -8, block.timestamp); }
    function setPrice(int64 value, uint64 confidence, int32 exponent, uint256 time) external { _price = Price(value, confidence, exponent, time); }
    function getPriceUnsafe(bytes32) external view returns (Price memory) { return _price; }
    function getUpdateFee(bytes[] calldata) external pure returns (uint256) { return 0; }
    function updatePriceFeeds(bytes[] calldata) external payable {}
}
