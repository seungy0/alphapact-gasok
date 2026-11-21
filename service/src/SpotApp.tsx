import { useEffect, useRef, useState } from "react";
import { getAddress, isAddress, toHex, type Address, type Hex } from "viem";
import { discoverWallets, friendlyError, type Provider, type WalletOption } from "./client";
import { DEFAULT_SPOT_RULE, type SpotAction, type SpotQuote, type SpotRule, type SpotState } from "../spot-domain";
import { spotCheckpointDeployment } from "../spot-chain";
import SpotProof from "./SpotProof";
import "./spot.css";

type Status = { configured: boolean; anchorReady: boolean; execution: string; liveOrders: boolean };
const won = (value: number) => `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(value)}원`;
const time = (value: string | number) => new Date(value).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" });
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const labels: Record<string, string> = { RULE_SAVED: "규칙 저장", ACCOUNT_SNAPSHOT: "계좌 조회", VALIDATION_REQUESTED: "주문 테스트 요청", VALIDATION_PASSED: "주문 테스트 통과", VALIDATION_UNCONFIRMED: "주문 테스트 확인 필요" };
async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/spot/${path}`, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined, cache: "no-store", signal: signal ?? AbortSignal.timeout(70_000) });
  const result = await response.json().catch(() => { throw new Error("서버 응답을 읽지 못했습니다. 다시 시도해 주세요."); }) as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "요청을 완료하지 못했습니다."); return result;
}
function Arrow() { return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>; }

export default function SpotApp() {
  const [status, setStatus] = useState<Status>();
  const [statusError, setStatusError] = useState<string>();
  const [marketQuote, setQuote] = useState<SpotQuote>();
  const [marketError, setMarketError] = useState<string>();
  const [draft, setDraft] = useState<SpotRule>({ ...DEFAULT_SPOT_RULE });
  const quote = marketQuote?.market === draft.market ? marketQuote : undefined;
  const [state, setState] = useState<SpotState>();
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [provider, setProvider] = useState<Provider>();
  const [owner, setOwner] = useState<Address>();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [walletError, setWalletError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [clock, setClock] = useState(() => Date.now());
  const generation = useRef(0);
  const busy = useRef(false);
  const walletDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => discoverWallets(setWallets), []);
  useEffect(() => {
    const controller = new AbortController();
    api<Status>("status", undefined, controller.signal).then(setStatus).catch(failure => { if (!controller.signal.aborted) setStatusError(friendlyError(failure)); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => api<{ quote: SpotQuote }>(`market?market=${draft.market}`, undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) { setQuote(result.quote); setClock(Date.now()); setMarketError(undefined); } })
      .catch(failure => { if (!controller.signal.aborted) setMarketError(friendlyError(failure)); });
    void refresh(); const timer = setInterval(() => { setClock(Date.now()); void refresh(); }, 30_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [draft.market]);
  useEffect(() => {
    if (!provider) return;
    const changed = () => { ++generation.current; setOwner(undefined); setProvider(undefined); setState(undefined); setNotice(undefined); setError("지갑 계정이 변경됐습니다. 사용할 계정으로 다시 연결해 주세요."); };
    provider.on?.("accountsChanged", changed); provider.on?.("disconnect", changed);
    return () => { provider.removeListener?.("accountsChanged", changed); provider.removeListener?.("disconnect", changed); };
  }, [provider]);
  async function connectWallet(wallet: WalletOption) {
    if (busy.current) return; busy.current = true; setPending("지갑 연결을 확인해 주세요."); setError(undefined); setWalletError(undefined);
    try {
      const accounts = await wallet.provider.request({ method: "eth_requestAccounts" }) as string[];
      if (!accounts[0] || !isAddress(accounts[0])) throw new Error("연결할 지갑 주소를 확인하지 못했습니다.");
      ++generation.current; setState(undefined); setOwner(getAddress(accounts[0])); setProvider(wallet.provider); setNotice(undefined); walletDialog.current?.close();
    } catch (failure) { const message = friendlyError(failure); setError(message); setWalletError(message); } finally { busy.current = false; setPending(undefined); }
  }
  async function perform(kind: SpotAction) {
    if (busy.current) return;
    if (!provider || !owner) { walletDialog.current?.showModal(); return; }
    busy.current = true; const epoch = generation.current; setError(undefined); setNotice(undefined);
    try {
      const current = await provider.request({ method: "eth_accounts" }) as string[];
      if (current[0]?.toLowerCase() !== owner.toLowerCase()) throw new Error("소유자 지갑을 다시 연결해 주세요.");
      setPending("요청 내용을 지갑에서 확인하고 서명해 주세요.");
      const challenge = await api<{ nonce: string; message: string }>("challenge", { owner, kind, payload: kind === "save-rule" ? draft : {} });
      if (epoch !== generation.current) return;
      const signature = await provider.request({ method: "personal_sign", params: [toHex(challenge.message), owner] }) as Hex;
      if (epoch !== generation.current) return;
      setPending(kind === "anchor" ? "GIWA 거래 확정을 기다리고 있습니다." : kind === "sync" ? "업비트에서 계좌를 조회하고 있습니다." : kind === "validate" ? "업비트 주문 생성 테스트를 진행하고 있습니다." : "요청을 처리하고 있습니다.");
      const result = await api<{ state?: SpotState; archive?: unknown }>("command", { nonce: challenge.nonce, signature });
      if (epoch !== generation.current) return;
      if (result.archive) {
        const url = URL.createObjectURL(new Blob([JSON.stringify(result.archive, null, 2)], { type: "application/json" }));
        const link = document.createElement("a"); link.href = url; link.download = `alphapact-upbit-spot-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }
      if (result.state) { setState(result.state); if (kind === "read" || kind === "save-rule") setDraft(result.state.rule); }
      const messages: Record<SpotAction, string> = { read: "내 연결 기록을 불러왔습니다.", sync: "업비트 계좌를 조회했습니다.", "save-rule": "정기 매수 규칙을 저장했습니다. 자동 실주문은 아직 실행하지 않습니다.", validate: "주문 생성 테스트를 통과했습니다. 실제 주문과 체결은 발생하지 않았습니다.", anchor: "기록 해시를 GIWA에 게시했습니다.", export: "개인 기록을 내려받았습니다. 잔고와 주문 정보가 포함되어 있습니다." };
      setNotice(messages[kind]);
    } catch (failure) { if (epoch === generation.current) setError(friendlyError(failure)); }
    finally { busy.current = false; setPending(undefined); }
  }
  const dirty = state ? JSON.stringify(draft) !== JSON.stringify(state.rule) : true;
  const canConnect = !!status?.configured;
  const stale = !quote || clock - quote.observedAt > 60_000;
  const snapshot = state?.snapshot;
  const krw = snapshot?.assets.find(asset => asset.currency === "KRW");
  const stateLoaded = !!state;
  const ready = canConnect && !!owner && !pending;
  return <div className="spot-app">
    <a className="skip-link" href="#spot-main">본문 바로가기</a>
    <header className="spot-header"><a className="spot-brand" href="/">AlphaPact</a><span className="spot-venue">업비트 현물</span><nav aria-label="서비스 전환"><a href="/app">GIWA 테스트넷</a><a href="#spot-setup">연결 안내</a></nav><button className="primary" disabled={!!pending} onClick={() => walletDialog.current?.showModal()}>{owner ? short(owner) : "지갑 연결"}</button></header>
    <main id="spot-main" className="spot-main">
      <div className="spot-heading"><div><h1>업비트 현물 연결</h1><p>계좌를 조회하고, 정기 매수 규칙으로 주문 가능 여부를 점검하세요.</p></div><span className="spot-phase">계좌 조회 · 주문 테스트 단계</span></div>
      {statusError && <p role="alert" className="error-message">연결 상태를 확인하지 못했습니다. {statusError} <button className="text-button" onClick={() => location.reload()}>다시 불러오기</button></p>}
      {status && !canConnect && <div className="spot-setup-notice" role="status"><strong>계좌 연결 설정이 필요합니다.</strong><p>고정 IP 서버에 업비트 API 키와 소유자 지갑을 등록하면 계좌 조회와 주문 테스트가 열립니다.</p><div className="spot-proof-actions"><a href="#spot-proof">GIWA 샘플 기록 확인 <Arrow/></a><a href="#spot-setup">등록할 항목 보기 <Arrow/></a></div></div>}
      {error && <div className="error-message" role="alert">{error}<button className="icon-button" aria-label="오류 닫기" onClick={() => setError(undefined)}>닫기</button></div>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {pending && <p className="pending-message" role="status">{pending}</p>}
      <div className="spot-market"><div><strong>{draft.market === "KRW-BTC" ? "비트코인" : "이더리움"}</strong><span>{draft.market}</span></div><strong className="spot-price">{quote ? won(quote.priceWon) : "시세 확인 중"}</strong><span>{quote ? `${time(quote.observedAt)}${stale ? " · 갱신 대기" : " 기준"}` : "업비트 공개 시세"}</span><a href={`https://upbit.com/exchange?code=CRIX.UPBIT.${draft.market}`} target="_blank" rel="noreferrer">업비트에서 보기</a></div>
      {marketError && <p className="spot-inline-error" role="status">{marketError} 마지막 시세는 주문 점검에 사용하지 않습니다.</p>}
      <div className="spot-grid">
        <section className="spot-strategy" aria-labelledby="spot-strategy-title"><h2 id="spot-strategy-title">정기 분할 매수</h2><p>24시간 간격으로 정한 금액을 매수하는 현물 규칙입니다. 지금은 규칙 저장과 다음 주문의 생성 가능 여부를 점검합니다.</p>
          <form onSubmit={event => { event.preventDefault(); void perform("save-rule"); }}><div className="spot-fields"><label>거래 종목<select value={draft.market} disabled={!!pending} onChange={event => setDraft({ ...draft, market: event.target.value as SpotRule["market"] })}><option value="KRW-BTC">비트코인 / 원화</option><option value="KRW-ETH">이더리움 / 원화</option></select></label><label>회당 매수 금액<select value={draft.orderWon} disabled={!!pending} onChange={event => setDraft({ ...draft, orderWon: Number(event.target.value) })}><option value={5_000}>5,000원</option><option value={10_000}>10,000원</option></select></label></div>
            <dl className="spot-rule-facts"><div><dt>매수 간격</dt><dd>24시간</dd></div><div><dt>거래 범위</dt><dd>보유 원화 안에서 현물 매수</dd></div><div><dt>현재 실행 단계</dt><dd>주문 생성 테스트</dd></div></dl><button className="primary" disabled={!canConnect || !!pending} type="submit">{owner ? "규칙 저장" : "지갑 연결하고 규칙 저장"}<Arrow/></button>{state && !dirty && <span className="spot-saved">저장된 규칙과 같습니다.</span>}</form>
          <div className="spot-test-action"><h3>다음 주문 점검</h3><p>저장된 규칙과 최근 조회한 원화 잔고로 업비트 주문 테스트를 요청합니다. 실제 매수나 수수료 지불은 발생하지 않습니다.</p><button className="secondary" disabled={!ready || !snapshot || dirty || stale || snapshot.mode === "READ_ONLY"} onClick={() => void perform("validate")}>주문 생성 테스트</button><small>{dirty ? "규칙을 저장한 뒤 계좌를 조회해 주세요." : !snapshot ? "계좌를 먼저 조회해 주세요." : snapshot.mode === "READ_ONLY" ? "현재 실행기는 조회 전용입니다." : "수수료를 포함한 주문 가능 여부는 업비트에서 검사합니다."}</small></div>
        </section>
        <section className="spot-account" aria-labelledby="spot-account-title"><div className="spot-section-heading"><h2 id="spot-account-title">내 업비트 계좌</h2><button className="text-button" disabled={!ready} onClick={() => void perform("sync")}>계좌 조회</button></div>
          {snapshot ? <><dl className="spot-balances"><div><dt>사용 가능한 원화</dt><dd>{krw ? won(Number(krw.available)) : won(0)}</dd></div><div><dt>주문에 묶인 원화</dt><dd>{krw ? won(Number(krw.locked)) : won(0)}</dd></div></dl><p className="spot-meta">{time(snapshot.syncedAt)} 조회 · {snapshot.mode === "READ_ONLY" ? "조회 전용" : "주문 테스트 가능"}</p><div className="spot-asset-list">{snapshot.assets.filter(asset => asset.currency !== "KRW").map(asset => <div key={asset.currency}><span>{asset.currency}</span><span>{asset.available} <small>사용 가능</small></span><span>{asset.locked} <small>주문 중</small></span></div>)}</div></> : <div className="spot-empty"><h3>{owner ? "등록된 계좌를 조회하세요." : "소유자 지갑으로 연결하세요."}</h3><p>잔고와 주문 내역은 등록된 지갑의 서명을 확인한 뒤 불러옵니다. 계좌 연결 전에는 금액을 표시하지 않습니다.</p>{owner ? <button className="secondary" disabled={!ready} onClick={() => void perform("read")}>내 연결 기록 불러오기</button> : <button className="secondary" disabled={!!pending} onClick={() => walletDialog.current?.showModal()}>지갑 연결</button>}</div>}
          <p className="spot-account-note">자산은 업비트 계좌에 있습니다. 이 화면의 지갑은 연결 소유자 확인과 기록 게시 승인에 사용합니다.</p>
        </section>
      </div>
      <section className="spot-records" aria-labelledby="spot-record-title"><div className="spot-section-heading"><div><h2 id="spot-record-title">연결 점검 기록</h2><p>규칙 변경과 계좌 조회, 주문 테스트 결과를 순서대로 남깁니다.</p></div><button className="secondary" disabled={!ready || !state?.count} onClick={() => void perform("export")}>개인 기록 내려받기</button></div>
        {state?.records.length ? <div className="spot-table-wrap" tabIndex={0} aria-label="점검 기록 표"><table><thead><tr><th scope="col">순서</th><th scope="col">처리</th><th scope="col">시각</th><th scope="col">기록 해시</th></tr></thead><tbody>{state.records.map(record => <tr key={record.hash}><td>{record.sequence}</td><td>{labels[record.kind] ?? record.kind}</td><td>{time(record.at)}</td><td><code>{short(record.hash)}</code></td></tr>)}</tbody></table></div> : <p className="spot-empty-line">{stateLoaded ? "저장된 점검 기록이 없습니다." : "지갑을 연결하고 내 연결 기록을 불러오면 표시됩니다."}</p>}
        {state?.records.length ? <p className="spot-table-hint">표를 옆으로 밀면 기록 해시까지 볼 수 있습니다.</p> : null}<div className="spot-anchor"><div><h3>GIWA에 기록 해시 보관</h3><p>원본 기록의 지문을 게시해, 나중에 내려받은 기록의 변경 여부를 대조합니다. 잔고·주문 번호·지갑 주소는 게시하지 않습니다.</p><p className="spot-meta">사후 기록의 해시 보관입니다. 업비트 원본의 진위, 모든 거래의 수집, 매매 전 예측이나 수익성을 증명하지 않습니다.</p>{state?.anchor && <a href={`https://sepolia-explorer.giwa.io/tx/${state.anchor.transactionHash}`} target="_blank" rel="noreferrer">{state.anchor.sequence}번까지 게시됨 · 거래 원본 보기</a>}</div><button className="secondary" disabled={!ready || !status?.anchorReady || !state?.count || state.anchor?.sequence === state.count} onClick={() => void perform("anchor")}>기록 해시 게시</button></div>
      </section>
      {snapshot && <section className="spot-records"><h2>최근 업비트 주문</h2><p>허용된 종목별 최근 7일 내 종료 주문 최대 20건과 미체결 주문 첫 100건입니다. 이 서비스 외에서 만든 주문도 포함될 수 있습니다.</p>{snapshot.orders.length ? <div className="spot-table-wrap" tabIndex={0} aria-label="업비트 주문 표"><table><thead><tr><th>종목</th><th>방향</th><th>상태</th><th>체결 수량</th><th>지불 수수료</th></tr></thead><tbody>{snapshot.orders.map(order => <tr key={order.uuid}><td>{order.market}</td><td>{order.side === "bid" ? "매수" : "매도"}</td><td>{({ wait: "대기", watch: "예약 대기", done: "체결 완료", cancel: "취소·일부 체결 가능" } as Record<string, string>)[order.state] ?? "확인 필요"}</td><td>{order.executedVolume}</td><td>{order.paidFee} KRW</td></tr>)}</tbody></table></div> : <p className="spot-empty-line">이번 조회 범위에 주문이 없습니다.</p>}{snapshot.orders.length ? <p className="spot-table-hint">표를 옆으로 밀면 체결 수량과 수수료를 볼 수 있습니다.</p> : null}</section>}
      <SpotProof />
      <section className="spot-setup" id="spot-setup"><h2>계좌 연결 안내</h2><p>첫 파일럿은 등록된 소유자 한 명의 계좌로 진행합니다. API 키와 비밀키는 고정 IP 서버에서만 보관합니다.</p><ol><li>업비트 API 키에 자산조회·주문조회 권한을 설정하고, 고정 IP 서버의 주소만 허용합니다. 출금 권한은 해제합니다.</li><li>서버에 키를 등록하고 조회 전용으로 시작합니다. 서비스에는 실행기 주소·연결용 비밀값·소유자 지갑 주소를 설정합니다.</li><li>계좌 조회를 확인한 뒤 주문하기 권한과 주문 테스트 모드를 설정합니다. 이 연결 경로는 실제 주문을 보내지 않습니다.</li></ol><details><summary>GIWA를 쓰는 범위</summary><p>업비트 현물 연결에서는 기록 해시를 보관합니다. 거래 한도와 API 권한은 거래소·실행기에서 관리합니다. 기존 GIWA 테스트넷의 계정 생성·권한 중지·토큰 회수는 별도 체험으로 유지합니다.</p><a href="/app">GIWA 테스트넷 열기</a>{spotCheckpointDeployment.ready && <p><a href={`https://sepolia-explorer.giwa.io/address/${spotCheckpointDeployment.contract}`} target="_blank" rel="noreferrer">기록 계약 확인</a></p>}</details><details><summary>실제 자동매매는 언제 시작하나요?</summary><p>현재 단계는 계좌 연결과 주문 생성 테스트입니다. 실계좌 권한·잔고·집행 한도·실패 복구를 확인한 뒤 실제 자동매매를 별도로 활성화해야 합니다. 저장한 24시간 규칙은 아직 자동 실주문을 예약하지 않습니다.</p></details></section>
    </main><footer className="spot-footer"><span>AlphaPact · 업비트 현물 파일럿</span><a href="/app">GIWA 테스트넷 체험</a></footer>
    <dialog ref={walletDialog} className="wallet-dialog" aria-labelledby="spot-wallet-title"><div className="spot-section-heading"><h2 id="spot-wallet-title">소유자 지갑 연결</h2><button className="icon-button" aria-label="지갑 선택 닫기" disabled={!!pending} onClick={() => walletDialog.current?.close()}>닫기</button></div><p>등록된 업비트 연결의 소유자를 확인합니다. 비밀키나 복구 문구를 입력하지 않습니다.</p>{walletError && <p className="error-message" role="alert">{walletError}</p>}{wallets.length ? wallets.map(wallet => <button className="spot-wallet-option" key={wallet.id} disabled={!!pending} onClick={() => void connectWallet(wallet)}>{wallet.name}<Arrow/></button>) : <p>설치된 브라우저 지갑을 찾지 못했습니다. MetaMask 등 지갑 앱의 브라우저에서 이 주소를 열어 주세요.</p>}</dialog>
  </div>;
}
