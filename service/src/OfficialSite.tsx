import { formatUnits, type Hex } from "viem";
import proof from "../public/evidence/copy-market.json";
import { evidenceTransaction } from "./evidence";
import "./official.css";

const app = "https://alphapact-testnet.yhs98.workers.dev";
const source = "https://github.com/seungy0/alphapact-gasok/tree/codex/phase4-review";
const directRecovery = evidenceTransaction("0x13a83105a9ffea16c05d3cdc283ed33d23ae78241ab76a2d1fcbcef4e20b2386");
const [first, second] = proof.followers;
const explorerTx = (hash: string) => evidenceTransaction(hash as Hex);

function Direction({ outward = false }: { outward?: boolean }) {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
    <path d={outward ? "M6 18 18 6M8 6h10v10" : "M4 12h16m-7-6 6 6-6 6"}/>
  </svg>;
}

function Wordmark() {
  return <a className="official-wordmark" href="/" aria-label="AlphaPact 홈">
    <svg aria-hidden="true" width="32" height="32" viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="7" fill="#153d36"/>
      <path d="M7.5 21.5 15 10l2.7 4.2M15.9 21.5 23.4 10M11 17h5.1M19 17h5.5" stroke="#cbefc2" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
    AlphaPact
  </a>;
}

function SwapReceipt() {
  return <aside className="official-receipt" aria-labelledby="official-receipt-title">
    <div className="official-receipt-head">
      <div><span>GIWA Sepolia</span><h2 id="official-receipt-title">두 팔로워의 자동 매수</h2></div>
      <span className="official-record-state"><i/> 확인 완료</span>
    </div>
    <div className="official-receipt-swap">
      <div><span>팔로워 A</span><strong>{formatUnits(BigInt(first.spent), 6)}<small> tUSD</small></strong></div>
      <div><span>팔로워 B</span><strong>{formatUnits(BigInt(second.spent), 6)}<small> tUSD</small></strong></div>
    </div>
    <div className="official-receipt-foot">
      <span>같은 전략, 각자의 거래 한도</span>
      <a href="#proof">영수증 보기 <Direction/></a>
    </div>
  </aside>;
}

const walkthrough = [
  { title: "제작자가 전략을 올립니다", detail: "지갑으로 서명해 매수 금액과 간격을 등록하면 전략 마켓에 공개됩니다." },
  { title: "이용자가 한도를 정합니다", detail: "거래당 한도와 24시간 한도를 정해 한 번 서명하면 자동 매수가 시작됩니다." },
  { title: "거래 결과를 확인합니다", detail: "테스트 교환의 원본을 열거나 언제든 매매를 중지하고 보유 토큰을 회수할 수 있습니다." },
];

export default function OfficialSite() {
  return <div className="official-site">
    <a className="official-skip" href="#official-main">본문으로 건너뛰기</a>
    <header className="official-header">
      <div className="official-width official-bar">
        <Wordmark/>
        <nav aria-label="AlphaPact 소개 메뉴">
          <a href="#product">이용 방법</a>
          <a href="#fees">성과보수</a>
          <a href="#proof">거래 기록</a>
        </nav>
        <a className="official-button official-button-outline" href="/copy">전략 마켓 <Direction/></a>
      </div>
    </header>

    <main id="official-main">
      <section className="official-width official-hero" aria-labelledby="official-title">
        <div className="official-hero-copy">
          <h1 id="official-title">내 계정에서 따라가는<br/>자동매매 전략</h1>
          <p>제작자가 올린 전략을 고르고 거래 한도와 기간을 정하세요. 누적 손실을 메우고 새로 번 이익에서만 성과보수를 나누는 구조를 시험하고 있습니다.</p>
          <div className="official-actions">
            <a className="official-button official-button-primary" href={`/copy?strategy=${proof.strategyId}`}>전략 팔로우 <Direction/></a>
            <a className="official-text-link" href="/demo">성과보수 체험 <Direction/></a>
          </div>
        </div>
        <div className="official-hero-visual">
          <div className="official-visual-top"><span>AlphaPact 실행 기록</span><span>테스트넷</span></div>
          <div className="official-strategy">
            <span aria-hidden="true" className="official-eth">
              <svg width="21" height="28" viewBox="0 0 22 32" fill="none"><path d="m11 1 9 15-9 5-9-5 9-15Z" stroke="currentColor" strokeWidth="1.5"/><path d="m2 19 9 12 9-12-9 5-9-5Z" fill="currentColor"/></svg>
            </span>
            <div><span>제작자가 등록한 전략</span><strong>{proof.strategy.name}</strong></div>
          </div>
          <SwapReceipt/>
        </div>
      </section>

      <section className="official-method" id="product" aria-labelledby="official-method-title">
        <div className="official-width official-method-grid">
          <div>
            <h2 id="official-method-title">따라갈 전략과<br/>허용할 거래를 정하세요</h2>
            <a className="official-text-link" href="/copy">전략 마켓 열기 <Direction/></a>
          </div>
          <ol>
            {walkthrough.map((item, index) => <li key={item.title}>
              <span className="official-step" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <div><h3>{item.title}</h3><p>{item.detail}</p></div>
            </li>)}
          </ol>
        </div>
      </section>

      <section className="official-width official-fees" id="fees" aria-labelledby="official-fees-title">
        <div>
          <h2 id="official-fees-title">손실을 다 메운 뒤에만<br/>성과보수가 생깁니다</h2>
          <p>예시 보수는 새 순이익의 10%입니다. 이익 중 8%는 제작자, 2%는 AlphaPact 몫으로 계산합니다. 체험은 가상 잔액으로 진행합니다.</p>
          <a className="official-text-link" href="/demo">정산 과정 체험 <Direction/></a>
        </div>
        <div className="official-fee-sheet">
          <header><strong>모의 정산 예시</strong><span>시작 금액 10,000,000원</span></header>
          <dl>
            <div><dt><strong>손실 구간</strong><span>계정 가치 9,000,000원</span></dt><dd>0원</dd></div>
            <div><dt><strong>원금 회복</strong><span>계정 가치 10,000,000원</span></dt><dd>0원</dd></div>
            <div><dt><strong>새 순이익 500,000원</strong><span>성과보수 계산 전 10,500,000원</span></dt><dd>50,000원</dd></div>
          </dl>
        </div>
      </section>

      <section className="official-proof" id="proof" aria-labelledby="official-proof-title">
        <div className="official-width official-proof-grid">
          <div>
            <h2 id="official-proof-title">GIWA에서 확인할 수 있는 것</h2>
            <p>제작자가 250 tUSD 정기 매수를 등록했습니다. 한도를 100 tUSD로 정한 계정은 100 tUSD, 250 tUSD로 정한 계정은 250 tUSD를 자동으로 교환했습니다. 고정 가격을 쓰는 테스트 토큰 거래입니다.</p>
          </div>
          <ul>
            <li><a href={explorerTx(proof.registration)} target="_blank" rel="noreferrer">제작자의 전략 등록 <Direction outward/></a></li>
            <li><a href={explorerTx(first.hash)} target="_blank" rel="noreferrer">팔로워 A · 100 tUSD 자동 매수 <Direction outward/></a></li>
            <li><a href={explorerTx(second.hash)} target="_blank" rel="noreferrer">팔로워 B · 250 tUSD 자동 매수 <Direction outward/></a></li>
            <li><a href={directRecovery} target="_blank" rel="noreferrer">실행 API 차단 중 소유자 직접 회수 <Direction outward/></a></li>
            <li><a href={source} target="_blank" rel="noreferrer">공개 소스 코드 <Direction outward/></a></li>
          </ul>
        </div>
      </section>
    </main>

    <footer className="official-width official-footer">
      <Wordmark/>
      <span>GASOK 제출 프로젝트</span>
      <a href={`${app}/spot#spot-proof`}>업비트 현물 파일럿</a>
      <a href={source} target="_blank" rel="noreferrer">GitHub</a>
    </footer>
  </div>;
}
