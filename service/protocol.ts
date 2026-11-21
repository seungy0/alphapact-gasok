import { defineChain, encodeAbiParameters, keccak256, parseAbi, type Address, type Hex } from "viem";
import deployed from "./deployment.json";

export const deployment = deployed as typeof deployed & { factory: Address; budget: Address; position: Address; router: Address; quote: Address; keeper: Address; pyth: Address; feedId: Hex };
export const chain = defineChain({
  id: 91342, name: "GIWA Sepolia", nativeCurrency: { name: "Test ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia-rpc.giwa.io"] } },
  // GIWA's documented preinstall; aggregate reads to respect public RPC limits.
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  blockExplorers: { default: { name: "GIWA Explorer", url: "https://sepolia-explorer.giwa.io" } }, testnet: true,
});
export const sessionComponents = [
  { name: "strategist", type: "address" }, { name: "expiresAt", type: "uint64" },
  { name: "maxTradeBudget", type: "uint128" }, { name: "maxRollingDayBudget", type: "uint128" },
  { name: "maxSlippageBps", type: "uint16" }, { name: "strategyHash", type: "bytes32" },
] as const;
export type Session = { strategist: Address; expiresAt: bigint; maxTradeBudget: bigint; maxRollingDayBudget: bigint; maxSlippageBps: number; strategyHash: Hex };
export const ZERO_SESSION: Session = { strategist: "0x0000000000000000000000000000000000000000", expiresAt: 0n, maxTradeBudget: 0n, maxRollingDayBudget: 0n, maxSlippageBps: 0, strategyHash: `0x${"0".repeat(64)}` };
export const factoryAbi = parseAbi([
  "function accounts(address owner,uint8 strategyId) view returns (address)",
  "function isAccount(address account) view returns (bool)",
  "function strategyOf(address account) view returns (uint8)",
  "function accountCount() view returns (uint256)", "function accountAt(uint256 index) view returns (address)",
  "function createAccount(address owner,uint8 strategyId,uint128 maxTradeBudget,uint128 maxRollingDayBudget,uint64 expiresAt,uint64 deadline,bytes signature) returns(address)",
  "event AccountCreated(address indexed owner,address indexed account,uint8 indexed strategyId,uint256 initialBudget)",
]);
export const accountAbi = parseAbi([
  "struct Session { address strategist; uint64 expiresAt; uint128 maxTradeBudget; uint128 maxRollingDayBudget; uint16 maxSlippageBps; bytes32 strategyHash; }",
  "function owner() view returns(address)", "function session() view returns(address strategist,uint64 expiresAt,uint128 maxTradeBudget,uint128 maxRollingDayBudget,uint16 maxSlippageBps,bytes32 strategyHash)",
  "function sessionId() view returns(uint256)", "function nextNonce() view returns(uint256)",
  "function authorizationNonce() view returns(uint256)", "function rollingDaySpent() view returns(uint256)",
  "function lastTradeAt() view returns(uint64)",
  "function swap(bool buyPosition,uint256 amountIn,uint256 amountOutMin,uint256 expectedSessionId,uint256 expectedNonce,uint64 deadline,bytes32 signalHash) returns(uint256)",
  "function executeOwnerAction(uint8 action,Session requested,uint256 expectedSessionId,uint256 nonce,uint64 deadline,bytes signature)",
  "function revokeSession()", "function revokeAndWithdraw()", "function withdrawToken(address token,uint256 amount)",
  "event SwapExecuted(uint256 indexed sessionId,uint256 indexed nonce,bytes32 indexed signalHash,address tokenIn,uint256 amountIn,uint256 amountOut,uint256 budgetSpent,uint64 quoteObservedAt)",
]);
export const tokenAbi = parseAbi(["function balanceOf(address owner) view returns(uint256)", "function transfer(address to,uint256 amount) returns(bool)", "function claim()"]);
export const pythAbi = parseAbi([
  "function getUpdateFee(bytes[] data) view returns(uint256)", "function updatePriceFeeds(bytes[] data) payable",
  "function getPriceUnsafe(bytes32 id) view returns((int64 price,uint64 conf,int32 expo,uint256 publishTime))",
]);
export const testQuoteAbi = parseAbi(["function observedAt() view returns(uint64)", "function priceE8() view returns(uint256)", "function publish(uint256 priceE8,uint64 observedAt,bytes32 sourcesHash)"]);
export const createTypes = { CreateAccount: [
  { name: "owner", type: "address" }, { name: "strategyId", type: "uint8" },
  { name: "maxTradeBudget", type: "uint128" }, { name: "maxRollingDayBudget", type: "uint128" },
  { name: "expiresAt", type: "uint64" }, { name: "deadline", type: "uint64" },
] } as const;
export const actionTypes = { OwnerAction: [
  { name: "action", type: "uint8" }, { name: "sessionHash", type: "bytes32" },
  { name: "sessionId", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
] } as const;
export function createDomain() { return { name: "AlphaPactFactory", version: "1", chainId: chain.id, verifyingContract: deployment.factory } as const; }
export function actionDomain(account: Address) { return { name: "AlphaPactAccount", version: "1", chainId: chain.id, verifyingContract: account } as const; }
export function sessionHash(session: Session) { return keccak256(encodeAbiParameters([{ type: "tuple", components: sessionComponents }], [session])); }
export function strategyHash(id: number) { return keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint8" }], ["alphapact:public-rule:v1", id])); }
export const strategies = [
  { id: 0, name: "ETH 균형 리밸런싱", category: "리밸런싱", summary: "ETH와 USD의 목표 비중을 50:50으로 유지합니다.", rule: "목표 비중에서 5%p 이상 벗어나면, 설정한 집행 한도 안에서 비중을 조정합니다.", cadence: "주기적 평가 · 최소 15분 간격", available: true },
  { id: 1, name: "ETH 정기 분할 매수", category: "분할 매수", summary: "정해진 간격으로 소액을 나누어 ETH를 매수합니다.", rule: "4시간마다 최대 500 tUSD를 매수합니다. 계정의 1회·24시간 한도를 함께 적용합니다.", cadence: "4시간 간격", available: true },
  { id: 2, name: "NostalgiaForInfinity", category: "오픈소스 · CEX", summary: "Freqtrade 기반 원본 전략. 거래소 실행 경로를 별도로 검토하고 있습니다.", rule: "GIWA 전략으로 변형해 표시하지 않습니다. 원본 코드·라이선스·필요 시장을 확인한 뒤 제공할 예정입니다.", cadence: "아직 실행할 수 없음", available: false, source: "https://github.com/iterativv/NostalgiaForInfinity" },
] as const;

export interface RuleInput { strategyId: number; cash: bigint; position: bigint; priceE8: bigint; tradeCap: bigint; dayCap: bigint; spent: bigint; lastTradeAt: bigint; now: bigint }
export function decide(input: RuleInput): { buy: boolean; amount: bigint; reason: string } | { hold: string } {
  const { strategyId, cash, position, priceE8, tradeCap, dayCap, spent, lastTradeAt, now } = input;
  if (priceE8 <= 0n || now < lastTradeAt) return { hold: "가격 확인 중" };
  const interval = strategyId === 1 ? 14_400n : 900n;
  if (lastTradeAt > 0n && now - lastTradeAt < interval) return { hold: "다음 매매 간격 대기" };
  const remaining = dayCap > spent ? dayCap - spent : 0n;
  const cap = tradeCap < remaining ? tradeCap : remaining;
  if (cap < 1_000_000n) return { hold: "24시간 집행 한도 도달" };
  if (strategyId === 1) {
    const amount = [cash, cap, 500_000_000n].reduce((a, b) => a < b ? a : b);
    return amount >= 1_000_000n ? { buy: true, amount, reason: "4시간 정기 매수" } : { hold: "테스트 USD 잔액 부족" };
  }
  const positionValue = position * priceE8 / 100_000_000_000_000_000_000n;
  const total = cash + positionValue;
  if (total === 0n) return { hold: "계정 잔액 없음" };
  const difference = cash - positionValue;
  if ((difference < 0n ? -difference : difference) * 10n < total) return { hold: "목표 비중 유지 중" };
  const desired = (difference < 0n ? -difference : difference) / 2n;
  const budget = desired < cap ? desired : cap;
  if (budget < 1_000_000n) return { hold: "조정 금액이 작아 대기" };
  if (difference > 0n) return { buy: true, amount: budget < cash ? budget : cash, reason: "ETH 비중을 목표에 맞춰 매수" };
  const amount = budget * 100_000_000_000_000_000_000n / priceE8;
  return { buy: false, amount: amount < position ? amount : position, reason: "ETH 비중을 목표에 맞춰 매도" };
}
