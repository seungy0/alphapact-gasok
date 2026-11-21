import type { SpotSnapshot } from "./spot-domain";

export type SpotExecutorConfig = { UPBIT_EXECUTOR_URL?: string; UPBIT_EXECUTOR_SHARED_SECRET?: string; UPBIT_CONNECTION_REF?: string };
const encoder = new TextEncoder();
const hex = (value: ArrayBuffer) => [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, "0")).join("");
export function spotExecutorConfigured(env: SpotExecutorConfig) {
  if (!env.UPBIT_EXECUTOR_SHARED_SECRET || env.UPBIT_EXECUTOR_SHARED_SECRET.length < 32 || !env.UPBIT_EXECUTOR_URL) return false;
  try { const url = new URL(env.UPBIT_EXECUTOR_URL); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}
export async function spotExecutorRequest<T>(env: SpotExecutorConfig, action: "sync" | "validate", order?: unknown, fetchImpl = fetch): Promise<T> {
  if (!spotExecutorConfigured(env)) throw new Error("업비트 연결 서버를 아직 설정하지 않았습니다.");
  const path = `/v1/spot/${action}`;
  const body = JSON.stringify({ connectionRef: env.UPBIT_CONNECTION_REF ?? "owner-upbit", ...(order ? { order } : {}) });
  const timestamp = String(Date.now()); const nonce = crypto.randomUUID();
  const digest = hex(await crypto.subtle.digest("SHA-256", encoder.encode(body)));
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.UPBIT_EXECUTOR_SHARED_SECRET!), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}\n${nonce}\nPOST\n${path}\n${digest}`)));
  const base = new URL(env.UPBIT_EXECUTOR_URL!); base.pathname = `${base.pathname.replace(/\/$/, "")}/`;
  const response = await fetchImpl(new URL(path.slice(1), base), { method: "POST", redirect: "manual", signal: AbortSignal.timeout(25_000),
    headers: { "content-type": "application/json", "x-alphapact-timestamp": timestamp, "x-alphapact-nonce": nonce, "x-alphapact-signature": signature }, body });
  const result = await response.json().catch(() => null) as { error?: string };
  if (!response.ok) {
    const known: Record<string, string> = {
      ORDER_VALIDATION_DISABLED: "현재 실행기는 조회 전용입니다. 주문 테스트 모드 설정이 필요합니다.",
      ORDER_LIMIT_EXCEEDED: "실행기에 설정된 주문 한도를 넘었습니다.",
      MARKET_NOT_ALLOWED: "실행기에서 허용하지 않은 종목입니다.",
      OUT_OF_SCOPE: "업비트 API 키에 필요한 조회 또는 주문 테스트 권한이 없습니다.",
      NO_AUTHORIZATION_IP: "업비트 API 키의 허용 IP를 확인해 주세요.",
      EXPIRED_ACCESS_KEY: "업비트 API 키의 유효기간을 확인해 주세요.",
      INSUFFICIENT_FUNDS_BID: "주문 금액과 수수료에 필요한 원화가 부족합니다.",
    };
    throw new Error(known[result?.error ?? ""] ?? "업비트 연결 요청을 완료하지 못했습니다. 서버 상태와 API 권한을 확인해 주세요.");
  }
  if (!result || typeof result !== "object") throw new Error("업비트 연결 서버의 응답을 읽지 못했습니다.");
  return result as T;
}
export function validSpotSnapshot(value: unknown): value is SpotSnapshot {
  const data = value as SpotSnapshot;
  return !!data && data.venue === "UPBIT_KR" && ["READ_ONLY", "VALIDATE_ONLY", "LIVE"].includes(data.mode) &&
    Array.isArray(data.assets) && Array.isArray(data.orders) && Array.isArray(data.markets) &&
    data.markets.every(market => ["KRW-BTC", "KRW-ETH"].includes(market)) &&
    data.assets.every(asset => ["KRW", "BTC", "ETH"].includes(asset.currency) && [asset.available, asset.locked].every(v => typeof v === "string" && /^\d+(\.\d+)?$/.test(v))) &&
    Number.isFinite(Date.parse(data.syncedAt)) && Number.isInteger(data.maxOrderWon) && data.maxOrderWon >= 5_000 && data.maxOrderWon <= 10_000;
}
