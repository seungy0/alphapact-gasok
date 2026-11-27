import type { SettlementScenario } from "./performance-fee";

export type StrategyDraft = { name: string; creator: string; scenario: SettlementScenario };
export type CatalogStrategy = StrategyDraft & { id: string };

export const marketExamples: readonly CatalogStrategy[] = [
  { id: "scheduled", name: "ETH 정기 분할 매수", creator: "AlphaPact 예시", scenario: "scheduled" },
  { id: "balanced", name: "ETH 균형 리밸런싱", creator: "AlphaPact 예시", scenario: "balanced" },
];

export function parseStrategyDraft(value: unknown): StrategyDraft | undefined {
  if (!value || typeof value !== "object") return;
  const { name, creator, scenario } = value as Record<string, unknown>;
  if (typeof name !== "string" || typeof creator !== "string") return;
  const title = name.trim();
  const author = creator.trim();
  if (!title || title.length > 36 || !author || author.length > 24) return;
  if (scenario !== "scheduled" && scenario !== "balanced") return;
  return { name: title, creator: author, scenario };
}

export function readCatalogStrategy(value: unknown): CatalogStrategy | undefined {
  const draft = parseStrategyDraft(value);
  if (!draft) return;
  const { id } = value as Record<string, unknown>;
  if (typeof id !== "string" || !id.startsWith("demo-")) return;
  return { ...draft, id };
}
