import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { describePending, KINDS, parseKinds, pendingRequired } from "./rules.ts";
import type { Kind, VersionStatus } from "./rules.ts";

export type Outcome = { status: 200 | 201 | 400 | 404 | 409 | 422; body: unknown };

type DeliveryRow = { id: string; campaign_id: string; status: "in_production" | "approved"; approved_at: string | null };
type VersionRow = {
  id: string;
  delivery_id: string;
  kind: Kind;
  number: number;
  url: string;
  duration_seconds: number | null;
  status: VersionStatus;
  created_at: string;
  approved_at: string | null;
};
type CommentRow = { id: string; version_id: string; at_second: number; body: string; created_at: string };

const notFound = (what: string): Outcome => ({ status: 404, body: { error: `${what} não encontrada` } });

// BEGIN IMMEDIATE pega o lock de escrita antes de ler: o número da versão nova e
// a lista de peças pendentes não mudam entre a leitura e a gravação, nem quando
// outro processo escreve no mesmo arquivo.
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
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

// Status efetivo: aprovada vence; senão, pedido de alteração registrado; senão pendente.
const VERSION_COLUMNS = `v.id, v.delivery_id, v.kind, v.number, v.url, v.duration_seconds, v.created_at, v.approved_at,
  CASE WHEN v.status = 'approved' THEN 'approved'
       WHEN cr.version_id IS NOT NULL THEN 'changes_requested'
       ELSE 'pending' END AS status`;

function findVersion(db: DatabaseSync, id: string) {
  return db
    .prepare(`SELECT ${VERSION_COLUMNS} FROM versions v LEFT JOIN change_requests cr ON cr.version_id = v.id WHERE v.id = ?`)
    .get(id) as VersionRow | undefined;
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
      `SELECT ${VERSION_COLUMNS} FROM versions v
       LEFT JOIN change_requests cr ON cr.version_id = v.id
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
  // Duração é opcional e só faz sentido em vídeo; quando vem, limita os comentários.
  const duration = input.duration_seconds;
  if (duration !== undefined) {
    if (kind !== "video") return { status: 400, body: { error: "duration_seconds só vale para vídeo" } };
    if (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration <= 0) {
      return { status: 400, body: { error: "duration_seconds deve ser inteiro positivo" } };
    }
  }

  const id = `ver_${randomUUID()}`;
  transaction(db, () => {
    const last = db
      .prepare("SELECT COALESCE(MAX(number), 0) AS n FROM versions WHERE delivery_id = ? AND kind = ?")
      .get(deliveryId, kind) as { n: number | bigint };
    db.prepare(
      `INSERT INTO versions (id, delivery_id, kind, number, url, duration_seconds, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(id, deliveryId, kind, Number(last.n) + 1, url, (duration as number | undefined) ?? null, now.toISOString());
    // Versão nova numa peça exigida desfaz a aprovação; peça que a campanha não
    // pediu não bloqueia, então também não desfaz.
    const current = findDelivery(db, deliveryId)!;
    if (current.status === "approved" && requiredOf(db, current.campaign_id).includes(kind)) {
      db.prepare("UPDATE deliveries SET status = 'in_production', approved_at = NULL WHERE id = ?").run(deliveryId);
      db.prepare("INSERT INTO approval_events (delivery_id, event, at, version_id) VALUES (?, 'invalidated', ?, ?)").run(
        deliveryId,
        now.toISOString(),
        id,
      );
    }
  });
  return { status: 201, body: readVersion(db, id) };
}

export function addComment(db: DatabaseSync, versionId: string, input: Record<string, unknown>, now: Date): Outcome {
  const version = findVersion(db, versionId);
  if (!version) return notFound("versão");
  const second = input.at_second;
  if (typeof second !== "number" || !Number.isSafeInteger(second) || second < 0) {
    return { status: 400, body: { error: "at_second deve ser inteiro seguro maior ou igual a 0" } };
  }
  // O formato errado é 400; passar da duração da versão comentada é regra, 422.
  if (version.duration_seconds !== null && second > version.duration_seconds) {
    return {
      status: 422,
      body: { error: "at_second além da duração da versão", duration_seconds: version.duration_seconds },
    };
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
  return transaction(db, (): Outcome => {
    const version = findVersion(db, versionId);
    if (!version) return notFound("versão");
    const current = currentVersions(db, version.delivery_id)[version.kind];
    if (current?.id !== version.id) {
      return { status: 409, body: { error: "só a versão atual da peça pode ser aprovada" } };
    }
    if (version.status === "changes_requested") {
      return { status: 409, body: { error: "versão com alteração pedida: envie uma versão nova" } };
    }
    if (version.status !== "approved") {
      db.prepare("UPDATE versions SET status = 'approved', approved_at = ? WHERE id = ?").run(now.toISOString(), versionId);
    }
    return { status: 200, body: readVersion(db, versionId) };
  });
}

// A marca pede alteração na versão atual, ainda não aprovada. A versão fica
// bloqueada para aprovação; a resposta do criador é uma versão nova.
export function requestChanges(db: DatabaseSync, versionId: string, input: Record<string, unknown>, now: Date): Outcome {
  return transaction(db, (): Outcome => {
    const version = findVersion(db, versionId);
    if (!version) return notFound("versão");
    const note = typeof input.note === "string" ? input.note.trim() : "";
    if (!note) return { status: 400, body: { error: "nota do pedido de alteração é obrigatória" } };
    const current = currentVersions(db, version.delivery_id)[version.kind];
    if (current?.id !== version.id) return { status: 409, body: { error: "só a versão atual pode receber pedido de alteração" } };
    if (version.status === "approved") return { status: 409, body: { error: "versão aprovada não recebe pedido de alteração" } };
    const existing = db.prepare("SELECT note FROM change_requests WHERE version_id = ?").get(versionId) as
      | { note: string }
      | undefined;
    if (existing) {
      if (existing.note !== note) return { status: 409, body: { error: "versão já tem outro pedido de alteração" } };
      return { status: 200, body: readVersion(db, versionId) };
    }
    db.prepare("INSERT INTO change_requests (version_id, note, requested_at) VALUES (?, ?, ?)").run(
      versionId,
      note,
      now.toISOString(),
    );
    return { status: 201, body: readVersion(db, versionId) };
  });
}

export function approveDelivery(db: DatabaseSync, deliveryId: string, now: Date): Outcome {
  return transaction(db, (): Outcome => {
    const delivery = findDelivery(db, deliveryId);
    if (!delivery) return notFound("entrega");
    const pending = pendingRequired(requiredOf(db, delivery.campaign_id), currentVersions(db, deliveryId));
    if (pending.length > 0) {
      return { status: 409, body: { error: "peça obrigatória sem versão aprovada", pending } };
    }
    if (delivery.status !== "approved") {
      db.prepare("UPDATE deliveries SET status = 'approved', approved_at = ? WHERE id = ?").run(now.toISOString(), deliveryId);
      db.prepare("INSERT INTO approval_events (delivery_id, event, at, version_id) VALUES (?, 'approved', ?, NULL)").run(
        deliveryId,
        now.toISOString(),
      );
    }
    return { status: 200, body: readDelivery(db, deliveryId) };
  });
}

export function readVersion(db: DatabaseSync, versionId: string) {
  const version = findVersion(db, versionId);
  if (!version) return null;
  const comments = db
    .prepare("SELECT * FROM comments WHERE version_id = ? ORDER BY at_second ASC, created_at ASC, id ASC")
    .all(versionId) as CommentRow[];
  const current = currentVersions(db, version.delivery_id)[version.kind];
  const changeRequest = db.prepare("SELECT note, requested_at FROM change_requests WHERE version_id = ?").get(versionId) as
    | { note: string; requested_at: string }
    | undefined;
  return {
    id: version.id,
    delivery_id: version.delivery_id,
    kind: version.kind,
    number: version.number,
    url: version.url,
    duration_seconds: version.duration_seconds,
    status: version.status,
    current: current?.id === version.id,
    change_request: changeRequest ?? null,
    comments: comments.map((c) => ({ id: c.id, at_second: c.at_second, body: c.body })),
  };
}

export function readDelivery(db: DatabaseSync, deliveryId: string) {
  const delivery = findDelivery(db, deliveryId);
  if (!delivery) return null;
  const required = requiredOf(db, delivery.campaign_id);
  const current = currentVersions(db, deliveryId);
  const versions = db
    .prepare(
      `SELECT ${VERSION_COLUMNS} FROM versions v LEFT JOIN change_requests cr ON cr.version_id = v.id
       WHERE v.delivery_id = ? ORDER BY v.kind ASC, v.number ASC`,
    )
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
    // Pagamento é derivado da aprovação: aprovar cedo demais é o que libera
    // pagamento sem o que a marca comprou.
    payment: delivery.status === "approved" ? "liberado" : "retido",
    required,
    pending: pendingRequired(required, current),
    // O motivo de cada pendência fica no GET; o 409 da aprovação mantém o corpo do contrato.
    pending_detail: describePending(required, current),
    approval_history: db
      .prepare("SELECT event, at, version_id FROM approval_events WHERE delivery_id = ? ORDER BY id ASC")
      .all(deliveryId),
    pieces,
  };
}
