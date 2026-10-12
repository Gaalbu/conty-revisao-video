import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

describe("versões enviadas ao mesmo tempo por conexões diferentes", () => {
  it("6 threads no mesmo arquivo recebem números de versão distintos e contíguos", async () => {
    const dir = mkdtempSync(join(tmpdir(), "video-"));
    const path = join(dir, "shared.sqlite");
    try {
      const db = openDatabase(path);
      const app = createApp(db);
      const post = async (p: string, body: unknown) =>
        (await (await app.request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as { id: string };
      const campaign = await post("/campaigns", { required: ["video"] });
      const delivery = await post("/deliveries", { campaign_id: campaign.id });

      const flags = new Int32Array(new SharedArrayBuffer(8));
      const results = Array.from({ length: 6 }, () => {
        const worker = new Worker(new URL("./version-worker.ts", import.meta.url), {
          workerData: { path, deliveryId: delivery.id, flags },
          execArgv: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
        });
        return new Promise<{ status: number; body: { number: number } }>((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
        });
      });
      while (Atomics.load(flags, 1) < 6) await new Promise((resolve) => setTimeout(resolve, 5));
      Atomics.store(flags, 0, 1);
      Atomics.notify(flags, 0);

      const replies = await Promise.all(results);
      expect(replies.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
      expect(replies.map((r) => r.body.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
