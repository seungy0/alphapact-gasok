import { getAddress, type Address, type PublicClient } from "viem";
import { accountAbi, deployment, factoryAbi, tokenAbi, type Session } from "./protocol";

/** Public chain reads only. No operator API or owner key is required. */
export async function readOwnerAccounts(client: Pick<PublicClient, "readContract" | "getChainId">, owner: Address, config = deployment) {
  if (!config.ready) return [];
  if (await client.getChainId() !== 91342) throw new Error("GIWA Sepolia 연결을 확인하지 못했습니다.");
  const addresses = await Promise.all([0, 1].map(strategyId => client.readContract({ address: config.factory, abi: factoryAbi, functionName: "accounts", args: [owner, strategyId] })));
  return Promise.all(addresses.filter(address => address !== "0x0000000000000000000000000000000000000000").map(async account => {
    if (!await client.readContract({ address: config.factory, abi: factoryAbi, functionName: "isAccount", args: [account] })) throw new Error("등록된 전략 계정이 아닙니다.");
    const [actualOwner, s, sessionId, nextNonce, authorizationNonce, spent, lastTradeAt, cash, position, strategyId] = await Promise.all([
      client.readContract({ address: account, abi: accountAbi, functionName: "owner" }),
      client.readContract({ address: account, abi: accountAbi, functionName: "session" }),
      client.readContract({ address: account, abi: accountAbi, functionName: "sessionId" }),
      client.readContract({ address: account, abi: accountAbi, functionName: "nextNonce" }),
      client.readContract({ address: account, abi: accountAbi, functionName: "authorizationNonce" }),
      client.readContract({ address: account, abi: accountAbi, functionName: "rollingDaySpent" }),
      client.readContract({ address: account, abi: accountAbi, functionName: "lastTradeAt" }),
      client.readContract({ address: config.budget, abi: tokenAbi, functionName: "balanceOf", args: [account] }),
      client.readContract({ address: config.position, abi: tokenAbi, functionName: "balanceOf", args: [account] }),
      client.readContract({ address: config.factory, abi: factoryAbi, functionName: "strategyOf", args: [account] }),
    ]);
    if (getAddress(actualOwner) !== getAddress(owner)) throw new Error("계정 소유자가 일치하지 않습니다.");
    const session: Session = { strategist: s[0], expiresAt: s[1], maxTradeBudget: s[2], maxRollingDayBudget: s[3], maxSlippageBps: s[4], strategyHash: s[5] };
    return { address: account, owner: actualOwner, session, sessionId, nextNonce, authorizationNonce, spent, lastTradeAt, cash, position, strategyId,
      active: s[0].toLowerCase() === config.keeper.toLowerCase() && s[1] > BigInt(Math.floor(Date.now() / 1000)), rpcFallback: true, activity: [] };
  }));
}
