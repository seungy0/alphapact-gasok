import { encodeAbiParameters, hexToBytes, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import deployed from "./algorithm-deployment.json";

export const algorithmDeployment = deployed as typeof deployed & { market: Address; budget: Address; position: Address; executor: Address; replay: Address };
export const algorithmDomain = { name: "AlphaPactAlgorithmMarket", version: "1", chainId: 91342, verifyingContract: algorithmDeployment.market } as const;
export const algorithmTypes = { RegisterAlgorithm: [
  { name: "creator", type: "address" }, { name: "name", type: "string" }, { name: "amount", type: "uint128" },
  { name: "programHash", type: "bytes32" }, { name: "deadline", type: "uint64" },
] } as const;
export const algorithmAbi = parseAbi([
  "struct Strategy { address creator; string name; uint128 amount; uint64 interval; address rule; bytes32 programHash; bytes buyCondition; bytes sellCondition; }",
  "function strategyAt(uint256 id) view returns (Strategy)",
  "function registerAlgorithm(address creator, string name, uint128 amount, bytes buyCondition, bytes sellCondition, uint64 deadline, bytes signature) returns (uint256)",
  "function strategyIdOf(address creator, string name, uint128 amount, bytes32 programHash) view returns (uint256)",
  "event AlgorithmRegistered(uint256 indexed strategyId, address indexed creator, address rule, bytes32 programHash)",
]);
export const decisionAbi = parseAbi(["function decision() view returns (uint8 side, uint64 sequence, uint64 openedAt, uint24 close)"]);
export const candleReplayAbi = parseAbi(["function snapshot() view returns (uint64 sequence, uint64 openedAt, uint24[8] closes)"]);

export const defaultAlgorithm = `{
  "buy": { "crossUp": [{ "sma": [0, 2] }, { "sma": [0, 4] }] },
  "sell": { "crossDown": [{ "sma": [0, 2] }, { "sma": [0, 4] }] }
}`;

function entry(value: unknown): [string, unknown] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("조건은 이름과 값을 가진 JSON 객체로 입력해 주세요.");
  const keys = Object.entries(value);
  if (keys.length !== 1) throw new Error("한 조건에는 연산을 하나만 입력해 주세요.");
  return keys[0];
}

function range(value: unknown, min: number, max: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error("종가 위치, 이동평균 구간 또는 가격 범위를 확인해 주세요.");
  }
  return value;
}

function pair(value: unknown) {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("두 값을 순서대로 입력해 주세요.");
  return value as [unknown, unknown];
}

function price(value: unknown, offset = 0): number[] {
  const [key, input] = entry(value);
  if (key === "close") return [1, range(input, 0, 7 - offset) + offset];
  if (key === "usd") {
    const cents = typeof input === "number" ? Math.round(input * 100) : NaN;
    if (typeof input !== "number" || Math.abs(cents / 100 - input) > 0.000_001) throw new Error("가격은 달러 기준 소수 둘째 자리까지 입력해 주세요.");
    const value = range(cents, 1, 16_777_215);
    return [2, value >> 16, (value >> 8) & 255, value & 255];
  }
  if (key === "sma") {
    const [start, length] = pair(input);
    const from = range(start, 0, 6 - offset) + offset;
    return [3, from, range(length, 2, 8 - from)];
  }
  throw new Error("비교할 값에 close, sma 또는 usd를 입력해 주세요.");
}

function condition(node: unknown, depth = 0): number[] {
  if (depth > 10) throw new Error("조건 안에 조건이 너무 많이 들어 있습니다.");
  const [key, value] = entry(node);
  if (key === "not") return [...condition(value, depth + 1), 8];
  const [left, right] = pair(value);
  if (key === "and" || key === "or") return [...condition(left, depth + 1), ...condition(right, depth + 1), key === "and" ? 6 : 7];
  if (key === "gt" || key === "lt") return [...price(left), ...price(right), key === "gt" ? 4 : 5];
  if (key === "crossUp" || key === "crossDown") {
    const compare = key === "crossUp" ? 4 : 5;
    return [...price(left), ...price(right), compare, ...price(left, 1), ...price(right, 1), compare, 8, 6];
  }
  throw new Error("gt, lt, crossUp, crossDown, and, or, not 중 하나를 입력해 주세요.");
}

export function compileAlgorithm(source: string) {
  if (source.length > 4_096) throw new Error("알고리즘 JSON은 4,096자까지 입력할 수 있습니다.");
  let parsed: { buy?: unknown; sell?: unknown };
  try { parsed = JSON.parse(source); }
  catch { throw new Error("알고리즘 파일의 JSON 문법을 확인해 주세요."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 2 || !parsed.buy || !parsed.sell) {
    throw new Error("buy와 sell 조건을 하나씩 입력해 주세요.");
  }
  const buy = condition(parsed.buy);
  const sell = condition(parsed.sell);
  if (buy.length > 112 || sell.length > 112) throw new Error("매수 또는 매도 조건이 너무 깁니다. 조건을 줄여 주세요.");
  const buyCondition = toHex(Uint8Array.from(buy));
  const sellCondition = toHex(Uint8Array.from(sell));
  return { buyCondition, sellCondition, programHash: hashProgram(buyCondition, sellCondition) };
}

export function hashProgram(buy: Hex, sell: Hex) {
  return keccak256(encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [buy, sell]));
}

/** Formats the program actually committed onchain, including equivalent expansions of crossUp/crossDown. */
export function describeCondition(code: Hex) {
  const bytes = hexToBytes(code);
  const stack: string[] = [];
  const ops: Record<number, string> = { 4: ">", 5: "<", 6: "그리고", 7: "또는" };
  for (let cursor = 0; cursor < bytes.length; cursor++) {
    const op = bytes[cursor];
    if (op === 1) stack.push(`종가[${bytes[++cursor]}]`);
    else if (op === 2) {
      const value = bytes[++cursor] * 65536 + bytes[++cursor] * 256 + bytes[++cursor];
      stack.push(`${(value / 100).toLocaleString("ko-KR")} USD`);
    } else if (op === 3) {
      const offset = bytes[++cursor];
      stack.push(`이동평균(${offset}, ${bytes[++cursor]})`);
    } else if (op === 8) stack.push(`아님 ${stack.pop()}`);
    else {
      const right = stack.pop(), left = stack.pop();
      stack.push(`(${left} ${ops[op]} ${right})`);
    }
  }
  return stack[0] ?? "";
}

export const algorithmSignalAbi = parseAbi([
  "struct CopySignal { bytes32 strategyVersion; address tokenIn; address tokenOut; uint256 amountIn; uint256 minAmountOut; uint64 sequence; uint64 issuedAt; uint64 expiresAt; }",
  "function currentSignal() view returns (CopySignal)",
  "function execute(address account, address publisher, CopySignal signal, bytes signature) returns (uint256)",
  "function strategyVersion() view returns (bytes32)",
  "function hashSignal(CopySignal signal) view returns (bytes32)",
]);
