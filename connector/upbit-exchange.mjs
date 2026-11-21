import { createUpbitJwt, UPBIT_KR_API_BASE } from "./upbit-readonly.mjs";

export const UPBIT_EXCHANGE_ENDPOINTS = Object.freeze({
  balances: "/v1/accounts",
  openOrders: "/v1/orders/open",
  closedOrders: "/v1/orders/closed",
  orderChance: "/v1/orders/chance",
  order: "/v1/order",
  orders: "/v1/orders",
  testOrder: "/v1/orders/test",
});

export class UpbitExchangeError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "UpbitExchangeError";
    this.status = status;
    this.code = code;
  }
}

function credential(value, label) {
  if (typeof value !== "string" || value.trim().length < 8) {
    throw new TypeError(`${label} is missing or invalid`);
  }
  return value.trim();
}

function market(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!/^KRW-[A-Z0-9]{2,12}$/.test(normalized)) {
    throw new TypeError("Only KRW Upbit markets such as KRW-BTC are supported");
  }
  return normalized;
}

function identifier(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(normalized)) {
    throw new TypeError("identifier must be 8-64 URL-safe characters");
  }
  return normalized;
}

function positiveDecimal(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized) || Number(normalized) <= 0) {
    throw new TypeError(`${label} must be a positive decimal string`);
  }
  return normalized;
}

function orderParameters(input) {
  const side = input?.side === "ask" ? "ask" : input?.side === "bid" ? "bid" : undefined;
  const ordType = ["limit", "price", "market"].includes(input?.ordType) ? input.ordType : undefined;
  if (!side || !ordType) throw new TypeError("side and ordType are invalid");
  if (ordType === "price" && side !== "bid") throw new TypeError("price orders are KRW market buys only");
  if (ordType === "market" && side !== "ask") throw new TypeError("market orders are asset sells only");

  const params = [
    ["market", market(input.market)],
    ["side", side],
    ["ord_type", ordType],
  ];
  if (ordType === "price" || ordType === "limit") params.push(["price", positiveDecimal(input.price, "price")]);
  if (ordType === "market" || ordType === "limit") params.push(["volume", positiveDecimal(input.volume, "volume")]);
  params.push(["identifier", identifier(input.identifier)]);
  return params;
}

function queryString(params) {
  return new URLSearchParams(params).toString();
}

async function readJson(response, operation) {
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code = typeof body?.error?.name === "string" ? body.error.name : undefined;
    throw new UpbitExchangeError(
      `Upbit ${operation} failed with HTTP ${response.status}${code ? ` (${code})` : ""}`,
      { status: response.status, code },
    );
  }
  if (!body || typeof body !== "object") throw new UpbitExchangeError(`Upbit ${operation} returned invalid JSON`);
  return body;
}

export function createUpbitExchangeClient({ accessKey, secretKey, fetchImpl = fetch }) {
  const credentials = {
    accessKey: credential(accessKey, "Upbit access key"),
    secretKey: credential(secretKey, "Upbit secret key"),
  };
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  async function request(pathname, { method = "GET", params = [], operation } = {}) {
    if (!Object.values(UPBIT_EXCHANGE_ENDPOINTS).includes(pathname)) {
      throw new UpbitExchangeError(`Endpoint is not in the exchange allowlist: ${pathname}`);
    }
    const encoded = queryString(params);
    const token = createUpbitJwt({ ...credentials, queryString: encoded });
    const url = new URL(pathname, UPBIT_KR_API_BASE);
    if (method === "GET" || method === "DELETE") url.search = encoded;
    const response = await fetchImpl(url, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        "user-agent": "AlphaPact-Upbit-Executor/1.0",
      },
      ...(method === "POST" ? { body: JSON.stringify(Object.fromEntries(params)) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
    return readJson(response, operation ?? pathname);
  }

  return Object.freeze({
    getBalances() {
      return request(UPBIT_EXCHANGE_ENDPOINTS.balances, { operation: "balance inquiry" });
    },
    getOpenOrders(input = {}) {
      const params = [];
      if (input.market) params.push(["market", market(input.market)]);
      params.push(["limit", "100"], ["order_by", "desc"]);
      return request(UPBIT_EXCHANGE_ENDPOINTS.openOrders, { params, operation: "open-order inquiry" });
    },
    getClosedOrders(inputMarket) {
      return request(UPBIT_EXCHANGE_ENDPOINTS.closedOrders, {
        params: [["market", market(inputMarket)], ["limit", "20"], ["order_by", "desc"]],
        operation: "closed-order inquiry",
      });
    },
    getOrder({ uuid, identifier: clientIdentifier }) {
      const params = uuid ? [["uuid", String(uuid)]] : [["identifier", identifier(clientIdentifier)]];
      return request(UPBIT_EXCHANGE_ENDPOINTS.order, { params, operation: "order inquiry" });
    },
    getOrderChance(inputMarket) {
      return request(UPBIT_EXCHANGE_ENDPOINTS.orderChance, { params: [["market", market(inputMarket)]], operation: "order availability inquiry" });
    },
    testOrder(input) {
      return request(UPBIT_EXCHANGE_ENDPOINTS.testOrder, { method: "POST", params: orderParameters(input), operation: "order validation" });
    },
    createOrder(input) {
      return request(UPBIT_EXCHANGE_ENDPOINTS.orders, { method: "POST", params: orderParameters(input), operation: "order submission" });
    },
    cancelOrder({ uuid, identifier: clientIdentifier }) {
      const params = uuid ? [["uuid", String(uuid)]] : [["identifier", identifier(clientIdentifier)]];
      return request(UPBIT_EXCHANGE_ENDPOINTS.order, { method: "DELETE", params, operation: "order cancellation" });
    },
  });
}

export function validateExecutorOrder(input, { allowedMarkets = ["KRW-BTC"], maxOrderWon = 10_000 } = {}) {
  const params = orderParameters(input);
  const normalized = Object.fromEntries(params);
  if (!allowedMarkets.includes(normalized.market)) throw new RangeError("MARKET_NOT_ALLOWED");
  if (normalized.side === "bid" && Number(normalized.price) > maxOrderWon) throw new RangeError("ORDER_LIMIT_EXCEEDED");
  return {
    market: normalized.market,
    side: normalized.side,
    ordType: normalized.ord_type,
    price: normalized.price,
    volume: normalized.volume,
    identifier: normalized.identifier,
  };
}
