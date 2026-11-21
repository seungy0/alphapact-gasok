import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createUpbitExchangeClient, validateExecutorOrder } from "../connector/upbit-exchange.mjs";
import { createSpotPilot } from "./upbit-spot-pilot.mjs";

const ORDER_MODES = new Set(["READ_ONLY", "VALIDATE_ONLY", "LIVE"]);

function secretValue(name, env = process.env) {
  const direct = env[name]?.trim();
  const file = env[`${name}_FILE`]?.trim();
  return { direct, file };
}

async function readSecret(name, env = process.env) {
  const { direct, file } = secretValue(name, env);
  if (direct) return direct;
  if (file) return (await readFile(file, "utf8")).trim();
  return undefined;
}

function allowedMarkets(env = process.env) {
  const markets = (env.UPBIT_ALLOWED_MARKETS ?? "KRW-BTC").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
  if (!markets.length || markets.some((value) => !/^KRW-[A-Z0-9]{2,12}$/.test(value))) throw new Error("UPBIT_ALLOWED_MARKETS_INVALID");
  return markets;
}

function orderMode(env = process.env) {
  const mode = (env.UPBIT_ORDER_MODE ?? "READ_ONLY").trim().toUpperCase();
  if (!ORDER_MODES.has(mode)) throw new Error("UPBIT_ORDER_MODE_INVALID");
  return mode;
}

function maxOrderWon(env = process.env) {
  const value = Number(env.UPBIT_MAX_ORDER_WON ?? 10_000);
  if (!Number.isInteger(value) || value < 5_000 || value > 10_000_000) throw new Error("UPBIT_MAX_ORDER_WON_INVALID");
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function executorSignature({ timestamp, nonce, method = "POST", pathname, body, sharedSecret }) {
  const canonical = `${timestamp}\n${nonce}\n${method}\n${pathname}\n${sha256(body)}`;
  return createHmac("sha256", sharedSecret).update(canonical).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(left ?? "", "utf8");
  const b = Buffer.from(right ?? "", "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function bodyText(request, limit = 32_768) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function connectionRef(body, configuredRef) {
  if (body?.connectionRef !== configuredRef) throw new Error("CONNECTION_NOT_FOUND");
  return configuredRef;
}

function publicOrder(order) {
  return {
    identifier: order?.identifier,
    uuid: order?.uuid,
    state: order?.state,
    executedVolume: order?.executed_volume,
    remainingVolume: order?.remaining_volume,
  };
}

export async function createLiveExecutor({ env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const [accessKey, secretKey, sharedSecret] = await Promise.all([
    readSecret("UPBIT_ACCESS_KEY", env),
    readSecret("UPBIT_SECRET_KEY", env),
    readSecret("UPBIT_EXECUTOR_SHARED_SECRET", env),
  ]);
  if (!accessKey || !secretKey || !sharedSecret) throw new Error("EXECUTOR_SECRETS_MISSING");
  const mode = orderMode(env);
  const markets = allowedMarkets(env);
  const maximum = maxOrderWon(env);
  const configuredRef = (env.UPBIT_CONNECTION_REF ?? "owner-upbit").trim();
  if (!/^[a-z0-9_-]{3,64}$/.test(configuredRef)) throw new Error("UPBIT_CONNECTION_REF_INVALID");
  const upbit = createUpbitExchangeClient({ accessKey, secretKey, fetchImpl });
  const spot = createSpotPilot({ upbit, mode, markets, maxOrderWon: maximum, now });
  const nonces = new Map();

  function authenticate(request, pathname, serialized) {
    const timestamp = request.headers["x-alphapact-timestamp"];
    const nonce = request.headers["x-alphapact-nonce"];
    const signature = request.headers["x-alphapact-signature"];
    if (typeof timestamp !== "string" || typeof nonce !== "string" || typeof signature !== "string") throw new Error("AUTH_REQUIRED");
    const numericTimestamp = Number(timestamp);
    const current = now();
    if (!Number.isFinite(numericTimestamp) || Math.abs(current - numericTimestamp) > 30_000) throw new Error("AUTH_EXPIRED");
    for (const [seenNonce, seenAt] of nonces) if (current - seenAt > 60_000) nonces.delete(seenNonce);
    if (nonces.has(nonce)) throw new Error("AUTH_REPLAYED");
    const expected = executorSignature({ timestamp, nonce, pathname, body: serialized, sharedSecret });
    if (!safeEqual(signature, expected)) throw new Error("AUTH_INVALID");
    nonces.set(nonce, current);
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json(response, 200, { ok: true, venue: "UPBIT_KR", mode, markets, maxOrderWon: maximum });
    }
    if (request.method !== "POST" || !url.pathname.startsWith("/v1/")) return json(response, 404, { error: "NOT_FOUND" });
    try {
      const serialized = await bodyText(request);
      authenticate(request, url.pathname, serialized);
      const body = JSON.parse(serialized);
      connectionRef(body, configuredRef);

      if (url.pathname === "/v1/spot/sync") return json(response, 200, await spot.sync());
      if (url.pathname === "/v1/spot/validate") return json(response, 200, await spot.validate(body.order));
      if (env.UPBIT_SPOT_PILOT_ONLY === "true") return json(response, 404, { error: "SPOT_PILOT_PATH_ONLY" });

      if (url.pathname === "/v1/account/sync") {
        const identifiers = Array.isArray(body.identifiers)
          ? [...new Set(body.identifiers.filter((value) => typeof value === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(value)))].slice(0, 20)
          : [];
        const [balances, openOrders, chance, ...knownOrders] = await Promise.all([
          upbit.getBalances(),
          upbit.getOpenOrders({ market: markets[0] }),
          upbit.getOrderChance(markets[0]),
          ...identifiers.map((identifier) => upbit.getOrder({ identifier }).catch(() => ({ identifier, state: "unknown" }))),
        ]);
        const krw = balances.find((balance) => balance.currency === "KRW") ?? {};
        return json(response, 200, {
          mode,
          availableKrw: Number(krw.balance ?? 0),
          lockedKrw: Number(krw.locked ?? 0),
          assetCount: balances.filter((balance) => Number(balance.balance ?? 0) + Number(balance.locked ?? 0) > 0).length,
          openOrderCount: Array.isArray(openOrders) ? openOrders.length : 0,
          permissions: {
            account: true,
            orders: true,
            orderPlacement: mode !== "READ_ONLY" && Boolean(chance?.market),
          },
          orders: knownOrders.map(publicOrder),
          syncedAt: new Date(now()).toISOString(),
        });
      }

      if (url.pathname === "/v1/orders/submit") {
        if (mode === "READ_ONLY") throw new Error("ORDER_SUBMISSION_DISABLED");
        const order = validateExecutorOrder(body.order, { allowedMarkets: markets, maxOrderWon: maximum });
        if (mode === "LIVE") {
          const existing = await upbit.getOrder({ identifier: order.identifier }).catch((error) => {
            if (error?.status === 404 || error?.code === "order_not_found") return undefined;
            throw error;
          });
          if (existing?.uuid) {
            return json(response, 200, { mode, validated: true, submitted: true, identifier: order.identifier, uuid: existing.uuid, state: existing.state });
          }
        }
        const validated = await upbit.testOrder(order);
        if (mode === "VALIDATE_ONLY") {
          return json(response, 200, { mode, validated: true, submitted: false, identifier: order.identifier, state: validated?.state ?? "validated" });
        }
        const submitted = await upbit.createOrder(order);
        return json(response, 200, { mode, validated: true, submitted: true, identifier: order.identifier, uuid: submitted.uuid, state: submitted.state });
      }

      if (url.pathname === "/v1/orders/cancel") {
        if (mode !== "LIVE") throw new Error("ORDER_CANCELLATION_DISABLED");
        const canceled = await upbit.cancelOrder({ identifier: body.identifier });
        return json(response, 200, { mode, validated: true, submitted: true, identifier: body.identifier, uuid: canceled.uuid, state: canceled.state });
      }
      return json(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      const code = error instanceof Error ? error.message : "EXECUTOR_ERROR";
      const safeCode = /^[A-Z0-9_:-]{3,80}$/.test(code) ? code : code.match(/\(([a-z_]+)\)/)?.[1]?.toUpperCase() ?? "EXECUTOR_ERROR";
      const status = safeCode.startsWith("AUTH_") ? 401 : safeCode === "CONNECTION_NOT_FOUND" ? 404 : safeCode === "REQUEST_TOO_LARGE" ? 413 : 409;
      return json(response, status, { error: safeCode });
    }
  }

  return { handle, configuration: { mode, markets, maxOrderWon: maximum, connectionRef: configuredRef } };
}

async function start() {
  const port = Number(process.env.PORT ?? 4190);
  const host = process.env.HOST ?? "0.0.0.0";
  const executor = await createLiveExecutor();
  const server = http.createServer(executor.handle);
  server.listen(port, host, () => console.log(`AlphaPact Upbit live executor listening on http://${host}:${port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await start();
