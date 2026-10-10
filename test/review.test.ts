import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { pendingRequired } from "../src/rules.ts";

type App = ReturnType<typeof createApp>;
type Version = { id: string; number: number; status: string; comments: Array<{ at_second: number; body: string }> };

function post(app: App, path: string, payload?: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("revisão de vídeo", () => {
  let app: App;

  beforeEach(() => {
    app = createApp(openDatabase(), () => new Date("2026-06-01T12:00:00.000Z"));
  });

  async function delivery(required: string[]): Promise<string> {
    const campaign = await json<{ id: string }>(await post(app, "/campaigns", { required }));
    const res = await post(app, "/deliveries", { campaign_id: campaign.id });
    expect(res.status).toBe(201);
    return (await json<{ id: string }>(res)).id;
  }

  async function version(deliveryId: string, kind: string, url: string): Promise<Version> {
    const res = await post(app, `/deliveries/${deliveryId}/pieces/${kind}/versions`, { url });
    expect(res.status).toBe(201);
    return json<Version>(res);
  }

  it("campanha exige vídeo e capa: só o vídeo aprovado, a entrega volta 409 com pending [cover]", async () => {
    const id = await delivery(["video", "cover"]);
    const video = await version(id, "video", "https://cdn.exemplo/v1.mp4");
    expect((await post(app, `/versions/${video.id}/approval`)).status).toBe(200);

    const res = await post(app, `/deliveries/${id}/approval`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "peça obrigatória sem versão aprovada", pending: ["cover"] });
  });

  it("com a capa aprovada a entrega é aprovada", async () => {
    const id = await delivery(["video", "cover"]);
    const video = await version(id, "video", "https://cdn.exemplo/v1.mp4");
    const cover = await version(id, "cover", "https://cdn.exemplo/capa.png");
    await post(app, `/versions/${video.id}/approval`);
    await post(app, `/versions/${cover.id}/approval`);

    const res = await post(app, `/deliveries/${id}/approval`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "approved", pending: [] });
  });

  it("campanha só de vídeo não exige roteiro: roteiro pendente não trava a entrega", async () => {
    const id = await delivery(["video"]);
    await version(id, "script", "https://docs.exemplo/roteiro-v1");
    const video = await version(id, "video", "https://cdn.exemplo/v1.mp4");
    await post(app, `/versions/${video.id}/approval`);

    const res = await post(app, `/deliveries/${id}/approval`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "approved" });
  });

  it("comentário no segundo 12 da versão 1 continua nela depois da versão 2, e a versão 2 nasce sem ele", async () => {
    const id = await delivery(["video"]);
    const v1 = await version(id, "video", "https://cdn.exemplo/v1.mp4");
    expect((await post(app, `/versions/${v1.id}/comments`, { at_second: 12, body: "corta o logo" })).status).toBe(201);
    const v2 = await version(id, "video", "https://cdn.exemplo/v2.mp4");

    const first = await json<Version & { current: boolean }>(await app.request(`/versions/${v1.id}`));
    expect(first.comments).toEqual([expect.objectContaining({ at_second: 12, body: "corta o logo" })]);
    expect(first.current).toBe(false);

    const second = await json<Version & { current: boolean }>(await app.request(`/versions/${v2.id}`));
    expect(second.number).toBe(2);
    expect(second.comments).toEqual([]);
    expect(second.current).toBe(true);
  });

  it("entrega aprovada que recebe vídeo novo volta para in_production e só reaprova com a versão nova aprovada", async () => {
    const id = await delivery(["video"]);
    const v1 = await version(id, "video", "https://cdn.exemplo/v1.mp4");
    await post(app, `/versions/${v1.id}/approval`);
    expect((await post(app, `/deliveries/${id}/approval`)).status).toBe(200);

    const v2 = await version(id, "video", "https://cdn.exemplo/v2.mp4");
    expect((await json<{ status: string }>(await app.request(`/deliveries/${id}`))).status).toBe("in_production");

    const blocked = await post(app, `/deliveries/${id}/approval`);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ pending: ["video"] });

    expect((await post(app, `/versions/${v1.id}/approval`)).status).toBe(409);
    await post(app, `/versions/${v2.id}/approval`);
    expect((await post(app, `/deliveries/${id}/approval`)).status).toBe(200);
  });

  it("recusa peça desconhecida, url inválida e segundo negativo", async () => {
    const id = await delivery(["video"]);
    expect((await post(app, `/deliveries/${id}/pieces/thumbnail/versions`, { url: "https://x/y" })).status).toBe(400);
    expect((await post(app, `/deliveries/${id}/pieces/video/versions`, { url: "não é url" })).status).toBe(400);
    const v1 = await version(id, "video", "https://cdn.exemplo/v1.mp4");
    expect((await post(app, `/versions/${v1.id}/comments`, { at_second: -1, body: "x" })).status).toBe(400);
    expect((await post(app, `/versions/${v1.id}/comments`, { at_second: 1.5, body: "x" })).status).toBe(400);
  });

  it("pendingRequired ignora peça não exigida e lista exigida sem versão", () => {
    expect(pendingRequired(["video", "cover"], { video: { status: "approved" }, script: { status: "pending" } })).toEqual([
      "cover",
    ]);
  });
});
