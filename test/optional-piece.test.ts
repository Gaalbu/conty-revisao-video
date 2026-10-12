import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

describe("versão nova em peça não exigida", () => {
  it("não desfaz a aprovação da entrega", async () => {
    const app = createApp(openDatabase(), () => new Date("2026-06-01T12:00:00.000Z"));
    const post = async (path: string, body?: unknown) =>
      (await (await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).json()) as { id: string; status: string };
    const campaign = await post("/campaigns", { required: ["video"] });
    const delivery = await post("/deliveries", { campaign_id: campaign.id });
    const v1 = await post(`/deliveries/${delivery.id}/pieces/video/versions`, { url: "https://cdn.exemplo/v1.mp4" });
    await post(`/versions/${v1.id}/approval`);
    await post(`/deliveries/${delivery.id}/approval`);
    await post(`/deliveries/${delivery.id}/pieces/script/versions`, { url: "https://docs.exemplo/roteiro" });
    expect(((await (await app.request(`/deliveries/${delivery.id}`)).json()) as { status: string }).status).toBe("approved");
  });
});
