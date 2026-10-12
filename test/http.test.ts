import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

type App = ReturnType<typeof createApp>;

describe("entrada HTTP", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: App;
  const raw = (path: string, body: string, contentType = "application/json") =>
    app.request(path, { method: "POST", headers: { "content-type": contentType }, body });
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  beforeEach(() => {
    db = openDatabase();
    app = createApp(db, () => new Date("2026-06-01T12:00:00.000Z"));
  });

  it("JSON inválido é 400 e não grava nada", async () => {
    const res = await raw("/campaigns", '{"required": ["video"');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "JSON inválido" });
    expect(count("campaigns")).toBe(0);
  });

  it("corpo que não é objeto JSON é 400", async () => {
    expect((await raw("/campaigns", '["video"]')).status).toBe(400);
  });

  it("corpo sem Content-Type JSON é 415; com charset é aceito", async () => {
    expect((await raw("/campaigns", '{"required":["video"]}', "text/plain")).status).toBe(415);
    expect((await raw("/campaigns", '{"required":["video"]}', "application/json; charset=utf-8")).status).toBe(201);
  });

  it("campo desconhecido é recusado com 400 e o nome do campo", async () => {
    const res = await raw("/campaigns", '{"required":["video"],"budget":1000}');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "budget" });
    expect(count("campaigns")).toBe(0);
  });

  it("__proto__ no corpo é campo desconhecido", async () => {
    expect((await raw("/campaigns", '{"required":["video"],"__proto__":{"x":1}}')).status).toBe(400);
  });

  it("corpo acima de 64 KB é 413", async () => {
    const res = await raw("/campaigns", JSON.stringify({ required: ["video"], pad: "x".repeat(70 * 1024) }));
    expect(res.status).toBe(413);
  });

  it("aprovações aceitam corpo vazio sem Content-Type", async () => {
    const campaign = (await (await raw("/campaigns", '{"required":["video"]}')).json()) as { id: string };
    const delivery = (await (await raw("/deliveries", JSON.stringify({ campaign_id: campaign.id }))).json()) as { id: string };
    const res = await app.request(`/deliveries/${delivery.id}/approval`, { method: "POST" });
    expect(res.status).toBe(409);
  });
});
