import type { Community, Lobster, RelationshipCounts } from "@/sim/types";

export type LobsterPosition3D = { x: number; y: number; z: number };

/** Stable empty refs for useSyncExternalStore getServerSnapshot (avoids infinite loop). */
const EMPTY_LOBSTERS: Lobster[] = [];
const EMPTY_POSITIONS: LobsterPosition3D[] = [];
const EMPTY_COMMUNITIES: Community[] = [];
const EMPTY_RELATIONSHIPS: Record<string, RelationshipCounts> = {};

export const getServerSnapshotLobsters = () => EMPTY_LOBSTERS;
export const getServerSnapshotPositions = () => EMPTY_POSITIONS;
export const getServerSnapshotCommunities = () => EMPTY_COMMUNITIES;
export const getServerSnapshotRelationships = () => EMPTY_RELATIONSHIPS;

type Listener = () => void;
let lobsters: Lobster[] = [];
let positions3D: LobsterPosition3D[] = [];
let communities: Community[] = [];
let relationships: Record<string, RelationshipCounts> = {};
/** Key: "loserId-winnerId" = times loser lost a shrimp to winner (aggression buildup). */
let lostShrimpToWinner: Record<string, number> = {};
const listeners = new Set<Listener>();

export const setTankLobsters = (
  next: Lobster[],
  positions?: LobsterPosition3D[],
  nextCommunities?: Community[],
  nextRelationships?: Record<string, RelationshipCounts>,
  nextLostShrimpToWinner?: Record<string, number>,
) => {
  lobsters = next;
  if (positions) positions3D = positions;
  if (nextCommunities !== undefined) communities = nextCommunities;
  if (nextRelationships !== undefined) relationships = nextRelationships;
  if (nextLostShrimpToWinner !== undefined) lostShrimpToWinner = nextLostShrimpToWinner;
  listeners.forEach((l) => l());
};

export const getTankLobsters = () => lobsters;
export const getTankLobsterPositions3D = () => positions3D;
export const getTankCommunities = () => communities;
export const getTankRelationships = () => relationships;
/** Aggression buildup: "loserId-winnerId" -> count. For a lobster L, keys "L-winnerId" mean L lost shrimp to winnerId (L is building aggression towards winner). */
export const getTankLostShrimpToWinner = () => lostShrimpToWinner;

export const subscribeTankLobsters = (listener: Listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
