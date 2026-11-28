# AlphaPact

AlphaPact는 제작자 전략을 선택해 자기 계정에서 따라가고, 이전 손실을 만회한 뒤 생긴 새 순이익에서 성과보수를 나누는 전략 마켓입니다. 이 저장소에는 GASOK Phase 4 평가용 공개 데모의 소스가 들어 있습니다.

## 심사위원 데모

- [AlphaPact 공식 사이트](https://alphapact.pages.dev/)
- [전략 등록과 성과보수 모의 데모](https://alphapact.pages.dev/demo)
- [기존 GIWA Sepolia 실행 앱](https://alphapact-testnet.yhs98.workers.dev/app)
- [지갑 없이 테스트 영수증 네 건 보기](https://alphapact-testnet.yhs98.workers.dev/#test-records)
- [업비트 현물 공개 시세와 샘플 기록 대조](https://alphapact-testnet.yhs98.workers.dev/spot#spot-proof)
- [소유자 직접 회수 영수증](https://sepolia-explorer.giwa.io/tx/0x13a83105a9ffea16c05d3cdc283ed33d23ae78241ab76a2d1fcbcef4e20b2386)

성과보수 체험은 가상 가격으로 정산합니다. 이전 손실을 다 만회한 뒤 새 순이익의 8%를 제작자에게, 2%를 AlphaPact에 배분하는 예시입니다. 테스트 실행 앱과 모의 정산은 별개이며, 신규 등록 전략이 테스트넷에서 주문을 실행하지는 않습니다.

## GIWA Sepolia · Chain ID 91342

- [전략 계정 팩토리](https://sepolia-explorer.giwa.io/address/0xb6ae5aa931b5afb2754640e594398071357302c4)
- [모의 교환시장](https://sepolia-explorer.giwa.io/address/0xeae145372ca27a7f97e047cb3d20f933e7828255)
- [현물 점검 기록 계약](https://sepolia-explorer.giwa.io/address/0xe428391c9826781bb0456b18868a2210c1215256)

계정 팩토리의 서명 검증과 교환시장은 `contracts/AlphaPactTestnetService.sol`, 한도·권한·직접 회수는 `contracts/AlphaPactStrategyAccount.sol`에 있습니다. tUSD/tETH는 현금 가치 없는 테스트 토큰입니다.

업비트 경로는 공개 시세와 등록 소유자의 계좌 조회·주문 테스트를 지원합니다. 공개 데모에서는 업비트 계정 등록 전이며, 실주문을 보내지 않습니다. `AlphaPactSpotCheckpoints.sol`에 합성 점검 기록의 해시가 게시되어 있습니다. GIWA에서 확인하는 것은 게시된 해시와 샘플의 일치 여부입니다.

## 로컬 빌드와 검증

Node.js 22.13 이상이 필요합니다.

```sh
npm ci
npm run service:build
npm test
npm run spot:verify -- service/public/evidence/spot-checkpoint-sample.json --chain
```

`npm run service:preview`는 프런트엔드를 띄웁니다. 테스트넷 실행과 계좌 API가 필요한 흐름은 위 공개 데모에서 확인할 수 있습니다. 비밀 키, 실제 계좌 내역과 운영 데이터는 이 패키지에 포함하지 않았습니다.

공식 사이트는 Cloudflare Pages에서 빌드하고 배포합니다. 빌드 명령은 `npx vite build --config service/vite.config.ts --mode pages`입니다. 모의 전략 목록은 Pages Functions와 D1을 사용합니다. 하는 일과 현재 실행 범위는 공식 사이트에서 확인할 수 있습니다.
