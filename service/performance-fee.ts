const BASIS_POINTS = 10_000n;

export const performanceFeeRates = { creator: 800n, platform: 200n } as const;

export type FeeCheckpoint = { highWaterProfit: bigint };

export const initialFeeCheckpoint: FeeCheckpoint = { highWaterProfit: 0n };

function shareOf(profit: bigint, rate: bigint) {
  return profit * rate / BASIS_POINTS;
}

export function settlePerformanceFee(
  checkpoint: FeeCheckpoint,
  equityBeforeFee: bigint,
  netContributions: bigint,
) {
  // Equity includes open positions, trading costs and past performance fees.
  // Add past fees back to compare like-for-like portfolio profits over time.
  const previousProfit = checkpoint.highWaterProfit;
  const previousCreatorFees = shareOf(previousProfit, performanceFeeRates.creator);
  const previousPlatformFees = shareOf(previousProfit, performanceFeeRates.platform);
  const cumulativeProfit = equityBeforeFee - netContributions + previousCreatorFees + previousPlatformFees;
  const highWaterProfit = cumulativeProfit > previousProfit ? cumulativeProfit : previousProfit;
  const eligibleProfit = highWaterProfit - previousProfit;
  const creatorFee = shareOf(highWaterProfit, performanceFeeRates.creator) - previousCreatorFees;
  const platformFee = shareOf(highWaterProfit, performanceFeeRates.platform) - previousPlatformFees;
  const fee = creatorFee + platformFee;

  return {
    checkpoint: { highWaterProfit },
    cumulativeProfit,
    eligibleProfit,
    creatorFee,
    platformFee,
    fee,
    equityAfterFee: equityBeforeFee - fee,
  };
}

export const settlementScenarios = {
  scheduled: { name: "정기 분할 매수", balancesBps: [10_000, 9_000, 10_000, 10_500] },
  balanced: { name: "목표 비중 리밸런싱", balancesBps: [10_000, 9_400, 10_000, 10_300] },
} as const;

export type SettlementScenario = keyof typeof settlementScenarios;

export function replaySettlements(capital: bigint, scenario: SettlementScenario) {
  let checkpoint = initialFeeCheckpoint;
  let paidFees = 0n;

  return settlementScenarios[scenario].balancesBps.map(balanceBps => {
    const illustrativeValue = capital * BigInt(balanceBps) / BASIS_POINTS;
    const equityBeforeFee = illustrativeValue - paidFees;
    const settlement = settlePerformanceFee(checkpoint, equityBeforeFee, capital);
    checkpoint = settlement.checkpoint;
    paidFees += settlement.fee;
    return { ...settlement, equityBeforeFee };
  });
}
