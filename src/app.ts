import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  addComment,
  addVersion,
  approveDelivery,
  approveVersion,
  createCampaign,
  createDelivery,
  readDelivery,
  readVersion,
} from "./review.ts";
import type { Outcome } from "./review.ts";

async function body(c: Context): Promise<Record<string, unknown>> {
  const parsed: unknown = await c.req.json().catch(() => ({}));
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

export function createApp(db: DatabaseSync, now: () => Date = () => new Date()) {
  const app = new Hono();
  const reply = (c: Context, outcome: Outcome) => c.json(outcome.body, outcome.status);

  app.post("/campaigns", async (c) => reply(c, createCampaign(db, await body(c))));
  app.post("/deliveries", async (c) => reply(c, createDelivery(db, await body(c))));
  app.post("/deliveries/:id/pieces/:kind/versions", async (c) =>
    reply(c, addVersion(db, c.req.param("id"), c.req.param("kind"), await body(c), now())),
  );
  app.post("/versions/:id/comments", async (c) => reply(c, addComment(db, c.req.param("id"), await body(c), now())));
  app.post("/versions/:id/approval", (c) => reply(c, approveVersion(db, c.req.param("id"), now())));
  app.post("/deliveries/:id/approval", (c) => reply(c, approveDelivery(db, c.req.param("id"), now())));

  app.get("/deliveries/:id", (c) => {
    const delivery = readDelivery(db, c.req.param("id"));
    return delivery ? c.json(delivery) : c.json({ error: "entrega não encontrada" }, 404);
  });
  app.get("/versions/:id", (c) => {
    const version = readVersion(db, c.req.param("id"));
    return version ? c.json(version) : c.json({ error: "versão não encontrada" }, 404);
  });

  return app;
}
