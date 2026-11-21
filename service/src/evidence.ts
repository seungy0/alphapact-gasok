export const testEvidence = {
 observedOn: "2026. 11. 1.",
 owner: "0xc52faCf0e0D3C46FE1aB55050b1753DD059b4b0D",
 account: "0xc10934E6Db3AA832EEe1248F5e935772dAf1BA0C",
 explorer: "https://sepolia-explorer.giwa.io",
 swap: { amountIn: "1,000", tokenIn: "tUSD", amountOut: "0.443578", tokenOut: "tETH", amountOutRaw: "443578346969919425" },
 records: [
  { label: "계정 생성", detail: "소유자 지갑에 연결", hash: "0x0a76c185c737593862c1e90e865d4a901e341ec7f08bc5c184732bd38e6271f5" },
  { label: "테스트 토큰 교환", detail: "1,000 tUSD → 약 0.443578 tETH", hash: "0x3fd3cf2ca287a9cc5c87a909d1c0e4b1f6c6289547c261f27c0bfdf57eaa54c8" },
  { label: "매매 권한 중지", detail: "새로운 전략 거래 중단", hash: "0x1ba4780ce629e2c65408bc8e858ce2d111386c55cc4483035be1b2a0638cb668" },
  { label: "보유 토큰 회수", detail: "소유자 지갑으로 반환", hash: "0xd0972f8e3dadce7deead374a54473da40b12af34f228f789fc36a66a009af67d" },
 ],
} as const;

export const evidenceActivityPath = `/activity?wallet=${testEvidence.owner}`;
export const evidenceTransaction = (hash: string) => `${testEvidence.explorer}/tx/${hash}`;
