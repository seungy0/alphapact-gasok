import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import Landing from "./Landing";
import { isIntroduction } from "./entry";
import "./styles.css";

const App = lazy(() => import("./App"));
const SpotApp = lazy(() => import("./SpotApp"));
const StrategyMarket = lazy(() => import("./StrategyMarket"));
const OfficialSite = lazy(() => import("./OfficialSite"));
const spot = location.pathname === "/spot" || location.pathname.startsWith("/spot/");
const legacyAnchor = ["#intro-main", "#test-records", "#how", "#evidence"].includes(location.hash);
const home = isIntroduction(location.pathname, location.search);
const official = import.meta.env.MODE === "pages" && home && !legacyAnchor;
const market = ["/market", "/demo", "/demo/"].includes(location.pathname) || (home && !official && !legacyAnchor);
const introduction = location.pathname === "/about" || (home && legacyAnchor);
document.documentElement.classList.toggle("intro-document", introduction);
document.title = official ? "AlphaPact — 내 계정에서 따라가는 자동매매 전략" : market ? "AlphaPact — 전략 마켓과 성과보수 체험" : spot ? "AlphaPact — 업비트 현물 연결" : introduction ? "AlphaPact — 내 지갑으로 시작하는 자동매매" : "AlphaPact — 내 지갑으로 시작하는 전략 운용";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<div className="intro-app-loading" role="status">서비스를 불러오고 있습니다.</div>}>
      {official ? <OfficialSite/> : market ? <StrategyMarket/> : spot ? <SpotApp/> : introduction ? <Landing/> : <App/>}
    </Suspense>
  </React.StrictMode>,
);
