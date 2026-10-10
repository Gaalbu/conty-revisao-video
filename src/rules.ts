export type Kind = "script" | "video" | "cover" | "caption";
export const KINDS: readonly Kind[] = ["script", "video", "cover", "caption"];

export type VersionStatus = "pending" | "approved";

// Peças exigidas pela campanha cuja versão atual ainda não está aprovada.
// Peça que a campanha não exige não entra, mesmo que exista e esteja pendente.
export function pendingRequired(
  required: readonly Kind[],
  currentByKind: Partial<Record<Kind, { status: VersionStatus }>>,
): Kind[] {
  return required.filter((kind) => currentByKind[kind]?.status !== "approved");
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
