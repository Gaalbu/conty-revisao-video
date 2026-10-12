export type Kind = "script" | "video" | "cover" | "caption";
export const KINDS: readonly Kind[] = ["script", "video", "cover", "caption"];

export type VersionStatus = "pending" | "changes_requested" | "approved";

// Peças exigidas pela campanha cuja versão atual ainda não está aprovada.
// Peça que a campanha não exige não entra, mesmo que exista e esteja pendente.
export function pendingRequired(
  required: readonly Kind[],
  currentByKind: Partial<Record<Kind, { status: VersionStatus }>>,
): Kind[] {
  return required.filter((kind) => currentByKind[kind]?.status !== "approved");
}

export type PendingReason = "sem_versao" | "aguardando_revisao" | "alteracao_pedida";

// O mesmo critério de pendingRequired, com o motivo de cada peça: sem versão,
// versão atual esperando revisão, ou versão atual com alteração pedida.
export function describePending(
  required: readonly Kind[],
  currentByKind: Partial<Record<Kind, { status: VersionStatus }>>,
): Array<{ kind: Kind; reason: PendingReason }> {
  return pendingRequired(required, currentByKind).map((kind) => {
    const status = currentByKind[kind]?.status;
    const reason: PendingReason =
      status === undefined ? "sem_versao" : status === "changes_requested" ? "alteracao_pedida" : "aguardando_revisao";
    return { kind, reason };
  });
}

export function parseKinds(value: unknown): Kind[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const kinds: Kind[] = [];
  for (const item of value) {
    const kind = KINDS.find((k) => k === item);
    if (!kind) return null;
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}
