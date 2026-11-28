import { useEffect, useState } from "react";
import { describeCondition } from "../algorithm-protocol";
import type { CopyStrategy } from "../copy-protocol";
import { chain } from "../protocol";
import { api } from "./client";

type Decision = { ready: boolean; side: 0 | 1 | 2; sequence: string; openedAt: string; close: number };
export const replayPrice = (cents: number) => `${(cents / 100).toLocaleString("ko-KR", { maximumFractionDigits: 2 })} USD`;

export default function AlgorithmDetails({ strategy, endpoint }: { strategy: CopyStrategy; endpoint: string }) {
  const [decision, setDecision] = useState<Decision>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    let timer: number | undefined;
    async function refresh() {
      try {
        const data = await api<Decision>(`${endpoint}/signal?strategyId=${strategy.id}`, undefined, abort.signal);
        if (!abort.signal.aborted) {
          setDecision(data.ready ? data : undefined);
          setFailed(false);
        }
      } catch {
        if (!abort.signal.aborted) setFailed(true);
      }
      if (!abort.signal.aborted) timer = window.setTimeout(refresh, 25_000);
    }
    void refresh();
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [endpoint, strategy.id]);

  return <div className="algorithm-details">
    <dl>
      <div><dt>테스트 종가</dt><dd>{decision ? replayPrice(decision.close) : "조회 중"}</dd></div>
      <div><dt>GIWA가 계산한 신호</dt><dd>{decision ? ["대기", "매수", "매도"][decision.side] : "조회 중"}</dd></div>
    </dl>
    {failed ? <p role="status">신호 조회가 지연되고 있습니다.</p> :
      decision && <p>리플레이 캔들 #{decision.sequence}</p>}
    <details>
      <summary>제작자가 등록한 조건</summary>
      <p><b>매수</b> {strategy.buyCondition && describeCondition(strategy.buyCondition)}</p>
      <p><b>매도</b> {strategy.sellCondition && describeCondition(strategy.sellCondition)}</p>
      <p>종가[0]은 최신 종가입니다. 이동평균(0, 2)는 최신 종가부터 두 값을 평균합니다.</p>
      {strategy.rule && <a href={`${chain.blockExplorers.default.url}/address/${strategy.rule}`} target="_blank" rel="noreferrer">GIWA 전략 계약</a>}
    </details>
  </div>;
}
