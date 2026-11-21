export const tradeLimits = [100, 250, 500, 1000, 2500] as const;
export const dayLimits = [500, 1000, 2500, 5000] as const;
export const durations = [1, 3, 7] as const;
export type PreviewSettings = { tradeLimit: number; dayLimit: number; duration: number };

export function previewSettings(search: string): PreviewSettings {
 const params = new URLSearchParams(search);
 const allowed = (name: string, values: readonly number[], fallback: number) => {
  const value = Number(params.get(name));
  return values.includes(value) ? value : fallback;
 };
 const tradeLimit = allowed("tradeLimit", tradeLimits, 1000);
 return { tradeLimit, dayLimit: Math.max(tradeLimit, allowed("dayLimit", dayLimits, 5000)), duration: allowed("duration", durations, 1) };
}

export function previewEntry(settings: PreviewSettings) {
 const bounded = previewSettings(new URLSearchParams(Object.entries(settings).map(([key, value]) => [key, String(value)])).toString());
 return `/app?${new URLSearchParams(Object.entries(bounded).map(([key, value]) => [key, String(value)]))}`;
}

export function isIntroduction(pathname: string, search: string) {
 return pathname === "/" && !new URLSearchParams(search).has("wallet");
}

export function selectedStrategy(search: string): 0 | 1 {
 return new URLSearchParams(search).get("strategy") === "1" ? 1 : 0;
}

export function appRoute(view: "explore" | "accounts" | "activity" | "help", search: string) {
 const wallet = new URLSearchParams(search).get("wallet");
 const path = view === "explore" ? "/app" : `/${view}`;
 return wallet ? `${path}?${new URLSearchParams({ wallet })}` : path;
}
