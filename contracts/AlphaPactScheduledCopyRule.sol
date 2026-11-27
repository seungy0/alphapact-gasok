// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {AlphaPactCopySignalExecutor} from "./AlphaPactCopySignalExecutor.sol";
import {AlphaPactStrategyAccount} from "./AlphaPactStrategyAccount.sol";

/// @notice Derives one copy signal per scheduled window from the chain's block time.
/// @dev A caller pays for the transaction. The executor applies the price floor and follower limits.
contract AlphaPactScheduledCopyRule is IERC1271 {
    struct Schedule {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint64 startsAt;
        uint64 interval;
    }

    AlphaPactCopySignalExecutor public immutable executor;
    bytes32 public immutable strategyVersion;
    address public immutable tokenIn;
    address public immutable tokenOut;
    uint256 public immutable amountIn;
    uint256 public immutable minAmountOut;
    uint64 public immutable startsAt;
    uint64 public immutable interval;
    uint64 public immutable executionWindow;

    error InvalidSchedule();
    error WindowClosed();

    constructor(AlphaPactCopySignalExecutor executor_, Schedule memory schedule) {
        if (address(executor_).code.length == 0 || schedule.tokenIn == schedule.tokenOut ||
            schedule.tokenIn.code.length == 0 || schedule.tokenOut.code.length == 0 ||
            schedule.amountIn == 0 || schedule.minAmountOut == 0 || schedule.startsAt == 0 ||
            schedule.interval < 15 minutes) revert InvalidSchedule();
        executor = executor_;
        strategyVersion = keccak256(abi.encode(schedule));
        tokenIn = schedule.tokenIn;
        tokenOut = schedule.tokenOut;
        amountIn = schedule.amountIn;
        minAmountOut = schedule.minAmountOut;
        startsAt = schedule.startsAt;
        interval = schedule.interval;
        executionWindow = executor_.MAX_SIGNAL_TTL();
    }

    function currentSignal() public view returns (AlphaPactCopySignalExecutor.CopySignal memory) {
        if (block.timestamp < startsAt) revert WindowClosed();
        uint64 elapsed = uint64(block.timestamp) - startsAt;
        uint64 issuedAt = uint64(block.timestamp) - elapsed % interval;
        uint64 expiresAt = issuedAt + executionWindow;
        if (block.timestamp >= expiresAt) revert WindowClosed();
        return AlphaPactCopySignalExecutor.CopySignal({
            strategyVersion: strategyVersion,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minAmountOut,
            sequence: elapsed / interval + 1,
            issuedAt: issuedAt,
            expiresAt: expiresAt
        });
    }

    function execute(AlphaPactStrategyAccount account) external returns (uint256) {
        return executor.execute(account, address(this), currentSignal(), "");
    }

    function isValidSignature(bytes32 hash, bytes calldata) external view override returns (bytes4) {
        return hash == executor.hashSignal(currentSignal()) ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}
