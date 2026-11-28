import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { createPublicClient, http, parseEventLogs, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { accountAbi, actionDomain, actionTypes, chain, sessionHash, tokenAbi, ZERO_SESSION } from "../service/protocol.ts";
import { copyAbi, copyDeployment as deployment, copyDomain, followTypes, registerTypes, type CopySubscription } from "../service/copy-protocol.ts";

const origin = process.env.ALPHAPACT_COPY_URL ?? "https://alphapact-testnet.yhs98.workers.dev";
const rpc = createPublicClient({ chain, transport: http() });
const usd = (value: number) => BigInt(value) * 1_000_000n;
const creator = privateKeyToAccount(generatePrivateKey());
const owners = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
const now = () => BigInt(Math.floor(Date.now() / 1_000));
const get = async <T,>(path: string): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(origin + "/api/copy/" + path, { signal: AbortSignal.timeout(40_000) });
      assert.ok(response.ok, await response.clone().text());
      return await response.json() as T;
    } catch (failure) {
      if (attempt === 3) throw failure;
      await wait(3_000);
    }
  }
};
async function post<T = { error: string }>(body: unknown) {
  const response = await fetch(origin + "/api/copy/relay", { method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body, (_, v) => typeof v === "bigint" ? String(v) : v),
  });
  return { ok: response.ok, status: response.status, data: await response.json() as T };
}

assert.equal(await rpc.getChainId(), 91342);
const start = await get<{ ready: boolean; market: Hex }>("strategies");
assert.equal(start.ready, true);
assert.equal(start.market, deployment.market);

const registration = { creator: creator.address, name: "ETH 정기 매수 테스트", amount: usd(250), interval: 900n, deadline: now() + 600n };
const registerSignature = await creator.signTypedData({ domain: copyDomain, types: registerTypes, primaryType: "RegisterStrategy", message: registration });
const registered = await post<{ hash: Hex; strategyId: string }>({ kind: "register", ...registration, signature: registerSignature });
assert.ok(registered.ok, JSON.stringify(registered));
const registerHash = registered.data.hash as Hex;
const strategyId = BigInt(registered.data.strategyId);
const strategy = await rpc.readContract({ address: deployment.market, abi: copyAbi, functionName: "strategyAt", args: [strategyId] });
assert.equal(strategy.creator, creator.address);
assert.equal(strategy.amount, usd(250));
assert.equal(strategy.interval, 900n);
console.log({ strategyId: String(strategyId), registerHash, creator: creator.address });

const caps = [100, 250];
const followers: CopySubscription[] = [];
const followHashes: Hex[] = [];
for (const [index, owner] of owners.entries()) {
  const message = { owner: owner.address, strategyId, maxTradeBudget: usd(caps[index]), maxRollingDayBudget: usd(300),
    expiresAt: now() + 600n, deadline: now() + 300n };
  const signature = await owner.signTypedData({ domain: copyDomain, types: followTypes, primaryType: "FollowStrategy", message });
  if (index === 0) {
    const tampered = await post({ kind: "follow", ...message, maxTradeBudget: usd(200), signature });
    assert.equal(tampered.ok, false);
    assert.equal(await rpc.readContract({ address: deployment.market, abi: copyAbi, functionName: "subscriptionIdOf", args: [owner.address, strategyId] }), 0n);
  }
  const followed = await post<{ hash: Hex; subscription: CopySubscription }>({ kind: "follow", ...message, signature });
  assert.ok(followed.ok, JSON.stringify(followed));
  const entry = followed.data.subscription as CopySubscription;
  assert.equal(entry.position, "0");
  assert.equal(entry.owner, owner.address);
  followers.push(entry);
  followHashes.push(followed.data.hash);
  console.log({ account: entry.account, owner: owner.address, startsAt: entry.startsAt, followHash: followed.data.hash });
}

// From this point the QA client only reads. The public minute scheduler must create both swaps.
const completed: CopySubscription[] = [];
for (const [index, entry] of followers.entries()) {
  const until = Date.now() + 215_000;
  for (;;) {
    const { accounts } = await get<{ accounts: CopySubscription[] }>(`accounts?owner=${entry.owner}`);
    const current = accounts.find(account => account.id === entry.id);
    if (current?.fill) {
      assert.equal(BigInt(current.fill.amountIn), usd(caps[index]));
      assert.equal(BigInt(current.cash), usd(10_000 - caps[index]));
      const output = usd(caps[index]) * 10n ** 12n / 2_000n * 9_970n / 10_000n;
      assert.equal(BigInt(current.position), output);
      assert.equal(BigInt(current.fill.amountOut), output);
      const receipt = await rpc.getTransactionReceipt({ hash: current.fill.hash });
      assert.equal(receipt.status, "success");
      assert.equal(receipt.from.toLowerCase(), deployment.keeper.toLowerCase());
      assert.equal(receipt.to?.toLowerCase(), current.rule.toLowerCase());
      const block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
      assert.ok(block.timestamp >= BigInt(entry.startsAt));
      assert.equal(parseEventLogs({ abi: accountAbi, eventName: "SwapExecuted", logs: receipt.logs })
        .find(log => log.address.toLowerCase() === entry.account.toLowerCase())?.args.amountIn, usd(caps[index]));
      completed.push(current);
      console.log({ account: entry.account, automatic: current.fill, delayAfterWindowSeconds: String(block.timestamp - BigInt(entry.startsAt)) });
      break;
    }
    if (Date.now() >= until) throw Error(`No scheduled fill for ${entry.account}: ${JSON.stringify(await get("status"))}`);
    await wait(8_000);
  }
}
assert.notEqual(completed[0].account, completed[1].account);

const entry = completed[0];
const message = { action: 1, sessionHash: sessionHash(ZERO_SESSION), sessionId: BigInt(entry.sessionId),
  nonce: BigInt(entry.authorizationNonce), deadline: now() + 300n };
const signature = await owners[0].signTypedData({ domain: actionDomain(entry.account), types: actionTypes, primaryType: "OwnerAction", message });
const stop = await post<{ hash: Hex }>({ kind: "stop", id: entry.id, ...message, signature });
assert.ok(stop.ok, JSON.stringify(stop));
const stopReceipt = await rpc.waitForTransactionReceipt({ hash: stop.data.hash, timeout: 75_000 });
assert.equal(stopReceipt.status, "success");
const after = await get<{ accounts: CopySubscription[] }>(`accounts?owner=${entry.owner}`);
assert.equal(after.accounts[0].active, false);
assert.equal(after.accounts[0].revoked, true);
assert.equal(BigInt(await rpc.readContract({ address: deployment.position, abi: tokenAbi, functionName: "balanceOf", args: [entry.account] })), BigInt(entry.position));

const evidence = { chainId: 91342, market: deployment.market, keeper: deployment.keeper, strategyId: String(strategyId),
  creator: creator.address, registerHash, followHashes, followers: completed, stopHash: stop.data.hash,
  checkedAt: new Date().toISOString(), venueMode: deployment.venueMode, priceMode: deployment.priceMode };
await mkdir("outputs/releases", { recursive: true });
await writeFile("outputs/releases/copy-market-e2e.json", JSON.stringify(evidence, null, 2) + "\n");
console.log({ stopped: stop.data.hash, evidence: "outputs/releases/copy-market-e2e.json" });
