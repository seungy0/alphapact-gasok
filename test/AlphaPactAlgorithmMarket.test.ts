import { expect } from "chai";
import { network } from "hardhat";
import { algorithmTypes, compileAlgorithm, defaultAlgorithm } from "../service/algorithm-protocol.js";
import { followTypes } from "../service/copy-protocol.js";

const { ethers, networkHelpers } = await network.create({ network: "hardhatOp", chainType: "op" });
const USD = 1_000_000n;

describe("AlphaPactAlgorithmMarket", () => {
  it("binds the creator program and copies its computed buy and sell with no trade on hold", async () => {
    const [creator, follower, relayer] = await ethers.getSigners();
    const executor = await ethers.deployContract("AlphaPactCopySignalExecutor");
    const market = await ethers.deployContract("AlphaPactAlgorithmMarket", [await executor.getAddress()]);
    const replay = await ethers.getContractAt("AlphaPactCandleReplay", await market.replay());
    const epoch = await replay.epoch();
    const domain = { name: "AlphaPactAlgorithmMarket", version: "1", chainId: 31337, verifyingContract: await market.getAddress() };
    const { buyCondition, sellCondition, programHash } = compileAlgorithm(JSON.stringify({
      buy: { and: [{ gt: [{ close: 0 }, { usd: 1930 }] }, { gt: [{ sma: [0, 2] }, { usd: 1930 }] }] },
      sell: { lt: [{ close: 0 }, { usd: 1930 }] },
    }));
    const amount = 250n * USD;
    const deadline = epoch + 600n;
    const message = { creator: creator.address, name: "Creator's ETH rule", amount, programHash, deadline };
    const registered = await creator.signTypedData(domain, { RegisterAlgorithm: [...algorithmTypes.RegisterAlgorithm] }, message);
    await expect(market.connect(relayer).registerAlgorithm(creator.address, message.name, amount, sellCondition, buyCondition, deadline, registered))
      .to.be.revertedWith("CREATOR_SIGNATURE_INVALID");
    await expect(market.connect(relayer).registerAlgorithm(creator.address, message.name, amount, buyCondition, sellCondition, deadline, registered))
      .to.emit(market, "AlgorithmRegistered");
    const other = compileAlgorithm(JSON.stringify({
      buy: { gt: [{ close: 0 }, { usd: 2400 }] }, sell: { lt: [{ close: 0 }, { usd: 1800 }] },
    }));
    const otherMessage = { ...message, name: "Range guard", programHash: other.programHash };
    const otherSignature = await creator.signTypedData(domain, { RegisterAlgorithm: [...algorithmTypes.RegisterAlgorithm] }, otherMessage);
    await market.connect(relayer).registerAlgorithm(creator.address, otherMessage.name, amount, other.buyCondition, other.sellCondition, deadline, otherSignature);

    const follow = { owner: follower.address, strategyId: 1n, maxTradeBudget: 100n * USD, maxRollingDayBudget: 300n * USD,
      expiresAt: epoch + 3600n, deadline };
    const signed = await follower.signTypedData(domain, { FollowStrategy: [...followTypes.FollowStrategy] }, follow);
    await expect(market.connect(relayer).follow({ ...follow, maxTradeBudget: amount }, signed)).to.be.revertedWith("FOLLOWER_SIGNATURE_INVALID");
    await expect(market.connect(relayer).follow(follow, signed)).to.emit(market, "StrategyFollowed");
    const { rule: address, account } = await market.subscriptionAt(1);
    const rule = await ethers.getContractAt("AlphaPactAlgorithmRule", address);
    const rule2 = await ethers.getContractAt("AlphaPactAlgorithmRule", (await market.strategyAt(2)).rule);
    const followerAccount = await ethers.getContractAt("AlphaPactTestnetAccount", account);
    const token = await ethers.getContractAt("AlphaPactPracticeAsset", await market.position());
    const cash = await ethers.getContractAt("AlphaPactPracticeAsset", await market.budget());

    await expect(rule.connect(relayer).execute(account)).to.be.revertedWithCustomError(executor, "SignalPredatesSession");
    await networkHelpers.time.increaseTo(epoch + 120n);
    expect((await rule.decision())[0]).to.equal(1n);
    expect((await rule2.decision())[0]).to.equal(0n);
    await expect(rule2.currentSignal()).to.be.revertedWithCustomError(rule2, "NoOrder");
    const signal = await rule.currentSignal();
    const forged = { strategyVersion: signal.strategyVersion, tokenIn: signal.tokenIn, tokenOut: signal.tokenOut,
      amountIn: signal.amountIn * 2n, minAmountOut: signal.minAmountOut, sequence: signal.sequence,
      issuedAt: signal.issuedAt, expiresAt: signal.expiresAt };
    await expect(executor.connect(relayer).execute(account, address, forged, "0x")).to.be.revertedWithCustomError(executor, "InvalidSignature");
    await expect(rule.connect(relayer).execute(account)).to.emit(followerAccount, "SwapExecuted");
    expect(await token.balanceOf(account)).to.equal(49_850_000_000_000_000n);
    expect(await cash.balanceOf(account)).to.equal(9_900n * USD);
    await expect(rule.connect(relayer).execute(account)).to.be.revertedWithCustomError(executor, "SignalAlreadyPassed");

    await networkHelpers.time.increaseTo(epoch + 11n * 120n);
    expect((await rule.decision())[0]).to.equal(2n);
    await expect(rule.connect(relayer).execute(account)).to.emit(followerAccount, "SwapExecuted");
    expect(await token.balanceOf(account)).to.equal(0n);
    expect(await cash.balanceOf(account)).to.equal(9_999_400_900n);

    await followerAccount.connect(follower).revokeSession();
    await networkHelpers.time.increaseTo(epoch + 12n * 120n);
    await expect(rule.connect(relayer).execute(account)).to.be.revertedWithCustomError(executor, "StrategyNotAuthorized");
  });

  it("rejects malformed JSON, out-of-range candles and unbounded conditions", () => {
    expect(() => compileAlgorithm("{")).to.throw("JSON");
    expect(() => compileAlgorithm(JSON.stringify({ buy: {gt:[{close:8},{usd:1900}]},sell:{lt:[{close:0},{usd:2000}]} }))).to.throw("범위");
    expect(() => compileAlgorithm(defaultAlgorithm + " ".repeat(4_096))).to.throw("4,096");
    expect(compileAlgorithm(defaultAlgorithm).programHash).to.match(/^0x[0-9a-f]{64}$/u);
  });
});
