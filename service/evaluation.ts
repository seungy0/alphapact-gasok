import type { Hex } from "viem";
import type { decide } from "./protocol";

type Decision = ReturnType<typeof decide>;
type TradeDecision = Exclude<Decision, { hold: string }>;

type Evaluation =
  | { status: "waiting" | "checking"; reason: string }
  | { status: "unconfirmed" }
  | { status: "confirmed"; reason: string; hash: Hex };

export type AccountEvaluation =
  | ({ at: string; sessionId: string } & Evaluation)
  | { at: string; reason: string; status?: never; sessionId?: never };

export async function evaluateStrategy<Price>(
  initial: Decision,
  refresh: () => Promise<{ price: Price; decision: Decision }>,
  exchange: (price: Price, decision: TradeDecision) => Promise<Hex>,
  save: (evaluation: Evaluation) => Promise<void>,
) {
  if ("hold" in initial) {
    await save({ status: "waiting", reason: initial.hold });
    return;
  }

  await save({ status: "checking", reason: initial.reason });
  let result: Evaluation;
  try {
    const { price, decision } = await refresh();
    result = "hold" in decision
      ? { status: "waiting", reason: decision.hold }
      : { status: "confirmed", reason: decision.reason, hash: await exchange(price, decision) };
  } catch (error) {
    await save({ status: "unconfirmed" });
    throw error;
  }

  await save(result);
}
