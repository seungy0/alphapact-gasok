// A separate allowlisted workflow. No live order or cancellation method is called here.
export const SPOT_MARKETS = Object.freeze(["KRW-BTC", "KRW-ETH"]);

function decimal(value) {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,18})?$/.test(text)) throw new Error("UPBIT_RESPONSE_INVALID");
  return text;
}

function orderView(order) {
  if (!order || typeof order.uuid !== "string" || !["bid", "ask"].includes(order.side) ||
      !SPOT_MARKETS.includes(order.market) || !["wait", "watch", "done", "cancel"].includes(order.state)) {
    throw new Error("UPBIT_RESPONSE_INVALID");
  }
  return {
    uuid: order.uuid, market: order.market, side: order.side, state: order.state,
    createdAt: order.created_at, executedVolume: decimal(order.executed_volume ?? "0"),
    remainingVolume: decimal(order.remaining_volume ?? "0"), paidFee: decimal(order.paid_fee ?? "0"),
  };
}

export function createSpotPilot({ upbit, mode, markets, maxOrderWon, now = Date.now }) {
  const supported = markets.filter(market => SPOT_MARKETS.includes(market));
  if (!supported.length) throw new Error("SPOT_MARKETS_REQUIRED");
  return {
    async sync() {
      const balances = await upbit.getBalances();
      if (!Array.isArray(balances)) throw new Error("UPBIT_RESPONSE_INVALID");
      const currencies = new Set(["KRW", ...supported.map(market => market.slice(4))]);
      const assets = balances.filter(item => currencies.has(item.currency)).map(item => ({
        currency: item.currency, available: decimal(item.balance), locked: decimal(item.locked),
      }));
      const orders = [];
      for (const market of supported) {
        const open = await upbit.getOpenOrders({ market });
        const closed = await upbit.getClosedOrders(market);
        if (!Array.isArray(open) || !Array.isArray(closed)) throw new Error("UPBIT_RESPONSE_INVALID");
        orders.push(...open.map(orderView), ...closed.map(orderView));
      }
      return { venue: "UPBIT_KR", mode, markets: supported, maxOrderWon: Math.min(maxOrderWon, 10_000),
        assets, orders, orderCoverage: "LATEST_20_CLOSED_PER_MARKET_PLUS_OPEN_FIRST_100", syncedAt: new Date(now()).toISOString() };
    },
    async validate(input) {
      if (mode === "READ_ONLY") throw new Error("ORDER_VALIDATION_DISABLED");
      if (!input || !supported.includes(input.market) || input.side !== "bid" || input.ordType !== "price" ||
          input.volume !== undefined || !/^[a-zA-Z0-9_-]{8,64}$/.test(input.identifier ?? "")) throw new Error("SPOT_ORDER_INVALID");
      if (typeof input.price !== "string" || !/^\d+$/.test(input.price) ||
          ![5_000, 10_000].includes(Number(input.price)) || Number(input.price) > Math.min(maxOrderWon, 10_000)) {
        throw new Error("ORDER_LIMIT_EXCEEDED");
      }
      await upbit.testOrder({ market: input.market, side: "bid", ordType: "price", price: input.price, identifier: input.identifier });
      // A dry-run UUID is deliberately discarded: it is neither an order nor a fill.
      return { venue: "UPBIT_KR", mode: "ORDER_VALIDATION", validated: true, submitted: false,
        market: input.market, side: "bid", amountWon: Number(input.price), checkedAt: new Date(now()).toISOString() };
    },
  };
}
