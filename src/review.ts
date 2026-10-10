import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { KINDS, parseKinds, pendingRequired } from "./rules.ts";
import type { Kind, VersionStatus } from "./rules.ts";

export type Outcome = { status: 200 | 201 | 400 | 404 | 409; body: unknown };

type DeliveryRow = { id: string; campaign_id: string; status: "in_production" | "approved"; approved_at: string | null };
type VersionRow = {
  id: string;
  delivery_id: string;
  kind: Kind;
  number: number;
  url: string;
  status: VersionStatus;
  created_at: string;
  approved_at: string | null;
};
type CommentRow = { id: string; version_id: string; at_second: number; body: string; created_at: string };

const notFound = (what: string): Outcome => ({ status: 404, body: { error: `${what} não encontrada` } });

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function findDelivery(db: DatabaseSync, id: string) {
  return db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as DeliveryRow | undefined;
}

function findVersion(db: DatabaseSync, id: string) {
  return db.prepare("SELECT * FROM versions WHERE id = ?").get(id) as VersionRow | undefined;
}

function requiredOf(db: DatabaseSync, campaignId: string): Kind[] {
  const row = db.prepare("SELECT required_json FROM campaigns WHERE id = ?").get(campaignId) as
    | { required_json: string }
    | undefined;
  return row ? (parseKinds(JSON.parse(row.required_json)) ?? []) : [];
}

function currentVersions(db: DatabaseSync, deliveryId: string): Partial<Record<Kind, VersionRow>> {
  const rows = db
    .prepare(
      `SELECT v.* FROM versions v
       WHERE v.delivery_id = ?
         AND v.number = (SELECT MAX(number) FROM versions WHERE delivery_id = v.delivery_id AND kind = v.kind)`,
    )
    .all(deliveryId) as VersionRow[];
  const byKind: Partial<Record<Kind, VersionRow>> = {};
  for (const row of rows) byKind[row.kind] = row;
  return byKind;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function createCampaign(db: DatabaseSync, input: Record<string, unknown>): Outcome {
  const required = parseKinds(input.required);
  if (!required) return { status: 400, body: { error: `required deve listar peças entre ${KINDS.join(", ")}` } };
  const id = `cmp_${randomUUID()}`;
  db.prepare("INSERT INTO campaigns (id, required_json) VALUES (?, ?)").run(id, JSON.stringify(required));
  return { status: 201, body: { id, required } };
}

export function createDelivery(db: DatabaseSync, input: Record<string, unknown>): Outcome {
  const campaignId = typeof input.campaign_id === "string" ? input.campaign_id : "";
  if (!db.prepare("SELECT 1 FROM campaigns WHERE id = ?").get(campaignId)) return notFound("campanha");
  const id = `dlv_${randomUUID()}`;
  db.prepare("INSERT INTO deliveries (id, campaign_id, status) VALUES (?, ?, 'in_production')").run(id, campaignId);
  return { status: 201, body: readDelivery(db, id) };
}

// Versão nova nasce pendente, vira a atual e não herda comentário. Se a entrega
// já estava aprovada, volta para produção até a versão nova ser aprovada.
export function addVersion(
  db: DatabaseSync,
  deliveryId: string,
  kindParam: string,
  input: Record<string, unknown>,
  now: Date,
): Outcome {
  const delivery = findDelivery(db, deliveryId);
  if (!delivery) return notFound("entrega");
  const kind = KINDS.find((k) => k === kindParam);
  if (!kind) return { status: 400, body: { error: `peça desconhecida: use ${KINDS.join(", ")}` } };
  if (!isHttpUrl(input.url)) return { status: 400, body: { error: "url inválida" } };
  const url = input.url;

  const id = `ver_${randomUUID()}`;
  transaction(db, () => {
    const last = db
      .prepare("SELECT COALESCE(MAX(number), 0) AS n FROM versions WHERE delivery_id = ? AND kind = ?")
      .get(deliveryId, kind) as { n: number | bigint };
    db.prepare(
      "INSERT INTO versions (id, delivery_id, kind, number, url, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    ).run(id, deliveryId, kind, Number(last.n) + 1, url, now.toISOString());
    db.prepare("UPDATE deliveries SET status = 'in_production', approved_at = NULL WHERE id = ?").run(deliveryId);
  });
  return { status: 201, body: readVersion(db, id) };
}

export function addComment(db: DatabaseSync, versionId: string, input: Record<string, unknown>, now: Date): Outcome {
  if (!findVersion(db, versionId)) return notFound("versão");
  const second = input.at_second;
  if (typeof second !== "number" || !Number.isSafeInteger(second) || second < 0) {
    return { status: 400, body: { error: "at_second deve ser inteiro seguro maior ou igual a 0" } };
  }
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) return { status: 400, body: { error: "comentário vazio" } };
  db.prepare("INSERT INTO comments (id, version_id, at_second, body, created_at) VALUES (?, ?, ?, ?, ?)").run(
    `cmt_${randomUUID()}`,
    versionId,
    second,
    body,
    now.toISOString(),
  );
  return { status: 201, body: readVersion(db, versionId) };
}

export function approveVersion(db: DatabaseSync, versionId: string, now: Date): Outcome {
  const version = findVersion(db, versionId);
  if (!version) return notFound("versão");
  const current = currentVersions(db, version.delivery_id)[version.kind];
  if (current?.id !== version.id) {
    return { status: 409, body: { error: "só a versão atual da peça pode ser aprovada" } };
  }
  if (version.status !== "approved") {
    db.prepare("UPDATE versions SET status = 'approved', approved_at = ? WHERE id = ?").run(now.toISOString(), versionId);
  }
  return { status: 200, body: readVersion(db, versionId) };
}

export function approveDelivery(db: DatabaseSync, deliveryId: string, now: Date): Outcome {
  const delivery = findDelivery(db, deliveryId);
  if (!delivery) return notFound("entrega");
  const pending = pendingRequired(requiredOf(db, delivery.campaign_id), currentVersions(db, deliveryId));
  if (pending.length > 0) {
    return { status: 409, body: { error: "peça obrigatória sem versão aprovada", pending } };
  }
  if (delivery.status !== "approved") {
    db.prepare("UPDATE deliveries SET status = 'approved', approved_at = ? WHERE id = ?").run(now.toISOString(), deliveryId);
  }
  return { status: 200, body: readDelivery(db, deliveryId) };
}

export function readVersion(db: DatabaseSync, versionId: string) {
  const version = findVersion(db, versionId);
  if (!version) return null;
  const comments = db
    .prepare("SELECT * FROM comments WHERE version_id = ? ORDER BY at_second ASC, created_at ASC, id ASC")
    .all(versionId) as CommentRow[];
  const current = currentVersions(db, version.delivery_id)[version.kind];
  return {
    id: version.id,
    delivery_id: version.delivery_id,
    kind: version.kind,
    number: version.number,
    url: version.url,
    status: version.status,
    current: current?.id === version.id,
    comments: comments.map((c) => ({ id: c.id, at_second: c.at_second, body: c.body })),
  };
}

export function readDelivery(db: DatabaseSync, deliveryId: string) {
  const delivery = findDelivery(db, deliveryId);
  if (!delivery) return null;
  const required = requiredOf(db, delivery.campaign_id);
  const current = currentVersions(db, deliveryId);
  const versions = db
    .prepare("SELECT * FROM versions WHERE delivery_id = ? ORDER BY kind ASC, number ASC")
    .all(deliveryId) as VersionRow[];

  const pieces: Partial<Record<Kind, unknown>> = {};
  for (const kind of KINDS) {
    const ofKind = versions.filter((v) => v.kind === kind);
    if (ofKind.length === 0 && !required.includes(kind)) continue;
    pieces[kind] = {
      required: required.includes(kind),
      current_version_id: current[kind]?.id ?? null,
      versions: ofKind.map((v) => ({ id: v.id, number: v.number, url: v.url, status: v.status })),
    };
  }
  return {
    id: delivery.id,
    campaign_id: delivery.campaign_id,
    status: delivery.status,
    required,
    pending: pendingRequired(required, current),
    pieces,
  };
}
