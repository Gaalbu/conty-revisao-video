import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { describePending } from "../src/rules.ts";

describe("pedido de alteração", () => {
  let app: ReturnType<typeof createApp>;
  const post = (path: string, payload?: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

  async function deliveryWith(required: string[]) {
    const campaign = await json<{ id: string }>(post("/campaigns", { required }));
    return (await json<{ id: string }>(post("/deliveries", { campaign_id: campaign.id }))).id;
  }
  const version = (delivery: string, kind: string, n: number) =>
    json<{ id: string; status: string }>(post(`/deliveries/${delivery}/pieces/${kind}/versions`, { url: `https://cdn.exemplo/${kind}-${n}` }));

  beforeEach(() => {
    app = createApp(openDatabase(), () => new Date("2026-06-01T12:00:00.000Z"));
  });

  it("pedir alteração marca a versão, guarda a nota e impede aprová-la", async () => {
    const id = await deliveryWith(["video"]);
    const v1 = await version(id, "video", 1);
    const res = await post(`/versions/${v1.id}/change-requests`, { note: "logo cortado no segundo 12" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: "changes_requested", change_request: { note: "logo cortado no segundo 12" } });
    expect((await post(`/versions/${v1.id}/approval`)).status).toBe(409);
  });

  it("a entrega fica em produção e o GET diz que a peça teve alteração pedida", async () => {
    const id = await deliveryWith(["video", "cover"]);
    const v1 = await version(id, "video", 1);
    await post(`/versions/${v1.id}/change-requests`, { note: "trocar trilha" });
    const res = await post(`/deliveries/${id}/approval`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "peça obrigatória sem versão aprovada", pending: ["video", "cover"] });
    expect(await json(app.request(`/deliveries/${id}`))).toMatchObject({
      status: "in_production",
      pending_detail: [
        { kind: "video", reason: "alteracao_pedida" },
        { kind: "cover", reason: "sem_versao" },
      ],
    });
  });

  it("a versão nova responde ao pedido: nasce pendente e pode ser aprovada", async () => {
    const id = await deliveryWith(["video"]);
    const v1 = await version(id, "video", 1);
    await post(`/versions/${v1.id}/change-requests`, { note: "trocar trilha" });
    const v2 = await version(id, "video", 2);
    expect(v2.status).toBe("pending");
    expect((await post(`/versions/${v2.id}/approval`)).status).toBe(200);
    expect((await post(`/deliveries/${id}/approval`)).status).toBe(200);
  });

  it("não pede alteração em versão aprovada, substituída ou sem nota", async () => {
    const id = await deliveryWith(["video"]);
    const v1 = await version(id, "video", 1);
    expect((await post(`/versions/${v1.id}/change-requests`, { note: "  " })).status).toBe(400);
    await post(`/versions/${v1.id}/approval`);
    expect((await post(`/versions/${v1.id}/change-requests`, { note: "tarde demais" })).status).toBe(409);
    await version(id, "video", 2);
    expect((await post(`/versions/${v1.id}/change-requests`, { note: "versão antiga" })).status).toBe(409);
  });

  it("repetir o mesmo pedido é idempotente; outro pedido na mesma versão é 409", async () => {
    const id = await deliveryWith(["video"]);
    const v1 = await version(id, "video", 1);
    expect((await post(`/versions/${v1.id}/change-requests`, { note: "a" })).status).toBe(201);
    expect((await post(`/versions/${v1.id}/change-requests`, { note: "a" })).status).toBe(200);
    expect((await post(`/versions/${v1.id}/change-requests`, { note: "b" })).status).toBe(409);
  });

  it("describePending dá o motivo de cada peça exigida, na ordem da campanha", () => {
    expect(
      describePending(["cover", "video", "caption"], {
        video: { status: "changes_requested" },
        caption: { status: "pending" },
        script: { status: "pending" },
      }),
    ).toEqual([
      { kind: "cover", reason: "sem_versao" },
      { kind: "video", reason: "alteracao_pedida" },
      { kind: "caption", reason: "aguardando_revisao" },
    ]);
  });
});
