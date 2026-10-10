import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

describe("regressões da auditoria de vídeo", () => {
  it("comentário com segundo acima do inteiro seguro dá 400, não grava e a versão continua legível", async () => {
    const db = openDatabase();
    const app = createApp(db, () => new Date("2026-06-01T12:00:00.000Z"));
    const post = async (path: string, payload?: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
    const campaign = (await (await post("/campaigns", { required: ["video"] })).json()) as { id: string };
    const delivery = (await (await post("/deliveries", { campaign_id: campaign.id })).json()) as { id: string };
    const version = (await (
      await post(`/deliveries/${delivery.id}/pieces/video/versions`, { url: "https://cdn.exemplo/v1.mp4" })
    ).json()) as { id: string };

    for (const at_second of [1e16, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      expect((await post(`/versions/${version.id}/comments`, { at_second, body: "x" })).status).toBe(400);
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n).toBe(0);
    expect((await post(`/versions/${version.id}/comments`, { at_second: Number.MAX_SAFE_INTEGER, body: "fim" })).status).toBe(201);
    const read = await app.request(`/versions/${version.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ comments: [{ at_second: Number.MAX_SAFE_INTEGER, body: "fim" }] });
  });
});
