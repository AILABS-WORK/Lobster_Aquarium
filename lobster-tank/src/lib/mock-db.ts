import { Lobster } from "@/sim/types";

const lobstersByUser = new Map<string, string>();
const lobsters = new Map<string, Lobster>();
const feedTxHashes = new Set<string>();
const feedEvents = new Map<string, { userId: string; lobsterId: string; amount: number }>();
const communities = new Map<
  string,
  { id: string; name: string; color: string; description?: string }
>();
const communityMembers = new Map<string, string>();
const communityLeaveAt = new Map<string, number>();

const COMMUNITY_LEAVE_COOLDOWN_MS = 1000 * 60 * 5;

const createLobsterId = (index: number) =>
  `LOB-${String(index).padStart(3, "0")}`;

export const claimLobsterForUser = (userId: string) => {
  if (lobstersByUser.has(userId)) {
    return { lobsterId: lobstersByUser.get(userId) ?? null, created: false };
  }

  const lobsterId = createLobsterId(lobsters.size + 1);
  const lobster: Lobster = {
    id: lobsterId,
    position: { x: 120, y: 120 },
    velocity: { x: 8, y: -6 },
    motionMode: "crawl",
    motionTimer: 2,
    heading: 0,
    targetSpeed: 0.5,
    elevation: 0,
    pitch: 0,
    size: 1,
    level: 1,
    xp: 0,
    courage: 1,
    likeability: 1,
    status: "Neutral",
    age: 0,
  };

  lobstersByUser.set(userId, lobsterId);
  lobsters.set(lobsterId, lobster);
  return { lobsterId, created: true };
};

export const getLobsterByUser = (userId: string) => {
  const lobsterId = lobstersByUser.get(userId);
  if (!lobsterId) return null;
  return lobsters.get(lobsterId) ?? null;
};

export const recordFeedEvent = (
  txHash: string,
  userId: string,
  lobsterId: string,
  amount: number,
) => {
  if (feedTxHashes.has(txHash)) {
    return false;
  }
  feedTxHashes.add(txHash);
  feedEvents.set(txHash, { userId, lobsterId, amount });
  return true;
};

export const createCommunity = (name: string, color: string, description?: string) => {
  const id = `community-${communities.size + 1}`;
  communities.set(id, { id, name, color, description });
  return communities.get(id) ?? null;
};

export const joinCommunity = (userId: string, communityId: string, now: number) => {
  if (!communities.has(communityId)) {
    return { ok: false, error: "Community not found" };
  }
  const lastLeave = communityLeaveAt.get(userId);
  if (lastLeave && now - lastLeave < COMMUNITY_LEAVE_COOLDOWN_MS) {
    return { ok: false, error: "Leave cooldown active" };
  }
  if (communityMembers.has(userId)) {
    return { ok: false, error: "Already in a community" };
  }
  communityMembers.set(userId, communityId);
  return { ok: true };
};

export const leaveCommunity = (userId: string, now: number) => {
  if (!communityMembers.has(userId)) {
    return { ok: false, error: "Not in a community" };
  }
  communityMembers.delete(userId);
  communityLeaveAt.set(userId, now);
  return { ok: true };
};
