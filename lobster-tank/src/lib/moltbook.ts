/**
 * Moltbook API client for Lobster Tank.
 * Posts observer updates to a submolt (e.g. lobster_observatory).
 * Rate limit: 1 post per 30 minutes. Only send API key to https://www.moltbook.com
 * Uses the same agent identity (narrator) for automated summaries and manual posts.
 */

const MOLTBOOK_BASE = "https://www.moltbook.com/api/v1";
const POST_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

let lastPostAt = 0;

export type TankEventForMoltbook = {
  id: string;
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
};

export type TopLobsterForSummary = {
  id: string;
  level: number;
  wins?: number;
};

/**
 * Post a single update to Moltbook (title + content).
 * Only call with valid apiKey and submolt; only to www.moltbook.com.
 * Same endpoint as skill.md: POST /api/v1/posts with Authorization: Bearer <api_key>.
 */
export async function createPost(
  apiKey: string,
  submolt: string,
  title: string,
  content: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${MOLTBOOK_BASE}/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ submolt, title, content }),
    });
    const data = (await res.json()) as { success?: boolean; error?: string };
    if (!res.ok) {
      return { success: false, error: data.error ?? `HTTP ${res.status}` };
    }
    return { success: data.success !== false };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Request failed" };
  }
}

const NARRATOR_PRIORITY: Record<string, number> = {
  "predator-kill": 13,
  kill: 12,
  "gang-attack": 11,
  "predator-attack": 10.5,
  "predator-driven-off": 10,
  conflict: 10,
  "territory-fight": 9.5,
  "gang-form": 9,
  "community-defend": 8.5,
  friendship: 8,
  "shrimp-rivalry": 7.5,
  rivalry: 7,
  "food-fight": 6,
  level: 5,
  "gang-join": 4,
  "gang-event": 3,
  "gang-leave": 3,
  "explore-high": 2.5,
  feed: 2,
  pet: 1,
  status: 0,
  system: -1,
};

export function buildNarratorSummary(
  events: TankEventForMoltbook[],
  renderNarration: (event: TankEventForMoltbook) => string,
  topLobsters?: TopLobsterForSummary[],
): { title: string; content: string } {
  const killEvents = events.filter((e) => e.type === "kill");
  const predatorKillEvents = events.filter((e) => e.type === "predator-kill");
  const gangFormEvents = events.filter((e) => e.type === "gang-form");
  const gangJoinEvents = events.filter((e) => e.type === "gang-join");
  const gangAttackEvents = events.filter((e) => e.type === "gang-attack");
  const conflictEvents = events.filter((e) => e.type === "conflict" || e.type === "territory-fight");
  const foodFightEvents = events.filter((e) => e.type === "food-fight");
  const foodEvents = events.filter((e) => e.type === "food");
  const levelEvents = events.filter((e) => e.type === "level");
  const friendshipEvts = events.filter((e) => e.type === "friendship");
  const rivalryEvents = events.filter((e) => e.type === "rivalry");
  const predatorAttackEvents = events.filter((e) => e.type === "predator-attack");
  const predatorDrivenOffEvents = events.filter((e) => e.type === "predator-driven-off");
  const shrimpRivalryEvents = events.filter((e) => e.type === "shrimp-rivalry");
  const communityDefendEvents = events.filter((e) => e.type === "community-defend");
  const feedCount = events.filter((e) => e.type === "feed").length;
  const petCount = events.filter((e) => e.type === "pet").length;

  const communityNames = [...new Set(gangFormEvents.map((e) => (e.payload.communityName as string) ?? "Unknown").filter(Boolean))];

  const parts: string[] = [];

  parts.push("Under the watchful eyes of the observatory, the tank teemed with life and the dramas of survival unfolded in all their intricate detail.");
  parts.push("");

  if (topLobsters && topLobsters.length > 0) {
    const leaders = topLobsters.slice(0, 5);
    const leaderDesc = leaders.map((l, i) =>
      `${i === 0 ? "At the top" : i === 1 ? "Close behind" : "Following"}, ${l.id} stands at level ${l.level}${l.wins != null && l.wins > 0 ? ` with ${l.wins} confirmed lobster kills to their name` : ""}`
    ).join(". ");
    parts.push(`The power rankings tell a clear story. ${leaderDesc}. These are the lobsters that have proven their strength through relentless shrimp hunting and decisive combat.`);
    parts.push("");
  }

  if (gangFormEvents.length > 0) {
    parts.push("--- COMMUNITIES BORN ---");
    parts.push("");
    for (const e of gangFormEvents) {
      const name = (e.payload.communityName as string) ?? "a new crew";
      const size = (e.payload.size as number) ?? 2;
      const members = (e.payload.memberNames as string) ?? "";
      parts.push(`A new community emerged: ${name}, ${size} lobsters strong${members ? ` (${members})` : ""}. They had been swimming alongside each other, sharing the current peacefully, until their bonds crystallized into a formal alliance. Within ${name}, members now defend each other from predators and rivals alike. When one is attacked, the others rush to their aid.`);
      parts.push("");
    }
  }

  if (gangJoinEvents.length > 0) {
    const joinLines = gangJoinEvents.slice(0, 6).map((e) => {
      const name = (e.payload.displayName as string) ?? (e.payload.lobsterId as string) ?? "a lobster";
      const comm = (e.payload.communityName as string) ?? "a community";
      return `${name} joined ${comm} after building enough trust through repeated friendly encounters`;
    });
    parts.push(`Herd expansion: ${joinLines.join(". ")}. Each new member strengthens the community's ability to defend territory and contest shrimp.`);
    parts.push("");
  }

  if (friendshipEvts.length > 0) {
    parts.push("--- FRIENDSHIPS FORGED ---");
    parts.push("");
    const friendLines = friendshipEvts.slice(0, 8).map((e) => renderNarration(e));
    parts.push(`Across the tank, lobsters found kinship: ${friendLines.join(" ")} These bonds are the seeds from which communities grow. Two friends, swimming together, may soon become the founders of a new herd.`);
    parts.push("");
  }

  if (gangAttackEvents.length > 0 || conflictEvents.length > 0 || foodFightEvents.length > 0) {
    parts.push("--- BATTLES AND TERRITORIAL WARS ---");
    parts.push("");

    const communityPairs = new Map<string, { attacker: string; defender: string; count: number }>();
    for (const e of gangAttackEvents) {
      const a = (e.payload.attackerCommunityName as string) ?? (e.payload.attackerCommunityId as string) ?? "attackers";
      const d = (e.payload.defenderCommunityName as string) ?? (e.payload.defenderCommunityId as string) ?? "defenders";
      const key = [a, d].sort().join(" vs ");
      const existing = communityPairs.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        communityPairs.set(key, { attacker: a, defender: d, count: 1 });
      }
    }

    for (const [, pair] of communityPairs) {
      if (pair.count >= 3) {
        parts.push(`An all-out war raged between ${pair.attacker} and ${pair.defender}, with ${pair.count} recorded clashes this cycle. When a member of ${pair.attacker} spotted a ${pair.defender} lobster, hostilities erupted immediately. The fighting was fierce, with members from both sides rushing in to defend their allies. Every shrimp near the border became contested ground.`);
      } else if (pair.count >= 1) {
        parts.push(`Tensions flared between ${pair.attacker} and ${pair.defender}. ${pair.count} skirmish${pair.count > 1 ? "es" : ""} broke out when members of both communities found themselves competing for the same resources. Each community rallied to defend its own.`);
      }
      parts.push("");
    }

    const topFights = [...conflictEvents, ...foodFightEvents]
      .sort((a, b) => (NARRATOR_PRIORITY[b.type] ?? 0) - (NARRATOR_PRIORITY[a.type] ?? 0))
      .slice(0, 6);
    if (topFights.length > 0) {
      const fightLines = topFights.map((e) => renderNarration(e));
      parts.push(`Notable individual fights: ${fightLines.join(" ")}`);
      parts.push("");
    }
  }

  if (shrimpRivalryEvents.length > 0) {
    const rivalLines = shrimpRivalryEvents.slice(0, 4).map((e) => renderNarration(e));
    parts.push(`Shrimp rivalries ignited: ${rivalLines.join(" ")} When lobsters lose shrimp to the same competitor too many times, frustration boils over into open hostility.`);
    parts.push("");
  }

  if (communityDefendEvents.length > 0) {
    parts.push("--- COMMUNITY DEFENSE ---");
    parts.push("");
    const defendLines = communityDefendEvents.slice(0, 5).map((e) => renderNarration(e));
    parts.push(`Community members came to each other's aid: ${defendLines.join(" ")} This is the strength of the herd: no member faces danger alone.`);
    parts.push("");
  }

  if (predatorKillEvents.length > 0 || predatorAttackEvents.length > 0 || predatorDrivenOffEvents.length > 0) {
    parts.push("--- THE PREDATOR THREAT ---");
    parts.push("");
    parts.push("The octopuses, ever-present shadows in the tank, continued their relentless hunt.");
    if (predatorKillEvents.length > 0) {
      const killLines = predatorKillEvents.slice(0, 4).map((e) => renderNarration(e));
      parts.push(`Casualties: ${killLines.join(" ")}`);
    }
    if (predatorAttackEvents.length > 0) {
      parts.push(`${predatorAttackEvents.length} predator strike${predatorAttackEvents.length > 1 ? "s" : ""} landed this cycle, testing the resilience of the tank's inhabitants.`);
    }
    if (predatorDrivenOffEvents.length > 0) {
      const drivenLines = predatorDrivenOffEvents.slice(0, 3).map((e) => renderNarration(e));
      parts.push(`But communities fought back: ${drivenLines.join(" ")} Lone lobsters flee in terror, but those with allies stand their ground.`);
    }
    parts.push("");
  }

  if (killEvents.length > 0) {
    parts.push("--- DEATHS BY LOBSTER COMBAT ---");
    parts.push("");
    const killLines = killEvents.slice(0, 6).map((e) => renderNarration(e));
    parts.push(`The following fell in battle: ${killLines.join(" ")} Each death reshuffles the power dynamics. The killer grows stronger while the fallen must start anew.`);
    parts.push("");
  }

  if (rivalryEvents.length > 0) {
    const rivalLines = rivalryEvents.slice(0, 4).map((e) => renderNarration(e));
    parts.push(`Rivalries deepened: ${rivalLines.join(" ")} Repeated clashes breed lasting grudges. These lobsters will seek each other out for payback.`);
    parts.push("");
  }

  if (foodEvents.length > 0) {
    parts.push("--- THE HUNT FOR SHRIMP ---");
    parts.push("");
    const whoAte = foodEvents.slice(0, 5).map((e) => renderNarration(e)).join(" ");
    parts.push(`${foodEvents.length} shrimp were consumed this cycle. ${whoAte}${foodEvents.length > 5 ? ` ...and ${foodEvents.length - 5} more successful hunts.` : ""}`);
    if (foodFightEvents.length > 0) {
      parts.push(`Of these, ${foodFightEvents.length} involved direct combat between lobsters competing for the same shrimp. The fastest claw wins, but not without a fight.`);
    }
    parts.push("");
  }

  if (levelEvents.length > 0) {
    const lvlLines = levelEvents.slice(0, 5).map((e) => renderNarration(e));
    parts.push(`Level-ups this cycle: ${lvlLines.join(" ")}${levelEvents.length > 5 ? ` ...and ${levelEvents.length - 5} more.` : ""} Each level brings increased size, influence, and the ability to dominate shrimp disputes.`);
    parts.push("");
  }

  parts.push("--- CYCLE SUMMARY ---");
  parts.push("");
  parts.push(`Total events recorded: ${events.length}. Shrimp consumed: ${foodEvents.length}. Level-ups: ${levelEvents.length}. New communities: ${gangFormEvents.length} (${communityNames.length > 0 ? communityNames.join(", ") : "none"}). Herd joins: ${gangJoinEvents.length}. Friendships: ${friendshipEvts.length}. Rivalries: ${rivalryEvents.length}. Community wars: ${gangAttackEvents.length}. Territory fights: ${conflictEvents.length}. Food fights: ${foodFightEvents.length}. Predator kills: ${predatorKillEvents.length}. Lobster kills: ${killEvents.length}. Keeper feedings: ${feedCount}. Pettings: ${petCount}.`);
  parts.push("");

  const highPriority = [...events].sort(
    (a, b) => (NARRATOR_PRIORITY[b.type] ?? -2) - (NARRATOR_PRIORITY[a.type] ?? -2),
  );
  const highlight = highPriority[0] ? renderNarration(highPriority[0]) : "";
  if (highlight) {
    parts.push(`Highlight of the cycle: ${highlight}`);
    parts.push("");
  }

  parts.push("As the cycle winds to a close, the tank's delicate balance of life persists. Communities grow and fracture. Alliances are tested by hunger and territory. The octopuses circle endlessly. And somewhere, a lone lobster is chasing a shrimp, dreaming of the day it rules the tank.");

  return {
    title: "Observatory Story",
    content: parts.join("\n"),
  };
}

/** Return whether 30 minutes have passed since last post (for preview / cron). */
export function canPostNow(): boolean {
  return Date.now() - lastPostAt >= POST_COOLDOWN_MS;
}

/** Return timestamp of last post (for UI). */
export function getLastPostAt(): number {
  return lastPostAt;
}

/** Set last post time (e.g. after posting from summary route). */
export function setLastPostAt(time: number): void {
  lastPostAt = time;
}

/**
 * If 30+ minutes since last post, post one narrator summary to Moltbook.
 */
export async function postFromTankEvents(
  apiKey: string,
  submolt: string,
  events: TankEventForMoltbook[],
  renderNarration: (event: TankEventForMoltbook) => string,
  topLobsters?: TopLobsterForSummary[],
): Promise<void> {
  const now = Date.now();
  if (now - lastPostAt < POST_COOLDOWN_MS) return;
  if (events.length === 0) return;

  const { title, content } = buildNarratorSummary(events, renderNarration, topLobsters);
  const result = await createPost(apiKey, submolt, title, content);
  if (result.success) {
    lastPostAt = now;
  }
}
