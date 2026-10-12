import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

type Delivery = {
  status: string;
  payment: string;
  approval_history: Array<{ event: string; at: string; version_id: string | null }>;
};

describe("pagamento e histórico da aprovação", () => {
  let app: ReturnType<typeof createApp>;
  let clock = "2026-06-01T12:00:00.000Z";
  const post = async (path: string, body?: unknown) =>
    (await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

  beforeEach(() => {
    clock = "2026-06-01T12:00:00.000Z";
    app = createApp(openDatabase(), () => new Date(clock));
  });

  it("pagamento fica retido até a entrega ser aprovada, e volta a reter quando versão nova desfaz a aprovação", async () => {
    const campaign = await json<{ id: string }>(post("/campaigns", { required: ["video"] }));
    const delivery = await json<{ id: string }>(post("/deliveries", { campaign_id: campaign.id }));
    const v1 = await json<{ id: string }>(post(`/deliveries/${delivery.id}/pieces/video/versions`, { url: "https://cdn.exemplo/v1.mp4" }));
    expect((await json<Delivery>(app.request(`/deliveries/${delivery.id}`))).payment).toBe("retido");

    await post(`/versions/${v1.id}/approval`);
    clock = "2026-06-02T12:00:00.000Z";
    expect(await json<Delivery>(post(`/deliveries/${delivery.id}/approval`))).toMatchObject({ status: "approved", payment: "liberado" });

    clock = "2026-06-03T12:00:00.000Z";
    const v2 = await json<{ id: string }>(post(`/deliveries/${delivery.id}/pieces/video/versions`, { url: "https://cdn.exemplo/v2.mp4" }));
    const after = await json<Delivery>(app.request(`/deliveries/${delivery.id}`));
    expect(after).toMatchObject({ status: "in_production", payment: "retido" });
    expect(after.approval_history).toEqual([
      { event: "approved", at: "2026-06-02T12:00:00.000Z", version_id: null },
      { event: "invalidated", at: "2026-06-03T12:00:00.000Z", version_id: v2.id },
    ]);

    await post(`/versions/${v2.id}/approval`);
    clock = "2026-06-04T12:00:00.000Z";
    await post(`/deliveries/${delivery.id}/approval`);
    const final = await json<Delivery>(app.request(`/deliveries/${delivery.id}`));
    expect(final.payment).toBe("liberado");
    expect(final.approval_history.map((e) => e.event)).toEqual(["approved", "invalidated", "approved"]);
  });

  it("aprovar de novo uma entrega aprovada não duplica o histórico; versão em peça não exigida não desfaz", async () => {
    const campaign = await json<{ id: string }>(post("/campaigns", { required: ["video"] }));
    const delivery = await json<{ id: string }>(post("/deliveries", { campaign_id: campaign.id }));
    const v1 = await json<{ id: string }>(post(`/deliveries/${delivery.id}/pieces/video/versions`, { url: "https://cdn.exemplo/v1.mp4" }));
    await post(`/versions/${v1.id}/approval`);
    await post(`/deliveries/${delivery.id}/approval`);
    await post(`/deliveries/${delivery.id}/approval`);
    await post(`/deliveries/${delivery.id}/pieces/script/versions`, { url: "https://docs.exemplo/roteiro" });
    const d = await json<Delivery>(app.request(`/deliveries/${delivery.id}`));
    expect(d.approval_history.map((e) => e.event)).toEqual(["approved"]);
    expect(d).toMatchObject({ status: "approved", payment: "liberado" });
  });
});
