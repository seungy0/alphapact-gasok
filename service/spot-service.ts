import { getAddress, isAddress, recoverMessageAddress, toHex, type Address, type Hex } from "viem";
import { DEFAULT_SPOT_RULE, normalizedAction, orderForValidation, spotHash, SPOT_MARKETS, ZERO_HASH,
  type SpotAction, type SpotAnchor, type SpotQuote, type SpotRecord, type SpotRule, type SpotSnapshot, type SpotState } from "./spot-domain";
import { spotExecutorConfigured, spotExecutorRequest, validSpotSnapshot, type SpotExecutorConfig } from "./spot-executor";

export type SpotEnvironment = SpotExecutorConfig & { UPBIT_OWNER_ADDRESS?: string };
export interface SpotStorage { get<T>(key: string): Promise<T | undefined>; put(entries: Record<string, unknown>): Promise<unknown>; delete(key: string): Promise<unknown> }
type Challenge = { nonce: string; message: string; action: SpotAction; payload: unknown; expiresAt: number; owner: Address; policyHash: Hex };
export type SpotAnchorRequest = { streamId: Hex; sequence: number; previousCheckpoint: Hex; evidenceHead: Hex; policyHash: Hex };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const randomHash = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

export class SpotService {
  constructor(private storage: SpotStorage, private env: SpotEnvironment,
    private anchor: ((request: SpotAnchorRequest) => Promise<SpotAnchor>) | undefined,
    private fetchImpl: typeof fetch = (input, options) => fetch(input, options), private now = Date.now) {}
  private configured() { return spotExecutorConfigured(this.env) && !!this.env.UPBIT_OWNER_ADDRESS && isAddress(this.env.UPBIT_OWNER_ADDRESS); }
  private async state(): Promise<SpotState> {
    const count = await this.storage.get<number>("record-count") ?? 0;
    const records: SpotRecord[] = [];
    for (let sequence = Math.max(1, count - 19); sequence <= count; sequence++) {
      const record = await this.storage.get<SpotRecord>(`record:${sequence}`); if (record) records.push(record);
    }
    return { rule: await this.storage.get<SpotRule>("rule") ?? DEFAULT_SPOT_RULE,
      snapshot: await this.storage.get<SpotSnapshot>("snapshot") ?? null, records: records.reverse(), count,
      head: await this.storage.get<Hex>("record-head") ?? ZERO_HASH, anchor: await this.storage.get<SpotAnchor>("anchor") ?? null };
  }
  private async append(kind: string, payload: unknown, rule: SpotRule, updates: Record<string, unknown> = {}) {
    const count = await this.storage.get<number>("record-count") ?? 0;
    if (count >= 2_000) throw new Error("파일럿 기록 용량에 도달했습니다. 기록을 내려받고 운영자에게 문의해 주세요.");
    const core = { version: 1 as const, sequence: count + 1, previousHash: await this.storage.get<Hex>("record-head") ?? ZERO_HASH,
      kind, at: new Date(this.now()).toISOString(), policyHash: spotHash(rule), salt: randomHash(), payload };
    const record = { ...core, hash: spotHash(core) };
    await this.storage.put({ [`record:${record.sequence}`]: record, "record-head": record.hash, "record-count": record.sequence, ...updates });
  }
  async market(market: string): Promise<SpotQuote> {
    if (!SPOT_MARKETS.includes(market as typeof SPOT_MARKETS[number])) throw new Error("지원하는 현물 종목을 선택해 주세요.");
    const cached = await this.storage.get<SpotQuote>(`quote:${market}`);
    if (cached && this.now() - cached.fetchedAt < 10_000 && this.now() - cached.observedAt < 60_000) return cached;
    const response = await this.fetchImpl(`https://api.upbit.com/v1/ticker?markets=${market}`, { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const values = await response.json().catch(() => null) as Array<{ market: string; trade_price: number; trade_timestamp: number }>;
    const item = Array.isArray(values) && values.length === 1 ? values[0] : undefined;
    if (!response.ok || !item || item.market !== market || !Number.isFinite(item.trade_price) || item.trade_price <= 0 ||
        !Number.isFinite(item.trade_timestamp) || item.trade_timestamp > this.now() + 2_000 || this.now() - item.trade_timestamp > 60_000) {
      throw new Error("최신 업비트 시세를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
    const quote = { market, priceWon: item.trade_price, observedAt: item.trade_timestamp, fetchedAt: this.now() };
    await this.storage.put({ [`quote:${market}`]: quote }); return quote;
  }
  private async challenge(body: Record<string, unknown>, origin: string) {
    if (!this.configured()) throw new Error("업비트 계좌 연결을 준비하고 있습니다. 고정 IP 서버의 API 키와 소유자 지갑 등록이 필요합니다.");
    if (typeof body.owner !== "string" || !isAddress(body.owner) || body.owner.toLowerCase() !== this.env.UPBIT_OWNER_ADDRESS!.toLowerCase()) throw new Error("이 지갑에 등록된 업비트 연결이 없습니다.");
    const binding = await this.storage.get<string>("owner-binding");
    if (binding && binding !== this.env.UPBIT_OWNER_ADDRESS!.toLowerCase()) throw new Error("연결 소유자가 변경됐습니다. 별도 계좌 연결 공간을 설정해 주세요.");
    if (!binding) await this.storage.put({ "owner-binding": this.env.UPBIT_OWNER_ADDRESS!.toLowerCase() });
    const owner = getAddress(body.owner); const { kind, payload } = normalizedAction(body.kind, body.payload);
    const issuedAt = this.now(); const expiresAt = issuedAt + 180_000; const nonce = crypto.randomUUID();
    const rule = kind === "save-rule" ? payload as SpotRule : await this.storage.get<SpotRule>("rule") ?? DEFAULT_SPOT_RULE;
    const labels: Record<SpotAction, string> = { read: "내 연결 기록 조회", sync: "업비트 계좌 조회", "save-rule": "현물 규칙 저장", validate: "주문 생성 테스트", anchor: "기록 해시 GIWA 게시", export: "내 기록 내려받기" };
    const message = `${new URL(origin).host}에서 AlphaPact 업비트 현물 연결을 요청합니다.\n\n지갑: ${owner}\n작업: ${labels[kind]}\n규칙: ${rule.market}, 회당 ${rule.orderWon}원, 24시간 간격, 현물·차입 없음\n요청 해시: ${spotHash({ kind, payload })}\n규칙 해시: ${spotHash(rule)}\n\n이 서명은 출금이나 실주문을 승인하지 않습니다.\nURI: ${origin}/spot\nNonce: ${nonce}\nIssued At: ${new Date(issuedAt).toISOString()}\nExpiration Time: ${new Date(expiresAt).toISOString()}`;
    await this.storage.put({ challenge: { nonce, message, action: kind, payload, expiresAt, owner, policyHash: spotHash(rule) } });
    return { nonce, message, expiresAt };
  }
  private async command(body: Record<string, unknown>, origin: string) {
    if (!this.configured()) throw new Error("업비트 연결 설정이 필요합니다.");
    const challenge = await this.storage.get<Challenge>("challenge");
    if (!challenge || body.nonce !== challenge.nonce || this.now() > challenge.expiresAt || !challenge.message.includes(`URI: ${origin}/spot\n`) ||
        typeof body.signature !== "string" || !/^0x[0-9a-f]{130}$/i.test(body.signature)) throw new Error("서명 요청이 만료됐습니다. 다시 시도해 주세요.");
    const signer = await recoverMessageAddress({ message: challenge.message, signature: body.signature as Hex });
    if (signer.toLowerCase() !== challenge.owner.toLowerCase() || signer.toLowerCase() !== this.env.UPBIT_OWNER_ADDRESS!.toLowerCase()) throw new Error("등록된 소유자 지갑의 서명이 필요합니다.");
    await this.storage.delete("challenge"); // one use, before any exchange/chain request
    const { action, payload } = challenge; const state = await this.state();
    if (["validate", "anchor"].includes(action) && spotHash(state.rule) !== challenge.policyHash) throw new Error("규칙이 변경됐습니다. 내용을 다시 확인하고 서명해 주세요.");
    if (action === "save-rule") {
      await this.append("RULE_SAVED", payload, payload as SpotRule, { rule: payload });
    } else if (action === "sync") {
      const snapshot = await spotExecutorRequest<SpotSnapshot>(this.env, "sync", undefined, this.fetchImpl);
      if (!validSpotSnapshot(snapshot) || Math.abs(this.now() - Date.parse(snapshot.syncedAt)) > 60_000) throw new Error("연결 서버의 계좌 응답을 확인하지 못했습니다.");
      await this.append("ACCOUNT_SNAPSHOT", snapshot, state.rule, { snapshot });
    } else if (action === "validate") {
      const order = orderForValidation(state.rule, state.snapshot, await this.market(state.rule.market), `ap_spot_${crypto.randomUUID().replaceAll("-", "")}`, this.now());
      await this.append("VALIDATION_REQUESTED", { market: order.market, side: order.side, amountWon: state.rule.orderWon }, state.rule);
      try {
        const result = await spotExecutorRequest<{ validated: boolean; submitted: boolean; mode: string }>(this.env, "validate", order, this.fetchImpl);
        if (result.validated !== true || result.submitted !== false || result.mode !== "ORDER_VALIDATION") throw new Error("주문 테스트 응답을 확인하지 못했습니다. 실주문 여부를 업비트에서 확인해 주세요.");
        await this.append("VALIDATION_PASSED", { market: order.market, amountWon: state.rule.orderWon, submitted: false }, state.rule);
      } catch (error) {
        await this.append("VALIDATION_UNCONFIRMED", { market: order.market, amountWon: state.rule.orderWon, result: "NOT_CONFIRMED" }, state.rule);
        throw error;
      }
    } else if (action === "anchor") {
      if (!this.anchor) throw new Error("GIWA 기록 계약을 준비하고 있습니다.");
      if (!state.count) throw new Error("계좌 조회 또는 규칙 저장 후 기록을 게시할 수 있습니다.");
      if (state.anchor?.sequence === state.count && state.anchor.evidenceHead === state.head) return { state };
      let streamId = await this.storage.get<Hex>("stream-id");
      if (!streamId) { streamId = randomHash(); await this.storage.put({ "stream-id": streamId }); }
      const pending = await this.storage.get<SpotAnchorRequest>("pending-anchor") ?? { streamId, sequence: state.count,
        previousCheckpoint: state.anchor?.checkpointHash ?? ZERO_HASH, evidenceHead: state.head, policyHash: spotHash(state.rule) };
      await this.storage.put({ "pending-anchor": pending });
      const anchor = await this.anchor(pending);
      await this.storage.put({ anchor }); await this.storage.delete("pending-anchor");
    } else if (action === "export") {
      const records: SpotRecord[] = [];
      for (let sequence = 1; sequence <= state.count; sequence++) {
        const record = await this.storage.get<SpotRecord>(`record:${sequence}`);
        if (!record) throw new Error("기록 일부를 읽지 못했습니다. 내려받기를 다시 시도해 주세요."); records.push(record);
      }
      return { archive: { schema: "ALPHAPACT_UPBIT_SPOT_V1", venue: "UPBIT_KR", execution: "READ_AND_ORDER_VALIDATION_ONLY", exportedAt: new Date(this.now()).toISOString(),
        streamId: await this.storage.get<Hex>("stream-id") ?? null, records, anchor: state.anchor } };
    }
    return { state: await this.state() };
  }
  async handle(request: Request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/status" && request.method === "GET") return json({ venue: "UPBIT_KR", configured: this.configured(), execution: "READ_AND_ORDER_VALIDATION_ONLY",
        liveOrders: false, markets: SPOT_MARKETS, maxOrderWon: 10_000, anchorReady: !!this.anchor });
      if (url.pathname === "/market" && request.method === "GET") return json({ quote: await this.market(url.searchParams.get("market") ?? "KRW-BTC") });
      if (!["/challenge", "/command"].includes(url.pathname) || request.method !== "POST") return json({ error: "요청을 찾지 못했습니다." }, 404);
      if (request.headers.get("origin") !== url.origin) return json({ error: "서비스 화면에서 다시 요청해 주세요." }, 403);
      const minute = Math.floor(this.now() / 60_000); const quota = await this.storage.get<{ minute: number; count: number }>("quota");
      if (quota?.minute === minute && quota.count >= 30) return json({ error: "요청이 많습니다. 잠시 후 다시 시도해 주세요." }, 429);
      await this.storage.put({ quota: { minute, count: quota?.minute === minute ? quota.count + 1 : 1 } });
      if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "JSON 요청이 필요합니다." }, 415);
      const reader = request.body?.getReader(); if (!reader) throw new Error("요청 내용이 없습니다.");
      let size = 0; const parts: Uint8Array[] = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
        if (size > 8_192) { await reader.cancel(); return json({ error: "요청 내용이 너무 큽니다." }, 413); } parts.push(value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      const text = new TextDecoder().decode(bytes);
      const body = JSON.parse(text) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("요청 내용을 확인해 주세요.");
      return json(url.pathname === "/challenge" ? await this.challenge(body, url.origin) : await this.command(body, url.origin));
    } catch (error) {
      const message = error instanceof Error ? error.message : "요청을 처리하지 못했습니다.";
      if (new URL(request.url).pathname === "/market") console.error("Spot public market request failed", { name: error instanceof Error ? error.name : "Unknown", message: message.slice(0, 250) });
      return json({ error: /^[가-힣]/.test(message) ? message : "연결 요청을 완료하지 못했습니다. 다시 시도해 주세요." }, 400);
    }
  }
}
