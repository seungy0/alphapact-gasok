import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { evidenceActivityPath, evidenceTransaction, testEvidence } from "./evidence";
import "./landing.css";

const rules = [
 { name: "ETH 균형 리밸런싱", short: "목표 비중에 맞춰 조정", description: "테스트 ETH와 테스트 USD의 목표 비중이 50:50인 규칙입니다.", trigger: "목표 비중에서 5%p 이상 벗어나면", action: "설정한 한도 안에서 매수·매도", fact: "최소 매매 간격", interval: "15분" },
 { name: "ETH 정기 분할 매수", short: "시간을 나누어 매수", description: "정해진 간격으로 테스트 USD를 나누어 ETH를 매수하는 규칙입니다.", trigger: "이전 매매 이후 4시간이 지나면", action: "한도와 잔액 안에서 최대 500 tUSD 매수", fact: "매매 간격", interval: "4시간" },
] as const;
const historyPanelId = "test-records";

function Arrow({ external = false, size = 18 }: { external?: boolean; size?: number }) {
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={external ? "M7 17 17 7M7 7h10v10" : "M4 12h16m-6-6 6 6-6 6"}/></svg>;
}

export default function Landing() {
 const [selected, setSelected] = useState<0 | 1>(0);
 const [view, setView] = useState<0 | 1>(() => location.hash === `#${historyPanelId}` ? 1 : 0);
 const preview = useRef<HTMLElement>(null);
 const tabs = useRef<(HTMLButtonElement | null)[]>([]);
 const rule = rules[selected];
 const start = `/app?strategy=${selected}`;

 useEffect(() => {
  if (location.hash === `#${historyPanelId}`) preview.current?.scrollIntoView({ block: "start" });
 }, []);

 function changeTab(event: KeyboardEvent<HTMLButtonElement>, index: 0 | 1) {
  const next = event.key === "ArrowLeft" || event.key === "ArrowRight" ? 1 - index : event.key === "Home" ? 0 : event.key === "End" ? 1 : undefined;
  if (next === undefined) return;
  event.preventDefault(); setView(next as 0 | 1); tabs.current[next]?.focus();
 }
 function showHistory() {
  setView(1);
  requestAnimationFrame(() => {
   preview.current?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion:reduce)").matches ? "auto" : "smooth" });
   tabs.current[1]?.focus({ preventScroll: true });
  });
 }

 return <div className="landing">
  <a className="lp-skip" href="#intro-main">본문으로 건너뛰기</a>
  <div className="lp-page">
   <header className="lp-header"><a className="lp-wordmark" href="/" aria-label="AlphaPact 홈">AlphaPact</a><nav aria-label="소개 메뉴"><a href="/spot">업비트 현물 연결</a><a href="#strategies">전략 둘러보기</a><a href="#how">사용 방법</a><a href="#evidence">거래 기록</a></nav><a className="lp-service-link" href="/app">서비스 열기</a></header>
   <main id="intro-main">
    <section className="lp-hero" aria-labelledby="intro-title"><h1 id="intro-title">내 지갑으로 시작하는 <span>자동매매.</span></h1><p>봇 설치나 거래소 API 키 없이 자동매매를 시험하세요.<br/>한도와 기간은 직접 정하고, 내 지갑으로 계정을 관리합니다.</p><div className="lp-hero-actions"><a className="lp-action" href={start}>전략 선택하기<Arrow/></a><button className="lp-action lp-secondary" onClick={showHistory}>테스트 기록 보기</button></div><a className="lp-upbit-link" href="/spot">업비트 현물 연결 · 주문 테스트<Arrow size={15}/></a><p className="lp-beta">GIWA 테스트넷 베타 · 현금 가치가 없는 테스트 토큰과 모의 교환시장을 사용합니다.</p></section>

    <section className="lp-product" id="strategies" aria-label="서비스 미리보기" ref={preview}>
     <div className="lp-product-bar"><strong>서비스 미리보기</strong><div className="lp-product-tabs" role="tablist" aria-label="미리보기 화면">{["전략", "거래 기록"].map((label, index) => <button key={label} id={`preview-tab-${index}`} role="tab" aria-selected={view === index} aria-controls={index === 0 ? "preview-panel-0" : historyPanelId} tabIndex={view === index ? 0 : -1} ref={element => { tabs.current[index] = element; }} onClick={() => setView(index as 0 | 1)} onKeyDown={event => changeTab(event, index as 0 | 1)}>{label}</button>)}</div><span>테스트넷</span></div>
     <div id="preview-panel-0" className="lp-tab-panel" role="tabpanel" aria-labelledby="preview-tab-0" hidden={view !== 0}>
      <div className="lp-product-body"><div className="lp-strategy-nav" aria-label="미리볼 전략">{rules.map((item, index) => <button key={item.name} aria-pressed={selected === index} onClick={() => setSelected(index as 0 | 1)}><strong>{item.name}</strong><span>{item.short}</span></button>)}</div>
       <div className="lp-strategy-pane"><div className="lp-rule-heading"><span className="lp-asset-symbol">ETH / USD</span><h2>{rule.name}</h2></div><p>{rule.description}</p><div className="lp-condition"><span>{rule.trigger}</span><Arrow size={20}/><span>{rule.action}</span></div><dl className="lp-rule-facts"><div><dt>{rule.fact}</dt><dd>{rule.interval}</dd></div><div><dt>테스트 교환 비용</dt><dd>0.30%</dd></div><div><dt>실행 시장</dt><dd>모의 교환시장</dd></div></dl><div className="lp-rule-footer"><a className="lp-service-link" href={start}>이 전략으로 시작</a><span>한도 설정과 지갑 서명은 서비스에서 진행합니다.</span></div>
        {selected === 0 ? <div className="lp-record-sample"><header><strong>완료된 테스트 교환</strong><span>{testEvidence.observedOn} 기능 테스트 기록</span><a href={evidenceTransaction(testEvidence.records[1].hash)} target="_blank" rel="noreferrer">원본 확인<Arrow external size={14}/></a></header><div className="lp-swap-amounts"><div><b>{testEvidence.swap.amountIn}</b><span>{testEvidence.swap.tokenIn}</span></div><Arrow/><div><b>약 {testEvidence.swap.amountOut}</b><span>{testEvidence.swap.tokenOut}</span></div></div><p className="lp-sample-note">운영자가 진행한 과거 테스트입니다. 현재 시세나 투자 실적을 뜻하지 않습니다.</p></div> : <div className="lp-record-sample"><header><strong>분할 매수 규칙</strong><span>매수 시점을 나누어 실행</span></header><div className="lp-dca-rule"><strong>4시간 간격</strong><span>회당 최대 500 tUSD</span></div><p className="lp-sample-note">남은 잔액·집행 한도·가격 조건이 충족될 때 실행합니다.</p></div>}
       </div>
      </div>
     </div>
     <div className="lp-history-pane lp-tab-panel" id={historyPanelId} role="tabpanel" aria-labelledby="preview-tab-1" hidden={view !== 1}>
      <div className="lp-history-heading"><h2>완료된 테스트 기록</h2><span>운영자 기능 테스트 · {testEvidence.observedOn}</span></div>
      <div className="lp-table-wrap" tabIndex={0} aria-label="테스트 거래표, 좁은 화면에서는 가로로 스크롤할 수 있습니다">
       <table className="lp-history">
        <thead><tr><th scope="col">처리</th><th scope="col">내용</th><th scope="col">트랜잭션</th></tr></thead>
        <tbody>{testEvidence.records.map(record => (
         <tr key={record.hash}>
          <td>{record.label}</td>
          <td>{record.detail}</td>
          <td><a href={evidenceTransaction(record.hash)} target="_blank" rel="noreferrer" aria-label={`${record.label} 트랜잭션 원본`}>{record.hash.slice(0, 6)}…{record.hash.slice(-4)}<Arrow external size={13}/></a></td>
         </tr>
        ))}</tbody>
       </table>
      </div>
      <p className="lp-table-hint">표를 옆으로 밀어 거래 원본을 확인할 수 있습니다.</p>
      <p className="lp-history-caption">성공한 테스트 거래의 원본입니다. 투자 실적이나 현금 수익을 뜻하지 않습니다.</p>
     </div>
     <div className="lp-product-foot"><span>현재 실행 가능한 두 기본 규칙을 살펴볼 수 있습니다.</span><span>수익성 검증 전 · 실제 자금 사용 전 단계</span></div>
    </section>

    <section className="lp-journey" id="how"><h2>전략 선택부터 회수까지.</h2><p className="lp-journey-intro">봇을 설치하거나 거래소 API 키를 입력할 필요 없이 시험할 수 있습니다.</p><div className="lp-steps"><article className="lp-step"><span>1. 시작</span><h3>규칙과 한도를 확인합니다.</h3><p>전략을 선택하고 1회·24시간 집행 한도와 기간을 정합니다. 지갑에서 내용을 확인한 뒤 서명합니다.</p></article><article className="lp-step"><span>2. 실행</span><h3>거래가 일어나면 기록을 봅니다.</h3><p>조건이 맞으면 서비스가 테스트 교환을 실행합니다. 실제 토큰 수량과 트랜잭션을 확인할 수 있습니다.</p></article><article className="lp-step"><span>3. 중지·회수</span><h3>계정은 내 지갑으로 관리합니다.</h3><p>매매 권한을 끄거나 남은 테스트 토큰의 회수를 요청합니다. 집행 한도는 손실을 보장하는 상한이 아닙니다.</p></article></div></section>

    <section className="lp-practical" aria-labelledby="practical-title"><div><h2 id="practical-title">무료 테스트 토큰으로<br/>직접 확인하세요.</h2><p>현재는 GIWA Sepolia의 기능을 체험하는 베타입니다. 시작부터 거래 내역과 회수까지 확인할 수 있습니다.</p><a className="lp-service-link" href={start}>테스트넷 서비스 열기</a></div><div className="lp-faq"><details><summary>지금 실제 돈으로 투자하나요?</summary><p>현금 가치가 없는 tUSD·tETH를 모의 시장에서 교환합니다. 트랜잭션은 실제로 기록되지만, 실제 ETH를 매수하거나 현금 수익을 얻는 서비스는 아닙니다.</p></details><details><summary>이용 비용은 얼마인가요?</summary><p>현재 베타는 구독료와 성과보수를 받지 않습니다. 기본 흐름의 테스트 가스를 지원하며, 모의 교환에 0.30% 비용을 테스트 토큰으로 반영합니다. 장애 시 직접 회수 경로에는 별도 테스트 ETH가 필요합니다.</p></details><details><summary>GIWA는 무엇을 검사하나요?</summary><p>계정의 소유권·허용 거래·집행 한도·기간을 계약에서 검사합니다. 원본 시세나 전략 판단의 진위까지 증명하지는 않습니다. 현재 테스트 가격은 서비스가 공개 시세를 참조해 게시합니다.</p></details><details><summary>서비스가 멈추면 어떻게 하나요?</summary><p>소유자가 계약을 직접 호출해 보유 토큰 회수를 요청하는 경로가 있습니다. 체인 장애나 토큰 전송 제한을 해결하거나 원금을 보전하는 기능은 아닙니다. <a href="/help#direct-recovery">직접 회수 안내</a></p></details></div></section>

    <section className="lp-evidence" id="evidence"><div><h2>체인에 남은 기능 테스트 기록</h2><p>{testEvidence.observedOn} 확인 · 계정 생성, 교환, 중지와 회수의 성공 기록입니다.</p></div><div className="lp-evidence-links"><a href={evidenceActivityPath}>전체 내역 보기<Arrow external size={14}/></a><a href={`${testEvidence.explorer}/address/${testEvidence.account}`} target="_blank" rel="noreferrer">계정 원본 보기<Arrow external size={14}/></a></div></section>
   </main>
   <footer className="lp-footer"><a className="lp-wordmark" href="/">AlphaPact</a><span>GIWA 테스트넷 베타 · 테스트 토큰은 현금 가치가 없습니다.</span><a href="/help">이용 안내</a><a href="/accounts">내 계정</a></footer>
  </div>
 </div>;
}
