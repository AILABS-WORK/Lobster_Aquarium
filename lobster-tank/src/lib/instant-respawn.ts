let pendingInstantRespawnLobsterId: string | null = null;

export function getPendingInstantRespawnLobsterId(): string | null {
  return pendingInstantRespawnLobsterId;
}

export function setPendingInstantRespawnLobsterId(id: string | null): void {
  pendingInstantRespawnLobsterId = id;
}
