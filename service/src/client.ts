import { createPublicClient, getAddress, isAddress, type Address, type Hex } from "viem";
import { readOwnerAccounts } from "../chain-account";
import type { AccountEvaluation } from "../evaluation";
import { giwaTransport } from "../rpc";
import { actionDomain, actionTypes, chain, createDomain, createTypes, deployment, sessionHash, strategyHash, ZERO_SESSION, type Session } from "../protocol";

export interface Provider { request(args: { method: string; params?: unknown[] }): Promise<unknown>; on?(event: string, callback: (...args: unknown[]) => void): void; removeListener?(event: string, callback: (...args: unknown[]) => void): void }
export interface WalletOption { id: string; name: string; icon?: string; provider: Provider }
export interface Activity { hash: Hex; account: Address; action: string; at: string; block: string; buy?: boolean; amountIn?: string; amountOut?: string; reason?: string }
export interface Account {
 address: Address; owner: Address; strategyId: number; cash: string; position: string; spent: string;
 sessionId: string; nextNonce: string; authorizationNonce: string; lastTradeAt: string; active: boolean;
 session: { strategist: Address; expiresAt: string; maxTradeBudget: string; maxRollingDayBudget: string; maxSlippageBps: number; strategyHash: Hex };
 activity: Activity[]; evaluation?: AccountEvaluation;
 rpcFallback?: boolean;
}
export interface Market { price: { priceE8: string; price: number; publishedAt: number }; history: Array<{ at: number; value: number }>; source: string }
export interface Status { ready: boolean; mode: string; gasSponsored: boolean; deployment: typeof deployment; lastTick: null | { at: string; accounts: number; errors: string[] } }

export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
 const response = await fetch(`/api/${path}`, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : {}, body: body ? stringify(body) : undefined, signal, cache: "no-store" });
 const data = await response.json().catch(() => { throw new Error("서버 응답을 읽지 못했습니다. 잠시 후 다시 시도해 주세요."); }) as { error?: string };
 if (!response.ok) throw new Error(data.error ?? "연결을 확인한 뒤 다시 시도해 주세요.");
 return data as T;
}
export const stringify = (value: unknown) => JSON.stringify(value, (_, entry) => typeof entry === "bigint" ? entry.toString() : entry);
const recoveryClient = createPublicClient({ chain, transport: giwaTransport(chain.rpcUrls.default.http[0]), batch: { multicall: { wait: 30 } } });
export async function accountsFor(owner: Address): Promise<Account[]> {
 let accounts: Account[];
 try {
  accounts = (await api<{ accounts: Account[] }>(`accounts?owner=${owner}`)).accounts;
  if (!Array.isArray(accounts)) throw new Error("계정 응답을 확인하지 못했습니다.");
 }
 catch { accounts = JSON.parse(stringify(await readOwnerAccounts(recoveryClient, owner))) as Account[]; }
 // Retain public account references for independent recovery and owner records.
 try { localStorage.setItem(`alphapact:accounts:${owner.toLowerCase()}`, stringify(accounts.map(({ address, strategyId }) => ({ address, strategyId, chainId: chain.id })))); } catch {}
 return accounts;
}
export async function verifyDirectAccount(owner: Address, account: Address) {
 const found = await readOwnerAccounts(recoveryClient, owner);
 if (!found.some(entry => entry.address.toLowerCase() === account.toLowerCase())) throw new Error("소유한 전략 계정을 확인하지 못했습니다.");
}
export function discoverWallets(callback: (wallets: WalletOption[]) => void) {
 const options = new Map<string, WalletOption>();
 const announce = (event: Event) => {
  const detail = (event as CustomEvent<{ info: { uuid: string; name: string; icon?: string }; provider: Provider }>).detail;
  if (!detail?.provider?.request || !detail.info?.uuid) return;
  options.set(detail.info.uuid, { id: detail.info.uuid, name: detail.info.name, icon: detail.info.icon?.startsWith("data:image/") ? detail.info.icon : undefined, provider: detail.provider });
  callback([...options.values()]);
 };
 window.addEventListener("eip6963:announceProvider", announce);
 window.dispatchEvent(new Event("eip6963:requestProvider"));
 const injected = (window as Window & { ethereum?: Provider }).ethereum;
 if (injected && options.size === 0) { options.set("injected", { id: "injected", name: "브라우저 지갑", provider: injected }); queueMicrotask(() => callback([...options.values()])); }
 return () => window.removeEventListener("eip6963:announceProvider", announce);
}
export async function connect(provider: Provider): Promise<Address> {
 const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
 if (!accounts[0] || !isAddress(accounts[0])) throw new Error("연결한 지갑의 주소를 확인하지 못했습니다.");
 await ensureChain(provider);
 return getAddress(accounts[0]);
}
export async function ensureChain(provider: Provider) {
 const expected = `0x${chain.id.toString(16)}`;
 if (Number(await provider.request({ method: "eth_chainId" })) === chain.id) return;
 try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: expected }] }); }
 catch (failure) {
  if ((failure as { code?: number }).code !== 4902) throw failure;
  await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: expected, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: chain.rpcUrls.default.http, blockExplorerUrls: [chain.blockExplorers.default.url] }] });
 }
 if (Number(await provider.request({ method: "eth_chainId" })) !== chain.id) throw new Error("지갑 네트워크를 GIWA Sepolia로 바꿔 주세요.");
}
async function sign(provider: Provider, owner: Address, typed: Record<string, unknown>): Promise<Hex> {
 await ensureChain(provider);
 const active = await provider.request({ method: "eth_accounts" }) as string[];
 if (active[0]?.toLowerCase() !== owner.toLowerCase()) throw new Error("지갑 계정이 바뀌었습니다. 다시 연결해 주세요.");
 return await provider.request({ method: "eth_signTypedData_v4", params: [owner, stringify({ ...typed, types: { EIP712Domain: [
  { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
 ], ...(typed.types as object) } })] }) as Hex;
}
export async function createAccount(provider: Provider, owner: Address, strategyId: number, tradeLimit: number, dayLimit: number, durationDays: number, setStage: (message: string) => void) {
 const now = BigInt(Math.floor(Date.now() / 1000));
 const message = { owner, strategyId, maxTradeBudget: BigInt(tradeLimit) * 1_000_000n, maxRollingDayBudget: BigInt(dayLimit) * 1_000_000n, expiresAt: now + BigInt(durationDays * 86_400), deadline: now + 600n };
 setStage("지갑에서 매매 권한과 한도를 확인해 주세요.");
 const signature = await sign(provider, owner, { domain: createDomain(), types: createTypes, primaryType: "CreateAccount", message });
 setStage("GIWA에 내 전략 계정을 만드는 중입니다.");
 return api<{ account: Address; hash?: Hex; existing?: boolean }>("relay", { kind: "create", ...message, signature });
}
export async function ownerAction(provider: Provider, owner: Address, account: Account, action: 0 | 1 | 2, setStage: (message: string) => void) {
 const fresh = await api<Account>(`account?address=${account.address}`);
 const now = BigInt(Math.floor(Date.now() / 1000));
 const requested: Session = action === 0 ? { strategist: deployment.keeper, expiresAt: now + 86_400n,
  maxTradeBudget: BigInt(fresh.session.maxTradeBudget || "1000000000") || 1_000_000_000n,
  maxRollingDayBudget: BigInt(fresh.session.maxRollingDayBudget || "5000000000") || 5_000_000_000n,
  maxSlippageBps: 100, strategyHash: strategyHash(fresh.strategyId) } : ZERO_SESSION;
 const message = { action, sessionHash: sessionHash(requested), sessionId: BigInt(fresh.sessionId), nonce: BigInt(fresh.authorizationNonce), deadline: now + 600n };
 setStage(action === 2 ? "지갑에서 권한 취소와 자산 회수를 확인해 주세요." : action === 1 ? "지갑에서 매매 권한 중지를 확인해 주세요." : "지갑에서 새 매매 권한을 확인해 주세요.");
 const signature = await sign(provider, owner, { domain: actionDomain(fresh.address), types: actionTypes, primaryType: "OwnerAction", message });
 setStage("GIWA에서 요청을 처리하는 중입니다.");
 return api<{ account: Address; hash: Hex }>("relay", { kind: "action", account: fresh.address, action, session: requested, sessionId: fresh.sessionId, nonce: fresh.authorizationNonce, deadline: message.deadline, signature });
}
export function friendlyError(failure: unknown) {
 if ((failure as { code?: number })?.code === 4001 || /rejected|denied/i.test(String((failure as Error)?.message))) return "지갑에서 요청을 취소했습니다. 자산은 이동하지 않았습니다.";
 return failure instanceof Error ? failure.message.slice(0, 260) : "요청을 처리하지 못했습니다. 다시 시도해 주세요.";
}
