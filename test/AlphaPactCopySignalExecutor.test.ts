import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create({ network: "hardhatOp", chainType: "op" });
const USD = 10n ** 6n;
const ETH = 10n ** 18n;
const STRATEGY = ethers.id("copy-strategy-v1");
const types = {
  CopySignal: [
    { name: "strategyVersion", type: "bytes32" },
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "minAmountOut", type: "uint256" },
    { name: "sequence", type: "uint64" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
};

async function fixture() {
  const [publisher, ownerA, ownerB, relayer] = await ethers.getSigners();
  const budget = await ethers.deployContract("StrategyTestToken", ["tUSD", 6]);
  const position = await ethers.deployContract("StrategyTestToken", ["tETH", 18]);
  const budgetAddress = await budget.getAddress();
  const positionAddress = await position.getAddress();
  const quote = await ethers.deployContract("StrategyTestQuote", [budgetAddress, positionAddress]);
  const router = await ethers.deployContract("StrategyTestRouter", [await quote.getAddress()]);
  const executor = await ethers.deployContract("AlphaPactCopySignalExecutor");
  const executorAddress = await executor.getAddress();
  const binding = await executor.strategyBinding(publisher.address, STRATEGY);
  await budget.mint(await router.getAddress(), 100_000n * USD);
  await position.mint(await router.getAddress(), 100n * ETH);

  async function openAccount(owner: typeof ownerA, tradeCap: bigint, dayCap: bigint) {
    const account = await ethers.deployContract("AlphaPactStrategyAccount", [
      owner.address, budgetAddress, positionAddress, await router.getAddress(), await quote.getAddress(),
    ]);
    const address = await account.getAddress();
    const permission = {
      strategist: executorAddress,
      expiresAt: (await networkHelpers.time.latest()) + 86_400,
      maxTradeBudget: tradeCap,
      maxRollingDayBudget: dayCap,
      maxSlippageBps: 100,
      strategyHash: binding,
    };
    await account.connect(owner).grantSession(permission);
    await budget.mint(address, 1_000n * USD);
    await position.mint(address, ETH);
    return { contract: account, address, permission };
  }

  const a = await openAccount(ownerA, 250n * USD, 300n * USD);
  const b = await openAccount(ownerB, 100n * USD, 500n * USD);
  const domain = {
    name: "AlphaPactCopySignalExecutor", version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: executorAddress,
  };
  const refreshQuote = async (price = 2_000n * USD) =>
    quote.setQuote(price, await networkHelpers.time.latest());
  await refreshQuote();

  async function signedBuy() {
    const issuedAt = await networkHelpers.time.latest();
    const signal = {
      strategyVersion: STRATEGY, tokenIn: budgetAddress, tokenOut: positionAddress,
      amountIn: 250n * USD, minAmountOut: 124_000_000_000_000_000n,
      sequence: 1, issuedAt, expiresAt: issuedAt + 120,
    };
    return { signal, signature: await publisher.signTypedData(domain, types, signal) };
  }
  return { publisher, ownerA, ownerB, relayer, budget, position, quote, router, executor, a, b, binding, domain, refreshQuote, signedBuy };
}

describe("AlphaPact signed copy signal execution", function () {
  it("lets independent relayers submit one signal with each follower's own cap", async function () {
    const f = await fixture();
    const { signal, signature } = await f.signedBuy();
    const digest = ethers.TypedDataEncoder.hash(f.domain, types, signal);
    await expect(f.executor.connect(f.relayer).execute(f.a.address, f.publisher.address, signal, signature))
      .to.emit(f.a.contract, "SwapExecuted")
      .withArgs(1, 0, digest, signal.tokenIn, 250n * USD, ETH / 8n, 250n * USD, await f.quote.observedAt());
    await f.executor.connect(f.ownerA).execute(f.b.address, f.publisher.address, signal, signature);
    expect(await f.budget.balanceOf(f.a.address)).to.equal(750n * USD);
    expect(await f.budget.balanceOf(f.b.address)).to.equal(900n * USD);
    expect(await f.position.balanceOf(f.b.address)).to.equal(ETH + ETH / 20n);
    expect(await f.executor.lastExecutedSequence(f.a.address, f.binding)).to.equal(1n);
    expect(await f.executor.lastExecutedSequence(f.b.address, f.binding)).to.equal(1n);
  });

  it("rejects changed signals, unauthorized publishers, versions and token pairs", async function () {
    const f = await fixture();
    const { signal, signature } = await f.signedBuy();
    const call = f.executor.connect(f.relayer);
    await expect(call.execute(f.a.address, f.publisher.address, {...signal, amountIn: 300n * USD}, signature))
      .to.be.revertedWithCustomError(f.executor, "InvalidSignature");
    await expect(call.execute(f.a.address, f.relayer.address, signal, await f.relayer.signTypedData(f.domain, types, signal)))
      .to.be.revertedWithCustomError(f.executor, "StrategyNotAuthorized");
    const otherVersion = { ...signal, strategyVersion: ethers.id("copy-strategy-v2") };
    await expect(call.execute(f.a.address, f.publisher.address, otherVersion, await f.publisher.signTypedData(f.domain, types, otherVersion)))
      .to.be.revertedWithCustomError(f.executor, "StrategyNotAuthorized");
    const otherPair = { ...signal, tokenOut: f.relayer.address };
    await expect(call.execute(f.a.address, f.publisher.address, otherPair, await f.publisher.signTypedData(f.domain, types, otherPair)))
      .to.be.revertedWithCustomError(f.executor, "UnsupportedPair");
  });

  it("stops after revocation and rejects replay even if the owner follows again", async function () {
    const f = await fixture();
    const { signal, signature } = await f.signedBuy();
    const call = f.executor.connect(f.relayer);
    await call.execute(f.a.address, f.publisher.address, signal, signature);
    await f.a.contract.connect(f.ownerA).revokeSession();
    await expect(call.execute(f.a.address, f.publisher.address, signal, signature))
      .to.be.revertedWithCustomError(f.executor, "StrategyNotAuthorized");
    await f.a.contract.connect(f.ownerA).grantSession(f.a.permission);
    await expect(call.execute(f.a.address, f.publisher.address, signal, signature))
      .to.be.revertedWithCustomError(f.executor, "SignalAlreadyPassed");

    await f.b.contract.connect(f.ownerB).revokeSession();
    await f.b.contract.connect(f.ownerB).grantSession(f.b.permission);
    await expect(call.execute(f.b.address, f.publisher.address, signal, signature))
      .to.be.revertedWithCustomError(f.executor, "SignalPredatesSession");

    await networkHelpers.time.increaseTo(signal.expiresAt);
    await expect(call.execute(f.b.address, f.publisher.address, signal, signature))
      .to.be.revertedWithCustomError(f.executor, "InvalidSignal");
  });

  it("rejects price deterioration and retries after an unsuccessful swap without consuming the signal", async function () {
    const f = await fixture();
    const { signal, signature } = await f.signedBuy();
    const call = f.executor.connect(f.relayer);
    await f.refreshQuote(2_200n * USD);
    await expect(call.execute(f.a.address, f.publisher.address, signal, signature))
      .to.be.revertedWithCustomError(f.executor, "SignalPriceMoved");

    await f.refreshQuote();
    // 0.9% worse would satisfy the account's 1% tolerance, but misses the publisher's minimum.
    await f.router.setExecution(9_910, 10_000, false);
    await expect(call.execute(f.a.address, f.publisher.address, signal, signature))
      .to.be.revertedWithCustomError(f.a.contract, "InsufficientOutput");
    expect(await f.executor.lastExecutedSequence(f.a.address, f.binding)).to.equal(0n);
    expect(await f.budget.balanceOf(f.a.address)).to.equal(1_000n * USD);
    await f.router.setExecution(10_000, 10_000, false);
    await call.execute(f.a.address, f.publisher.address, signal, signature);
    expect(await f.budget.balanceOf(f.a.address)).to.equal(750n * USD);
  });

  it("resizes a sell by the follower's remaining rolling budget", async function () {
    const f = await fixture();
    const { signal, signature } = await f.signedBuy();
    await f.executor.execute(f.a.address, f.publisher.address, signal, signature);
    await networkHelpers.time.increase(900);
    await f.refreshQuote();
    const issuedAt = await networkHelpers.time.latest();
    const sell = {
      ...signal, tokenIn: signal.tokenOut, tokenOut: signal.tokenIn,
      amountIn: ETH / 2n, minAmountOut: 990n * USD, sequence: 2, issuedAt, expiresAt: issuedAt + 120,
    };
    await f.executor.connect(f.relayer).execute(f.a.address, f.publisher.address, sell,
      await f.publisher.signTypedData(f.domain, types, sell));
    expect(await f.a.contract.rollingDaySpent()).to.equal(300n * USD);
    expect(await f.budget.balanceOf(f.a.address)).to.equal(800n * USD);
    expect(await f.position.balanceOf(f.a.address)).to.equal(11n * ETH / 10n);
  });

  it("derives the trigger from chain time and enforces price and follower limits without an offchain signature", async function () {
    const f = await fixture();
    const startsAt = (await networkHelpers.time.latest()) + 60;
    const schedule = {
      tokenIn: await f.budget.getAddress(), tokenOut: await f.position.getAddress(),
      amountIn: 250n * USD, minAmountOut: 124_000_000_000_000_000n, startsAt, interval: 900,
    };
    const rule = await ethers.deployContract("AlphaPactScheduledCopyRule", [await f.executor.getAddress(), schedule]);
    const ruleAddress = await rule.getAddress();
    const strategyVersion = await rule.strategyVersion();
    const strategyHash = await f.executor.strategyBinding(ruleAddress, strategyVersion);
    await f.a.contract.connect(f.ownerA).grantSession({ ...f.a.permission, strategyHash });
    await f.b.contract.connect(f.ownerB).grantSession({ ...f.b.permission, strategyHash });

    const caller = rule.connect(f.relayer);
    await expect(caller.execute(f.a.address)).to.be.revertedWithCustomError(rule, "WindowClosed");
    await networkHelpers.time.increaseTo(startsAt);
    await f.refreshQuote(2_200n * USD);
    await expect(caller.execute(f.a.address)).to.be.revertedWithCustomError(f.executor, "SignalPriceMoved");
    const forged = {
      strategyVersion, tokenIn: schedule.tokenIn, tokenOut: schedule.tokenOut,
      amountIn: 400n * USD, minAmountOut: schedule.minAmountOut, sequence: 1, issuedAt: startsAt, expiresAt: startsAt + 180,
    };
    await expect(f.executor.connect(f.relayer).execute(f.a.address, ruleAddress, forged, "0x"))
      .to.be.revertedWithCustomError(f.executor, "InvalidSignature");

    await f.refreshQuote();
    const signal = await rule.currentSignal();
    expect(signal.sequence).to.equal(1n);
    await expect(caller.execute(f.a.address)).to.emit(f.a.contract, "SwapExecuted");
    await expect(caller.execute(f.b.address)).to.emit(f.b.contract, "SwapExecuted");
    expect(await f.budget.balanceOf(f.a.address)).to.equal(750n * USD);
    expect(await f.budget.balanceOf(f.b.address)).to.equal(900n * USD);
    await expect(caller.execute(f.a.address)).to.be.revertedWithCustomError(f.executor, "SignalAlreadyPassed");

    await networkHelpers.time.increaseTo(startsAt + 180);
    await expect(caller.execute(f.b.address)).to.be.revertedWithCustomError(rule, "WindowClosed");
    await networkHelpers.time.increaseTo(startsAt + 920);
    await f.refreshQuote();
    expect((await rule.currentSignal()).sequence).to.equal(2n);
    await expect(caller.execute(f.b.address)).to.emit(f.b.contract, "SwapExecuted");
    expect(await f.budget.balanceOf(f.b.address)).to.equal(800n * USD);
  });
});
