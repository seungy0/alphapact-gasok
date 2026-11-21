import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { SpotService, type SpotStorage } from "../service/spot-service";
import { DEFAULT_SPOT_RULE, normalizeSpotRule, orderForValidation, spotHash, verifySpotRecords, ZERO_HASH, type SpotRecord, type SpotSnapshot } from "../service/spot-domain";
const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
const origin = "https://alphapact.example";
class Memory implements SpotStorage {
  values = new Map<string, unknown>();
  async get<T>(key: string) { return this.values.get(key) as T | undefined; }
  async put(entries: Record<string, unknown>) { for (const [key, value] of Object.entries(entries)) this.values.set(key, structuredClone(value)); }
  async delete(key: string) { return this.values.delete(key); }
}
function fixture(configured = true) {
  const storage = new Memory(); const calls: Array<{ url: string; body?: string }> = []; let clock = 1_800_000_000_000;
  const snapshot: SpotSnapshot = { venue: "UPBIT_KR", mode: "VALIDATE_ONLY", markets: ["KRW-BTC"], maxOrderWon: 10000,
    assets: [{ currency: "KRW", available: "50000", locked: "0" }], orders: [], orderCoverage: "LATEST_20_CLOSED_PER_MARKET_PLUS_OPEN_FIRST_100", syncedAt: new Date(clock).toISOString() };
  const fetchImpl: typeof fetch = async (input, options) => {
    const url = String(input); calls.push({ url, body: String(options?.body ?? "") });
    if (url.startsWith("https://api.upbit.com/v1/ticker")) return Response.json([{ market: "KRW-BTC", trade_price: 100000000, trade_timestamp: clock }]);
    if (url.endsWith("/v1/spot/sync")) return Response.json({ ...snapshot, syncedAt: new Date(clock).toISOString() });
    if (url.endsWith("/v1/spot/validate")) return Response.json({ mode: "ORDER_VALIDATION", validated: true, submitted: false });
    throw new Error(`Unexpected request ${url}`);
  };
  const anchors: unknown[] = [];
  const service = new SpotService(storage, configured ? { UPBIT_OWNER_ADDRESS: owner.address, UPBIT_EXECUTOR_URL: "https://executor.example/executor/", UPBIT_EXECUTOR_SHARED_SECRET: "fake-shared-secret-at-least-32-characters" } : {},
    async request => { anchors.push(request); return { sequence: request.sequence, evidenceHead: request.evidenceHead, transactionHash: `0x${"aa".repeat(32)}`, checkpointHash: `0x${"bb".repeat(32)}`, block: "42" }; }, fetchImpl, () => clock);
  const request = (path: string, body?: unknown, requestOrigin = origin) => service.handle(new Request(`${origin}${path}`, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json", origin: requestOrigin } : {}, body: body ? JSON.stringify(body) : undefined }));
  async function authorize(kind: string, payload: unknown = {}) {
    const response = await request("/challenge", { owner: owner.address, kind, payload }); const challenge = await response.json() as { nonce: string; message: string };
    assert.equal(response.status, 200, JSON.stringify(challenge));
    return { nonce: challenge.nonce, signature: await owner.signMessage({ message: challenge.message }) };
  }
  async function command(kind: string, payload: unknown = {}) { return request("/command", await authorize(kind, payload)); }
  return { storage, calls, anchors, request, authorize, command, snapshot, setClock: (value: number) => { clock = value; } };
}
test("unconfigured deployment serves public data, hides private state and rejects commands", async () => {
  const f = fixture(false); const status = await (await f.request("/status")).json() as { configured: boolean; liveOrders: boolean };
  assert.equal(status.configured, false); assert.equal(status.liveOrders, false);
  assert.equal((await f.request("/market")).status, 200);
  assert.equal((await f.request("/challenge", { owner: owner.address, kind: "sync", payload: {} })).status, 400);
  assert.equal((await f.request("/state")).status, 404);
});
test("private commands require owner, same origin, valid signature and a one-use nonce", async () => {
  const f = fixture();
  assert.equal((await f.request("/challenge", { owner: other.address, kind: "read", payload: {} })).status, 400);
  assert.equal((await f.request("/challenge", { owner: owner.address, kind: "read", payload: {} }, "https://attacker.example")).status, 403);
  const signed = await f.authorize("read"); assert.equal((await f.request("/command", signed)).status, 200);
  assert.equal((await f.request("/command", signed)).status, 400);
  const bad = await f.authorize("read"); bad.signature = await other.signMessage({ message: "wrong" });
  assert.equal((await f.request("/command", bad)).status, 400); assert.equal(f.calls.length, 0);
});
test("challenge expires and cannot request live orders or inject amounts", async () => {
  const f = fixture(); const signed = await f.authorize("read"); f.setClock(1_800_000_181_000);
  assert.equal((await f.request("/command", signed)).status, 400);
  assert.equal((await f.request("/challenge", { owner: owner.address, kind: "live-order", payload: {} })).status, 400);
  assert.equal((await f.request("/challenge", { owner: owner.address, kind: "validate", payload: { price: "9999999" } })).status, 400);
});
test("pilot links policy, private snapshot, dry run, hash chain and a redacted checkpoint", async () => {
  const f = fixture();
  assert.equal((await f.command("save-rule", DEFAULT_SPOT_RULE)).status, 200);
  assert.equal((await f.command("sync")).status, 200);
  assert.equal((await f.command("validate")).status, 200);
  const validated = f.calls.find(call => call.url.endsWith("/v1/spot/validate")); assert.ok(validated);
  const order = JSON.parse(validated.body!).order; assert.equal(order.price, "5000"); assert.equal(order.side, "bid");
  assert.equal(f.calls.some(call => call.url.includes("/orders/submit")), false);
  assert.equal((await f.command("anchor")).status, 200); assert.equal(f.anchors.length, 1);
  assert.doesNotMatch(JSON.stringify(f.anchors), /50000|available|uuid|UPBIT_OWNER|signature/);
  const exported = await (await f.command("export")).json() as { archive: { records: SpotRecord[]; anchor: { evidenceHead: string } } };
  assert.deepEqual(exported.archive.records.map(record => record.kind), ["RULE_SAVED", "ACCOUNT_SNAPSHOT", "VALIDATION_REQUESTED", "VALIDATION_PASSED"]);
  assert.equal(verifySpotRecords(exported.archive.records).head, exported.archive.anchor.evidenceHead);
  const modified = structuredClone(exported.archive.records); modified[1].payload = { changed: true };
  assert.throws(() => verifySpotRecords(modified), /해시/);
  assert.throws(() => verifySpotRecords(exported.archive.records.filter((_, index) => index !== 1)), /순서/);
});
test("leverage, extra fields, unsupported markets, stale data and insufficient funds fail closed", () => {
  for (const value of [{ ...DEFAULT_SPOT_RULE, leverage: 2 }, { ...DEFAULT_SPOT_RULE, borrow: true }, { ...DEFAULT_SPOT_RULE, orderWon: 10001 }, { ...DEFAULT_SPOT_RULE, market: "BTC-PERP" }, { ...DEFAULT_SPOT_RULE, arbitrary: true }]) assert.throws(() => normalizeSpotRule(value));
  const f = fixture(); const quote = { market: "KRW-BTC", priceWon: 100000000, observedAt: 1_800_000_000_000, fetchedAt: 1_800_000_000_000 };
  assert.throws(() => orderForValidation(DEFAULT_SPOT_RULE, null, quote, "identifier", quote.observedAt));
  assert.throws(() => orderForValidation(DEFAULT_SPOT_RULE, f.snapshot, quote, "identifier", quote.observedAt + 61000));
  assert.throws(() => orderForValidation(DEFAULT_SPOT_RULE, { ...f.snapshot, mode: "READ_ONLY" }, quote, "identifier", quote.observedAt));
  assert.throws(() => orderForValidation(DEFAULT_SPOT_RULE, { ...f.snapshot, assets: [] }, quote, "identifier", quote.observedAt));
  assert.equal(spotHash({ a: 1, b: 2 }), spotHash({ b: 2, a: 1 })); assert.equal(verifySpotRecords([]).head, ZERO_HASH);
});
test("an existing private store cannot be rebound to another owner", async () => {
  const f = fixture(); await f.command("sync");
  const replacement = new SpotService(f.storage, { UPBIT_OWNER_ADDRESS: other.address, UPBIT_EXECUTOR_URL: "https://executor.example/", UPBIT_EXECUTOR_SHARED_SECRET: "fake-shared-secret-at-least-32-characters" }, undefined);
  const response = await replacement.handle(new Request(`${origin}/challenge`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ owner: other.address, kind: "read", payload: {} }) }));
  assert.equal(response.status, 400); assert.match((await response.json() as { error: string }).error, /소유자가 변경/);
});
