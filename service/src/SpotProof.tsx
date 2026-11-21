import { useEffect, useRef, useState } from "react";
import { chain } from "../protocol";
import { readSpotEvidence, verifySpotCheckpoint } from "../spot-evidence";
import type { SpotAnchor } from "../spot-domain";

const samplePath = "/evidence/spot-checkpoint-sample.json";

export default function SpotProof() {
  const section = useRef<HTMLElement>(null);
  const [state, setState] = useState<
    { status: "idle" | "pending" } | { status: "verified"; anchor: SpotAnchor } | { status: "error"; message: string }
  >({ status: "idle" });

  useEffect(() => {
    if (location.hash === "#spot-proof") section.current?.scrollIntoView();
  }, []);

  async function verify() {
    setState({ status: "pending" });
    try {
      const sample = await fetch(samplePath, { signal: AbortSignal.timeout(8_000) })
        .then(response => {
          if (!response.ok) throw new Error();
          return response.json();
        })
        .catch(() => { throw new Error("샘플 기록을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요."); });
      const anchor = await verifySpotCheckpoint(readSpotEvidence(sample));
      setState({ status: "verified", anchor });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "기록을 확인하지 못했습니다. 다시 시도해 주세요.",
      });
    }
  }

  return (
    <section ref={section} className="spot-setup spot-proof" id="spot-proof" aria-labelledby="spot-proof-title">
      <h2 id="spot-proof-title">GIWA 샘플 기록 확인</h2>
      <p>샘플 JSON의 해시를 계산해 GIWA Sepolia에 게시된 해시와 대조합니다. 지갑과 업비트 API 키는 필요 없습니다.</p>
      <p className="spot-meta">거래소를 호출하지 않고 만든 합성 기록 1건입니다. 검증 결과는 게시 시점의 기록과 일치하는지 보여줍니다.</p>
      <div className="spot-proof-actions">
        <button className="secondary" disabled={state.status === "pending"} onClick={() => void verify()}>
          {state.status === "pending" ? "GIWA 기록 확인 중" : state.status === "error" ? "다시 확인" : "기록 해시 대조"}
        </button>
        <a href={samplePath} download>샘플 JSON 내려받기</a>
      </div>
      <div role="status">
        {state.status === "error" && <p className="spot-proof-error">{state.message}</p>}
        {state.status === "verified" && (
          <div className="spot-proof-result">
            <strong>샘플과 GIWA 기록의 해시가 일치합니다.</strong>
            <code>{state.anchor.evidenceHead}</code>
            <a href={`${chain.blockExplorers.default.url}/tx/${state.anchor.transactionHash}`} target="_blank" rel="noreferrer">
              게시 거래 원본 보기
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
