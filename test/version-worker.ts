import { workerData, parentPort } from "node:worker_threads";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

// Uma conexão própria por thread, no mesmo arquivo. Espera o sinal de largada
// para todas enviarem a versão ao mesmo tempo.
const { path, deliveryId, flags } = workerData as { path: string; deliveryId: string; flags: Int32Array };
const app = createApp(openDatabase(path));
Atomics.add(flags, 1, 1);
Atomics.wait(flags, 0, 0);
const res = await app.request(`/deliveries/${deliveryId}/pieces/video/versions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "https://cdn.exemplo/concorrente.mp4" }),
});
parentPort?.postMessage({ status: res.status, body: await res.json() });
