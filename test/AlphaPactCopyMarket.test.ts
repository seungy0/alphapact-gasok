import { expect } from "chai";
import { network } from "hardhat";
import { followTypes, registerTypes } from "../service/copy-protocol.js";

const { ethers, networkHelpers } = await network.create({ network: "hardhatOp", chainType: "op" });
const USD = 1_000_000n;
const ETH = 10n ** 18n;

describe("AlphaPactCopyMarket", () => {
  it("registers a third-party rule and applies each follower's approved cap", async () => {
    const [creator, followerA, followerB, relayer] = await ethers.getSigners();
    const market = await ethers.deployContract("AlphaPactCopyMarket");
    const domain = { name: "AlphaPactCopyMarket", version: "1", chainId: 31337, verifyingContract: await market.getAddress() };
    const now = await networkHelpers.time.latest();
    const strategy = { creator: creator.address, name: "ETH 정기 매수", amount: 250n * USD, interval: 900, deadline: now + 600 };
    const registered = await creator.signTypedData(domain, { RegisterStrategy: [...registerTypes.RegisterStrategy] }, strategy);
    const args = [strategy.creator, strategy.name, strategy.amount, strategy.interval, strategy.deadline, registered] as const;
    await expect(market.connect(relayer).register(...args)).to.emit(market, "StrategyRegistered").withArgs(1, creator.address, strategy.name, strategy.amount, strategy.interval);
    await market.connect(followerA).register(...args);
    expect(await market.strategyCount()).to.equal(1n);

    for (const [owner, cap] of [[followerA, 100n], [followerB, 300n]] as const) {
      const request = { owner: owner.address, strategyId: 1, maxTradeBudget: cap * USD, maxRollingDayBudget: 300n * USD,
        expiresAt: now + 7_200, deadline: now + 600 };
      const signature = await owner.signTypedData(domain, { FollowStrategy: [...followTypes.FollowStrategy] }, request);
      await expect(market.connect(relayer).follow({ ...request, maxTradeBudget: 200n * USD }, signature))
        .to.be.revertedWith("FOLLOWER_SIGNATURE_INVALID");
      await expect(market.connect(relayer).follow(request, signature)).to.emit(market, "StrategyFollowed");
      await market.connect(relayer).follow(request, signature);
    }
    expect(await market.subscriptionCount()).to.equal(2n);
    const a = await market.subscriptionAt(1);
    const b = await market.subscriptionAt(2);
    const ruleA = await ethers.getContractAt("AlphaPactScheduledCopyRule", a.rule);
    const ruleB = await ethers.getContractAt("AlphaPactScheduledCopyRule", b.rule);
    const token = await ethers.getContractAt("AlphaPactPracticeAsset", await market.position());
    const accountA = await ethers.getContractAt("AlphaPactTestnetAccount", a.account);
    expect(await accountA.owner()).to.equal(followerA.address);
    await expect(ruleA.connect(relayer).execute(a.account)).to.be.revertedWithCustomError(ruleA, "WindowClosed");
    await networkHelpers.time.increaseTo(b.startsAt);
    await expect(ruleA.connect(relayer).execute(a.account)).to.emit(accountA, "SwapExecuted");
    await ruleB.connect(relayer).execute(b.account);
    expect(await token.balanceOf(a.account)).to.equal(100n * ETH * 9_970n / 2_000n / 10_000n);
    expect(await token.balanceOf(b.account)).to.equal(250n * ETH * 9_970n / 2_000n / 10_000n);
    const executor = await ethers.getContractAt("AlphaPactCopySignalExecutor", await market.executor());
    await expect(ruleA.connect(relayer).execute(a.account)).to.be.revertedWithCustomError(executor, "SignalAlreadyPassed");

    await accountA.connect(followerA).revokeAndWithdraw();
    expect(await token.balanceOf(a.account)).to.equal(0n);
    expect(await token.balanceOf(followerA.address)).to.be.greaterThan(0n);
    await networkHelpers.time.increaseTo(a.startsAt + 900n);
    await expect(ruleA.connect(relayer).execute(a.account)).to.be.revertedWithCustomError(executor, "StrategyNotAuthorized");
  });
});
