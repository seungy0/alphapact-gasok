import { expect } from "chai";
import { network } from "hardhat";
const { ethers } = await network.create({ network: "hardhatOp", chainType: "op" });
const stream = `0x${"11".repeat(32)}`;
const evidence = `0x${"22".repeat(32)}`;
const policy = `0x${"33".repeat(32)}`;
describe("AlphaPactSpotCheckpoints", function () {
  it("fixes the publisher, venue and validation-only evidence mode", async function () {
    const [publisher] = await ethers.getSigners(); const contract = await ethers.deployContract("AlphaPactSpotCheckpoints", [publisher.address]);
    expect(await contract.publisher()).to.equal(publisher.address);
    expect(await contract.VENUE_HASH()).to.equal(ethers.id("UPBIT_KR"));
    expect(await contract.MODE_HASH()).to.equal(ethers.id("READ_AND_ORDER_VALIDATION_ONLY"));
  });
  it("links checkpoints, supports batch snapshots and rejects rewrites or forks", async function () {
    const [publisher] = await ethers.getSigners(); const contract = await ethers.deployContract("AlphaPactSpotCheckpoints", [publisher.address]);
    await expect(contract.publish(stream, 4, ethers.ZeroHash, evidence, policy)).to.emit(contract, "CheckpointPublished");
    const first = await contract.checkpoints(stream);
    expect(first.sequence).to.equal(4n); expect(first.evidenceHead).to.equal(evidence);
    await expect(contract.publish(stream, 4, first.checkpointHash, evidence, policy)).to.be.revertedWithCustomError(contract, "InvalidCheckpoint");
    await expect(contract.publish(stream, 5, ethers.ZeroHash, evidence, policy)).to.be.revertedWithCustomError(contract, "InvalidCheckpoint");
    await contract.publish(stream, 6, first.checkpointHash, policy, policy);
    const second = await contract.checkpoints(stream); expect(second.sequence).to.equal(6n); expect(second.checkpointHash).not.to.equal(first.checkpointHash);
  });
  it("rejects other publishers and empty identities or commitments", async function () {
    const [publisher, outsider] = await ethers.getSigners(); const contract = await ethers.deployContract("AlphaPactSpotCheckpoints", [publisher.address]);
    await expect(contract.connect(outsider).publish(stream, 1, ethers.ZeroHash, evidence, policy)).to.be.revertedWithCustomError(contract, "NotPublisher");
    for (const values of [[ethers.ZeroHash, 1, ethers.ZeroHash, evidence, policy], [stream, 0, ethers.ZeroHash, evidence, policy], [stream, 1, ethers.ZeroHash, ethers.ZeroHash, policy], [stream, 1, ethers.ZeroHash, evidence, ethers.ZeroHash]] as const) {
      await expect(contract.publish(...values)).to.be.revertedWithCustomError(contract, "InvalidCheckpoint");
    }
  });
});
