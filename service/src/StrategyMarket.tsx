import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { performanceFeeRates, replaySettlements, settlementScenarios, type SettlementScenario } from "../performance-fee";
import { marketExamples, parseStrategyDraft, readCatalogStrategy, type CatalogStrategy } from "../strategy-catalog";
import { evidenceTransaction, testEvidence } from "./evidence";
import "./market.css";

const stages = ["팔로우 시작", "손실 구간", "원금 회복", "새 이익"] as const;
const capitalChoices = [1_000_000, 5_000_000, 10_000_000];
const catalogUrl = "/api/strategy-catalog";
const testnetApp = "https://alphapact-testnet.yhs98.workers.dev";
const numberFormat = new Intl.NumberFormat("ko-KR");
const won = (value: number | bigint) => `${numberFormat.format(value)}원`;
const signedWon = (value: bigint) => `${value > 0n ? "+" : ""}${won(value)}`;
const creatorRate = Number(performanceFeeRates.creator) / 100;
const platformRate = Number(performanceFeeRates.platform) / 100;
const feeRate = creatorRate + platformRate;

function Arrow({ external = false }: { external?: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={external ? "M6 18 18 6M8 6h10v10" : "M4 12h15m-6-6 6 6-6 6"}/></svg>;
}

function SettlementChart({ scenario, step }: { scenario: SettlementScenario; step: number }) {
  const points = settlementScenarios[scenario].balancesBps.map((value, index) => ({
    x: 8 + index * 168,
    y: 24 + (10_500 - value) / 15,
  }));
  const toPolyline = (subset: typeof points) => subset.map(({ x, y }) => `${x},${y}`).join(" ");
  const activePoints = points.slice(0, step + 1);
  const current = activePoints.at(-1)!;
  return <div className="market-chart" aria-hidden="true">
    <svg viewBox="0 0 520 142" preserveAspectRatio="none" focusable="false">
      <line x1="0" x2="520" y1={points[0].y} y2={points[0].y} className="market-chart-baseline"/>
      <line x1="0" x2="520" y1="131" y2="131" className="market-chart-grid"/>
      {points.map(({ x }) => <line key={x} x1={x} x2={x} y1="14" y2="131" className="market-chart-grid"/>)}
      <polyline points={toPolyline(points)} className="market-chart-preview"/>
      {activePoints.length > 1 && <>
        <polygon points={`8,131 ${toPolyline(activePoints)} ${current.x},131`} className="market-chart-fill"/>
        <polyline points={toPolyline(activePoints)} className="market-chart-line"/>
      </>}
      {points.map(({ x, y }, index) => <circle key={x} cx={x} cy={y} r="4.5" className={index === step ? "market-chart-current" : index < step ? "market-chart-reached" : "market-chart-future"}/>)}
    </svg>
    <div className="market-chart-labels">{stages.map((label, index) => <span key={label} className={index === step ? "is-current" : undefined}>{label}</span>)}</div>
  </div>;
}

export default function StrategyMarket() {
  const [customStrategies, setCustomStrategies] = useState<CatalogStrategy[]>([]);
  const [selectedId, setSelectedId] = useState(marketExamples[0].id);
  const [capital, setCapital] = useState(capitalChoices[2]);
  const [step, setStep] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [registration, setRegistration] = useState(false);
  const [posting, setPosting] = useState(false);
  const [notice, setNotice] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const playRef = useRef<HTMLButtonElement>(null);
  const strategies = [...marketExamples, ...customStrategies];
  const selected = strategies.find(strategy => strategy.id === selectedId) ?? marketExamples[0];
  const lastStep = stages.length - 1;
  const currentStep = Math.max(step, 0);
  const points = useMemo(() => replaySettlements(BigInt(capital), selected.scenario), [capital, selected.scenario]);
  const current = points[currentStep];
  const stepNotes = [
    "가상 잔액으로 시작합니다. 다음 구간부터 순이익을 계산합니다.",
    "계정에 누적 손실이 있어 성과보수는 0원입니다.",
    "원금까지 회복했습니다. 새 순이익이 없어 성과보수는 0원입니다.",
    `새 순이익 ${won(current.eligibleProfit)}에만 성과보수를 계산했습니다.`,
  ];

  useEffect(() => {
    const request = new AbortController();
    void fetch(catalogUrl, { signal: request.signal }).then(async response => {
      const catalog = await response.json() as { strategies?: unknown };
      if (!response.ok || !Array.isArray(catalog.strategies)) return;
      const listed = catalog.strategies.map(readCatalogStrategy).filter((strategy): strategy is CatalogStrategy => !!strategy);
      setCustomStrategies(current => current.concat(listed.filter(strategy => !current.some(item => item.id === strategy.id))));
    }).catch(() => {
      // Keep the two built-in scenarios available if the public catalog is down.
    });
    return () => request.abort();
  }, []);

  useEffect(() => {
    if (!playing || step < 0 || step >= lastStep) return;
    const timer = window.setTimeout(() => {
      setStep(step + 1);
      if (step + 1 === lastStep) setPlaying(false);
    }, 3_600);
    return () => window.clearTimeout(timer);
  }, [lastStep, playing, step]);

  useEffect(() => {
    if (registration) titleRef.current?.focus();
  }, [registration]);

  function reset() {
    setPlaying(false);
    setStep(-1);
  }

  function selectStrategy(id: string) {
    if (id === selectedId) return;
    setSelectedId(id);
    reset();
  }

  function nextStep() {
    if (step < 0) {
      setStep(0);
      setPlaying(true);
      return;
    }
    setPlaying(false);
    setStep(step === lastStep ? -1 : step + 1);
  }

  function togglePlayback() {
    if (step === lastStep) setStep(0);
    setPlaying(!playing);
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (posting) return;
    const draft = parseStrategyDraft(Object.fromEntries(new FormData(event.currentTarget)));
    if (!draft) {
      setNotice("전략 이름, 제작자 이름과 매매 규칙을 확인하세요.");
      return;
    }
    setPosting(true);
    setNotice("");
    try {
      const response = await fetch(catalogUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json() as { strategy?: unknown; error?: string };
      const strategy = readCatalogStrategy(result.strategy);
      if (!response.ok || !strategy) {
        setNotice(result.error ?? "등록 결과를 확인하지 못했습니다. 같은 내용으로 다시 시도해 주세요.");
        return;
      }
      setCustomStrategies(current => [strategy, ...current.filter(item => item.id !== strategy.id)]);
      setSelectedId(strategy.id);
      reset();
      setRegistration(false);
      setNotice(`${strategy.name} 전략을 모의 마켓에 등록했습니다.`);
      document.getElementById("market-terminal")?.scrollIntoView({ block: "start" });
      playRef.current?.focus({ preventScroll: true });
    } catch {
      setNotice("전략 등록 서버에 연결할 수 없습니다. 입력을 유지했으니 잠시 후 다시 시도해 주세요.");
    } finally {
      setPosting(false);
    }
  }

  return <div className="strategy-market">
    <a className="market-skip" href="#market-main">본문으로 건너뛰기</a>
    <header className="market-header">
      <div className="market-width market-nav">
        <a className="market-brand" href="/" aria-label="AlphaPact 홈">Alpha<span>Pact</span></a>
        <nav aria-label="마켓 메뉴">
          <a aria-current="page" href="#strategies">전략 마켓</a>
          <a href="#giwa-record">GIWA 테스트 기록</a>
        </nav>
        <a className="market-outline" href="/copy">GIWA 전략 마켓 <Arrow/></a>
      </div>
    </header>

    <main className="market-width" id="market-main">
      <section className="market-hero" aria-labelledby="market-title">
        <div className="market-intro">
          <h1 id="market-title">전략은 직접 고르고,<br/>보수는 이익에서.</h1>
          <p>제작자가 올린 매매 규칙을 내 계정에서 따라갑니다. 성과보수는 이전 손실을 다 메우고 새로 번 금액에서만 나눕니다.</p>
          <a href="#strategies" className="market-primary">전략 둘러보기 <Arrow/></a>
          <small>모의 체험에서는 지갑 연결과 결제가 필요 없습니다.</small>
        </div>

        <section className="market-terminal" id="market-terminal" aria-labelledby="terminal-title">
          <div className="market-terminal-heading">
            <div><h2 id="terminal-title">성과보수 체험</h2><p>{selected.name}</p></div>
            <span className="market-mode">모의 정산</span>
          </div>
          <div className="market-figures">
            <div>
              <span>계정 가치</span>
              <strong>{won(current.equityAfterFee)}</strong>
            </div>
            <div>
              <span>이번 성과보수</span>
              <strong className="market-fee-amount">{won(current.fee)}</strong>
            </div>
          </div>
          <SettlementChart scenario={selected.scenario} step={currentStep}/>
          <p id="settlement-status" className="market-settlement-status" role="status">
            {step < 0 ? "가상 가격으로 손실, 회복, 정산을 차례로 확인하세요." : stepNotes[currentStep]}
          </p>
          <div className="market-controls">
            {step < 0 ? <label className="market-capital">모의 시작 금액
              <select value={capital} onChange={event => setCapital(Number(event.target.value))}>
                {capitalChoices.map(choice => <option value={choice} key={choice}>{won(choice)}</option>)}
              </select>
            </label> : <span className="market-starting">시작 금액 <strong>{won(capital)}</strong></span>}
            <div className="market-play">
              {step >= 0 && <button className="market-playback" onClick={togglePlayback}>{playing ? "일시 정지" : "자동 재생"}</button>}
              <button ref={playRef} className="market-advance" onClick={nextStep}>
                {step < 0 ? "모의 팔로우" : step === lastStep ? "다시 체험" : "다음 정산 시점"} <Arrow/>
              </button>
            </div>
          </div>
        </section>
      </section>

      {step > 0 && <section className="market-ledger" aria-labelledby="ledger-title">
        <div className="market-section-title">
          <div><h2 id="ledger-title">정산 내역</h2><p>순손익은 매매 비용을 반영한 시나리오 값입니다.</p></div>
          <span>새 순이익 중 {feeRate}%</span>
        </div>
        <ol className="market-ledger-list">
          {points.slice(1, currentStep + 1).map((entry, index) => <li key={stages[index + 1]}>
            <strong>{stages[index + 1]}</strong>
            <span>누적 순손익 <b>{signedWon(entry.cumulativeProfit)}</b></span>
            <span>성과보수 <b>{won(entry.fee)}</b></span>
          </li>)}
        </ol>
        {current.fee > 0 && <dl className="market-distribution">
          <div><dt>고객 몫 {100 - feeRate}%</dt><dd>{won(current.eligibleProfit - current.fee)}</dd></div>
          <div><dt>제작자 몫 {creatorRate}%</dt><dd>{won(current.creatorFee)}</dd></div>
          <div><dt>AlphaPact 몫 {platformRate}%</dt><dd>{won(current.platformFee)}</dd></div>
        </dl>}
      </section>}

      <section className="market-strategies" id="strategies" aria-labelledby="market-strategies-title">
        <div className="market-section-title">
          <div><h2 id="market-strategies-title">전략 마켓</h2><p>규칙을 고르고 같은 방식으로 성과보수를 시험하세요.</p></div>
          <button className="market-outline" aria-expanded={registration} aria-controls="market-registration" onClick={() => { setNotice(""); setRegistration(!registration); }}>{registration ? "등록 닫기" : "전략 등록"}</button>
        </div>
        <form id="market-registration" className="market-registration" hidden={!registration} onSubmit={register} aria-busy={posting}>
          <p>등록한 전략과 제작자 이름은 모의 마켓을 방문한 모든 사람에게 표시됩니다.</p>
          <label>전략 이름<input name="name" ref={titleRef} maxLength={36} required placeholder="예: 주간 ETH 분할 매수"/></label>
          <label>제작자 이름<input name="creator" maxLength={24} required placeholder="마켓에 표시할 이름"/></label>
          <label>매매 규칙<select name="scenario">
            {Object.entries(settlementScenarios).map(([id, scenario]) => <option key={id} value={id}>{scenario.name}</option>)}
          </select></label>
          <button className="market-primary" type="submit" disabled={posting}>{posting ? "등록 중" : "모의 마켓에 등록"}</button>
        </form>
        {notice && <p className="market-notice" role="status">{notice}</p>}
        <ul className="market-list">
          {strategies.map(strategy => <li key={strategy.id}>
            <div className="market-strategy-name"><strong>{strategy.name}</strong><span>{strategy.creator}</span></div>
            <span className="market-strategy-type">{settlementScenarios[strategy.scenario].name}</span>
            <a className="market-strategy-action" href="#market-terminal" onClick={() => selectStrategy(strategy.id)} aria-label={`${strategy.name} 정산 체험`}>체험하기 <Arrow/></a>
          </li>)}
        </ul>
      </section>

      <section className="market-proof" id="giwa-record" aria-labelledby="giwa-record-title">
        <div className="market-proof-copy"><h2 id="giwa-record-title">GIWA에 남은 자동 교환 기록</h2><p>테스트넷 앱에서는 GIWA 계약이 거래 권한과 한도를 검사합니다. 아래는 기존 자동 교환의 실제 테스트넷 트랜잭션입니다. 위 성과보수 체험은 가상 가격으로 계산됩니다.</p></div>
        <div className="market-proof-receipt">
          <span>GIWA Sepolia · {testEvidence.observedOn}</span>
          <strong>{testEvidence.swap.amountIn} {testEvidence.swap.tokenIn} <Arrow/> 약 {testEvidence.swap.amountOut} {testEvidence.swap.tokenOut}</strong>
          <a href={evidenceTransaction(testEvidence.records[1].hash)} target="_blank" rel="noreferrer">교환 트랜잭션 확인 <Arrow external/></a>
        </div>
      </section>
    </main>

    <footer className="market-width market-footer"><a className="market-brand" href="/">Alpha<span>Pact</span></a><a href="/about">서비스 안내</a><a href={`${testnetApp}/spot`}>업비트 현물 연결</a></footer>
  </div>;
}
