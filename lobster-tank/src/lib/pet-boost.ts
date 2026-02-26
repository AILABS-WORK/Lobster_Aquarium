/**
 * Client-side pet boost state: lobster id -> boost end time (ms).
 * Set when /api/me returns lobster.petBoostUntil; read by engine in TankScene.
 */
let petBoostEndByLobsterId: Record<string, number> = {};

export function getPetBoostEndByLobsterId(): Record<string, number> {
  return petBoostEndByLobsterId;
}

export function setPetBoost(lobsterId: string | null, endTimeMs: number | null): void {
  if (!lobsterId) return;
  if (endTimeMs == null) {
    const next = { ...petBoostEndByLobsterId };
    delete next[lobsterId];
    petBoostEndByLobsterId = next;
  } else {
    petBoostEndByLobsterId = { ...petBoostEndByLobsterId, [lobsterId]: endTimeMs };
  }
}

export function setPetBoostFromMe(lobsterId: string | null, petBoostUntil: number | null): void {
  setPetBoost(lobsterId ?? null, petBoostUntil ?? null);
}
