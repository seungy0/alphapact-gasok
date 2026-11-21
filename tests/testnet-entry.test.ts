import assert from "node:assert/strict";
import { test } from "node:test";
import { appRoute, isIntroduction, previewEntry, previewSettings, selectedStrategy } from "../service/src/entry";

test("public introduction preserves existing wallet links and operating deep links", () => {
 assert.equal(isIntroduction("/", "?utm_source=demo"), true);
 assert.equal(isIntroduction("/", "?wallet=0x123"), false);
 for (const path of ["/app", "/accounts", "/activity", "/help"]) assert.equal(isIntroduction(path, ""), false);
});

test("preview settings survive entry to the operating app", () => {
 const selected = { tradeLimit: 2500, dayLimit: 2500, duration: 7 };
 const entry = new URL(previewEntry(selected), "https://example.com");
 assert.equal(entry.pathname, "/app");
 assert.deepEqual(previewSettings(entry.search), selected);
});

test("tampered or unsupported URL settings fall back to supported controls", () => {
 assert.deepEqual(previewSettings("?tradeLimit=-1&dayLimit=999999&duration=365"), { tradeLimit: 1000, dayLimit: 5000, duration: 1 });
 assert.deepEqual(previewSettings("?tradeLimit=2500&dayLimit=500&duration=3"), { tradeLimit: 2500, dayLimit: 2500, duration: 3 });
 assert.deepEqual(previewSettings("?tradeLimit=NaN&duration=Infinity"), { tradeLimit: 1000, dayLimit: 5000, duration: 1 });
});

test("returning to strategy selection stays in the app and retains a read-only wallet", () => {
 const wallet = "0xc52faCf0e0D3C46FE1aB55050b1753DD059b4b0D";
 assert.equal(appRoute("explore", ""), "/app");
 const route = new URL(appRoute("accounts", `?wallet=${wallet}&tradeLimit=1000`), "https://example.com");
 assert.equal(route.pathname, "/accounts");
 assert.equal(route.searchParams.get("wallet"), wallet);
 assert.equal(route.searchParams.has("tradeLimit"), false);
});

test("strategy links select either executable rule and reject unsupported source ids", () => {
 assert.equal(selectedStrategy("?strategy=1"), 1);
 assert.equal(selectedStrategy("?strategy=0"), 0);
 for (const search of ["", "?strategy=2", "?strategy=-1", "?strategy=NaN", "?strategy=1.0", "?strategy=1e0"]) assert.equal(selectedStrategy(search), 0);
});
