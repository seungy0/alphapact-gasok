import assert from "node:assert/strict";
import test from "node:test";
import { createSpotPilot } from "../agent/upbit-spot-pilot.mjs";
const order = { market: "KRW-BTC", side: "bid", ordType: "price", price: "5000", identifier: "ap_spot_test_12345678" };
function fixture(mode = "VALIDATE_ONLY") {
  const calls = [];
  const upbit = {
    getBalances: async () => { calls.push("balances"); return [{ currency: "KRW", balance: "50000", locked: "0" }, { currency: "BTC", balance: "0.1", locked: "0" }, { currency: "XRP", balance: "99", locked: "0" }]; },
    getOpenOrders: async () => { calls.push("open"); return []; },
    getClosedOrders: async () => { calls.push("closed"); return []; },
    testOrder: async input => { calls.push(["test", input]); return { uuid: "dry-run-only", state: "wait" }; },
    createOrder: async () => { throw new Error("LIVE ORDER MUST NEVER BE CALLED"); },
    cancelOrder: async () => { throw new Error("CANCEL MUST NEVER BE CALLED"); },
  };
  return { pilot: createSpotPilot({ upbit, mode, markets: ["KRW-BTC"], maxOrderWon: 10000 }), calls };
}
test("spot sync reads selected balances and limited orders without order-placement permission", async () => {
  const { pilot, calls } = fixture("READ_ONLY"); const state = await pilot.sync();
  assert.deepEqual(calls, ["balances", "open", "closed"]);
  assert.deepEqual(state.assets.map(item => item.currency), ["KRW", "BTC"]);
  assert.equal(state.orderCoverage, "LATEST_20_CLOSED_PER_MARKET_PLUS_OPEN_FIRST_100");
});
for (const mode of ["VALIDATE_ONLY", "LIVE"]) test(`${mode}: spot validation only tests and discards dry-run UUIDs`, async () => {
  const { pilot, calls } = fixture(mode); const result = await pilot.validate(order);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], "test");
  assert.equal(result.submitted, false); assert.equal(result.validated, true); assert.equal("uuid" in result, false);
});
test("read-only rejects validation before calling Upbit", async () => {
  const { pilot, calls } = fixture("READ_ONLY"); await assert.rejects(pilot.validate(order), /ORDER_VALIDATION_DISABLED/); assert.equal(calls.length, 0);
});
for (const input of [{ ...order, market: "KRW-ETH" }, { ...order, side: "ask" }, { ...order, ordType: "limit" }, { ...order, volume: "1" }, { ...order, price: "10001" }, { ...order, price: "0" }, { ...order, price: "5e3" }]) {
  test(`spot rejects unsupported input ${JSON.stringify(input)}`, async () => {
    const { pilot, calls } = fixture(); await assert.rejects(pilot.validate(input)); assert.equal(calls.length, 0);
  });
}
