import { strict as assert } from "node:assert";
import { test } from "node:test";
import { initialFeeCheckpoint, replaySettlements, settlePerformanceFee } from "../service/performance-fee";

test("settles only the new profit after a drawdown and splits the fee", () => {
  const points = replaySettlements(10_000_000n, "scheduled");
  assert.deepEqual(points.map(point => point.fee), [0n, 0n, 0n, 50_000n]);
  const final = points[3];
  assert.equal(final.eligibleProfit, 500_000n);
  assert.equal(final.creatorFee, 40_000n);
  assert.equal(final.platformFee, 10_000n);
  assert.equal(final.equityAfterFee, 10_450_000n);
});

test("does not charge a previously settled gain again, including after a second drawdown", () => {
  const first = settlePerformanceFee(initialFeeCheckpoint, 10_500_000n, 10_000_000n);
  const duplicate = settlePerformanceFee(first.checkpoint, first.equityAfterFee, 10_000_000n);
  assert.equal(duplicate.fee, 0n);
  const drawdown = settlePerformanceFee(duplicate.checkpoint, 10_000_000n, 10_000_000n);
  assert.equal(drawdown.fee, 0n);
  const second = settlePerformanceFee(drawdown.checkpoint, 10_650_000n, 10_000_000n);
  assert.equal(second.eligibleProfit, 200_000n);
  assert.equal(second.fee, 20_000n);
});

test("excludes deposits and withdrawals and counts losses in marked equity", () => {
  const losing = settlePerformanceFee(initialFeeCheckpoint, 9_000_000n, 10_000_000n);
  const deposit = settlePerformanceFee(losing.checkpoint, 11_000_000n, 12_000_000n);
  assert.equal(deposit.cumulativeProfit, -1_000_000n);
  assert.equal(deposit.fee, 0n);
  const withdrawal = settlePerformanceFee(deposit.checkpoint, 8_000_000n, 9_000_000n);
  assert.equal(withdrawal.cumulativeProfit, deposit.cumulativeProfit);
  assert.equal(withdrawal.fee, 0n);
});

test("preserves fractional fee amounts across checkpoints in whole won", () => {
  let checkpoint = initialFeeCheckpoint;
  let paidFees = 0n;
  let creatorFees = 0n;
  let platformFees = 0n;
  for (let profit = 1n; profit <= 100n; profit++) {
    const settlement = settlePerformanceFee(checkpoint, 1_000n + profit - paidFees, 1_000n);
    checkpoint = settlement.checkpoint;
    paidFees += settlement.fee;
    creatorFees += settlement.creatorFee;
    platformFees += settlement.platformFee;
  }
  assert.equal(checkpoint.highWaterProfit, 100n);
  assert.deepEqual([paidFees, creatorFees, platformFees], [10n, 8n, 2n]);
});
