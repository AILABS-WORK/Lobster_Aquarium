import type { TankState } from "@/sim/types";

type Stored = { state: TankState; lobsterCount: number } | null;

const byAquarium = new Map<string, Stored>();

export function getTankState(aquariumId?: string): Stored {
  if (!aquariumId) return byAquarium.get("global") ?? null;
  return byAquarium.get(aquariumId) ?? null;
}

export function setTankState(state: TankState, lobsterCount: number, aquariumId?: string): void {
  const key = aquariumId ?? "global";
  byAquarium.set(key, { state, lobsterCount });
}

export function clearTankState(aquariumId?: string): void {
  if (!aquariumId) {
    byAquarium.clear();
    return;
  }
  byAquarium.delete(aquariumId);
}
