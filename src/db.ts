import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  required_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  status TEXT NOT NULL CHECK (status IN ('in_production', 'approved')),
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id),
  kind TEXT NOT NULL CHECK (kind IN ('script', 'video', 'cover', 'caption')),
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved')),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  UNIQUE (delivery_id, kind, number)
);

-- Pedido de alteração da marca numa versão. Fica numa tabela própria para não
-- mexer no CHECK de status de bancos já criados; o status efetivo é derivado.
CREATE TABLE IF NOT EXISTS change_requests (
  version_id TEXT PRIMARY KEY REFERENCES versions(id),
  note TEXT NOT NULL,
  requested_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id),
  at_second INTEGER NOT NULL CHECK (at_second >= 0),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  // Outra conexão no mesmo arquivo espera o lock de escrita em vez de falhar com
  // "database is locked"; WAL deixa a leitura correr durante a escrita.
  db.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  addMissingColumns(db);
  return db;
}

// Colunas que chegaram depois da primeira versão do schema: bancos já criados
// ganham a coluna, nula, sem perder dados.
function addMissingColumns(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(versions)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "duration_seconds")) {
    db.exec("ALTER TABLE versions ADD COLUMN duration_seconds INTEGER CHECK (duration_seconds > 0)");
  }
}
