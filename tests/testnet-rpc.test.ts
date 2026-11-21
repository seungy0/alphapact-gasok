import test from "node:test";
import assert from "node:assert/strict";
import { queueRpc } from "../service/rpc";

function time() {
  let clock = 0;
  return { now: () => clock, wait: async (milliseconds: number) => { clock += milliseconds; } };
}
test("concurrent operator reads and writes are spaced and ordered", async () => {
  const clock = time(); const starts: number[] = [];
  const request = queueRpc(async (value: number) => { starts.push(clock.now()); return value; }, clock);
  assert.deepEqual(await Promise.all([request(1), request(2), request(3)]), [1, 2, 3]);
  assert.deepEqual(starts, [0, 500, 1000]);
});
test("provider quota errors retry the same payload with bounded backoff", async () => {
  const clock = time(); const payload = { method: "eth_sendRawTransaction", params: ["0x1234"] };
  const seen: unknown[] = [];
  const request = queueRpc(async value => { seen.push(value); if (seen.length < 3) throw new Error("RPC Request failed: over rate limit"); return "same-hash"; }, clock);
  assert.equal(await request(payload), "same-hash");
  assert.deepEqual(seen, [payload, payload, payload]); assert.equal(clock.now(), 6000);
});
test("contract reverts are not retried and do not stall the queue", async () => {
  const seen: string[] = []; const request = queueRpc(async (value: string) => { seen.push(value); if (value === "bad") throw new Error("execution reverted"); return value; }, time());
  const bad = request("bad"); const good = request("good");
  await assert.rejects(bad, /execution reverted/); assert.equal(await good, "good"); assert.deepEqual(seen, ["bad", "good"]);
});
test("a persistent provider quota error stops after four attempts", async () => {
  let attempts = 0; const request = queueRpc(async () => { attempts++; throw new Error("HTTP 429"); }, time());
  await assert.rejects(request(undefined), /429/); assert.equal(attempts, 4);
});
