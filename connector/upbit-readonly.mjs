import { createHash, createHmac, randomUUID } from "node:crypto";

export const UPBIT_KR_API_BASE = "https://api.upbit.com";
export const UPBIT_READ_ONLY_ENDPOINTS = Object.freeze({
  balances: "/v1/accounts",
  closedOrders: "/v1/orders/closed",
});

const MAX_ORDER_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export class UpbitReadOnlyError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "UpbitReadOnlyError";
    this.status = status;
    this.code = code;
  }
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function assertCredential(value, label) {
  if (typeof value !== "string" || value.trim().length < 8) {
    throw new TypeError(`${label} is missing or invalid`);
  }
  return value.trim();
}

export function createUpbitJwt({ accessKey, secretKey, queryString = "", nonce = randomUUID() }) {
  const normalizedAccessKey = assertCredential(accessKey, "Upbit access key");
  const normalizedSecretKey = assertCredential(secretKey, "Upbit secret key");
  if (typeof queryString !== "string") throw new TypeError("queryString must be a string");
  if (typeof nonce !== "string" || nonce.length < 8) throw new TypeError("nonce is invalid");

  const header = { alg: "HS512", typ: "JWT" };
  const payload = {
    access_key: normalizedAccessKey,
    nonce,
    ...(queryString
      ? {
          query_hash: createHash("sha512").update(queryString).digest("hex"),
          query_hash_alg: "SHA512",
        }
      : {}),
  };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha512", normalizedSecretKey)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

function normalizeIso(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${label} must be an ISO-8601 timestamp`);
  return new Date(timestamp).toISOString();
}

export function validateCaptureWindow(startTime, endTime) {
  const start = normalizeIso(startTime, "startTime");
  const end = normalizeIso(endTime, "endTime");
  const duration = Date.parse(end) - Date.parse(start);
  if (duration <= 0) throw new RangeError("endTime must be later than startTime");
  if (duration > MAX_ORDER_WINDOW_MS) {
    throw new RangeError("Upbit closed-order capture window cannot exceed seven days");
  }
  return { startTime: start, endTime: end };
}

function assertMarket(value) {
  const market = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}-[A-Z0-9]{2,12}$/.test(market)) {
    throw new TypeError("market must use an Upbit pair such as KRW-BTC");
  }
  return market;
}

async function readJson(response, operation) {
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const code = typeof body?.error?.name === "string" ? body.error.name : undefined;
    throw new UpbitReadOnlyError(
      `Upbit ${operation} request failed with HTTP ${response.status}${code ? ` (${code})` : ""}`,
      { status: response.status, code },
    );
  }
  if (!Array.isArray(body)) {
    throw new UpbitReadOnlyError(`Upbit ${operation} response was not an array`);
  }
  return body;
}

export function createUpbitReadOnlyClient({ accessKey, secretKey, fetchImpl = fetch }) {
  const credentials = {
    accessKey: assertCredential(accessKey, "Upbit access key"),
    secretKey: assertCredential(secretKey, "Upbit secret key"),
  };
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  async function authorizedGet(pathname, searchParams, operation) {
    if (!Object.values(UPBIT_READ_ONLY_ENDPOINTS).includes(pathname)) {
      throw new UpbitReadOnlyError(`Endpoint is not in the read-only allowlist: ${pathname}`);
    }
    const url = new URL(pathname, UPBIT_KR_API_BASE);
    for (const [key, value] of searchParams ?? []) url.searchParams.append(key, value);
    const queryString = url.searchParams.toString();
    const token = createUpbitJwt({ ...credentials, queryString });
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": "AlphaPact-ReadOnly-Connector/1.0",
      },
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
    return readJson(response, operation);
  }

  return Object.freeze({
    async getBalances() {
      return authorizedGet(UPBIT_READ_ONLY_ENDPOINTS.balances, [], "balance inquiry");
    },
    async getClosedOrders({ market, startTime, endTime }) {
      const window = validateCaptureWindow(startTime, endTime);
      const params = [
        ["market", assertMarket(market)],
        ["start_time", window.startTime],
        ["end_time", window.endTime],
        ["limit", "1000"],
        ["order_by", "asc"],
      ];
      return authorizedGet(UPBIT_READ_ONLY_ENDPOINTS.closedOrders, params, "closed-order inquiry");
    },
  });
}

export async function captureUpbitReadOnly({
  accessKey,
  secretKey,
  market = "KRW-BTC",
  startTime,
  endTime,
  fetchImpl = fetch,
  capturedAt = new Date().toISOString(),
}) {
  const window = validateCaptureWindow(startTime, endTime);
  const normalizedMarket = assertMarket(market);
  const client = createUpbitReadOnlyClient({ accessKey, secretKey, fetchImpl });
  const [balances, orders] = await Promise.all([
    client.getBalances(),
    client.getClosedOrders({ market: normalizedMarket, ...window }),
  ]);
  return {
    schemaVersion: 1,
    venue: "UPBIT_KR",
    capturedAt: normalizeIso(capturedAt, "capturedAt"),
    window,
    market: normalizedMarket,
    balances,
    orders,
  };
}
