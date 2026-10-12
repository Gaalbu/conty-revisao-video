import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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
  requestChanges,
} from "./review.ts";
import type { Outcome } from "./review.ts";

export const MAX_BODY_BYTES = 64 * 1024;

type Body = { ok: true; value: Record<string, unknown> } | { ok: false; response: Response };

// Lê o corpo de forma estrita: Content-Type JSON, JSON válido, objeto, e só os
// campos que a rota conhece. Corpo vazio vale como {} (as aprovações não têm corpo).
async function readBody(c: Context, allowed: readonly string[]): Promise<Body> {
  const text = await c.req.text();
  if (!text.trim()) return { ok: true, value: {} };
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    return { ok: false, response: c.json({ error: "corpo precisa ser application/json" }, 415) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, response: c.json({ error: "JSON inválido" }, 400) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, response: c.json({ error: "corpo precisa ser um objeto JSON" }, 400) };
  }
  const unknown = Object.keys(parsed).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    return { ok: false, response: c.json({ error: "campo desconhecido", field: unknown }, 400) };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export function createApp(db: DatabaseSync, now: () => Date = () => new Date()) {
  const app = new Hono();
  const reply = (c: Context, outcome: Outcome) => c.json(outcome.body, outcome.status);

  app.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "corpo acima de 64 KB" }, 413) }));

  app.post("/campaigns", async (c) => {
    const body = await readBody(c, ["required"]);
    return body.ok ? reply(c, createCampaign(db, body.value)) : body.response;
  });
  app.post("/deliveries", async (c) => {
    const body = await readBody(c, ["campaign_id"]);
    return body.ok ? reply(c, createDelivery(db, body.value)) : body.response;
  });
  app.post("/deliveries/:id/pieces/:kind/versions", async (c) => {
    const body = await readBody(c, ["url"]);
    return body.ok ? reply(c, addVersion(db, c.req.param("id"), c.req.param("kind"), body.value, now())) : body.response;
  });
  app.post("/versions/:id/comments", async (c) => {
    const body = await readBody(c, ["at_second", "body"]);
    return body.ok ? reply(c, addComment(db, c.req.param("id"), body.value, now())) : body.response;
  });
  app.post("/versions/:id/change-requests", async (c) => {
    const body = await readBody(c, ["note"]);
    return body.ok ? reply(c, requestChanges(db, c.req.param("id"), body.value, now())) : body.response;
  });
  app.post("/versions/:id/approval", async (c) => {
    const body = await readBody(c, []);
    return body.ok ? reply(c, approveVersion(db, c.req.param("id"), now())) : body.response;
  });
  app.post("/deliveries/:id/approval", async (c) => {
    const body = await readBody(c, []);
    return body.ok ? reply(c, approveDelivery(db, c.req.param("id"), now())) : body.response;
  });

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
