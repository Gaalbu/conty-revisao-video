import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

describe("duração do vídeo", () => {
  let app: ReturnType<typeof createApp>;
  let delivery: string;
  const post = (path: string, payload?: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
  const version = (kind: string, extra: Record<string, unknown> = {}) =>
    post(`/deliveries/${delivery}/pieces/${kind}/versions`, { url: `https://cdn.exemplo/${kind}`, ...extra });

  beforeEach(async () => {
    app = createApp(openDatabase(), () => new Date("2026-06-01T12:00:00.000Z"));
    const campaign = await json<{ id: string }>(post("/campaigns", { required: ["video", "cover"] }));
    delivery = (await json<{ id: string }>(post("/deliveries", { campaign_id: campaign.id }))).id;
  });

  it("aceita comentário de 0 até a duração, inclusive, e recusa além dela com 422", async () => {
    const v1 = await json<{ id: string; duration_seconds: number }>(version("video", { duration_seconds: 30 }));
    expect(v1.duration_seconds).toBe(30);
    expect((await post(`/versions/${v1.id}/comments`, { at_second: 0, body: "início" })).status).toBe(201);
    expect((await post(`/versions/${v1.id}/comments`, { at_second: 30, body: "fim" })).status).toBe(201);
    const beyond = await post(`/versions/${v1.id}/comments`, { at_second: 31, body: "depois do fim" });
    expect(beyond.status).toBe(422);
    expect(await beyond.json()).toMatchObject({ duration_seconds: 30 });
  });

  it("o limite é a duração da versão comentada, não a da atual", async () => {
    const v1 = await json<{ id: string }>(version("video", { duration_seconds: 60 }));
    await version("video", { duration_seconds: 20 });
    expect((await post(`/versions/${v1.id}/comments`, { at_second: 45, body: "na versão longa" })).status).toBe(201);
  });

  it("duração só vale para vídeo e precisa ser inteiro positivo", async () => {
    expect((await version("cover", { duration_seconds: 10 })).status).toBe(400);
    for (const duration_seconds of [0, -5, 12.5, "30"]) {
      expect((await version("video", { duration_seconds })).status).toBe(400);
    }
  });

  it("vídeo sem duração continua aceitando comentário em qualquer segundo seguro", async () => {
    const v1 = await json<{ id: string }>(version("video"));
    expect((await post(`/versions/${v1.id}/comments`, { at_second: 9999, body: "sem duração informada" })).status).toBe(201);
  });
});
