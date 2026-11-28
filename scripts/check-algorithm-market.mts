import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { createPublicClient, createWalletClient, decodeFunctionData, getAddress, http, parseEventLogs, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { accountAbi, chain, tokenAbi } from "../service/protocol.ts";
import { copyAbi, followTypes, type CopySubscription } from "../service/copy-protocol.ts";
import {
  algorithmAbi, algorithmDeployment as deployment, algorithmDomain, algorithmSignalAbi, algorithmTypes, compileAlgorithm, decisionAbi,
} from "../service/algorithm-protocol.ts";

const origin = process.env.ALPHAPACT_ALGORITHM_URL ?? "https://alphapact-testnet.yhs98.workers.dev";
const endpoint = origin + "/api/copy/algorithm";
const rpc = createPublicClient({ chain, transport: http() });
const units = (value: number) => BigInt(value) * 1_000_000n;
const deadline = () => BigInt(Math.floor(Date.now() / 1000)) + 600n;
const creator = privateKeyToAccount(generatePrivateKey());
const owner = privateKeyToAccount(generatePrivateKey());
const sell = process.argv.includes("--sell");
const seed = 80_000_000_000_000_000n;

async function request<T>(path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(endpoint + "/" + path, {
        method: body ? "POST" : "GET",
        headers: { origin, "content-type": "application/json" },
        body: body ? JSON.stringify(body, (_, value) => typeof value === "bigint" ? String(value) : value) : undefined,
        signal: AbortSignal.timeout(75_000),
      });
      const result = await response.json();
      assert.ok(response.ok, JSON.stringify(result));
      return result as T;
    } catch (failure) {
      if (attempt >= 3) throw failure;
      await wait(4_000);
    }
  }
}

async function register(name: string, source: unknown) {
  const program = compileAlgorithm(JSON.stringify(source));
  const message = { creator: creator.address, name, amount: units(250), programHash: program.programHash, deadline: deadline() };
  const signature = await creator.signTypedData({ domain: algorithmDomain, types: algorithmTypes, primaryType: "RegisterAlgorithm", message });
  const registered = await request<{ strategyId: string; hash?: Hex }>("relay", { kind: "register", ...message, ...program, signature });
  const strategy = await rpc.readContract({ address: deployment.market, abi: algorithmAbi, functionName: "strategyAt", args: [BigInt(registered.strategyId)] });
  assert.equal(strategy.creator, creator.address);
  assert.equal(strategy.programHash, program.programHash);
  console.log({ name, ...registered, rule: strategy.rule, programHash: program.programHash });
  return { ...registered, ...strategy, amount: String(strategy.amount), interval: Number(strategy.interval), source };
}

assert.equal(await rpc.getChainId(), 91342);
const variant = sell ? await register("ETH 테스트 가격 상단에서 정리", {
  buy: { gt: [{ close: 0 }, { usd: 2400 }] },
  sell: { lt: [{ sma: [0, 2] }, { usd: 2200 }] },
}) : await register("ETH 종가와 평균 조건", {
  buy: { and: [{ gt: [{ close: 0 }, { usd: 1930 }] }, { gt: [{ sma: [0, 2] }, { usd: 1930 }] }] },
  sell: { lt: [{ close: 0 }, { usd: 1930 }] },
});
const message = { owner: owner.address, strategyId: BigInt(variant.strategyId), maxTradeBudget: units(100),
  maxRollingDayBudget: units(300), expiresAt: deadline() + 50n * 60n, deadline: deadline() };
const signature = await owner.signTypedData({ domain: algorithmDomain, types: followTypes, primaryType: "FollowStrategy", message });
const followed = await request<{ subscription: CopySubscription; hash?: Hex }>("relay", { kind: "follow", ...message, signature });
assert.equal(followed.subscription.owner, owner.address);
assert.equal(followed.subscription.position, "0");
assert.equal(followed.subscription.rule, variant.rule);
console.log({ followed: followed.subscription, followHash: followed.hash });

let seedHash: Hex | undefined;
if (sell) {
  const file = process.env.ALPHAPACT_TESTNET_FUNDER_KEY_FILE;
  assert.ok(file, "Provide a funded GIWA Sepolia QA wallet in ALPHAPACT_TESTNET_FUNDER_KEY_FILE");
  const account = privateKeyToAccount((await readFile(file, "utf8")).trim() as Hex);
  const wallet = createWalletClient({ account, chain, transport: http() });
  const balance = await rpc.readContract({ address: deployment.position, abi: tokenAbi, functionName: "balanceOf", args: [account.address] });
  if (balance < seed) {
    const claim = await wallet.writeContract({ address: deployment.position, abi: tokenAbi, functionName: "claim" });
    assert.equal((await rpc.waitForTransactionReceipt({ hash: claim, confirmations: 2 })).status, "success");
  }
  seedHash = await wallet.writeContract({ address: deployment.position, abi: tokenAbi, functionName: "transfer", args: [followed.subscription.account, seed] });
  assert.equal((await rpc.waitForTransactionReceipt({ hash: seedHash })).status, "success");
}

const other = await register("가격 범위가 벗어날 때만 거래", {
  buy: { gt: [{ close: 0 }, { usd: 2400 }] },
  sell: { lt: [{ close: 0 }, { usd: 1800 }] },
});

// Only read from here. No QA request publishes a signal or submits a swap.
const until = Date.now() + 480_000;
const statePath = `accounts?owner=${owner.address}&strategyId=${variant.strategyId}`;
let record: CopySubscription;
for (;;) {
  const data = await request<{ accounts: CopySubscription[] }>(statePath);
  if (data.accounts[0]?.fill) {
    record = data.accounts[0];
    break;
  }
  if (Date.now() > until) throw Error(`No automatic fill: ${JSON.stringify(await request("status"))}`);
  await wait(12_000);
}
const fill = record.fill!;
const receipt = await rpc.getTransactionReceipt({ hash: fill.hash });
const tx = await rpc.getTransaction({ hash: fill.hash });
const args = decodeFunctionData({ abi: algorithmSignalAbi, data: tx.input }).args;
assert.ok(args?.length === 4);
const [account, rule, submittedSignal] = args;
assert.equal(getAddress(receipt.from), deployment.keeper);
assert.equal(getAddress(receipt.to!), deployment.executor);
assert.equal(account, record.account);
assert.equal(rule, variant.rule);
assert.equal(receipt.status, "success");
const [decision, hold] = await Promise.all([
  rpc.readContract({ address: variant.rule, abi: decisionAbi, functionName: "decision", blockNumber: receipt.blockNumber }),
  rpc.readContract({ address: other.rule, abi: decisionAbi, functionName: "decision", blockNumber: receipt.blockNumber }),
]);
assert.equal(decision[0], sell ? 2 : 1);
assert.equal(hold[0], 0);
assert.equal(decision[1], hold[1]);
assert.equal(submittedSignal.sequence, decision[1]);
assert.ok(submittedSignal.issuedAt >= BigInt(record.startsAt));
const event = parseEventLogs({ abi: accountAbi, eventName: "SwapExecuted", logs: receipt.logs }).find(log => getAddress(log.address) === account);
assert.equal(event?.args.amountIn, sell ? 50_000_000_000_000_000n : units(100));
assert.equal(event?.args.amountOut, sell ? 99_700_000n : 49_850_000_000_000_000n);
const followedEvents = await rpc.getContractEvents({ address: deployment.market, abi: copyAbi, eventName: "StrategyFollowed",
  args: { subscriptionId: BigInt(record.id), owner: owner.address }, fromBlock: BigInt(deployment.block), toBlock: receipt.blockNumber });
assert.ok(followedEvents[0]?.transactionHash);

const evidence = { chainId: chain.id, market: deployment.market, replay: deployment.replay, keeper: deployment.keeper,
  variant: { ...variant, decision: sell ? "SELL" : "BUY" }, other: { ...other, decision: "HOLD" }, follower: record,
  followHash: followedEvents[0].transactionHash, seedHash,
  snapshot: { sequence: String(decision[1]), openedAt: String(decision[2]), close: decision[3], block: String(receipt.blockNumber) },
  checkedAt: new Date().toISOString(), inputs: "SYNTHETIC_CANDLE_REPLAY", executionPrice: "FIXED_TEST_QUOTE", swapHash: fill.hash };
await mkdir("outputs/releases", { recursive: true });
await writeFile(`outputs/releases/algorithm-market${sell ? "-sell" : ""}-e2e.json`, JSON.stringify(evidence, null, 2) + "\n");
console.log({ swapHash: fill.hash, actualInput: fill.amountIn, actualOutput: fill.amountOut, signalSequence: String(decision[1]), sameCandleHold: true });
