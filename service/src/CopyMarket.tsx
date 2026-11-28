import { useEffect, useRef, useState, type FormEvent } from "react";
import { formatUnits, type Address, type Hex } from "viem";
import { actionDomain, actionTypes, chain, sessionHash, ZERO_SESSION } from "../protocol";
import {
  copyDeployment, copyDomain, followTypes, registerTypes, type CopyStrategy, type CopySubscription,
} from "../copy-protocol";
import { api, connect, discoverWallets, friendlyError, sign, type Provider, type WalletOption } from "./client";
import "./market.css";
import "./copy.css";

const explorer = chain.blockExplorers.default.url;
const dollars = (raw: string) => `${Number(formatUnits(BigInt(raw), 6)).toLocaleString("ko-KR")} tUSD`;
const tokens = (raw: string) => `${formatUnits(BigInt(raw), 18)} tETH`;
const shorten = (address: Address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const usd = (form: FormData, name: string) => BigInt(String(form.get(name))) * 1_000_000n;
const clock = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "numeric", minute: "2-digit", second: "2-digit" });
const time = (seconds: number) => `${clock.format(seconds * 1_000)} KST`;
const currentTime = () => Math.floor(Date.now() / 1_000);
type Catalog = { ready: boolean; strategies: CopyStrategy[]; before: string | null };
type Connection = { owner: Address; provider: Provider };
const accountPath = (owner: Address, strategyId: string) => `copy/accounts?owner=${owner}&strategyId=${strategyId}`;

function ReceiptLink({ hash, children }: { hash: Hex; children: string }) {
  return <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">{children}</a>;
}

function AccountDetails({ account, strategy, pending, control }: {
  account: CopySubscription; strategy: CopyStrategy; pending: boolean; control: (action: "stop" | "withdraw") => void;
}) {
  const elapsed = currentTime() - Number(account.startsAt);
  const interval = Number(strategy.interval);
  const currentSequence = Math.max(1, Math.floor(elapsed / interval) + 1);
  const currentWindow = Number(account.startsAt) + (currentSequence - 1) * interval;
  const upcoming = elapsed >= 0 && (elapsed % interval >= 180 || account.fill?.sequence === currentSequence)
    ? currentWindow + interval : currentWindow;
  return <section className="copy-account" aria-label="내 팔로우 계정">
    <div className="copy-lineup">
      <h3>내 팔로우 계정</h3>
      <span className={account.active ? "copy-enabled" : undefined}>{account.active ? "팔로우 중" : account.revoked ? "중지됨" : "권한 만료"}</span>
    </div>
    <dl className="copy-balance">
      <div><dt>남은 테스트 예산</dt><dd>{dollars(account.cash)}</dd></div>
      <div><dt>보유 테스트 ETH</dt><dd>{tokens(account.position)}</dd></div>
    </dl>
    {account.fill && <div className="copy-receipt">
      <strong>자동 매수 완료</strong>
      <span>{dollars(account.fill.amountIn)} 사용 · {tokens(account.fill.amountOut)} 수령</span>
      <ReceiptLink hash={account.fill.hash}>GIWA 거래 영수증 보기</ReceiptLink>
    </div>}
    {account.active && <p>{Number(account.expiresAt) <= upcoming ? "다음 매수 전에 권한이 만료됩니다." :
      upcoming <= currentTime() ? "자동 매수 결과를 기다리고 있습니다." : `다음 매수 시작 ${time(upcoming)}`}</p>}
    <p><a href={`${explorer}/address/${account.account}`} target="_blank" rel="noreferrer">전략 계정 {shorten(account.account)}</a></p>
    <div className="copy-actions">
      {account.active && <button className="market-outline" disabled={pending} onClick={() => control("stop")}>팔로우 중지</button>}
      {(BigInt(account.cash) > 0n || BigInt(account.position) > 0n) && <button className="market-outline" disabled={pending}
        onClick={() => control("withdraw")}>중지하고 토큰 회수</button>}
    </div>
    <p className="copy-small">다시 시작하려면 새 전략을 선택해 주세요.</p>
  </section>;
}

export default function CopyMarket() {
  const [catalog, setCatalog] = useState<Catalog>();
  const [catalogError, setCatalogError] = useState("");
  const [selectedId, setSelectedId] = useState(new URLSearchParams(location.search).get("strategy") ?? "");
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [walletId, setWalletId] = useState("");
  const [connection, setConnection] = useState<Connection>();
  const [accounts, setAccounts] = useState<CopySubscription[]>();
  const [view, setView] = useState<"follow" | "register">("follow");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [accountError, setAccountError] = useState("");
  const [notice, setNotice] = useState("");
  const [hash, setHash] = useState<Hex>();
  const detailsRef = useRef<HTMLElement>(null);
  const selected = catalog?.strategies.find(entry => entry.id === selectedId) ?? catalog?.strategies[0];
  const strategyId = selected?.id;
  const active = accounts?.find(entry => entry.strategyId === selected?.id);

  async function loadCatalog(before?: string, signal?: AbortSignal) {
    const data = await api<Catalog>(`copy/strategies${before ? `?before=${before}` : ""}`, undefined, signal);
    setCatalog(existing => before && existing ? { ...data, strategies: [...existing.strategies, ...data.strategies] } : data);
    setCatalogError("");
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadCatalog(undefined, controller.signal).catch(() => {
      if (!controller.signal.aborted) setCatalogError("전략 목록을 불러오지 못했습니다.");
    });
    return () => controller.abort();
  }, []);

  useEffect(() => discoverWallets(setWallets), []);

  useEffect(() => {
    if (!connection || !strategyId) return;
    const accountUrl = accountPath(connection.owner, strategyId);
    setAccounts(undefined);
    setAccountError("");
    const abort = new AbortController();
    let timer: number | undefined;
    async function refresh() {
      try {
        const data = await api<{ accounts: CopySubscription[] }>(accountUrl, undefined, abort.signal);
        if (!abort.signal.aborted) {
          setAccounts(data.accounts);
          setAccountError("");
        }
      } catch {
        if (!abort.signal.aborted) setAccountError("계정 조회가 지연되고 있습니다. 잠시 후 자동으로 다시 확인합니다.");
      }
      if (!abort.signal.aborted) timer = window.setTimeout(refresh, 12_000);
    }
    function disconnect() {
      setConnection(undefined);
      setAccounts(undefined);
      setNotice("");
      setHash(undefined);
      setError("지갑 계정이 바뀌었습니다. 다시 연결해 주세요.");
    }
    connection.provider.on?.("accountsChanged", disconnect);
    void refresh();
    return () => {
      abort.abort();
      window.clearTimeout(timer);
      connection.provider.removeListener?.("accountsChanged", disconnect);
    };
  }, [connection, strategyId]);

  async function run(initial: string, task: () => Promise<void>) {
    setPending(initial);
    setError("");
    setNotice("");
    setHash(undefined);
    try { await task(); }
    catch (failure) { setError(friendlyError(failure)); }
    finally { setPending(""); }
  }

  async function connectWallet() {
    const wallet = wallets.find(option => option.id === walletId) ?? wallets[0];
    if (!wallet) return;
    await run("지갑에서 연결을 확인해 주세요.", async () => {
      const owner = await connect(wallet.provider);
      setAccounts(undefined);
      setConnection({ owner, provider: wallet.provider });
    });
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connection) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name")).trim();
    if (!name || new TextEncoder().encode(name).length > 108) { setError("전략 이름을 36자 안으로 입력해 주세요."); return; }
    const message = { creator: connection.owner, name, amount: usd(form, "amount"),
      interval: BigInt(String(form.get("interval"))) * 60n, deadline: BigInt(currentTime() + 600) };
    await run("지갑에서 전략 등록 내용을 확인해 주세요.", async () => {
      const signature = await sign(connection.provider, connection.owner, { domain: copyDomain, types: registerTypes, primaryType: "RegisterStrategy", message });
      setPending("GIWA에 전략을 등록하고 있습니다.");
      const result = await api<{ strategyId: string; hash?: Hex; existing?: boolean }>("copy/relay", { kind: "register", ...message, signature });
      setHash(result.hash);
      setNotice(result.existing ? "이미 등록된 전략을 열었습니다." : "전략이 등록됐습니다. 다른 지갑에서 이 전략을 팔로우할 수 있습니다.");
      setSelectedId(result.strategyId);
      setView("follow");
      await loadCatalog().catch(() => setCatalogError("목록이 아직 갱신되지 않았습니다."));
    });
  }

  async function follow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connection || !selected) return;
    const form = new FormData(event.currentTarget);
    const maxTradeBudget = usd(form, "trade");
    const maxRollingDayBudget = usd(form, "day");
    if (maxRollingDayBudget < maxTradeBudget) { setError("24시간 한도는 거래당 한도 이상으로 설정해 주세요."); return; }
    const message = { owner: connection.owner, strategyId: BigInt(selected.id), maxTradeBudget, maxRollingDayBudget,
      expiresAt: BigInt(currentTime() + Number(form.get("hours")) * 3_600), deadline: BigInt(currentTime() + 600) };
    await run("지갑에서 매수 한도와 기간을 확인해 주세요.", async () => {
      const signature = await sign(connection.provider, connection.owner, { domain: copyDomain, types: followTypes, primaryType: "FollowStrategy", message });
      setPending("GIWA에 내 팔로우 계정을 만드는 중입니다.");
      const result = await api<{ subscription: CopySubscription; hash?: Hex }>("copy/relay", { kind: "follow", ...message, signature });
      setAccounts(previous => [result.subscription, ...(previous ?? []).filter(entry => entry.id !== result.subscription.id)]);
      setHash(result.hash);
      setNotice("팔로우가 시작됐습니다. 거래마다 지갑을 열 필요는 없습니다.");
    });
  }

  async function control(kind: "stop" | "withdraw") {
    if (!connection || !active) return;
    const message = { action: kind === "stop" ? 1 : 2, sessionId: BigInt(active.sessionId), nonce: BigInt(active.authorizationNonce),
      sessionHash: sessionHash(ZERO_SESSION), deadline: BigInt(currentTime() + 600) };
    await run(kind === "stop" ? "지갑에서 팔로우 중지를 확인해 주세요." : "지갑에서 중지와 테스트 토큰 회수를 확인해 주세요.", async () => {
      const signature = await sign(connection.provider, connection.owner, { domain: actionDomain(active.account), types: actionTypes, primaryType: "OwnerAction", message });
      setPending("GIWA에서 요청을 처리하고 있습니다.");
      const result = await api<{ hash: Hex; pending: boolean }>("copy/relay", { kind, id: active.id, ...message, signature });
      setHash(result.hash);
      if (result.pending) {
        setNotice("요청을 보냈습니다. GIWA에서 확인되는 대로 계정 상태가 바뀝니다.");
        return;
      }
      setNotice(kind === "stop" ? "팔로우가 중지됐습니다." : "테스트 토큰을 연결한 지갑으로 보냈습니다.");
      setAccounts((await api<{ accounts: CopySubscription[] }>(accountPath(connection.owner, active.strategyId))).accounts);
    });
  }

  const linkWallet = <div className="copy-wallet-action">
    {wallets.length > 1 && <label>연결할 지갑<select value={walletId || wallets[0].id} onChange={event => setWalletId(event.target.value)} disabled={!!pending}>
      {wallets.map(wallet => <option key={wallet.id} value={wallet.id}>{wallet.name}</option>)}
    </select></label>}
    {wallets.length ? <button className="market-primary" disabled={!!pending} onClick={() => void connectWallet()}>지갑 연결</button> : <>
      <a className="market-primary" href={`https://link.metamask.io/dapp/${location.host}${location.pathname}`}>MetaMask 앱에서 열기</a>
      <a href="https://metamask.io/download" target="_blank" rel="noreferrer">브라우저 지갑 설치</a>
    </>}
  </div>;

  return <div className="strategy-market copy-market">
    <a className="market-skip" href="#copy-main">본문으로 건너뛰기</a>
    <header className="market-header">
      <div className="market-width copy-topbar">
        <a className="market-brand" href="/">Alpha<span>Pact</span></a>
        <nav aria-label="체험 메뉴"><a href="/copy" aria-current="page">전략 마켓</a><a href="/demo">성과보수 체험</a></nav>
        {connection && <span className="copy-connected">{shorten(connection.owner)} <button className="market-outline" disabled={!!pending}
          onClick={() => { setConnection(undefined); setAccounts(undefined); setError(""); setNotice(""); setHash(undefined); }}>연결 해제</button></span>}
      </div>
    </header>
    <main className="market-width copy-main" id="copy-main">
      <h1>전략 마켓</h1>
      <p className="copy-summary">제작자가 올린 전략을 고르고 내 한도를 정하면 GIWA에서 테스트 매수가 자동으로 나갑니다.</p>
      <p className="copy-testnet"><strong>GIWA Sepolia</strong><span>테스트 토큰으로 교환합니다. 가격은 1 tETH당 2,000 tUSD로 고정돼 있습니다.</span></p>
      {catalogError && <p role="alert" className="copy-error">{catalogError} <button className="market-outline" onClick={() => void loadCatalog().catch(() => setCatalogError("전략 목록을 불러오지 못했습니다."))}>다시 불러오기</button></p>}
      <div className="copy-grid">
        <section aria-labelledby="copy-list-title">
          <div className="copy-lineup copy-section-head">
            <h2 id="copy-list-title">등록된 전략</h2>
            <button className="market-outline" disabled={!!pending || !catalog?.ready} onClick={() => {
              setView("register"); setError(""); setNotice(""); setHash(undefined);
              requestAnimationFrame(() => detailsRef.current?.focus());
            }}>내 전략 등록</button>
          </div>
          {!catalog && !catalogError && <p role="status" className="copy-empty">전략을 불러오고 있습니다.</p>}
          {catalog && !catalog.strategies.length && <p className="copy-empty">{catalog.ready ? "등록된 전략이 없습니다." : "테스트넷 계약을 준비하고 있습니다."}</p>}
          <ul className="copy-list">
            {catalog?.strategies.map(strategy => <li key={strategy.id}><button
              className={strategy.id === selected?.id && view === "follow" ? "copy-selected" : undefined}
              aria-pressed={strategy.id === selected?.id && view === "follow"} disabled={!!pending} onClick={() => {
                setSelectedId(strategy.id); setView("follow"); setError(""); setNotice(""); setHash(undefined);
                requestAnimationFrame(() => detailsRef.current?.focus());
              }}>
              <span><strong>{strategy.name}</strong><small>제작자 {shorten(strategy.creator)}</small></span>
              <span><b>{dollars(strategy.amount)}</b><small>{Number(strategy.interval) / 60}분마다 매수</small></span>
            </button></li>)}
          </ul>
          {catalog?.before && <button className="market-outline copy-more" disabled={!!pending} onClick={() =>
            void loadCatalog(catalog.before!).catch(() => setCatalogError("이전 전략을 불러오지 못했습니다."))}>전략 더 보기</button>}
        </section>
        <section className="copy-details" ref={detailsRef} tabIndex={-1} aria-labelledby="copy-details-title">
          <h2 id="copy-details-title">{view === "register" ? "내 전략 등록" : selected?.name ?? "전략 팔로우"}</h2>
          {view === "register" ? <p>지정한 금액만큼 정해둔 간격마다 테스트 ETH를 사는 전략입니다.</p> : selected &&
            <p>{Number(selected.interval) / 60}분마다 최대 {dollars(selected.amount)}를 사용합니다. 내 한도가 더 낮으면 그 한도까지만 매수합니다.</p>}
          {!connection ? <div className="copy-connect"><p>{wallets.length ? "내 지갑을 연결하면 등록하거나 팔로우할 수 있습니다." : "등록하거나 팔로우하려면 이더리움 지갑이 필요합니다."}</p>{linkWallet}</div> :
            view === "register" ? <form className="copy-form" onSubmit={event => void register(event)}>
              <label>전략 이름<input name="name" required maxLength={36} placeholder="예시: ETH 정기 매수"/></label>
              <div className="copy-fields">
                <label>매수 금액 (tUSD)<input name="amount" type="number" min={10} max={2500} defaultValue={250} required/></label>
                <label>매수 간격 (분)<input name="interval" type="number" min={15} max={1440} defaultValue={15} required/></label>
              </div>
              <button className="market-primary" disabled={!!pending}>서명하고 등록</button>
            </form> : selected && (active ? <AccountDetails account={active} strategy={selected} pending={!!pending} control={kind => void control(kind)}/> :
              accounts === undefined || accountError ? <p role="status">{accountError || "이미 팔로우 중인지 확인하고 있습니다."}</p> :
              <form className="copy-form" key={selected.id} onSubmit={event => void follow(event)}>
                <div className="copy-fields">
                  <label>거래당 한도 (tUSD)<input name="trade" type="number" min={10} max={2500} defaultValue={100} required/></label>
                  <label>24시간 한도 (tUSD)<input name="day" type="number" min={10} max={5000} defaultValue={300} required/></label>
                </div>
                <label>매매 권한 기간<select name="hours" defaultValue="1"><option value="1">1시간</option><option value="6">6시간</option><option value="24">24시간</option></select></label>
                <p>테스트 예산 10,000 tUSD로 시작합니다. 팔로우하고 약 1~2분 뒤 첫 매수가 나갑니다.</p>
                <button className="market-primary" disabled={!!pending}>서명하고 팔로우</button>
              </form>)}
          <div className="copy-feedback" aria-live="polite">
            {pending && <p>{pending}</p>}
            {notice && !pending && <p>{notice}</p>}
            {hash && <ReceiptLink hash={hash}>요청 영수증 보기</ReceiptLink>}
          </div>
          {error && <p className="copy-error" role="alert">{error}</p>}
        </section>
      </div>
      <footer className="copy-footer">
        <a href={`${explorer}/address/${copyDeployment.market}`} target="_blank" rel="noreferrer">GIWA 전략 등록 계약</a>
        <span>이 체험에서는 성과보수를 정산하지 않습니다.</span>
      </footer>
    </main>
  </div>;
}
