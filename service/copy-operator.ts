import {
  encodeFunctionData, getAddress, isAddress, isHex, keccak256, parseEventLogs,
  type Address, type Hex, type PublicClient, type Transport,
} from "viem";
import { accountAbi, chain, tokenAbi, ZERO_SESSION } from "./protocol";
import { copyAbi, copyDeployment, scheduledRuleAbi } from "./copy-protocol";
import { algorithmAbi, algorithmDeployment, algorithmSignalAbi, candleReplayAbi, decisionAbi, hashProgram } from "./algorithm-protocol";

type Send = (id: string, to: Address, data: Hex) => Promise<{ hash: Hex; block: bigint }>;
type QueueEntry = { account: Address; rule: Address; startsAt: number; interval: number; expiresAt: number; lastSequence: number };
type FollowIntent = { owner: Address; strategyId: string; deadline: number };
type BroadcastJob = { hash: Hex; done?: boolean; error?: string };
type Fill = { hash: Hex; block: string; amountIn: string; amountOut: string; sequence: number;
  side?: "BUY" | "SELL"; signalSequence?: string; close?: number };
const nowSeconds = () => Math.floor(Date.now() / 1_000);

function address(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new Error("지갑 주소를 확인해 주세요.");
  return getAddress(value);
}

function integer(value: unknown, min: bigint, max: bigint): bigint {
  if (typeof value !== "string" || !/^\d{1,24}$/.test(value)) throw new Error("숫자 입력을 확인해 주세요.");
  const n = BigInt(value);
  if (n < min || n > max) throw new Error("입력값이 허용 범위를 벗어났습니다.");
  return n;
}

function signature(value: unknown): Hex {
  if (typeof value !== "string" || !isHex(value) || value.length < 4 || value.length > 4098 || value.length % 2) {
    throw new Error("지갑 서명을 확인해 주세요.");
  }
  return value;
}

export class CopyOperator {
  private catalogCache: { at: number; data: Awaited<ReturnType<CopyOperator["readCatalog"]>> } | undefined;

  constructor(private readonly client: PublicClient<Transport, typeof chain>, private readonly storage: DurableObjectStorage,
    private readonly send: Send, private readonly mode: "copy" | "algorithm" = "copy") {}

  private get config() { return this.mode === "algorithm" ? algorithmDeployment : copyDeployment; }

  private strategyCount() {
    return this.client.readContract({ address: this.config.market, abi: copyAbi, functionName: "strategyCount" });
  }

  private strategy(id: bigint) {
    if (this.mode === "algorithm") return this.algorithm(id);
    return this.client.readContract({ address: this.config.market, abi: copyAbi, functionName: "strategyAt", args: [id] });
  }

  private algorithm(id: bigint) {
    return this.client.readContract({ address: algorithmDeployment.market, abi: algorithmAbi, functionName: "strategyAt", args: [id] });
  }

  async signal(id: string | null) {
    if (!algorithmDeployment.ready) return { ready: false };
    if (id === null) {
      const [sequence, openedAt, closes] = await this.client.readContract({ address: algorithmDeployment.replay,
        abi: candleReplayAbi, functionName: "snapshot" });
      return { ready: true, sequence, openedAt, closes };
    }
    const strategy = await this.algorithm(integer(id, 1n, 10n ** 24n));
    const [side, sequence, openedAt, close] = await this.client.readContract({ address: strategy.rule, abi: decisionAbi, functionName: "decision" });
    return { ready: true, side, sequence, openedAt, close };
  }

  private subscription(id: bigint) {
    return this.client.readContract({ address: this.config.market, abi: copyAbi, functionName: "subscriptionAt", args: [id] });
  }

  async list(before: string | null) {
    if (before !== null) return this.readCatalog(before);
    if (this.catalogCache && nowSeconds() - this.catalogCache.at < 10) return this.catalogCache.data;
    try {
      const data = await this.readCatalog(null);
      this.catalogCache = { at: nowSeconds(), data };
      return data;
    } catch (failure) {
      if (this.catalogCache) return this.catalogCache.data;
      throw failure;
    }
  }

  private async readCatalog(before: string | null) {
    const total = this.config.ready ? await this.strategyCount() : 0n;
    const cursor = before === null ? total + 1n : integer(before, 1n, total + 1n);
    const size = Number(cursor > 9n ? 8n : cursor - 1n);
    const items = await Promise.all(Array.from({ length: size }, async (_, index) => {
      const id = cursor - BigInt(index + 1);
      return { id, ...await this.strategy(id) };
    }));
    return { ready: this.config.ready, market: this.config.market, strategies: items, before: cursor - BigInt(size) > 1n ? cursor - BigInt(size) : null };
  }

  async accounts(ownerValue: unknown, strategyValue: string | null) {
    const owner = address(ownerValue);
    if (!this.config.ready) return { accounts: [] };
    if (strategyValue !== null) {
      const strategyId = integer(strategyValue, 1n, 10n ** 24n);
      const id = await this.client.readContract({ address: this.config.market, abi: copyAbi,
        functionName: "subscriptionIdOf", args: [owner, strategyId] });
      return { accounts: id === 0n ? [] : [await this.state(id)] };
    }
    const count = await this.client.readContract({ address: this.config.market, abi: copyAbi, functionName: "ownerSubscriptionCount", args: [owner] });
    const ids = await Promise.all(Array.from({ length: Number(count > 8n ? 8n : count) }, (_, index) =>
      this.client.readContract({ address: this.config.market, abi: copyAbi, functionName: "ownerSubscriptionAt", args: [owner, count - 1n - BigInt(index)] })));
    return { accounts: await Promise.all(ids.map(id => this.state(id))) };
  }

  private async state(id: bigint) {
    const subscription = await this.subscription(id);
    const account = subscription.account;
    const read = (functionName: "session" | "sessionId" | "authorizationNonce") =>
      this.client.readContract({ address: account, abi: accountAbi, functionName });
    const [permission, sessionId, authorizationNonce, cash, position, fill] = await Promise.all([
      read("session"), read("sessionId"), read("authorizationNonce"),
      this.client.readContract({ address: this.config.budget, abi: tokenAbi, functionName: "balanceOf", args: [account] }),
      this.client.readContract({ address: this.config.position, abi: tokenAbi, functionName: "balanceOf", args: [account] }),
      this.storage.get<Fill>(`${this.mode}-fill:${id}`),
    ]);
    const [strategist, expiresAt, maxTradeBudget, maxRollingDayBudget] = permission as readonly [Address, bigint, bigint, bigint, number, Hex];
    const delegated = strategist.toLowerCase() === this.config.executor.toLowerCase();
    return { id, ...subscription, expiresAt, maxTradeBudget, maxRollingDayBudget, sessionId, authorizationNonce, cash, position,
      active: delegated && expiresAt > BigInt(nowSeconds()), revoked: !delegated, fill: fill ?? null };
  }

  private async enroll(id: bigint, entry: Awaited<ReturnType<CopyOperator["state"]>>) {
    const key = `${this.mode}-queue:${id}`;
    if (!entry.active || await this.storage.get(key)) return;
    const strategy = await this.strategy(entry.strategyId);
    await this.storage.put<QueueEntry>(key, { account: entry.account, rule: entry.rule, startsAt: Number(entry.startsAt),
      interval: Number(strategy.interval), expiresAt: Number(entry.expiresAt), lastSequence: entry.fill?.sequence ?? 0 });
  }

  private async quota(caller: string, stop: boolean, jobId: string) {
    const day = Math.floor(nowSeconds() / 86_400);
    const callerKey = `${this.mode}-quota:${caller}`;
    const globalKey = stop ? `${this.mode}-control-quota` : `${this.mode}-create-quota`;
    const reservationKey = `quota-reservation:${jobId}`;
    const keys = [callerKey, globalKey, reservationKey];
    const saved = await this.storage.get<{ day: number; count: number }>(keys);
    const recent = (key: string) => saved.get(key)?.day === day ? saved.get(key)!.count : 0;
    if (recent(reservationKey)) return;
    const globalLimit = stop ? 150 : this.mode === "algorithm" ? 20 : 40;
    if (recent(callerKey) >= (stop ? 40 : 12) || recent(globalKey) >= globalLimit) {
      throw new Error("오늘의 테스트 가스 지원 한도에 도달했습니다. 내일 다시 시도해 주세요.");
    }
    await this.storage.put(Object.fromEntries(keys.map(key => [key, { day, count: recent(key) + 1 }])));
  }

  async relay(body: Record<string, unknown>, caller: string) {
    if (!this.config.ready) throw new Error("GIWA 테스트넷 복사 거래를 준비 중입니다.");
    const sig = signature(body.signature);
    const now = BigInt(nowSeconds());
    const deadline = integer(body.deadline, now, now + 900n);
    if (body.kind === "register") {
      const name = typeof body.name === "string" ? body.name : "";
      if (!name.trim() || new TextEncoder().encode(name).length > 108 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
        throw new Error("전략 이름을 한 줄로 입력해 주세요.");
      }
      const creator = address(body.creator);
      const amount = integer(body.amount, 10_000_000n, 2_500_000_000n);
      if (this.mode === "algorithm") return this.registerAlgorithm(creator, name, amount, body.buyCondition, body.sellCondition, deadline, sig, caller);
      const args = [creator, name, amount, integer(body.interval, 900n, 86_400n), deadline, sig] as const;
      const simulated = await this.client.simulateContract({ address: this.config.market, abi: copyAbi, functionName: "register", args });
      const current = await this.strategyCount();
      if (simulated.result <= current) {
        const strategy = await this.strategy(simulated.result);
        if (strategy.creator === args[0] && strategy.name === args[1] && strategy.amount === args[2] && strategy.interval === args[3]) {
          return { strategyId: simulated.result, existing: true };
        }
      }
      const jobId = `copy-register:${keccak256(sig)}`;
      await this.quota(caller, false, jobId);
      const result = await this.send(jobId, this.config.market, encodeFunctionData({ abi: copyAbi, functionName: "register", args }));
      this.catalogCache = undefined;
      const receipt = await this.client.getTransactionReceipt({ hash: result.hash });
      const event = parseEventLogs({ abi: copyAbi, eventName: "StrategyRegistered", logs: receipt.logs }).find(log =>
        log.address.toLowerCase() === this.config.market.toLowerCase() && log.args.creator === args[0] &&
        log.args.name === args[1] && log.args.amount === args[2] && log.args.interval === args[3]);
      if (!event) throw new Error("등록 결과를 확인할 수 없습니다. 전략 목록을 새로 불러와 주세요.");
      return { strategyId: event.args.strategyId, hash: result.hash };
    }
    if (body.kind === "follow") {
      const request = {
        owner: address(body.owner), strategyId: integer(body.strategyId, 1n, await this.strategyCount()),
        maxTradeBudget: integer(body.maxTradeBudget, 10_000_000n, 2_500_000_000n),
        maxRollingDayBudget: integer(body.maxRollingDayBudget, 10_000_000n, 5_000_000_000n),
        expiresAt: integer(body.expiresAt, now + 61n, now + 7n * 86_400n), deadline,
      };
      const args = [request, sig] as const;
      const method = { address: this.config.market, abi: copyAbi, functionName: "follow" as const, args };
      await this.client.simulateContract(method);
      const lookup = { address: this.config.market, abi: copyAbi, functionName: "subscriptionIdOf" as const, args: [request.owner, request.strategyId] as const };
      let id = await this.client.readContract(lookup);
      let hash: Hex | undefined;
      const intentKey = `${this.mode}-intent:${request.owner}:${request.strategyId}`;
      if (id === 0n) {
        const jobId = `${this.mode}-follow:${keccak256(sig)}`;
        await this.quota(caller, false, jobId);
        await this.storage.put<FollowIntent>(intentKey, { owner: request.owner, strategyId: String(request.strategyId), deadline: Number(deadline) });
        ({ hash } = await this.send(jobId, this.config.market, encodeFunctionData(method)));
        id = await this.client.readContract(lookup);
      }
      if (id === 0n) throw new Error("팔로우 결과가 아직 반영되지 않았습니다. 다시 시도해 주세요.");
      const entry = await this.state(id);
      await this.enroll(id, entry);
      await this.storage.delete(intentKey);
      return { subscription: entry, hash };
    }
    if (body.kind === "stop" || body.kind === "withdraw") {
      const id = integer(body.id, 1n, 10n ** 24n);
      const subscribed = await this.subscription(id);
      const action = body.kind === "stop" ? 1 : 2;
      const args = [action, ZERO_SESSION, integer(body.sessionId, 1n, 10n ** 24n), integer(body.nonce, 0n, 10n ** 24n), deadline, sig] as const;
      const method = { address: subscribed.account, abi: accountAbi, functionName: "executeOwnerAction" as const, args };
      const data = encodeFunctionData(method);
      const jobId = `${this.mode}-control:${id}:${keccak256(data)}`;
      if (!await this.storage.get<BroadcastJob>(`job:${jobId}`)) {
        await this.client.simulateContract(method);
        await this.quota(caller, true, jobId);
      }
      try {
        const result = await this.send(jobId, subscribed.account, data);
        await this.storage.delete(`${this.mode}-queue:${id}`);
        return { hash: result.hash, pending: false };
      } catch (failure) {
        // Once a signed transaction is stored, a delayed RPC response cannot establish failure.
        const broadcast = await this.storage.get<BroadcastJob>(`job:${jobId}`);
        if (!broadcast || broadcast.error) throw failure;
        return { hash: broadcast.hash, pending: !broadcast.done };
      }
    }
    throw new Error("지원하지 않는 요청입니다.");
  }

  private async registerAlgorithm(creator: Address, name: string, amount: bigint, buy: unknown, sell: unknown,
    deadline: bigint, sig: Hex, caller: string) {
    const program = (value: unknown): Hex => {
      if (typeof value !== "string" || !/^0x(?:[\da-f]{2}){1,112}$/i.test(value)) throw new Error("알고리즘 조건을 확인해 주세요.");
      return value as Hex;
    };
    const buyCondition = program(buy);
    const sellCondition = program(sell);
    const programHash = hashProgram(buyCondition, sellCondition);
    const method = { address: this.config.market, abi: algorithmAbi, functionName: "registerAlgorithm" as const,
      args: [creator, name, amount, buyCondition, sellCondition, deadline, sig] as const };
    await this.client.simulateContract(method);
    const lookup = { address: this.config.market, abi: algorithmAbi, functionName: "strategyIdOf" as const,
      args: [creator, name, amount, programHash] as const };
    let id = await this.client.readContract(lookup);
    if (id !== 0n) return { strategyId: id, existing: true };
    const jobId = `algorithm-register:${keccak256(sig)}`;
    await this.quota(caller, false, jobId);
    const result = await this.send(jobId, this.config.market, encodeFunctionData(method));
    this.catalogCache = undefined;
    id = await this.client.readContract({ ...lookup, blockNumber: result.block });
    if (id === 0n) throw new Error("등록한 알고리즘이 아직 목록에 반영되지 않았습니다.");
    return { strategyId: id, hash: result.hash };
  }

  private async pendingAlgorithmSignal(rule: Address) {
    const [decision, signal] = await this.client.multicall({ contracts: [
      { address: rule, abi: decisionAbi, functionName: "decision" },
      { address: rule, abi: algorithmSignalAbi, functionName: "currentSignal" },
    ] });
    if (decision.status !== "success") throw decision.error;
    const [side, signalSequence, openedAt, close] = decision.result;
    if (side === 0) return null;
    if (signal.status !== "success") throw signal.error;
    if (signal.result.sequence !== signalSequence || signal.result.issuedAt !== openedAt) throw new Error("CANDLE_MOVED");
    return { side: (side === 1 ? "BUY" : "SELL") as "BUY" | "SELL", signal: signal.result, close };
  }

  async tick() {
    if (!this.config.ready) return;
    const intents = await this.storage.list<FollowIntent>({ prefix: `${this.mode}-intent:`, limit: 4 });
    for (const [key, intent] of intents) {
      try {
        const id = await this.client.readContract({ address: this.config.market, abi: copyAbi, functionName: "subscriptionIdOf",
          args: [intent.owner, BigInt(intent.strategyId)] });
        if (id !== 0n) await this.enroll(id, await this.state(id));
        if (id !== 0n || nowSeconds() > intent.deadline + 180) await this.storage.delete(key);
      } catch (failure) {
        console.info("Copy enrollment will retry", { name: (failure as Error).name });
      }
    }
    const queue = await this.storage.list<QueueEntry>({ prefix: `${this.mode}-queue:` });
    const at = nowSeconds();
    const matches = [];
    const algorithm = this.mode === "algorithm";
    const windowStart = (entry: QueueEntry, sequence: number) => entry.startsAt + (sequence - 1) * entry.interval;
    const timeUntilClose = (entry: QueueEntry, sequence: number) => windowStart(entry, sequence) + (algorithm ? entry.interval : 180) - nowSeconds();
    for (const [key, entry] of queue) {
      if (entry.expiresAt <= at) {
        await this.storage.delete(key);
        continue;
      }
      const elapsed = at - entry.startsAt;
      const sequence = Math.floor(elapsed / entry.interval) + 1;
      if (elapsed >= 0 && timeUntilClose(entry, sequence) > 20 && sequence > entry.lastSequence) matches.push({ key, entry, sequence });
    }
    matches.sort((a, b) => windowStart(a.entry, a.sequence) - windowStart(b.entry, b.sequence));
    const cursor = algorithm && matches.length
      ? (await this.storage.get<number>("algorithm-scan-cursor") ?? 0) % matches.length : 0;
    const candidates = [...matches.slice(cursor), ...matches.slice(0, cursor)];
    let swaps = 0;
    let holds = 0;
    let errors = 0;
    let inspected = 0;
    const pendingSignals = new Map<Address, Awaited<ReturnType<CopyOperator["pendingAlgorithmSignal"]>>>();
    for (const { key, entry, sequence } of candidates.slice(0, algorithm ? 12 : 4)) {
      if (swaps === 4) break;
      inspected++;
      const id = key.slice((`${this.mode}-queue:`).length);
      try {
        if (timeUntilClose(entry, sequence) <= 20) continue;
        let order: Awaited<ReturnType<CopyOperator["pendingAlgorithmSignal"]>> = null;
        if (algorithm) {
          if (!pendingSignals.has(entry.rule)) pendingSignals.set(entry.rule, await this.pendingAlgorithmSignal(entry.rule));
          order = pendingSignals.get(entry.rule) ?? null;
          if (!order) {
            holds++;
            continue;
          }
          if (Number(order.signal.issuedAt) !== windowStart(entry, sequence)) continue;
        }
        const state = await this.state(BigInt(id));
        if (!state.active || (state.cash === 0n && (!algorithm || state.position === 0n))) {
          await this.storage.delete(key);
          continue;
        }
        if (order && (order.side === "BUY" ? state.cash === 0n : state.position === 0n)) continue;
        if (order) {
          const [lastTradeAt, spent] = await this.client.multicall({ contracts: [
            { address: entry.account, abi: accountAbi, functionName: "lastTradeAt" },
            { address: entry.account, abi: accountAbi, functionName: "rollingDaySpent" },
          ], allowFailure: false });
          if (lastTradeAt + 900n > BigInt(nowSeconds()) || spent >= state.maxRollingDayBudget) continue;
        }
        const tokenIn = order?.signal.tokenIn ?? this.config.budget;
        const data = order ? encodeFunctionData({ abi: algorithmSignalAbi, functionName: "execute",
          args: [entry.account, entry.rule, order.signal, "0x"] }) :
          encodeFunctionData({ abi: scheduledRuleAbi, functionName: "execute", args: [entry.account] });
        if (timeUntilClose(entry, sequence) <= 16) continue;
        const result = await this.send(`${this.mode}-swap:${id}:${sequence}`, order ? this.config.executor : entry.rule, data);
        const receipt = await this.client.getTransactionReceipt({ hash: result.hash });
        const event = parseEventLogs({ abi: accountAbi, eventName: "SwapExecuted", logs: receipt.logs }).find(log =>
          log.address.toLowerCase() === entry.account.toLowerCase() && log.args.tokenIn.toLowerCase() === tokenIn.toLowerCase());
        if (!event) throw new Error("COPY_SWAP_RECEIPT_MISSING");
        const detail = order ? { signalSequence: String(order.signal.sequence), side: order.side, close: order.close } : {};
        await this.storage.put({ [key]: { ...entry, lastSequence: sequence },
          [`${this.mode}-fill:${id}`]: { hash: result.hash, block: String(result.block), amountIn: String(event.args.amountIn),
            amountOut: String(event.args.amountOut), sequence, ...detail } satisfies Fill });
        swaps++;
      } catch (failure) {
        errors++;
        console.info("Copy window attempt", { mode: this.mode, subscription: id, sequence, name: (failure as Error).name });
      }
    }
    if (algorithm && matches.length) await this.storage.put("algorithm-scan-cursor", (cursor + inspected) % matches.length);
    await this.storage.put(`${this.mode}-last-tick`, { at: new Date().toISOString(), subscribed: queue.size, due: matches.length, swaps, holds, errors });
  }

  status() {
    return this.storage.get(`${this.mode}-last-tick`);
  }
}
