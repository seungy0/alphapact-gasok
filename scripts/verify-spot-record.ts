import { readFile } from "node:fs/promises";
import { readSpotEvidence, verifySpotCheckpoint } from "../service/spot-evidence";

const file = process.argv[2];
if (!file) throw new Error("사용법: npm run spot:verify -- /절대경로/내-기록.json [--chain]");
const evidence = readSpotEvidence(JSON.parse(await readFile(file, "utf8")));
let chainVerified = false;
if (process.argv.includes("--chain")) {
  await verifySpotCheckpoint(evidence);
  chainVerified = true;
}
console.log(JSON.stringify({ localIntegrity: true, ...evidence.verified, chainVerified, anchoredThrough: evidence.anchor?.sequence ?? 0,
  meaning: "사후 기록 무결성 확인. 거래소 원본의 진위·누락 없음·실제 체결·수익성·매매 전 예측을 증명하지 않음." }, null, 2));
