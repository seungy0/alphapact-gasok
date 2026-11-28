import { parseAbi, type Address, type Hex } from "viem";
import deploymentJson from "./copy-deployment.json";

export const copyDeployment = deploymentJson as typeof deploymentJson & {
  market: Address; keeper: Address; budget: Address; position: Address; executor: Address; hash: Hex;
};

export const copyAbi = parseAbi([
  "struct Strategy { address creator; string name; uint128 amount; uint64 interval; }",
  "struct Subscription { address owner; uint256 strategyId; address account; address rule; uint64 startsAt; }",
  "struct Follow { address owner; uint256 strategyId; uint128 maxTradeBudget; uint128 maxRollingDayBudget; uint64 expiresAt; uint64 deadline; }",
  "function register(address creator, string name, uint128 amount, uint64 interval, uint64 deadline, bytes signature) returns (uint256)",
  "function follow(Follow request, bytes signature) returns (uint256)",
  "function strategyCount() view returns (uint256)",
  "function strategyAt(uint256 id) view returns (Strategy)",
  "function subscriptionAt(uint256 id) view returns (Subscription)",
  "function subscriptionIdOf(address owner, uint256 strategyId) view returns (uint256)",
  "function ownerSubscriptionCount(address owner) view returns (uint256)",
  "function ownerSubscriptionAt(address owner, uint256 index) view returns (uint256)",
  "event StrategyRegistered(uint256 indexed strategyId, address indexed creator, string name, uint128 amount, uint64 interval)",
]);
export const scheduledRuleAbi = parseAbi(["function execute(address account) returns (uint256)"]);
export const copyDomain = { name: "AlphaPactCopyMarket", version: "1", chainId: 91342, verifyingContract: copyDeployment.market } as const;
export const registerTypes = { RegisterStrategy: [
  { name: "creator", type: "address" }, { name: "name", type: "string" }, { name: "amount", type: "uint128" },
  { name: "interval", type: "uint64" }, { name: "deadline", type: "uint64" },
] } as const;
export const followTypes = { FollowStrategy: [
  { name: "owner", type: "address" }, { name: "strategyId", type: "uint256" }, { name: "maxTradeBudget", type: "uint128" },
  { name: "maxRollingDayBudget", type: "uint128" }, { name: "expiresAt", type: "uint64" }, { name: "deadline", type: "uint64" },
] } as const;

export interface CopyStrategy { id: string; creator: Address; name: string; amount: string; interval: string }
export interface CopyFill { hash: Hex; block: string; amountIn: string; amountOut: string; sequence: number }
export interface CopySubscription {
  id: string; owner: Address; strategyId: string; account: Address; rule: Address; startsAt: string;
  expiresAt: string; sessionId: string; authorizationNonce: string; active: boolean; revoked: boolean;
  maxTradeBudget: string; maxRollingDayBudget: string; cash: string; position: string; fill: CopyFill | null;
}
