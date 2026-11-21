import { keccak256, toHex, type Hex } from "viem";

export const SPOT_MARKETS = ["KRW-BTC", "KRW-ETH"] as const;
export const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
export type SpotRule = { version: 1; strategy: "DCA"; market: typeof SPOT_MARKETS[number]; orderWon: number; intervalHours: 24; leverage: 1; borrow: false };
export const DEFAULT_SPOT_RULE: SpotRule = { version: 1, strategy: "DCA", market: "KRW-BTC", orderWon: 5_000, intervalHours: 24, leverage: 1, borrow: false };
export type SpotQuote = { market: string; priceWon: number; observedAt: number; fetchedAt: number };
export type SpotSnapshot = { venue: "UPBIT_KR"; mode: string; markets: string[]; maxOrderWon: number;
  assets: Array<{ currency: string; available: string; locked: string }>;
  orders: Array<{ uuid: string; market: string; side: string; state: string; createdAt: string; executedVolume: string; remainingVolume: string; paidFee: string }>;
  orderCoverage: string; syncedAt: string };
export type SpotRecord = { version: 1; sequence: number; previousHash: Hex; kind: string; at: string; policyHash: Hex; salt: Hex; payload: unknown; hash: Hex };
export type SpotAnchor = { transactionHash: Hex; sequence: number; evidenceHead: Hex; checkpointHash: Hex; block: string };
export type SpotState = { rule: SpotRule; snapshot: SpotSnapshot | null; records: SpotRecord[]; count: number; head: Hex; anchor: SpotAnchor | null };
export type SpotAction = "read" | "sync" | "save-rule" | "validate" | "anchor" | "export";

export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  throw new Error("기록에 저장할 수 없는 값이 있습니다.");
}
export function spotHash(value: unknown): Hex { return keccak256(toHex(canonical(value))); }
export function normalizeSpotRule(value: unknown): SpotRule {
  const rule = value as SpotRule;
  if (!rule || rule.version !== 1 || rule.strategy !== "DCA" || !SPOT_MARKETS.includes(rule.market) ||
      ![5_000, 10_000].includes(rule.orderWon) || rule.intervalHours !== 24 || rule.leverage !== 1 || rule.borrow !== false ||
      Object.keys(rule).sort().join() !== Object.keys(DEFAULT_SPOT_RULE).sort().join()) {
    throw new Error("현물 정기 매수 규칙과 금액을 확인해 주세요.");
  }
  return { version: 1, strategy: "DCA", market: rule.market, orderWon: rule.orderWon, intervalHours: 24, leverage: 1, borrow: false };
}
export function normalizedAction(kind: unknown, payload: unknown): { kind: SpotAction; payload: unknown } {
  if (!["read", "sync", "save-rule", "validate", "anchor", "export"].includes(String(kind))) throw new Error("지원하지 않는 요청입니다.");
  if (kind === "save-rule") return { kind, payload: normalizeSpotRule(payload) };
  if (canonical(payload) !== "{}") throw new Error("요청 내용을 확인해 주세요.");
  return { kind: kind as SpotAction, payload: {} };
}
export function orderForValidation(rule: SpotRule, snapshot: SpotSnapshot | null, quote: SpotQuote, identifier: string, now: number) {
  normalizeSpotRule(rule);
  const syncedAt = snapshot ? Date.parse(snapshot.syncedAt) : NaN;
  if (!snapshot || !Number.isFinite(syncedAt) || now - syncedAt > 60_000 || syncedAt > now + 2_000) throw new Error("계좌를 다시 조회한 뒤 주문을 점검해 주세요.");
  if (quote.market !== rule.market || quote.priceWon <= 0 || now - quote.observedAt > 60_000 || quote.observedAt > now + 2_000) throw new Error("최신 업비트 시세를 확인한 뒤 다시 시도해 주세요.");
  if (!snapshot.markets.includes(rule.market) || rule.orderWon > snapshot.maxOrderWon) throw new Error("실행기에 허용된 종목과 주문 한도를 확인해 주세요.");
  if (snapshot.mode === "READ_ONLY") throw new Error("현재 연결은 조회 전용입니다. 주문 테스트 권한을 설정해 주세요.");
  const krw = Number(snapshot.assets.find(asset => asset.currency === "KRW")?.available ?? "0");
  if (!Number.isFinite(krw) || krw < rule.orderWon) throw new Error("주문 금액보다 사용 가능한 원화가 부족합니다.");
  return { market: rule.market, side: "bid" as const, ordType: "price" as const, price: String(rule.orderWon), identifier };
}
export function verifySpotRecords(records: SpotRecord[]) {
  let head = ZERO_HASH;
  for (let index = 0; index < records.length; index++) {
    const { hash, ...core } = records[index];
    if (core.version !== 1 || core.sequence !== index + 1 || core.previousHash !== head || spotHash(core) !== hash || !/^0x[0-9a-f]{64}$/i.test(core.salt)) {
      throw new Error(`기록 ${index + 1}의 순서 또는 해시가 일치하지 않습니다.`);
    }
    head = hash;
  }
  return { count: records.length, head };
}
