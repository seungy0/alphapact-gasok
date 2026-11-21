import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import Landing from "./Landing";
import { isIntroduction } from "./entry";
import "./styles.css";

const App = lazy(() => import("./App"));
const SpotApp = lazy(() => import("./SpotApp"));
const spot = location.pathname === "/spot" || location.pathname.startsWith("/spot/");
const introduction = isIntroduction(location.pathname, location.search);
document.documentElement.classList.toggle("intro-document", introduction);
document.title = spot ? "AlphaPact — 업비트 현물 연결" : introduction ? "AlphaPact — 내 지갑으로 시작하는 자동매매" : "AlphaPact — 내 지갑으로 시작하는 전략 운용";
createRoot(document.getElementById("root")!).render(<React.StrictMode>{spot ? <Suspense fallback={<div className="intro-app-loading" role="status">업비트 연결 화면을 불러오고 있습니다.</div>}><SpotApp/></Suspense> : introduction ? <Landing/> : <Suspense fallback={<div className="intro-app-loading" role="status">서비스를 불러오고 있습니다.</div>}><App/></Suspense>}</React.StrictMode>);
