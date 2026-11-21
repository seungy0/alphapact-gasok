import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { encodeFunctionData, formatUnits, getAddress, isAddress, type Address, type Hex } from "viem";
import { accountAbi, chain, deployment, strategies } from "../protocol";
import { accountsFor, api, connect, createAccount, discoverWallets, ensureChain, friendlyError, ownerAction, verifyDirectAccount, type Account, type Activity, type Market, type Provider, type Status, type WalletOption } from "./client";
import { appRoute, dayLimits, durations, previewSettings, selectedStrategy, tradeLimits } from "./entry";

type View = "explore" | "accounts" | "activity" | "help";
const pages: { id: View; label: string; icon: string }[] = [{ id: "explore", label: "전략 탐색", icon: "discover" }, { id: "accounts", label: "내 계정", icon: "wallet" }, { id: "activity", label: "거래 내역", icon: "activity" }];
const n = (value: number, maximumFractionDigits = 2) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits }).format(value);
const units = (value: string | undefined, decimals = 6) => value ? Number(formatUnits(BigInt(value), decimals)) : 0;
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const explorer = (kind: "address" | "tx", value: string) => `${chain.blockExplorers.default.url}/${kind}/${value}`;
const at = (value: string | number) => new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(typeof value === "number" ? value * 1000 : value));
function syncWalletLink(owner: Address) {
 const params = new URLSearchParams(location.search);
 if (!params.has("wallet")) return;
 params.set("wallet", owner);
 history.replaceState(null, "", `${location.pathname}?${params}${location.hash}`);
}

function Icon({ name, size = 20 }: { name: string; size?: number }) {
 const paths: Record<string, ReactNode> = {
  discover: <><path d="m16 8-3 5-5 3 3-5 5-3Z"/><circle cx="12" cy="12" r="9"/></>,
  wallet: <><path d="M4 6h15v14H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h13v2M19 10h-5v6h5"/><path d="M16 13h.01"/></>,
  activity: <><path d="M3 17V7m6 13V4m6 13V9m6 11V3"/></>,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
  external: <><path d="M14 3h7v7m0-7L10 14M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6"/></>,
  shield: <><path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Z"/><path d="m8 12 3 3 5-6"/></>,
  help: <><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .6-1.5 1-1.5 2m0 3h.01"/></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 7a8 8 0 0 1 13-1L20 8M4 16l1.5 2a8 8 0 0 0 13-1"/></>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  chevron: <path d="m8 5 7 7-7 7"/>,
  pause: <><path d="M8 5v14m8-14v14"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
 };
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.arrow}</svg>;
}
function Brand() { return <a href="/" className="brand" aria-label="AlphaPact 홈">AlphaPact</a>; }
function Tokens({ small = false }: { small?: boolean }) { return <span className={`tokens ${small ? "small" : ""}`} aria-label="테스트 ETH와 테스트 USD"><span className="eth-token"><svg viewBox="0 0 20 24" width="19" height="23" aria-hidden="true"><path d="m10 1-8 12 8 5 8-5L10 1Zm0 18-8-5 8 9 8-9-8 5Z" fill="currentColor"/></svg></span><span className="usd-token">$</span></span>; }
function TxLink({ hash, children }: { hash: string; children?: ReactNode }) { return <a className="tx-link" href={explorer("tx", hash)} target="_blank" rel="noreferrer">{children ?? short(hash)}<Icon name="external" size={13}/></a>; }
function Empty({ icon, title, children }: { icon: string; title: string; children: ReactNode }) { return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={25}/></span><h3>{title}</h3><div>{children}</div></div>; }
function History({ entries, unavailable = false }: { entries: Activity[]; unavailable?: boolean }) {
 const labels: Record<string, string> = { CREATE: "계정 생성", REVOKE: "권한 중지", RESUME: "운용 재개", WITHDRAW: "권한 취소·회수" };
 if (unavailable && !entries.length) return <Empty icon="activity" title="거래 내역 연결 대기"><p>잔액은 GIWA에서 직접 읽었습니다.<br/>거래 내역은 서비스 연결이 복구되면 표시합니다.</p></Empty>;
 if (!entries.length) return <Empty icon="activity" title="아직 거래 내역이 없습니다"><p>계정 생성부터 매매·회수까지,<br/>처리된 트랜잭션을 이곳에서 확인할 수 있어요.</p></Empty>;
 return <><div className="table-scroll" tabIndex={0} role="region" aria-label="거래 내역 표, 좁은 화면에서는 가로로 스크롤할 수 있습니다"><table className="history-table"><thead><tr><th>유형</th><th>거래 수량</th><th>시간</th><th>트랜잭션</th></tr></thead><tbody>{entries.map(item => <tr key={item.hash}><td><span className={item.action === "SWAP" ? item.buy ? "buy-label" : "sell-label" : ""}>{item.action === "SWAP" ? item.buy ? "ETH 매수" : "ETH 매도" : labels[item.action] ?? item.action}</span><small>{item.action === "SWAP" ? "테스트 토큰 교환" : "GIWA Sepolia"}</small></td><td>{item.action === "SWAP" && item.amountIn ? <><b>{n(units(item.amountIn, item.buy ? 6 : 18), item.buy ? 2 : 6)} {item.buy ? "tUSD" : "tETH"}</b><small>{item.amountOut ? `${n(units(item.amountOut, item.buy ? 18 : 6), item.buy ? 6 : 2)} ${item.buy ? "tETH" : "tUSD"} 수령` : "체결 완료"}</small></> : "—"}</td><td className="number">{at(item.at)}</td><td><TxLink hash={item.hash}/></td></tr>)}</tbody></table></div><p className="table-hint">표를 옆으로 밀어 트랜잭션 원본을 확인할 수 있습니다.</p></>;
}

export default function App() {
 const [view, setView] = useState<View>(() => location.pathname.includes("accounts") ? "accounts" : location.pathname.includes("activity") ? "activity" : location.pathname.includes("help") ? "help" : "explore");
 const [selected, setSelected] = useState<number>(() => selectedStrategy(location.search));
 const [filter, setFilter] = useState("전체");
 const [search, setSearch] = useState("");
 const [wallets, setWallets] = useState<WalletOption[]>([]);
 const [provider, setProvider] = useState<Provider>();
 const [connected, setConnected] = useState<Address>();
 const [viewer, setViewer] = useState<Address | undefined>(() => { const candidate = new URLSearchParams(location.search).get("wallet") ?? localStorage.getItem("alphapact:wallet"); return candidate && isAddress(candidate) ? getAddress(candidate) : undefined; });
 const [lookup, setLookup] = useState("");
 const [accounts, setAccounts] = useState<Account[]>();
 const [status, setStatus] = useState<Status>();
 const [market, setMarket] = useState<Market>();
 const [observedAt, setObservedAt] = useState(() => Date.now());
 const [serviceError, setServiceError] = useState<string>();
 const [error, setError] = useState<string>();
 const [notice, setNotice] = useState<{ text: string; hash?: string }>();
 const [pending, setPending] = useState<string>();
 const [tradeLimit, setTradeLimit] = useState(() => previewSettings(location.search).tradeLimit);
 const [dayLimit, setDayLimit] = useState(() => previewSettings(location.search).dayLimit);
 const [duration, setDuration] = useState(() => previewSettings(location.search).duration);
 const [confirmExit, setConfirmExit] = useState(false);
 const walletDialog = useRef<HTMLDialogElement>(null);
 const viewerRef = useRef(viewer);
 useEffect(() => { viewerRef.current = viewer; }, [viewer]);
 const strategy = strategies[selected];
 const current = accounts?.find(account => account.strategyId === selected);
 const own = !!connected && !!current && connected.toLowerCase() === current.owner.toLowerCase();
 const entries = [...(accounts ?? []).flatMap(account => account.activity)].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

 useEffect(() => discoverWallets(setWallets), []);
 useEffect(() => {
  const listener = () => setView(location.pathname.includes("accounts") ? "accounts" : location.pathname.includes("activity") ? "activity" : location.pathname.includes("help") ? "help" : "explore");
  window.addEventListener("popstate", listener); return () => window.removeEventListener("popstate", listener);
 }, []);
 useEffect(() => {
  if (view === "help" && location.hash === "#direct-recovery") document.getElementById("direct-recovery")?.scrollIntoView();
 }, [view]);
 const refresh = useCallback(async () => {
  if (!viewer) return;
  const owner = viewer; const found = await accountsFor(owner);
  if (viewerRef.current === owner) setAccounts(found);
 }, [viewer]);
 useEffect(() => {
  let active = true;
  const read = () => {
   setObservedAt(Date.now());
   void api<Status>("status").then(data => { if (active) { setStatus(data); setServiceError(undefined); } }).catch(() => { if (active) setServiceError("실행 서비스 연결을 확인하고 있습니다. 잠시 후 새로고침해 주세요."); });
   void api<Market>("market").then(data => { if (active) setMarket(data); }).catch(() => undefined);
  };
  read(); const timer = setInterval(read, 30_000); return () => { active = false; clearInterval(timer); };
 }, []);
 useEffect(() => {
  if (!viewer) return;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
   try {
    const data = await accountsFor(viewer);
    if (active) setAccounts(data);
   } catch (failure) {
    if (active) setServiceError(friendlyError(failure));
   } finally {
    if (active) timer = setTimeout(read, 15_000);
   }
  };
  void read();
  return () => { active = false; clearTimeout(timer); };
 }, [viewer]);
 useEffect(() => {
  if (!provider?.on) return;
  const changed = (...args: unknown[]) => {
   const next = args[0] as string[];
   if (!next?.[0] || !isAddress(next[0])) { setConnected(undefined); return; }
   const owner = getAddress(next[0]); setConnected(owner); setViewer(owner); setAccounts(undefined); syncWalletLink(owner); localStorage.setItem("alphapact:wallet", owner);
  };
  provider.on("accountsChanged", changed); return () => provider.removeListener?.("accountsChanged", changed);
 }, [provider]);
 function navigate(next: View) { if (pending) return; setView(next); history.pushState(null, "", appRoute(next, location.search)); setError(undefined); setConfirmExit(false); }
 function select(id: number) { if (pending) return; setSelected(id); setError(undefined); setConfirmExit(false); if (innerWidth < 1000) requestAnimationFrame(() => document.getElementById("strategy-details")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" })); }
 async function connectWallet(wallet: WalletOption) {
  if (pending) return;
  setError(undefined); setPending("지갑에서 연결을 확인해 주세요.");
  try { const owner = await connect(wallet.provider); setProvider(wallet.provider); setConnected(owner); setViewer(owner); setAccounts(undefined); syncWalletLink(owner); localStorage.setItem("alphapact:wallet", owner); walletDialog.current?.close(); }
  catch (failure) { setError(friendlyError(failure)); }
  finally { setPending(undefined); }
 }
 async function start(event: FormEvent) {
  event.preventDefault(); if (pending) return; setError(undefined); setNotice(undefined);
  if (!provider || !connected) { walletDialog.current?.showModal(); return; }
  if (tradeLimit > dayLimit) { setError("24시간 한도를 1회 집행 한도 이상으로 정해 주세요."); return; }
  try { setPending("권한 요청을 준비하고 있습니다."); const result = await createAccount(provider, connected, selected, tradeLimit, dayLimit, duration, setPending); if (viewerRef.current !== connected) return; setNotice({ text: "내 전략 계정을 만들었습니다. 첫 매매 조건을 평가합니다.", hash: result.hash }); await refresh(); }
  catch (failure) { setError(friendlyError(failure)); }
  finally { setPending(undefined); }
 }
 async function control(action: 0 | 1 | 2) {
  if (pending) return;
  if (!provider || !connected || !current || !own) { walletDialog.current?.showModal(); return; }
  setError(undefined); setNotice(undefined);
  try { setPending("계정 상태를 확인하고 있습니다."); const result = await ownerAction(provider, connected, current, action, setPending); if (viewerRef.current !== connected) return; setNotice({ text: action === 2 ? "매매 권한을 취소하고 보유 토큰을 내 지갑으로 회수했습니다." : action === 1 ? "새로운 매매를 중지했습니다. 자산은 내 계정에 남아 있습니다." : "새 매매 권한을 부여했습니다.", hash: result.hash }); setConfirmExit(false); await refresh(); }
  catch (failure) { setError(friendlyError(failure)); }
  finally { setPending(undefined); }
 }
 async function directExit() {
  if (pending) return;
  if (!provider || !connected || !current || !own) { walletDialog.current?.showModal(); return; }
  try {
   setError(undefined); await ensureChain(provider); await verifyDirectAccount(connected, current.address);
   const active = await provider.request({ method: "eth_accounts" }) as string[];
   if (active[0]?.toLowerCase() !== connected.toLowerCase()) throw new Error("지갑 계정이 바뀌었습니다. 다시 연결해 주세요.");
   setPending("내 지갑에서 직접 회수 트랜잭션을 확인해 주세요.");
   const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from: connected, to: current.address, value: "0x0", chainId: `0x${chain.id.toString(16)}`, data: encodeFunctionData({ abi: accountAbi, functionName: "revokeAndWithdraw" }) }] }) as Hex;
   setNotice({ text: "직접 회수 요청을 보냈습니다. Explorer에서 확정 상태를 확인해 주세요.", hash }); setConfirmExit(false);
  } catch (failure) { setError(friendlyError(failure)); } finally { setPending(undefined); }
 }
 function lookupWallet(event: FormEvent) { event.preventDefault(); if (!isAddress(lookup)) { setError("0x로 시작하는 지갑 주소를 확인해 주세요."); return; } setViewer(getAddress(lookup)); setAccounts(undefined); setError(undefined); history.replaceState(null, "", appRoute(view, `?wallet=${getAddress(lookup)}`)); }
 const isStale = market ? observedAt / 1000 - market.price.publishedAt > 120 : true;
 const filtered = strategies.filter(item => (filter === "전체" || filter === "오픈소스" && item.id === 2 || item.category === filter) && `${item.name} ${item.category}`.toLowerCase().includes(search.toLowerCase()));

 const lookupForm = <form className="address-lookup" onSubmit={lookupWallet}><label htmlFor="wallet-lookup">지갑 주소로 읽기 전용 조회</label><div><input id="wallet-lookup" placeholder="0x…" value={lookup} onChange={event => setLookup(event.target.value)} autoComplete="off" spellCheck={false}/><button className="secondary" type="submit">조회</button></div></form>;
 return <div className="app-shell">
  <a className="skip-link" href="#main">본문 바로가기</a>
  <header className="app-header"><Brand/><span className="network-tag"><span className="status-dot"/>GIWA Sepolia<span className="network-caption">테스트넷</span></span><div className="header-actions"><a className="subtle-link desktop-only" href="/spot">업비트 현물</a><a className="subtle-link desktop-only" href="https://docs.giwa.io/get-started/connect-to-giwa" target="_blank" rel="noreferrer">네트워크 안내<Icon name="external" size={13}/></a><button className={connected ? "wallet-connected" : "primary wallet-button"} disabled={!!pending} onClick={() => walletDialog.current?.showModal()}><Icon name="wallet" size={17}/>{connected ? short(connected) : "지갑 연결"}</button></div></header>
  <aside className="sidebar"><nav aria-label="서비스 메뉴">{pages.map(page => <button key={page.id} className={view === page.id ? "nav-item active" : "nav-item"} disabled={!!pending} aria-current={view === page.id ? "page" : undefined} onClick={() => navigate(page.id)}><Icon name={page.icon}/><span>{page.label}</span>{page.id === "accounts" && !!accounts?.length && <span className="nav-count">{accounts.length}</span>}</button>)}<button className={`nav-item mobile-help ${view === "help" ? "active" : ""}`} disabled={!!pending} aria-current={view === "help" ? "page" : undefined} onClick={() => navigate("help")}><Icon name="help"/><span>이용 안내</span></button></nav><div className="sidebar-bottom"><button className={view === "help" ? "nav-item active" : "nav-item"} disabled={!!pending} onClick={() => navigate("help")}><Icon name="help"/><span>이용 안내</span></button><div className="connection-info"><span className={`status-dot ${status?.ready ? "" : "waiting"}`}/><div><b>{status?.ready ? "테스트넷 실행 중" : "실행 상태 확인 중"}</b><small>테스트 가스는 서비스가 지원</small></div></div><span className="sidebar-disclaimer">테스트 토큰은 현금 가치가 없습니다.</span></div></aside>
  <main className="workspace" id="main">
   {viewer && !connected && <div className="read-only-banner"><span>지갑 {short(viewer)}의 계정을 읽기 전용으로 보고 있습니다.</span><button onClick={() => walletDialog.current?.showModal()}>내 지갑 연결</button></div>}
   {status && !status.ready && <div role="status" className="service-message">{status.deployment.ready ? "실행 서비스가 일시 대기 중입니다. 잠시 후 다시 시도하거나 내 지갑으로 직접 회수할 수 있어요." : "테스트넷 거래 서비스를 준비하고 있습니다. 계약 배포가 끝나면 계정 생성과 거래를 시작할 수 있어요."}</div>}
   {accounts?.some(account => account.rpcFallback) && <div role="status" className="service-message">실행 API에 연결할 수 없어 GIWA에서 계정을 직접 읽었습니다. 내 지갑으로 직접 회수할 수 있습니다.</div>}
   {serviceError && <div role="status" className="service-message">{serviceError}<button onClick={() => location.reload()}>새로고침</button></div>}
   {notice && <div role="status" className="notice"><Icon name="check"/><span>{notice.text}</span>{notice.hash && <TxLink hash={notice.hash}>거래 확인</TxLink>}<button className="icon-button" aria-label="알림 닫기" onClick={() => setNotice(undefined)}><Icon name="close" size={16}/></button></div>}
   <div className="page-heading"><div><h1>{view === "explore" ? "전략 탐색" : view === "accounts" ? "내 전략 계정" : view === "activity" ? "거래 내역" : "AlphaPact 이용 안내"}</h1><p>{view === "explore" ? "규칙을 확인하고 테스트 토큰으로 시작하세요." : view === "accounts" ? "계정의 자산과 매매 권한을 직접 관리하세요." : view === "activity" ? "계정 생성부터 토큰 교환·회수까지 실제 트랜잭션을 확인하세요." : "권한은 어떻게 작동하고, 테스트넷에서는 무엇을 할 수 있나요?"}</p></div>{(view === "accounts" || view === "activity") && <button className="secondary refresh-button" onClick={() => void refresh().catch(failure => setError(friendlyError(failure)))}><Icon name="refresh" size={16}/>새로고침</button>}</div>
   {error && <div role="alert" className="error-message">{error}<button className="icon-button" aria-label="오류 닫기" onClick={() => setError(undefined)}><Icon name="close" size={16}/></button></div>}
   {view !== "help" && <div className="market-strip"><div className="market-identity"><span className="market-symbol"><Tokens small/></span><div><b>ETH / USD</b><small>공개 시세 참조</small></div></div><div className="market-price">{market ? `$${n(market.price.price)}` : <span className="loading-text">시세 연결 중</span>}</div><div className="market-detail"><span className={`status-dot ${isStale ? "waiting" : ""}`}/><span>{market ? isStale ? "시세 갱신 대기" : `${at(market.price.publishedAt)} 업데이트` : "최신 시세를 확인합니다"}</span></div><span className="venue-note">서비스 게시 가격 · 테스트 거래소</span></div>}
   {view === "explore" ? <div className="operating-grid"><section className="strategy-workspace" aria-label="전략 목록"><div className="strategy-toolbar"><div className="filter-tabs" aria-label="전략 유형">{["전체", "리밸런싱", "분할 매수", "오픈소스"].map(label => <button key={label} className={filter === label ? "selected" : ""} onClick={() => setFilter(label)} aria-pressed={filter === label}>{label}</button>)}</div><label className="search-field"><span className="sr-only">전략 검색</span><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><input placeholder="전략 검색" value={search} onChange={event => setSearch(event.target.value)}/></label></div><div className="list-caption"><span>전략 {filtered.length}개</span><span>성과 순위가 아닌 공개 규칙으로 비교합니다</span></div><div className="strategy-list">{filtered.length ? filtered.map(item => <article key={item.id} className={`strategy-row ${selected === item.id ? "chosen" : ""} ${!item.available ? "coming-soon" : ""}`}><header><Tokens/><div className="strategy-title"><div className="strategy-tags"><span>{item.category}</span><span className={item.available && status?.ready ? "available-tag" : "pending-tag"}>{item.available ? status?.ready ? "테스트넷 실행 가능" : status?.deployment.ready ? "실행 대기" : status ? "배포 준비 중" : "상태 확인 중" : "준비 중"}</span></div><h2>{item.name}</h2></div><button className={selected === item.id ? "select-button is-selected" : "select-button"} disabled={!!pending} aria-pressed={selected === item.id} onClick={() => select(item.id)}>{selected === item.id ? <><Icon name="check" size={15}/><span className="desktop-label">선택됨</span><span className="mobile-label">{current?.strategyId === item.id ? "계정 보기" : item.available ? "시작하기" : "상세 보기"}</span></> : <><span>선택</span><Icon name="chevron" size={15}/></>}</button></header><p className="strategy-description">{item.summary}</p><dl className="strategy-facts"><div><dt>{item.id === 0 ? "목표 비중" : "운용 규칙"}</dt><dd>{item.id === 0 ? "ETH 50% · USD 50%" : item.id === 1 ? "4시간마다 최대 500 tUSD" : "원본 Freqtrade 전략"}</dd></div><div><dt>최소 매매 간격</dt><dd>{item.id === 0 ? "15분" : item.id === 1 ? "4시간" : "원본 설정에 따름"}</dd></div><div><dt>{item.available ? "테스트 교환 비용" : "실행 환경"}</dt><dd>{item.available ? "0.30%" : "CEX · 별도 검토"}</dd></div></dl><footer><span>{item.available ? "공개된 규칙 · 수익성 검증 전" : "GIWA 전략으로 변형하지 않은 원본"}</span><button className="text-button" disabled={!!pending} onClick={() => { select(item.id); document.getElementById("strategy-details")?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }}>규칙 보기<Icon name="chevron" size={13}/></button></footer></article>) : <Empty icon="discover" title="조건에 맞는 전략이 없습니다"><p>다른 검색어나 전략 유형을 선택해 주세요.</p><button className="secondary" onClick={() => { setSearch(""); setFilter("전체"); }}>전체 전략 보기</button></Empty>}</div><div className="ownership-note"><Icon name="shield" size={21}/><div><b>회수 권한은 내 지갑에 남습니다.</b><p>전략은 허용된 교환만 실행합니다. 매매 권한을 중지하거나 보유 테스트 토큰을 내 지갑으로 회수할 수 있어요.</p></div></div></section>{renderPanel()}</div>
   : view === "accounts" ? <>{!viewer ? <section className="surface account-empty"><Empty icon="wallet" title="지갑을 연결하고 내 계정을 확인하세요"><p>전략 계정과 자산은 내 지갑 주소에 연결됩니다.<br/>ChatGPT 계정 없이 사용할 수 있어요.</p><button className="primary" onClick={() => walletDialog.current?.showModal()}>지갑 연결</button></Empty>{lookupForm}</section> : !accounts ? <div className="surface loading-block" role="status">GIWA에서 계정을 불러오고 있습니다.</div> : !accounts.length ? <section className="surface"><Empty icon="wallet" title="아직 만든 전략 계정이 없습니다"><p>전략을 선택하면 내 지갑이 소유하는 계정을 만들고<br/>테스트 예산 10,000 tUSD로 시작할 수 있어요.</p><button className="primary" onClick={() => navigate("explore")}>전략 고르기<Icon name="arrow" size={16}/></button></Empty></section> : <div className="operating-grid"><section className="account-list">{accounts.map(account => <button key={account.address} className={`account-row surface ${selected === account.strategyId ? "chosen" : ""}`} disabled={!!pending} onClick={() => select(account.strategyId)}><div className="account-row-top"><Tokens small/><span className={`account-status ${account.active ? "running" : "stopped"}`}><span className={`status-dot ${account.active ? "" : "waiting"}`}/>{account.active ? "운용 중" : BigInt(account.cash) === 0n && BigInt(account.position) === 0n ? "회수됨" : "중지됨"}</span></div><h2>{strategies[account.strategyId]?.name}</h2><div className="account-value"><span>테스트 계정 평가액</span><strong>{market ? `${n(units(account.cash) + units(account.position, 18) * market.price.price)} tUSD` : "시세 확인 중"}</strong></div><div className="account-asset-line"><span>tUSD <b>{n(units(account.cash))}</b></span><span>tETH <b>{n(units(account.position, 18), 6)}</b></span></div><div className="account-row-bottom"><span>{short(account.address)}</span><span>계정 관리<Icon name="chevron" size={15}/></span></div></button>)}<section className="surface mini-history"><h2>최근 내역</h2><History entries={entries.slice(0, 5)} unavailable={accounts?.some(account => account.rpcFallback)}/></section></section>{renderPanel()}</div>}</>
   : view === "activity" ? <section className="surface"><div className="surface-heading"><h2>앱에서 처리한 트랜잭션</h2><span>{entries.length}건</span></div>{!viewer ? <Empty icon="activity" title="지갑을 연결하면 내역을 볼 수 있어요"><p>실제로 처리된 GIWA 트랜잭션만 표시합니다.</p><button className="primary" onClick={() => walletDialog.current?.showModal()}>지갑 연결</button>{lookupForm}</Empty> : <History entries={entries} unavailable={accounts?.some(account => account.rpcFallback)}/>}</section>
   : <section className="surface help-content"><h2>내 지갑에 연결된 개인 전략 계정</h2><p>지갑을 연결하고 전략을 고르면 개인 전략 계정을 만듭니다. 매매할 수 있는 금액과 기간을 지갑에서 확인해 서명하면, 서비스가 테스트 가스를 대신 내고 GIWA에 계정을 생성합니다.</p><h2>테스트넷에서 실제로 일어나는 일</h2><p>계약 생성, 테스트 토큰 교환, 권한 취소와 회수는 실제 GIWA Sepolia 트랜잭션입니다. tUSD와 tETH는 현금 가치가 없는 테스트 자산입니다. 서비스가 Coinbase·Kraken의 최신 ETH/USD 공개 시세를 대조해 테스트 가격을 게시합니다. 이 가격에 0.30% 비용을 적용하는 모의 거래소이며, 실제 시장 유동성이나 투자 수익을 의미하지 않습니다.</p><h2>전략이 할 수 있는 일</h2><p>정해진 두 테스트 토큰의 교환만 허용합니다. 매매 금액·기간·빈도·허용 가격을 계약에서 검사합니다. 집행 한도는 손실 상한이 아니며, 시장 가격 변화로 테스트 평가액이 줄어들 수 있습니다.</p><h2>서비스에 무엇을 맡기나요?</h2><p>전략 규칙의 판단과 테스트 가격 게시를 서비스에 맡깁니다. 계약은 집행 한도·기한·고정 거래 경로를 검사하지만, 공개 API 시세의 진위나 전략 판단 자체를 증명하지는 않습니다. 이 가격 구조는 테스트 전용이며 실자금에 사용하지 않습니다.</p><h2>중지와 회수는 어떻게 다른가요?</h2><p>권한 중지는 새로운 매매를 막고 자산을 계정에 남깁니다. 자산 회수는 권한을 취소하고 계정의 두 테스트 토큰을 소유자 지갑으로 반환합니다. 현금 환전이나 원금 보전을 뜻하지 않습니다.</p><h2 id="direct-recovery">실행 서비스가 중단되면?</h2><p>계정의 직접 회수 기능은 서비스 서버를 거치지 않습니다. 내 지갑에 GIWA 테스트 ETH가 있으면 계정 화면에서 직접 회수할 수 있습니다. 체인 장애와 토큰 자체의 전송 동결까지 해결할 수는 없습니다.</p><div className="help-links"><a href="https://docs.giwa.io" target="_blank" rel="noreferrer">GIWA 문서<Icon name="external" size={14}/></a><a href="https://faucet.giwa.io" target="_blank" rel="noreferrer">무료 테스트 ETH<Icon name="external" size={14}/></a>{deployment.ready && <a href={explorer("address", deployment.factory)} target="_blank" rel="noreferrer">공개 계정 생성 계약<Icon name="external" size={14}/></a>}</div></section>}
   <footer className="workspace-footer"><span>AlphaPact Testnet</span><span>실제 자금을 사용하지 마세요. 테스트 토큰은 현금 가치가 없습니다.</span><a href="mailto:snggyu.lee@gmail.com?subject=AlphaPact%20테스트넷%20문의">문의</a></footer>
  </main>
  <dialog ref={walletDialog} className="wallet-dialog" aria-labelledby="wallet-dialog-title"><div className="dialog-heading"><h2 id="wallet-dialog-title">지갑 연결</h2><button className="icon-button" aria-label="닫기" disabled={!!pending} onClick={() => walletDialog.current?.close()}><Icon name="close"/></button></div><p>내 지갑으로 계정을 만들고 직접 관리하세요.</p>{connected && <div className="connected-detail"><b>{short(connected)}</b><span>연결된 지갑</span><button className="text-button" onClick={() => { setConnected(undefined); setProvider(undefined); walletDialog.current?.close(); }}>연결 해제</button></div>}{wallets.length ? <div className="wallet-options">{wallets.map(wallet => <button key={wallet.id} disabled={!!pending} onClick={() => void connectWallet(wallet)}>{wallet.icon ? <img src={wallet.icon} alt="" width="30" height="30"/> : <Icon name="wallet" size={28}/>}<span>{wallet.name}</span><Icon name="chevron" size={17}/></button>)}</div> : <div className="no-wallet"><Icon name="wallet" size={32}/><h3>브라우저 지갑이 필요합니다</h3><p>MetaMask 등 이더리움 지갑을 설치하거나<br/>모바일 지갑 앱에서 이 페이지를 열어 주세요.</p><a className="primary" href={`https://link.metamask.io/dapp/${location.host}${location.pathname}`} target="_blank" rel="noreferrer">MetaMask 앱에서 열기<Icon name="external" size={15}/></a><a className="subtle-link" href="https://metamask.io/download" target="_blank" rel="noreferrer">브라우저 지갑 설치</a></div>}{pending && <p role="status" className="pending-message">{pending}</p>}{error && <p role="alert" className="error-message">{error}</p>}<div className="wallet-dialog-note"><Icon name="shield" size={18}/><span>비밀키나 복구 문구를 입력받지 않습니다.<br/>사용 네트워크: GIWA Sepolia</span></div></dialog>
 </div>;


 function renderPanel() {
  return <aside className="operation-panel surface" id="strategy-details"><div className="panel-heading"><h2>{strategy.name}</h2><Tokens small/></div><p className="panel-rule">{strategy.rule}</p>{!strategy.available ? <div className="pending-strategy"><span className="pending-tag">실행 경로 준비 중</span><p>NFI는 CEX용 원본 전략입니다.<br/>현재 GIWA 계정에서 실행할 수 없습니다.</p><a className="secondary" href="https://github.com/iterativv/NostalgiaForInfinity" target="_blank" rel="noreferrer">원본 저장소<Icon name="external" size={14}/></a></div> : current ? <><div className="panel-account-status"><span className={`account-status ${current.active ? "running" : "stopped"}`}><span className={`status-dot ${current.active ? "" : "waiting"}`}/>{current.active ? "운용 중" : BigInt(current.cash) + BigInt(current.position) === 0n ? "중지됨 · 잔액 없음" : "매매 권한 중지"}</span><a className="tx-link" href={explorer("address", current.address)} target="_blank" rel="noreferrer">{short(current.address)}<Icon name="external" size={13}/></a></div><dl className="panel-balances"><div><dt>테스트 USD</dt><dd>{n(units(current.cash))}<small>tUSD</small></dd></div><div><dt>테스트 ETH</dt><dd>{n(units(current.position, 18), 6)}<small>tETH</small></dd></div></dl><dl className="permission-list"><div><dt>24시간 집행액</dt><dd>{n(units(current.spent))} / {n(units(current.session.maxRollingDayBudget))} tUSD</dd></div><div><dt>1회 집행 한도</dt><dd>{n(units(current.session.maxTradeBudget))} tUSD</dd></div><div><dt>권한 만료</dt><dd>{Number(current.session.expiresAt) ? at(Number(current.session.expiresAt)) : "권한 취소됨"}</dd></div></dl><div className="evaluation-state"><span className={`status-dot ${current.active ? "" : "waiting"}`}/><div><b>{!current.active ? "매매 권한이 중지되어 있습니다." : current.evaluation?.reason ?? (current.rpcFallback ? "GIWA에서 읽은 실제 계정 상태" : "첫 매매 조건 평가 대기")}</b><small>{!current.active ? BigInt(current.cash) + BigInt(current.position) > 0n ? "새로운 매매는 실행하지 않습니다. 보유 토큰은 회수할 수 있습니다." : "계정에 남은 토큰이 없습니다." : current.evaluation ? `${at(current.evaluation.at)} 평가` : current.rpcFallback ? "서비스 연결이 복구되면 평가 내역을 표시합니다" : "실제 실행 결과가 생기면 표시합니다"}</small></div></div>{!own ? <button className="primary full-width" onClick={() => walletDialog.current?.showModal()}>소유자 지갑 연결</button> : <div className="account-controls">{current.active ? <button className="secondary full-width" disabled={!!pending || !status?.ready} onClick={() => void control(1)}><Icon name="pause" size={16}/>매매 권한 중지</button> : <button className="primary full-width" disabled={!!pending || !status?.ready || BigInt(current.cash) + BigInt(current.position) === 0n} onClick={() => void control(0)}>24시간 운용 재개<Icon name="arrow" size={16}/></button>}<div className="exit-controls">{confirmExit ? <><p>매매 권한을 취소하고 계정의 tUSD·tETH를 내 지갑으로 회수합니다.</p><button className="danger full-width" disabled={!!pending || !status?.ready} onClick={() => void control(2)}>권한 취소하고 회수</button><button className="text-button" disabled={!!pending} onClick={() => setConfirmExit(false)}>취소</button></> : <button className="text-button recovery-button" disabled={!!pending || BigInt(current.cash) + BigInt(current.position) === 0n} onClick={() => setConfirmExit(true)}>보유 자산 회수<Icon name="arrow" size={15}/></button>}<details open={current.rpcFallback || undefined}><summary>내 지갑으로 직접 회수</summary><p>서비스를 거치지 않고 계약을 직접 호출합니다. 내 지갑에 무료 테스트 ETH가 필요합니다.</p><button className="secondary full-width" disabled={!!pending} onClick={() => void directExit()}>지갑에서 직접 회수</button><a className="subtle-link" href="https://faucet.giwa.io" target="_blank" rel="noreferrer">무료 테스트 ETH 받기<Icon name="external" size={12}/></a></details></div></div>}</> : <form className="start-form" onSubmit={event => void start(event)}><div className="starting-budget"><span>제공되는 테스트 예산</span><strong>10,000<small>tUSD</small></strong></div><div className="permission-fields"><label>1회 집행 한도<select disabled={!!pending} value={tradeLimit} onChange={event => { const value = Number(event.target.value); setTradeLimit(value); if (value > dayLimit) setDayLimit(value); }}>{tradeLimits.map(value => <option key={value} value={value}>{n(value)} tUSD</option>)}</select></label><label>24시간 집행 한도<select disabled={!!pending} value={dayLimit} onChange={event => setDayLimit(Number(event.target.value))}>{dayLimits.filter(value => value >= tradeLimit).map(value => <option key={value} value={value}>{n(value)} tUSD</option>)}</select></label><label>매매 권한 기간<select disabled={!!pending} value={duration} onChange={event => setDuration(Number(event.target.value))}>{durations.map(value => <option key={value} value={value}>{value}일</option>)}</select></label></div><p className="permission-description"><Icon name="shield" size={17}/><span>지정한 테스트 토큰 교환만 허용합니다.<br/>중지와 회수 권한은 내 지갑에 남습니다.</span></p><button type="submit" className="primary start-button" disabled={!!pending || !!connected && !status?.ready}>{connected ? "계정 만들고 시작" : "지갑 연결하고 시작"}<Icon name="arrow" size={17}/></button><span className="gas-note">테스트 가스 지원 · 실제 자금 필요 없음</span>{connected && !status?.ready && <p role="status" className="preparing-note">실행 서비스를 준비하고 있습니다. 준비가 끝나면 시작할 수 있어요.</p>}</form>}{pending && <div className="pending-message" role="status"><span className="pending-indicator"/>{pending}</div>}{strategy.available && <div className="panel-footnote"><span>테스트 거래소 · 기준가격 대비 0.30% 비용</span><span>집행 한도는 손실 상한이 아닙니다.</span></div>}</aside>;
 }
}
