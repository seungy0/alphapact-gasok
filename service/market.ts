import { parseUnits } from "viem";

export type SourceQuote = { source: "Coinbase" | "Kraken"; price: string; at: number };
export type TestPrice = { priceE8: string; price: number; publishedAt: number; sources: SourceQuote[]; trust: "OPERATOR_PUBLISHED_TEST_PRICE" };
export function compareQuotes(quotes: SourceQuote[], now: number): TestPrice {
  if (quotes.length !== 2 || new Set(quotes.map(q => q.source)).size !== 2) throw new Error("두 가격 제공처를 확인할 때까지 매매를 대기합니다.");
  const values = quotes.map(q => {
    if (!/^\d{1,8}(\.\d{1,8})?$/.test(q.price) || !Number.isFinite(q.at) || q.at > now + 2 || now - q.at > 60) throw new Error("최신 시세를 확인할 때까지 매매를 대기합니다.");
    const value = parseUnits(q.price, 8); if (value <= 0n) throw new Error("가격을 확인하지 못했습니다."); return value;
  });
  const low = values[0] < values[1] ? values[0] : values[1];
  const high = values[0] > values[1] ? values[0] : values[1];
  if ((high - low) * 100n > low) throw new Error("가격 제공처 사이의 시세 차이가 커 매매를 대기합니다.");
  const priceE8 = (low + high) / 2n;
  return { priceE8: String(priceE8), price: Number(priceE8) / 1e8, publishedAt: Math.floor(Math.min(...quotes.map(q => q.at), now)), sources: quotes, trust: "OPERATOR_PUBLISHED_TEST_PRICE" };
}
export async function fetchTestPrice(): Promise<TestPrice> {
  const [coinbase, kraken] = await Promise.all([
    fetch("https://api.exchange.coinbase.com/products/ETH-USD/ticker", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) }),
    fetch("https://api.kraken.com/0/public/Trades?pair=ETHUSD&count=1", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) }),
  ]);
  if (!coinbase.ok || !kraken.ok) throw new Error("시세 제공처에 연결하지 못했습니다. 잠시 후 다시 확인합니다.");
  const c = await coinbase.json() as { price: string; time: string };
  const k = await kraken.json() as { error: string[]; result: { XETHZUSD: [string, string, number][] } };
  const trade = k.result?.XETHZUSD?.at(-1);
  if (k.error?.length || !trade) throw new Error("Kraken 시세를 확인하지 못했습니다.");
  return compareQuotes([{ source: "Coinbase", price: c.price, at: Date.parse(c.time) / 1000 }, { source: "Kraken", price: trade[0], at: trade[2] }], Date.now() / 1000);
}
