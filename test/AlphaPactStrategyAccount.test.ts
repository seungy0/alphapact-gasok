/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create({ network: "hardhatOp", chainType: "op" });
const A = 10n ** 6n;
const B = 10n ** 18n;
const SIGNAL = ethers.id("local-test-signal-not-market-evidence");
const STRATEGY = ethers.id("local-test-policy-v1");
const INTERVAL = 15 * 60;

async function fixture() {
  const [owner, strategist, outsider, replacement] = await ethers.getSigners();
  const budget = await ethers.deployContract("StrategyTestToken", ["TEST-BUDGET", 6]);
  const position = await ethers.deployContract("StrategyTestToken", ["TEST-POSITION", 18]);
  const quote = await ethers.deployContract("StrategyTestQuote", [await budget.getAddress(), await position.getAddress()]);
  const router = await ethers.deployContract("StrategyTestRouter", [await quote.getAddress()]);
  const account = await ethers.deployContract("AlphaPactStrategyAccount", [
    owner.address, await budget.getAddress(), await position.getAddress(), await router.getAddress(), await quote.getAddress(),
  ]);
  await budget.mint(await account.getAddress(), 10_000n * A);
  await position.mint(await account.getAddress(), 2n * B);
  await budget.mint(await router.getAddress(), 100_000n * A);
  await position.mint(await router.getAddress(), 100n * B);
  const config = {
    strategist: strategist.address, expiresAt: (await networkHelpers.time.latest()) + 86_400,
    maxTradeBudget: 1_000n * A, maxRollingDayBudget: 1_500n * A,
    maxSlippageBps: 100, strategyHash: STRATEGY,
  };
  await account.connect(owner).grantSession(config);
  return { owner, strategist, outsider, replacement, budget, position, quote, router, account, config };
}

async function freshQuote(f: any, price = 2_000n * A) {
  await f.quote.setQuote(price, await networkHelpers.time.latest());
}

async function swap(f: any, overrides: Record<string, any> = {}) {
  const buy = overrides.buy ?? true;
  const input = overrides.input ?? 500n * A;
  const output = buy ? input * B / (2_000n * A) : input * (2_000n * A) / B;
  return f.account.connect(overrides.caller ?? f.strategist).swap(
    buy, input, overrides.minimum ?? output * 99n / 100n,
    overrides.session ?? await f.account.sessionId(), overrides.nonce ?? await f.account.nextNonce(),
    overrides.deadline ?? (await networkHelpers.time.latest()) + 60, overrides.signal ?? SIGNAL,
  );
}

describe("AlphaPactStrategyAccount (testnet prototype)", function () {
  it("executes a real local token swap to the account, measures balances and clears approval", async function () {
    const f = await fixture();
    await expect(swap(f)).to.emit(f.account, "SwapExecuted");
    expect(await f.budget.balanceOf(await f.account.getAddress())).to.equal(9_500n * A);
    expect(await f.position.balanceOf(await f.account.getAddress())).to.equal(2n * B + B / 4n);
    expect(await f.router.lastRecipient()).to.equal(await f.account.getAddress());
    expect(await f.budget.allowance(await f.account.getAddress(), await f.router.getAddress())).to.equal(0);
    expect(await f.account.nextNonce()).to.equal(1);
    expect(await f.account.rollingDaySpent()).to.equal(500n * A);
  });

  it("makes ownership and the allowed assets, router and quote adapter immutable", async function () {
    const f = await fixture();
    expect(await f.account.owner()).to.equal(f.owner.address);
    expect(await f.account.budgetToken()).to.equal(await f.budget.getAddress());
    expect(await f.account.positionToken()).to.equal(await f.position.getAddress());
    expect(await f.account.router()).to.equal(await f.router.getAddress());
    expect(await f.account.referenceQuote()).to.equal(await f.quote.getAddress());
    expect(await f.account.TESTNET_ONLY()).to.equal(true);
    await expect(ethers.deployContract("AlphaPactStrategyAccount", [f.owner.address,
      await f.budget.getAddress(), await f.budget.getAddress(), await f.router.getAddress(), await f.quote.getAddress(),
    ])).to.be.revertedWithCustomError(f.account, "InvalidConfiguration");
  });

  it("refuses deployment on a simulated Ethereum mainnet chain ID", async function () {
    const f = await fixture();
    const foreign = await network.create({ network: "hardhatOp", chainType: "op", override: { chainId: 1 } });
    try {
      const [signer] = await foreign.ethers.getSigners();
      await expect(foreign.ethers.deployContract("AlphaPactStrategyAccount", Array(5).fill(signer.address)))
        .to.be.revertedWithCustomError(f.account, "UnsupportedNetwork");
    } finally { await foreign.close(); }
  });

  it("rejects a non-owner granting, revoking or withdrawing", async function () {
    const f = await fixture();
    for (const caller of [f.strategist, f.outsider]) {
      await expect(f.account.connect(caller).grantSession(f.config)).to.be.revertedWithCustomError(f.account, "NotOwner");
      await expect(f.account.connect(caller).revokeSession()).to.be.revertedWithCustomError(f.account, "NotOwner");
      await expect(f.account.connect(caller).withdrawToken(await f.budget.getAddress(), A)).to.be.revertedWithCustomError(f.account, "NotOwner");
      await expect(f.account.connect(caller).withdrawNative(1)).to.be.revertedWithCustomError(f.account, "NotOwner");
    }
  });

  it("rejects swaps from anyone except the active strategist", async function () {
    const f = await fixture();
    await expect(swap(f, { caller: f.outsider })).to.be.revertedWithCustomError(f.account, "NotStrategist");
    await expect(swap(f, { caller: f.owner })).to.be.revertedWithCustomError(f.account, "NotStrategist");
  });

  it("bounds permission duration, caps, slippage and strategy identity", async function () {
    const f = await fixture();
    const now = await networkHelpers.time.latest();
    for (const changes of [
      { strategist: ethers.ZeroAddress }, { strategist: await f.router.getAddress() },
      { expiresAt: now }, { expiresAt: now + 8 * 86_400 }, { maxTradeBudget: 0 },
      { maxRollingDayBudget: 10n * A }, { maxSlippageBps: 0 }, { maxSlippageBps: 101 },
      { strategyHash: ethers.ZeroHash },
    ]) {
      await expect(f.account.grantSession({ ...f.config, ...changes })).to.be.revertedWithCustomError(f.account, "InvalidConfiguration");
    }
  });

  it("blocks revoked authority and a queued transaction from an earlier permission epoch", async function () {
    const f = await fixture();
    const previous = await f.account.sessionId();
    await f.account.revokeSession();
    await expect(swap(f, { session: previous })).to.be.revertedWithCustomError(f.account, "SessionUnavailable");
    await f.account.grantSession(f.config);
    await expect(swap(f, { session: previous })).to.be.revertedWithCustomError(f.account, "InvalidSequence");
    await swap(f);
  });

  it("invalidates the old strategist immediately when the owner replaces it", async function () {
    const f = await fixture();
    await f.account.grantSession({ ...f.config, strategist: f.replacement.address });
    await expect(swap(f)).to.be.revertedWithCustomError(f.account, "NotStrategist");
    await swap(f, { caller: f.replacement });
  });

  it("fails closed after permission expiry", async function () {
    const f = await fixture();
    await networkHelpers.time.increaseTo(f.config.expiresAt);
    await expect(swap(f)).to.be.revertedWithCustomError(f.account, "SessionUnavailable");
    await expect(f.account.withdrawToken(await f.budget.getAddress(), A)).to.emit(f.account, "TokenWithdrawn");
  });

  it("rejects nonce replay, skipped nonce and stale session IDs", async function () {
    const f = await fixture();
    await expect(swap(f, { nonce: 1 })).to.be.revertedWithCustomError(f.account, "InvalidSequence");
    await expect(swap(f, { session: 0 })).to.be.revertedWithCustomError(f.account, "InvalidSequence");
    await swap(f);
    await expect(swap(f, { nonce: 0 })).to.be.revertedWithCustomError(f.account, "InvalidSequence");
  });

  it("rejects empty trades, empty signal commitments and unsafe deadlines", async function () {
    const f = await fixture();
    const now = await networkHelpers.time.latest();
    for (const changes of [{ input: 0n }, { minimum: 0n }, { signal: ethers.ZeroHash },
      { deadline: now - 1 }, { deadline: now + 1_000 }]) {
      await expect(swap(f, changes)).to.be.revertedWithCustomError(f.account, "InvalidTrade");
    }
  });

  it("blocks rapid churn even when the owner re-grants the same permission", async function () {
    const f = await fixture();
    await swap(f);
    await f.account.grantSession(f.config);
    await expect(swap(f)).to.be.revertedWithCustomError(f.account, "TradeTooSoon");
    await networkHelpers.time.increase(INTERVAL);
    await freshQuote(f);
    await swap(f);
  });

  it("enforces an independent price floor instead of trusting the strategist's minimum", async function () {
    const f = await fixture();
    await expect(swap(f, { minimum: 1 })).to.be.revertedWithCustomError(f.account, "InsufficientOutput");
    expect(await f.account.nextNonce()).to.equal(0);
  });

  it("rejects stale, future and zero reference quotes", async function () {
    const f = await fixture();
    await networkHelpers.time.increase(120);
    await expect(swap(f)).to.be.revertedWithCustomError(f.account, "QuoteUnavailable");
    await f.quote.setQuote(2_000n * A, (await networkHelpers.time.latest()) + 1_000);
    await expect(swap(f)).to.be.revertedWithCustomError(f.account, "QuoteUnavailable");
    await f.quote.setQuote(0, await networkHelpers.time.latest());
    await expect(swap(f)).to.be.revertedWithCustomError(f.account, "QuoteUnavailable");
  });

  it("enforces the gross per-order limit for both swap directions with 6/18 decimals", async function () {
    const f = await fixture();
    await expect(swap(f, { input: 1_001n * A })).to.be.revertedWithCustomError(f.account, "SpendLimitExceeded");
    await expect(swap(f, { buy: false, input: B })).to.be.revertedWithCustomError(f.account, "SpendLimitExceeded");
    await swap(f, { buy: false, input: B / 4n });
    expect(await f.account.rollingDaySpent()).to.equal(500n * A);
  });

  it("counts round-trip turnover instead of netting buys against sells", async function () {
    const f = await fixture();
    await swap(f, { input: 1_000n * A });
    await networkHelpers.time.increase(INTERVAL);
    await freshQuote(f);
    await swap(f, { buy: false, input: B / 4n });
    expect(await f.account.rollingDaySpent()).to.equal(1_500n * A);
    await networkHelpers.time.increase(INTERVAL);
    await freshQuote(f);
    await expect(swap(f, { input: A })).to.be.revertedWithCustomError(f.account, "SpendLimitExceeded");
  });

  it("does not reset the rolling budget on revocation or strategy replacement", async function () {
    const f = await fixture();
    await swap(f, { input: 1_000n * A });
    await f.account.revokeSession();
    await f.account.grantSession({ ...f.config, strategist: f.replacement.address });
    await networkHelpers.time.increase(INTERVAL);
    await freshQuote(f);
    await expect(swap(f, { caller: f.replacement, input: 501n * A })).to.be.revertedWithCustomError(f.account, "SpendLimitExceeded");
    expect(await f.account.rollingDaySpent()).to.equal(1_000n * A);
  });

  it("expires spend by elapsed 24 hours rather than a reset at midnight", async function () {
    const f = await fixture();
    await f.account.grantSession({ ...f.config, expiresAt: (await networkHelpers.time.latest()) + 3 * 86_400 });
    await swap(f, { input: 1_000n * A });
    const firstAt = Number(await f.account.lastTradeAt());
    await networkHelpers.time.increaseTo(firstAt + 86_399);
    expect(await f.account.rollingDaySpent()).to.equal(1_000n * A);
    await networkHelpers.time.increaseTo(firstAt + 86_400);
    expect(await f.account.rollingDaySpent()).to.equal(0);
    await freshQuote(f);
    await swap(f, { input: 1_000n * A });
    expect(await f.account.rollingDaySpent()).to.equal(1_000n * A);
  });

  it("rolls back balances, budget, nonce and approvals if the router ignores the minimum", async function () {
    const f = await fixture();
    await f.router.setExecution(9_000, 10_000, false);
    await expect(swap(f)).to.be.revertedWithCustomError(f.account, "InsufficientOutput");
    expect(await f.budget.balanceOf(await f.account.getAddress())).to.equal(10_000n * A);
    expect(await f.account.rollingDaySpent()).to.equal(0);
    expect(await f.account.nextNonce()).to.equal(0);
    expect(await f.account.lastTradeAt()).to.equal(0);
    expect(await f.budget.allowance(await f.account.getAddress(), await f.router.getAddress())).to.equal(0);
  });

  it("checks actual input consumption rather than the router's returned amounts", async function () {
    const f = await fixture();
    await f.router.setExecution(10_000, 5_000, false);
    await expect(swap(f)).to.be.revertedWithCustomError(f.account, "UnexpectedInputDelta");
    expect(await f.account.nextNonce()).to.equal(0);
  });

  it("leaves no router allowance that can drain remaining or future deposits", async function () {
    const f = await fixture();
    await swap(f);
    await f.budget.mint(await f.account.getAddress(), 50n * A);
    await expect(f.router.pullLater(await f.budget.getAddress(), await f.account.getAddress(), f.outsider.address, A))
      .to.be.revertedWithCustomError(f.budget, "ERC20InsufficientAllowance");
    expect(await f.budget.balanceOf(f.outsider.address)).to.equal(0);
  });

  it("blocks reentrancy during the external router call", async function () {
    const f = await fixture();
    const bot = await ethers.deployContract("StrategyTestStrategist");
    await f.account.grantSession({ ...f.config, strategist: await bot.getAddress() });
    const epoch = await f.account.sessionId();
    const deadline = (await networkHelpers.time.latest()) + 60;
    const first = f.account.interface.encodeFunctionData("swap", [true, 500n * A, B / 4n, epoch, 0, deadline, SIGNAL]);
    const nested = f.account.interface.encodeFunctionData("swap", [true, 500n * A, B / 4n, epoch, 1, deadline, SIGNAL]);
    await f.router.setCallback(await bot.getAddress(), bot.interface.encodeFunctionData("execute", [await f.account.getAddress(), nested]));
    await bot.execute(await f.account.getAddress(), first);
    expect(await f.router.callbackSucceeded()).to.equal(false);
    expect(await f.router.callbackResult()).to.equal(ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10));
    expect(await f.account.nextNonce()).to.equal(1);
  });

  it("preserves owner recovery of both held tokens when oracle and router fail", async function () {
    const f = await fixture();
    await f.quote.setBroken(true);
    await expect(swap(f)).to.be.revertedWith("TEST_ORACLE_UNAVAILABLE");
    await f.router.setExecution(10_000, 10_000, true);
    await f.account.revokeSession();
    await f.account.withdrawToken(await f.budget.getAddress(), 10_000n * A);
    await f.account.withdrawToken(await f.position.getAddress(), 2n * B);
    expect(await f.budget.balanceOf(f.owner.address)).to.equal(10_000n * A);
    expect(await f.position.balanceOf(f.owner.address)).to.equal(2n * B);
    expect(await f.budget.balanceOf(await f.account.getAddress())).to.equal(0);
  });

  it("lets the owner atomically revoke and withdraw both assets during a venue outage", async function () {
    const f = await fixture();
    await f.quote.setBroken(true);
    await f.router.setExecution(10_000, 10_000, true);
    await expect(f.account.connect(f.strategist).revokeAndWithdraw()).to.be.revertedWithCustomError(f.account, "NotOwner");
    await expect(f.account.revokeAndWithdraw()).to.emit(f.account, "SessionRevoked");
    expect((await f.account.session()).strategist).to.equal(ethers.ZeroAddress);
    expect(await f.budget.balanceOf(f.owner.address)).to.equal(10_000n * A);
    expect(await f.position.balanceOf(f.owner.address)).to.equal(2n * B);
    await expect(swap(f)).to.be.revertedWithCustomError(f.account, "SessionUnavailable");
  });

  it("rolls back permission state and approvals when the router reverts or over-pulls", async function () {
    const f = await fixture();
    await f.router.setExecution(10_000, 10_000, true);
    await expect(swap(f)).to.be.revertedWith("TEST_ROUTER_UNAVAILABLE");
    await f.router.setExecution(10_000, 11_000, false);
    await expect(swap(f)).to.be.revertedWithCustomError(f.budget, "ERC20InsufficientAllowance");
    expect(await f.account.nextNonce()).to.equal(0);
    expect(await f.account.rollingDaySpent()).to.equal(0);
    expect(await f.budget.allowance(await f.account.getAddress(), await f.router.getAddress())).to.equal(0);
  });

  it("keeps a full day of permitted churn and subsequent pruning within a bounded gas cost", async function () {
    const f = await fixture();
    await f.account.grantSession({ ...f.config, expiresAt: (await networkHelpers.time.latest()) + 7 * 86_400,
      maxRollingDayBudget: 100_000n * A });
    for (let i = 0; i < 96; i++) {
      if (i > 0) await networkHelpers.time.increase(INTERVAL);
      await freshQuote(f);
      await swap(f, i % 2 === 0 ? {} : { buy: false, input: B / 4n });
    }
    expect(await f.account.rollingDaySpent()).to.equal(48_000n * A);
    await networkHelpers.time.increase(86_400);
    await freshQuote(f);
    const receipt = await (await swap(f)).wait();
    expect(receipt.gasUsed).to.be.lessThan(1_500_000n);
    expect(await f.account.rollingDaySpent()).to.equal(500n * A);
    await f.account.revokeAndWithdraw();
    expect(await f.budget.balanceOf(await f.account.getAddress())).to.equal(0);
  });

  it("can recover an unrelated accidentally sent token only to the immutable owner", async function () {
    const f = await fixture();
    const other = await ethers.deployContract("StrategyTestToken", ["ACCIDENTAL", 18]);
    await other.mint(await f.account.getAddress(), B);
    await f.account.withdrawToken(await other.getAddress(), B);
    expect(await other.balanceOf(f.owner.address)).to.equal(B);
  });

  it("keeps native gas deposits recoverable without granting the strategist native spending", async function () {
    const f = await fixture();
    await f.owner.sendTransaction({ to: await f.account.getAddress(), value: ethers.parseEther("0.01") });
    await f.account.revokeSession();
    await f.account.withdrawNative(ethers.parseEther("0.01"));
    expect(await ethers.provider.getBalance(await f.account.getAddress())).to.equal(0);
  });
});
