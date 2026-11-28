import { parseStrategyDraft, type CatalogStrategy } from "../../../strategy-catalog";

type Environment = { CATALOG: D1Database };

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

async function readDraft(request: Request) {
  if (!request.headers.get("Content-Type")?.includes("application/json")) return;
  const reader = request.body?.getReader();
  if (!reader) return;
  const buffer = new Uint8Array(2_048);
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (length + value.length > buffer.length) {
      await reader.cancel();
      return;
    }
    buffer.set(value, length);
    length += value.length;
  }
  try {
    return parseStrategyDraft(JSON.parse(new TextDecoder().decode(buffer.subarray(0, length))));
  } catch {
    return;
  }
}

export const onRequest: PagesFunction<Environment> = async ({ request, env }) => {
  try {
    if (request.method === "GET") {
      const { results } = await env.CATALOG.prepare(
        "SELECT id, name, creator, scenario FROM demo_strategy ORDER BY created_at DESC, id LIMIT 100",
      ).all<CatalogStrategy>();
      return json({ strategies: results });
    }
    if (request.method !== "POST") {
      return Response.json({ error: "지원하지 않는 요청입니다." }, { status: 405, headers: { Allow: "GET, POST" } });
    }
    if (request.headers.get("Origin") !== new URL(request.url).origin) {
      return json({ error: "체험 화면에서 다시 요청해 주세요." }, 403);
    }
    const draft = await readDraft(request);
    if (!draft) return json({ error: "전략 이름, 제작자 이름과 매매 규칙을 확인해 주세요." }, 400);

    const result = await env.CATALOG.prepare(
      "INSERT INTO demo_strategy (id, name, creator, scenario, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (name, creator, scenario) DO NOTHING",
    ).bind(`demo-${crypto.randomUUID()}`, draft.name, draft.creator, draft.scenario, Date.now()).run();
    const strategy = await env.CATALOG.prepare(
      "SELECT id, name, creator, scenario FROM demo_strategy WHERE name = ? AND creator = ? AND scenario = ?",
    ).bind(draft.name, draft.creator, draft.scenario).first<CatalogStrategy>();
    return json({ strategy }, result.meta.changes ? 201 : 200);
  } catch {
    return json({ error: "전략 마켓에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요." }, 503);
  }
};
