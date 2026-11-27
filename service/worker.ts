import { DurableObject } from "cloudflare:workers";
import {
  createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, getAddress,
  hashTypedData, isAddress, isHex, keccak256, parseEventLogs, toHex,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  accountAbi, actionDomain, actionTypes, chain, createDomain, createTypes, decide,
  deployment as config, factoryAbi, testQuoteAbi, sessionHash, strategies, strategyHash,
  tokenAbi, ZERO_SESSION, type Session,
} from "./protocol";
import { fetchTestPrice, type TestPrice } from "./market";
import { evaluateStrategy, type AccountEvaluation } from "./evaluation";
import { giwaTransport } from "./rpc";
import { SpotService, type SpotAnchorRequest, type SpotEnvironment } from "./spot-service";
import { spotCheckpointAbi, spotCheckpointDeployment } from "./spot-chain";
import { type SpotAnchor } from "./spot-domain";
import { parseStrategyDraft, type CatalogStrategy } from "./strategy-catalog";

interface Env extends SpotEnvironment { ASSETS: Fetcher; OPERATOR: DurableObjectNamespace; SPOT: DurableObjectNamespace; GIWA_RPC_URL: string; TESTNET_KEEPER_KEY?: string }
type Activity = { hash: Hex; account: Address; action: string; at: string; block: string; buy?: boolean; amountIn?: string; amountOut?: string; reason?: string };
type Price = TestPrice;
type Job = { hash: Hex; raw?: Hex; nonce?: number; at: string; done?: boolean; block?: string; error?: string };
const textEncoder = new TextEncoder();
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data, (_, v) => typeof v === "bigint" ? v.toString() : v), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const address = (value: unknown): Address => { if (typeof value !== "string" || !isAddress(value)) throw new Error("지갑 주소를 확인해 주세요."); return getAddress(value); };
const quantity = (value: unknown): bigint => { if (typeof value !== "string" || !/^\d{1,45}$/.test(value)) throw new Error("금액과 거래 번호를 확인해 주세요."); return BigInt(value); };
const signatureOf = (value: unknown): Hex => { if (typeof value !== "string" || !isHex(value) || value.length < 130 || value.length > 8194) throw new Error("지갑 서명이 필요합니다."); return value; };
const minute = () => Math.floor(Date.now() / 60_000);

async function boundedBody(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new Error("JSON 요청이 필요합니다.");
  const reader = request.body?.getReader(); if (!reader) throw new Error("요청 내용이 없습니다.");
  let size = 0; const chunks: Uint8Array[] = [];
  for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 32_768) { await reader.cancel(); throw new Error("요청 내용이 너무 큽니다."); } chunks.push(value); }
  const body = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
}

export class TestnetOperator extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve();
  private client;
  private wallet;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const transport = giwaTransport(env.GIWA_RPC_URL);
    this.client = createPublicClient({ chain, transport, batch: { multicall: { wait: 30 } } });
    this.wallet = env.TESTNET_KEEPER_KEY ? createWalletClient({ account: privateKeyToAccount(env.TESTNET_KEEPER_KEY as Hex), chain, transport }) : undefined;
  }
  private serialize<T>(job: () => Promise<T>): Promise<T> { const next = this.tail.then(job, job); this.tail = next.catch(() => undefined); return next; }
  private async strategyCatalog(request: Request) {
    const stored = await this.ctx.storage.get<CatalogStrategy[]>("demo-strategies") ?? [];
    if (request.method === "GET") return json({ strategies: stored });
    const draft = parseStrategyDraft(await boundedBody(request));
    if (!draft) return json({ error: "전략 이름, 제작자 이름과 지원되는 매매 규칙을 확인해 주세요." }, 400);

    const strategy = stored.find(item => item.name === draft.name && item.creator === draft.creator && item.scenario === draft.scenario);
    if (strategy) return json({ strategy });
    const now = Math.floor(Date.now() / 86_400_000);
    const quota = await this.ctx.storage.get<{ day: number; count: number }>("demo-catalog-quota");
    const count = quota?.day === now ? quota.count : 0;
    if (count >= 100) return json({ error: "오늘 모의 전략 등록 한도에 도달했습니다. 내일 다시 시도해 주세요." }, 429);
    const created = { ...draft, id: `demo-${crypto.randomUUID()}` };
    await this.ctx.storage.put({
      "demo-strategies": [created, ...stored].slice(0, 100),
      "demo-catalog-quota": { day: now, count: count + 1 },
    });
    return json({ strategy: created }, 201);
  }
  private async price(): Promise<Price> {
    const price = await fetchTestPrice();
    await this.ctx.storage.put("price-data", { price, fetchedAt: Date.now() });
    const history = await this.ctx.storage.get<Array<{ at: number; value: number }>>("price-history") ?? [];
    if (history.at(-1)?.at !== price.publishedAt) { history.push({ at: price.publishedAt, value: price.price }); await this.ctx.storage.put("price-history", history.slice(-1440)); }
    return price;
  }
  private async cachedPrice(): Promise<Price> {
    const cached = await this.ctx.storage.get<{ price: Price; fetchedAt: number }>("price-data");
    return cached && Date.now() - cached.fetchedAt < 15_000 ? cached.price : this.price();
  }
  private async accountState(account: Address) {
    if (!config.ready || !await this.client.readContract({ address: config.factory, abi: factoryAbi, functionName: "isAccount", args: [account] })) throw new Error("등록된 전략 계정을 찾지 못했습니다.");
    const read = (functionName: "owner" | "session" | "sessionId" | "nextNonce" | "authorizationNonce" | "rollingDaySpent" | "lastTradeAt") => this.client.readContract({ address: account, abi: accountAbi, functionName });
    const [owner, active, epoch, nonce, authNonce, spent, lastTradeAt, cash, position, strategyId] = await Promise.all([
      read("owner"), read("session"), read("sessionId"), read("nextNonce"), read("authorizationNonce"), read("rollingDaySpent"), read("lastTradeAt"),
      this.client.readContract({ address: config.budget, abi: tokenAbi, functionName: "balanceOf", args: [account] }),
      this.client.readContract({ address: config.position, abi: tokenAbi, functionName: "balanceOf", args: [account] }),
      this.client.readContract({ address: config.factory, abi: factoryAbi, functionName: "strategyOf", args: [account] }),
    ]);
    const s = active as readonly [Address, bigint, bigint, bigint, number, Hex];
    const session: Session = { strategist: s[0], expiresAt: s[1], maxTradeBudget: s[2], maxRollingDayBudget: s[3], maxSlippageBps: s[4], strategyHash: s[5] };
    const activity = await this.ctx.storage.get<Activity[]>(`activity:${account.toLowerCase()}`) ?? [];
    const latest = await this.ctx.storage.get<AccountEvaluation>(`evaluation:${account.toLowerCase()}`);
    const evaluation = latest?.sessionId === undefined || latest.sessionId === String(epoch) ? latest : undefined;
    return { address: account, owner: owner as Address, session, sessionId: epoch as bigint, nextNonce: nonce as bigint, authorizationNonce: authNonce as bigint,
      spent: spent as bigint, lastTradeAt: lastTradeAt as bigint, cash, position, strategyId,
      active: s[0].toLowerCase() === config.keeper.toLowerCase() && s[1] > BigInt(Math.floor(Date.now() / 1000)), activity, evaluation };
  }
  private async record(item: Activity) {
    const key = `activity:${item.account.toLowerCase()}`;
    const history = await this.ctx.storage.get<Activity[]>(key) ?? [];
    if (!history.some(old => old.hash === item.hash)) await this.ctx.storage.put(key, [item, ...history].slice(0, 100));
  }
  private async settle(id: string, job: Job): Promise<{ hash: Hex; block: bigint }> {
    if (job.done) {
      if (job.error) throw new Error(job.error);
      return { hash: job.hash, block: BigInt(job.block!) };
    }
    if (job.raw) {
      try { await this.client.sendRawTransaction({ serializedTransaction: job.raw }); }
      catch (failure) {
        const existing = await this.client.getTransaction({ hash: job.hash }).catch(() => undefined);
        if (!existing) throw failure;
      }
    }
    const receipt = await this.client.waitForTransactionReceipt({ hash: job.hash, confirmations: 2, timeout: 45_000, pollingInterval: 3_000 });
    const error = receipt.status === "reverted" ? "트랜잭션이 거절되었습니다. 계정 상태를 새로고침해 주세요." : undefined;
    const nonce = job.nonce ?? (await this.client.getTransaction({ hash: job.hash })).nonce;
    const nextNonce = await this.ctx.storage.get<number>("next-transaction-nonce") ?? 0;
    await this.ctx.storage.put("next-transaction-nonce", Math.max(nextNonce, nonce + 1));
    await this.ctx.storage.put(`job:${id}`, { ...job, raw: undefined, done: true, block: String(receipt.blockNumber), error });
    if (await this.ctx.storage.get<string>("pending-job") === id) await this.ctx.storage.delete("pending-job");
    if (error) throw new Error(error);
    return { hash: job.hash, block: receipt.blockNumber };
  }
  private async send(id: string, to: Address, data: Hex, value = 0n): Promise<{ hash: Hex; block: bigint }> {
    if (!this.wallet || this.wallet.account.address.toLowerCase() !== config.keeper.toLowerCase()) throw new Error("테스트넷 실행 서비스가 준비 중입니다.");
    if (await this.client.getChainId() !== 91342) throw new Error("GIWA 테스트넷 연결을 확인하지 못했습니다.");
    const pending = await this.ctx.storage.get<string>("pending-job");
    if (pending && pending !== id) {
      const previous = await this.ctx.storage.get<Job>(`job:${pending}`);
      if (previous) {
        try { await this.settle(pending, previous); }
        catch (failure) {
          // A confirmed revert consumes its nonce. An unknown/pending transaction
          // must finish before another nonce is signed, including after a restart.
          if (!(await this.ctx.storage.get<Job>(`job:${pending}`))?.done) throw failure;
        }
      } else throw new Error("이전 실행 상태를 확인하고 있습니다. 잠시 후 다시 시도해 주세요.");
    }
    let job = await this.ctx.storage.get<Job>(`job:${id}`);
    if (!job) {
      const balance = await this.client.getBalance({ address: this.wallet.account.address });
      if (balance < 50_000_000_000_000n) throw new Error("테스트 가스 충전이 필요해 실행을 잠시 대기합니다. 내 지갑의 직접 회수 기능은 사용할 수 있습니다.");
      const gasPrice = await this.client.getGasPrice();
      if (gasPrice > 20_000_000n) throw new Error("테스트넷 가스 가격이 높아 실행을 대기합니다.");
      const nonce = Math.max(await this.client.getTransactionCount({ address: this.wallet.account.address, blockTag: "latest" }),
        await this.client.getTransactionCount({ address: this.wallet.account.address, blockTag: "pending" }),
        await this.ctx.storage.get<number>("next-transaction-nonce") ?? 0);
      const gas = await this.client.estimateGas({ account: this.wallet.account.address, to, data, value, nonce });
      if (gas > 12_000_000n) throw new Error("허용된 실행 비용을 초과했습니다.");
      const transaction = await this.wallet.prepareTransactionRequest({ to, data, value, nonce, gas: gas * 12n / 10n, gasPrice, type: "legacy" });
      const raw = await this.wallet.signTransaction(transaction);
      job = { hash: keccak256(raw), raw, nonce, at: new Date().toISOString() };
      await this.ctx.storage.put({ [`job:${id}`]: job, "pending-job": id });
    }
    return this.settle(id, job);
  }
  private async updateOracle() {
    const current = await this.client.readContract({ address: config.quote, abi: testQuoteAbi, functionName: "observedAt" });
    // Refresh after account discovery/queued RPC reads, not at the start of a
    // cron batch. Leave time for publication and the swap inside the 60s limit.
    const price = await this.price();
    if (Date.now() / 1000 - price.publishedAt > 15) throw new Error("집행에 사용할 최신 시세를 기다리고 있습니다.");
    if (current >= BigInt(price.publishedAt)) return price;
    console.info("Test price publication", { observedAt: price.publishedAt, startedAt: Math.floor(Date.now() / 1000) });
    await this.send(`price:${price.publishedAt}`, config.quote, encodeFunctionData({ abi: testQuoteAbi, functionName: "publish", args: [BigInt(price.priceE8), BigInt(price.publishedAt), keccak256(toHex(JSON.stringify(price.sources)))] }));
    console.info("Test price confirmed", { observedAt: price.publishedAt, confirmedAt: Math.floor(Date.now() / 1000) });
    return price;
  }
  private async tickAccount(account: Address, price: Price) {
    const state = await this.accountState(account);
    if (!state.active) return;
    const choose = (value: Price) => decide({ strategyId: state.strategyId, cash: state.cash, position: state.position, priceE8: BigInt(value.priceE8),
      tradeCap: state.session.maxTradeBudget, dayCap: state.session.maxRollingDayBudget, spent: state.spent, lastTradeAt: state.lastTradeAt, now: BigInt(Math.floor(Date.now() / 1000)) });
    await evaluateStrategy(choose(price), async () => {
      // Idle accounts need no onchain price update.
      const latestPrice = await this.updateOracle();
      return { price: latestPrice, decision: choose(latestPrice) };
    }, (latestPrice, decision) => this.exchange(account, state, latestPrice, decision), evaluation =>
      this.ctx.storage.put(`evaluation:${account.toLowerCase()}`, { ...evaluation, at: new Date().toISOString(), sessionId: String(state.sessionId) }));
  }
  private async exchange(account: Address, state: { sessionId: bigint; nextNonce: bigint; strategyId: number }, price: Price, decision: { buy: boolean; amount: bigint; reason: string }) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const reference = decision.buy ? decision.amount * 100_000_000_000_000_000_000n / BigInt(price.priceE8) : decision.amount * BigInt(price.priceE8) / 100_000_000_000_000_000_000n;
    const minimum = (reference * 9_920n + 9_999n) / 10_000n;
    const signal = keccak256(toHex(JSON.stringify({ account, nonce: String(state.nextNonce), strategy: state.strategyId, priceAt: price.publishedAt, reason: decision.reason })));
    const result = await this.send(`swap:${account}:${state.sessionId}:${state.nextNonce}:${price.publishedAt}`, account, encodeFunctionData({ abi: accountAbi, functionName: "swap", args: [decision.buy, decision.amount, minimum,
      state.sessionId, state.nextNonce, now + 180n, signal] }));
    const receipt = await this.client.getTransactionReceipt({ hash: result.hash });
    const executed = parseEventLogs({ abi: accountAbi, eventName: "SwapExecuted", logs: receipt.logs }).find(event =>
      event.address.toLowerCase() === account.toLowerCase() && event.args.signalHash === signal &&
      event.args.sessionId === state.sessionId && event.args.nonce === state.nextNonce);
    if (receipt.status !== "success" || !executed) throw new Error("계정의 교환 영수증을 확인하지 못했습니다.");
    await this.record({ hash: result.hash, account, action: "SWAP", at: new Date().toISOString(), block: String(result.block), buy: decision.buy, amountIn: String(decision.amount), amountOut: String(executed.args.amountOut), reason: decision.reason });
    return result.hash;
  }
  private async tick() {
    if (!config.ready || !this.wallet) return { ready: false };
    const count = Number(await this.client.readContract({ address: config.factory, abi: factoryAbi, functionName: "accountCount" }));
    const cursor = await this.ctx.storage.get<number>("cursor") ?? 0;
    const price = await this.price();
    const errors: string[] = [];
    for (let i = 0; i < Math.min(count, 12); i++) {
      const account = await this.client.readContract({ address: config.factory, abi: factoryAbi, functionName: "accountAt", args: [BigInt((cursor + i) % count)] });
      try { await this.tickAccount(account, price); } catch (failure) { errors.push(failure instanceof Error ? failure.message.slice(0, 200) : "계정 평가 실패"); }
    }
    await this.ctx.storage.put("cursor", count > 0 ? (cursor + 12) % count : 0);
    const status = { at: new Date().toISOString(), accounts: count, errors };
    await this.ctx.storage.put("last-tick", status);
    return status;
  }
  private async publishSpotCheckpoint(request: SpotAnchorRequest): Promise<SpotAnchor> {
    if (!spotCheckpointDeployment.ready || spotCheckpointDeployment.chainId !== 91342 ||
        spotCheckpointDeployment.publisher.toLowerCase() !== config.keeper.toLowerCase()) throw new Error("GIWA 기록 계약을 준비하고 있습니다.");
    const result = await this.send(`spot:${request.streamId}:${request.sequence}`, spotCheckpointDeployment.contract,
      encodeFunctionData({ abi: spotCheckpointAbi, functionName: "publish", args: [request.streamId, BigInt(request.sequence), request.previousCheckpoint, request.evidenceHead, request.policyHash] }));
    const receipt = await this.client.getTransactionReceipt({ hash: result.hash });
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== spotCheckpointDeployment.contract.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: spotCheckpointAbi, ...log });
        if (decoded.eventName === "CheckpointPublished" && decoded.args.streamId === request.streamId && decoded.args.sequence === BigInt(request.sequence) && decoded.args.evidenceHead === request.evidenceHead) {
          return { transactionHash: result.hash, sequence: request.sequence, evidenceHead: request.evidenceHead, checkpointHash: decoded.args.checkpointHash, block: String(result.block) };
        }
      } catch { /* Other contract event. */ }
    }
    throw new Error("GIWA 기록 게시 결과를 확인하지 못했습니다.");
  }
  private async relay(body: Record<string, unknown>, ip: string) {
    if (!config.ready) throw new Error("테스트넷 계약 배포가 준비 중입니다.");
    const signature = signatureOf(body.signature);
    const deadline = quantity(body.deadline);
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (deadline < now || deadline > now + 900n) throw new Error("서명 요청이 만료됐습니다. 다시 시도해 주세요.");
    const quotaKey = `quota:${ip}`;
    const stored = await this.ctx.storage.get<{ minute: number; count: number }>(quotaKey);
    const quota = stored?.minute === minute() ? stored.count : 0;
    if (quota >= 8) throw new Error("요청이 많습니다. 잠시 후 다시 시도해 주세요.");
    await this.ctx.storage.put(quotaKey, { minute: minute(), count: quota + 1 });
    if (body.kind === "create") {
      const owner = address(body.owner); const strategyId = Number(body.strategyId);
      const maxTradeBudget = quantity(body.maxTradeBudget); const maxRollingDayBudget = quantity(body.maxRollingDayBudget); const expiresAt = quantity(body.expiresAt);
      if (![0, 1].includes(strategyId) || maxTradeBudget < 100_000_000n || maxTradeBudget > 2_500_000_000n || maxRollingDayBudget < maxTradeBudget || maxRollingDayBudget > 5_000_000_000n || expiresAt <= now || expiresAt > now + 604_800n) throw new Error("권한과 집행 한도를 확인해 주세요.");
      const message = { owner, strategyId, maxTradeBudget, maxRollingDayBudget, expiresAt, deadline };
      if (!await this.client.verifyTypedData({ address: owner, domain: createDomain(), types: createTypes, primaryType: "CreateAccount", message, signature })) throw new Error("지갑 서명을 확인하지 못했습니다.");
      const existing = await this.client.readContract({ address: config.factory, abi: factoryAbi, functionName: "accounts", args: [owner, strategyId] });
      if (existing !== "0x0000000000000000000000000000000000000000") return { account: existing, existing: true };
      const dayKey = `create:${ip}:${Math.floor(Date.now() / 86_400_000)}`;
      const creates = await this.ctx.storage.get<number>(dayKey) ?? 0;
      if (creates >= 10) throw new Error("오늘의 테스트 계정 생성 한도에 도달했습니다.");
      await this.ctx.storage.put(dayKey, creates + 1);
      const id = hashTypedData({ domain: createDomain(), types: createTypes, primaryType: "CreateAccount", message });
      const result = await this.send(id, config.factory, encodeFunctionData({ abi: factoryAbi, functionName: "createAccount", args: [owner, strategyId, maxTradeBudget, maxRollingDayBudget, expiresAt, deadline, signature] }));
      const account = await this.client.readContract({ address: config.factory, abi: factoryAbi, functionName: "accounts", args: [owner, strategyId], blockNumber: result.block });
      await this.record({ ...result, block: String(result.block), account, action: "CREATE", at: new Date().toISOString() });
      this.ctx.waitUntil(this.serialize(async () => {
        try { await this.tickAccount(account, await this.price()); }
        catch (error) { console.warn("Initial strategy evaluation could not finish", error); }
      }));
      return { account, hash: result.hash };
    }
    if (body.kind !== "action") throw new Error("지원하지 않는 요청입니다.");
    const account = address(body.account); const action = Number(body.action);
    if (![0, 1, 2].includes(action)) throw new Error("지원하지 않는 계정 동작입니다.");
    const state = await this.accountState(account);
    const epoch = quantity(body.sessionId); const nonce = quantity(body.nonce);
    if (epoch !== state.sessionId || nonce !== state.authorizationNonce) throw new Error("계정 상태가 바뀌었습니다. 새로고침 후 다시 서명해 주세요.");
    let requested = ZERO_SESSION;
    if (action === 0) {
      const raw = body.session as Record<string, unknown>;
      requested = { strategist: address(raw?.strategist), expiresAt: quantity(raw?.expiresAt), maxTradeBudget: quantity(raw?.maxTradeBudget), maxRollingDayBudget: quantity(raw?.maxRollingDayBudget), maxSlippageBps: Number(raw?.maxSlippageBps), strategyHash: raw?.strategyHash as Hex };
      if (requested.strategist.toLowerCase() !== config.keeper.toLowerCase() || requested.strategyHash !== strategyHash(state.strategyId) || requested.maxSlippageBps !== 100 || requested.maxTradeBudget < 100_000_000n || requested.maxTradeBudget > 2_500_000_000n || requested.maxRollingDayBudget < requested.maxTradeBudget || requested.maxRollingDayBudget > 5_000_000_000n || requested.expiresAt <= now || requested.expiresAt > now + 604_800n) throw new Error("허용할 전략 권한을 다시 확인해 주세요.");
    }
    const message = { action, sessionHash: sessionHash(requested), sessionId: epoch, nonce, deadline };
    if (!await this.client.verifyTypedData({ address: state.owner, domain: actionDomain(account), types: actionTypes, primaryType: "OwnerAction", message, signature })) throw new Error("계정 소유자의 서명이 필요합니다.");
    const id = hashTypedData({ domain: actionDomain(account), types: actionTypes, primaryType: "OwnerAction", message });
    const result = await this.send(id, account, encodeFunctionData({ abi: accountAbi, functionName: "executeOwnerAction", args: [action, requested, epoch, nonce, deadline, signature] }));
    await this.record({ ...result, block: String(result.block), account, action: ["RESUME", "REVOKE", "WITHDRAW"][action], at: new Date().toISOString() });
    return { account, hash: result.hash };
  }
  async fetch(request: Request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/strategy-catalog") return await this.serialize(() => this.strategyCatalog(request));
      if (url.pathname === "/spot-anchor" && request.method === "POST") {
        const checkpoint = await request.json() as SpotAnchorRequest;
        return json(await this.serialize(() => this.publishSpotCheckpoint(checkpoint)));
      }
      if (url.pathname === "/tick") return json(await this.serialize(() => this.tick()));
      if (url.pathname === "/relay") { const body = await boundedBody(request); return json(await this.serialize(() => this.relay(body, request.headers.get("x-caller") ?? "unknown"))); }
      if (url.pathname === "/market") return json({ price: await this.cachedPrice(), history: await this.ctx.storage.get("price-history") ?? [], source: "Coinbase + Kraken · 서비스 게시 테스트 가격", mode: "TESTNET" });
      if (url.pathname === "/accounts") {
        const owner = address(url.searchParams.get("owner"));
        if (!config.ready) return json({ accounts: [] });
        const found = await Promise.all([0, 1].map(strategyId => this.client.readContract({ address: config.factory, abi: factoryAbi, functionName: "accounts", args: [owner, strategyId] })));
        return json({ accounts: await Promise.all(found.filter(a => a !== "0x0000000000000000000000000000000000000000").map(a => this.accountState(a))) });
      }
      if (url.pathname === "/account") return json(await this.accountState(address(url.searchParams.get("address"))));
      if (url.pathname === "/status") {
        const balance = this.wallet ? await this.client.getBalance({ address: this.wallet.account.address }).catch(() => 0n) : 0n;
        return json({ ready: config.ready && !!this.wallet && balance >= 50_000_000_000_000n, deployment: config, strategies,
          lastTick: await this.ctx.storage.get("last-tick") ?? null, gasSponsored: true, mode: "TESTNET", observedAt: new Date().toISOString() });
      }
      return json({ error: "요청을 찾지 못했습니다." }, 404);
    } catch (failure) {
      const raw = failure instanceof Error ? failure.message : "요청을 처리하지 못했습니다.";
      // Keep provider diagnostics in operator logs, never signatures or raw transactions.
      const diagnostic = failure as { name?: string; shortMessage?: string; details?: string };
      console.error("Testnet request failed", { path: new URL(request.url).pathname, name: diagnostic.name,
        message: (diagnostic.shortMessage ?? raw.split("\n")[0]).slice(0, 300), details: diagnostic.details?.slice(0, 200) });
      const safe = /^[가-힣]/.test(raw) ? raw.slice(0, 300) : "테스트넷 요청을 처리하지 못했습니다. 잠시 후 새로고침해 주세요.";
      return json({ error: safe }, 400);
    }
  }
}

function secure(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff"); headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("x-frame-options", "DENY"); headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://sepolia-rpc.giwa.io https://hermes.pyth.network; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
export class UpbitSpotOperator extends DurableObject<Env> {
  private service: SpotService;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.service = new SpotService(ctx.storage, env, spotCheckpointDeployment.ready ? async checkpoint => {
      const actor = env.OPERATOR.get(env.OPERATOR.idFromName("giwa-sepolia-operator-v1"));
      const response = await actor.fetch(new Request("https://operator.internal/spot-anchor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(checkpoint) }));
      const result = await response.json() as SpotAnchor & { error?: string };
      if (!response.ok || result.error) throw new Error(result.error ?? "GIWA 기록을 게시하지 못했습니다.");
      return result;
    } : undefined);
  }
  fetch(request: Request): Promise<Response> {
    const job = this.tail.then(() => this.service.handle(request));
    this.tail = job.catch(() => undefined); return job;
  }
}
const worker = {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return secure(await env.ASSETS.fetch(request));
    if (url.pathname.startsWith("/api/spot/")) {
      const upstream = new URL(request.url); upstream.pathname = url.pathname.slice("/api/spot".length);
      const pilotOwner = env.UPBIT_OWNER_ADDRESS && isAddress(env.UPBIT_OWNER_ADDRESS) ? env.UPBIT_OWNER_ADDRESS.toLowerCase() : "unconfigured";
      const actor = env.SPOT.get(env.SPOT.idFromName(`upbit-spot-owner-pilot-v1:${pilotOwner}`));
      return secure(await actor.fetch(new Request(upstream, { method: request.method, headers: request.headers,
        body: request.method === "POST" ? request.body : undefined })));
    }
    const allowed = ["/api/status", "/api/market", "/api/accounts", "/api/account", "/api/relay", "/api/strategy-catalog"];
    if (!allowed.includes(url.pathname)) return secure(json({ error: "요청을 찾지 못했습니다." }, 404));
    if (url.pathname === "/api/relay") {
      if (request.method !== "POST" || request.headers.get("origin") !== url.origin) return secure(json({ error: "이 서비스 화면에서 다시 요청해 주세요." }, 403));
    } else if (url.pathname === "/api/strategy-catalog" && request.method === "POST") {
      if (request.headers.get("origin") !== url.origin) return secure(json({ error: "이 서비스 화면에서 다시 요청해 주세요." }, 403));
    } else if (request.method !== "GET") return secure(json({ error: "지원하지 않는 요청입니다." }, 405));
    const headers = new Headers(request.headers);
    const ip = request.headers.get("cf-connecting-ip") ?? "local";
    headers.set("x-caller", keccak256(textEncoder.encode(ip)).slice(0, 26));
    const upstream = new URL(request.url); upstream.pathname = url.pathname.slice(4);
    const actorName = url.pathname === "/api/strategy-catalog" ? "testnet-strategy-catalog-v1" : "giwa-sepolia-operator-v1";
    const actor = env.OPERATOR.get(env.OPERATOR.idFromName(actorName));
    return secure(await actor.fetch(new Request(upstream, { method: request.method, headers, body: request.method === "POST" ? request.body : undefined })));
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const actor = env.OPERATOR.get(env.OPERATOR.idFromName("giwa-sepolia-operator-v1"));
    ctx.waitUntil(actor.fetch(new Request("https://operator.internal/tick")));
  },
};
export default worker;
