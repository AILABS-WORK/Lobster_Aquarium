/**
 * Narrative weight system and historian preprocessing for Lobster Observatory stories.
 * Detects rivalries, defense clusters, alliances, grudges, level-ups; assigns titles.
 * Only narrative-worthy events are included (no shrimp/food spam).
 */

/** Event types to send to the historian: lobster kills, community formations, community attacks, octopus kills, lobster deaths, level-ups, grudges, etc. Excludes "food" (shrimp eaten) and system noise. */
export const NARRATIVE_EVENT_TYPES = new Set<string>([
  "kill",
  "conflict",
  "territory-fight",
  "food-fight",
  "gang-form",
  "gang-join",
  "gang-leave",
  "gang-attack",
  "gang-event",
  "community-defend",
  "predator-kill",
  "predator-killed",
  "predator-attack",
  "predator-driven-off",
  "respawn",
  "level",
  "promotion",
  "friendship",
  "rivalry",
  "shrimp-rivalry",
  "feed",
  "pet",
  "social",
]);

export function filterNarrativeEvents<T extends { type: string }>(events: T[]): T[] {
  return events.filter((e) => NARRATIVE_EVENT_TYPES.has(e.type) && e.type !== "food");
}

export type TankEventForSummary = {
  id: string;
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
};

const name = (p: Record<string, unknown>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "string" && v) return v;
  }
  return (p.lobsterId ?? p.winnerId ?? p.loserId ?? p.allyId ?? "a lobster") as string;
};

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export type RivalryArc = {
  lobsterA: string;
  lobsterB: string;
  count: number;
  status: "ACTIVE_FEUD" | "ESCALATING_FEUD" | "ENDLESS_DUEL";
  winsA: number;
  winsB: number;
};

export type DefenseCluster = {
  defendedLobster: string;
  defenders: string[];
  count: number;
};

export type GrudgeEvent = {
  who: string;
  against: string;
};

export type LevelUpEvent = {
  lobster: string;
  level: number;
};

export type TitleAssignment = {
  lobster: string;
  title: string;
  reason: string;
};

export type HistorianAnalysis = {
  rivalries: RivalryArc[];
  defenseClusters: DefenseCluster[];
  grudges: GrudgeEvent[];
  levelUps: LevelUpEvent[];
  friendships: { a: string; b: string; joined: boolean }[];
  gangForms: { community: string; founder: string; other: string }[];
  kills: { killer: string; victim: string }[];
  predatorKills: string[];
  /** Lobsters who killed the octopus (predator-killed). */
  predatorKilledBy: string[];
  communityDefenseLines: string[];
  titles: TitleAssignment[];
  leaders: { name: string; level: number; wins: number }[];
  communities: { name: string; members: string[] }[];
  chronologicalSample: string[];
};

const FIGHT_TYPES = ["kill", "conflict", "territory-fight", "food-fight"] as const;

export function analyzeForHistorian(
  events: TankEventForSummary[],
  topLobsters: { id: string; level: number; wins?: number; displayName?: string | null }[],
  communitiesWithMembers: { name: string; id: string; members: string[] }[],
  renderNarration: (e: TankEventForSummary) => string,
): HistorianAnalysis {
  const fightCount = new Map<string, number>();
  const winsByA = new Map<string, number>();
  const winsByB = new Map<string, number>();
  const defenseByAlly = new Map<string, Map<string, number>>();
  const defenderCount = new Map<string, number>();
  const grudges: GrudgeEvent[] = [];
  const levelUps: LevelUpEvent[] = [];
  const friendships: { a: string; b: string; joined: boolean }[] = [];
  const gangForms: { community: string; founder: string; other: string }[] = [];
  const kills: { killer: string; victim: string }[] = [];
  const predatorKills: string[] = [];
  const predatorKilledBy: string[] = [];
  const communityDefenseLines: string[] = [];

  for (const e of events) {
    const p = e.payload;
    if (FIGHT_TYPES.includes(e.type as typeof FIGHT_TYPES[number])) {
      const winner = name(p, "displayName", "winnerName", "killerName", "attackerId", "winnerId");
      const loser = name(p, "otherName", "loserName", "victimName", "defenderId", "loserId");
      if (winner && loser && winner !== loser) {
        const key = pairKey(winner, loser);
        fightCount.set(key, (fightCount.get(key) ?? 0) + 1);
        const [first, second] = key.split("|");
        if (winner === first) {
          winsByA.set(key, (winsByA.get(key) ?? 0) + 1);
        } else {
          winsByB.set(key, (winsByB.get(key) ?? 0) + 1);
        }
      }
    }
    if (e.type === "community-defend") {
      const defender = name(p, "defenderName", "defenderId");
      const ally = name(p, "allyName", "allyId");
      if (defender && ally) {
        let byAlly = defenseByAlly.get(ally);
        if (!byAlly) {
          byAlly = new Map();
          defenseByAlly.set(ally, byAlly);
        }
        byAlly.set(defender, (byAlly.get(defender) ?? 0) + 1);
        defenderCount.set(defender, (defenderCount.get(defender) ?? 0) + 1);
      }
      communityDefenseLines.push(renderNarration(e));
    }
    if (e.type === "gang-attack") {
      communityDefenseLines.push(renderNarration(e));
    }
    if (e.type === "shrimp-rivalry" || e.type === "rivalry") {
      const who = name(p, "lobsterName", "displayName", "loserId");
      const against = name(p, "rivalName", "otherName", "winnerId");
      if (who && against) grudges.push({ who, against });
    }
    if (e.type === "level") {
      const lobster = name(p, "displayName", "lobsterId");
      const level = typeof p.level === "number" ? p.level : 1;
      levelUps.push({ lobster, level });
    }
    if (e.type === "friendship" || e.type === "social") {
      const a = name(p, "displayName", "lobsterId");
      const b = name(p, "otherName", "otherId");
      if (a && b) friendships.push({ a, b, joined: e.type === "friendship" });
    }
    if (e.type === "gang-form") {
      gangForms.push({
        community: (p.communityName as string) ?? "a crew",
        founder: name(p, "displayName", "lobsterId"),
        other: name(p, "otherName", "otherId"),
      });
    }
    if (e.type === "kill") {
      kills.push({
        killer: name(p, "displayName", "winnerName", "winnerId"),
        victim: name(p, "otherName", "loserName", "loserId"),
      });
    }
    if (e.type === "predator-kill") {
      predatorKills.push(name(p, "displayName", "victimName", "lobsterId"));
    }
    if (e.type === "predator-killed") {
      predatorKilledBy.push(name(p, "killerName", "displayName", "killerId"));
    }
  }

  const rivalries: RivalryArc[] = [];
  for (const [key, count] of fightCount) {
    if (count < 2) continue;
    const [a, b] = key.split("|");
    const winsA = winsByA.get(key) ?? Math.floor(count / 2);
    const winsB = winsByB.get(key) ?? count - winsA;
    let status: RivalryArc["status"] = "ACTIVE_FEUD";
    if (count >= 5 && Math.min(winsA, winsB) >= 1) status = "ENDLESS_DUEL";
    else if (count >= 4) status = "ESCALATING_FEUD";
    else if (count >= 3) status = "ACTIVE_FEUD";
    rivalries.push({ lobsterA: a, lobsterB: b, count, status, winsA, winsB });
  }

  const defenseClusters: DefenseCluster[] = [];
  for (const [ally, byDefender] of defenseByAlly) {
    const defenders = [...byDefender.keys()];
    const count = [...byDefender.values()].reduce((s, n) => s + n, 0);
    if (defenders.length >= 1 && count >= 1) {
      defenseClusters.push({ defendedLobster: ally, defenders, count });
    }
  }

  const titles: TitleAssignment[] = [];
  const titleReasons = new Map<string, string>();
  for (const [defender, c] of defenderCount) {
    if (c >= 2 && !titleReasons.has(defender)) {
      titles.push({ lobster: defender, title: "the Shield", reason: "intervened to defend others at least twice" });
      titleReasons.set(defender, "Defender");
    }
  }
  for (const r of rivalries) {
    if (r.count >= 5) {
      for (const lob of [r.lobsterA, r.lobsterB]) {
        if (!titleReasons.has(lob)) {
          titles.push({ lobster: lob, title: "Rival Lord", reason: `repeated feud (${r.count} clashes)` });
          titleReasons.set(lob, "Rival");
        }
      }
    }
  }
  for (const lu of levelUps) {
    if (lu.level >= 15) {
      if (!titleReasons.has(lu.lobster)) {
        titles.push({ lobster: lu.lobster, title: "Deepwater Titan", reason: `reached level ${lu.level}` });
        titleReasons.set(lu.lobster, "Ascended");
      }
    }
  }
  for (const f of friendships) {
    if (f.joined && !titleReasons.has(f.a)) {
      titles.push({ lobster: f.a, title: "Currentwalker", reason: "forged friendship without bloodshed" });
      titleReasons.set(f.a, "Peacebringer");
    }
    if (f.joined && !titleReasons.has(f.b)) {
      titles.push({ lobster: f.b, title: "Currentwalker", reason: "forged friendship without bloodshed" });
      titleReasons.set(f.b, "Peacebringer");
    }
  }

  const chronologicalSample = [...events]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(renderNarration);

  const leaders = topLobsters.slice(0, 10).map((l) => ({
    name: (l.displayName ?? l.id).toString(),
    level: l.level,
    wins: l.wins ?? 0,
  }));

  const communities = communitiesWithMembers.map((c) => ({
    name: c.name,
    members: c.members,
  }));

  return {
    rivalries,
    defenseClusters,
    grudges,
    levelUps,
    friendships,
    gangForms,
    kills,
    predatorKills,
    predatorKilledBy,
    communityDefenseLines,
    titles,
    leaders,
    communities,
    chronologicalSample,
  };
}

export const HISTORIAN_SYSTEM_PROMPT = `LOBSTER OBSERVATORY — HISTORIAN MODE

You are the official historian of the Lobster Observatory. You receive real simulation data: event lists, lobster names, community names, rivalries, and defenses.

CRITICAL — YOU MUST:
- Use ONLY the exact lobster names and community names from the data (e.g. from LEADERS, COMMUNITIES, CHRONOLOGICAL EVENTS). Never invent names like "Clawford", "Shelly", "Pinchy", "Rock Dwellers", "Coral Clan" unless they appear in the data.
- When the data lists leaders, communities, kills, level-ups, or many chronological events, your story MUST name those lobsters and communities and describe those events. Do not write "no leaders" or "no communities" or "the tank was quiet" when the data contains names and events.
- If a section says "None." or "None yet.", do NOT write a long paragraph about absence. Either skip that section in one short sentence or move on. Never invent calm or peace when CHRONOLOGICAL EVENTS contains many entries — the story must be driven by those events.
- Build the narrative in chronological order: use the event list (oldest to newest) so the story reflects what actually happened in sequence.

NARRATIVE RULES:
1. Prioritize LOBSTER KILLS, COMMUNITY FORMATIONS (gang-form), and COMMUNITY ATTACKS (multiple lobsters from one community attacking another community's lobster — use community-defend and gang-attack). These drive the story.
2. Include octopus kills (predator-kill = lobster died to octopus; predator-killed = lobster killed octopus), lobster deaths (kill + respawn), and any sense of communities being wiped out or wars.
3. Focus on EVENT CHAINS: repeated fights = rivalry storyline; multiple defenders for one lobster = alliance; name lobsters and communities.
4. Level-ups, grudges, friendships = turning points. Every paragraph must reference REAL events and REAL names from the data. No generic filler.

STORY STRUCTURE (in order):
1. Opening Atmosphere — tensions/alliances forming (use real names from the data)
2. Rising Conflicts — clashes, defenses (name lobsters and communities)
3. Major Rivalries — repeated fight pairs (name them)
4. Alliance Formation — who defended whom, which communities (name them)
5. Turning Points — grudges, level-ups (name who was involved)
6. Power Balance — who leads, who rose (use LEADERS and level-ups)
7. Current State of the Tank — who leads now, which communities exist, unresolved feuds (use real names only)

STYLE: Documentary historian. Mythic but grounded. Every paragraph must cite specific names and events from the data.`;

export function buildHistorianUserPrompt(analysis: HistorianAnalysis): string {
  const eventCount = analysis.chronologicalSample.length;
  const lines: string[] = [
    `Write a HISTORIAN CHRONICLE using ONLY the data below. Total events in window: ${eventCount}.`,
    "You MUST use the exact lobster names and community names from LEADERS, COMMUNITIES, and the CHRONOLOGICAL EVENTS list. Do not invent names. Do not describe calm or absence when this data contains events and names — your story must reference them.",
    "",
    "=== CHRONOLOGICAL EVENTS (oldest first — build your story from this order) ===",
  ];
  for (const line of analysis.chronologicalSample) {
    lines.push(`- ${line}`);
  }
  lines.push("", "=== LEADERS (current — name these in your story) ===");
  if (analysis.leaders.length > 0) {
    lines.push(analysis.leaders.map((l, i) => `#${i + 1} ${l.name} (level ${l.level}, ${l.wins} wins)`).join(". "));
  } else {
    lines.push("None.");
  }
  lines.push("", "=== COMMUNITIES (name these and their members) ===");
  if (analysis.communities.length > 0) {
    for (const c of analysis.communities) {
      lines.push(`${c.name}: ${c.members.join(", ") || "no members"}`);
    }
  } else {
    lines.push("None yet.");
  }
  lines.push("", "=== TITLES (use when referring to these lobsters) ===");
  if (analysis.titles.length > 0) {
    for (const t of analysis.titles) {
      lines.push(`${t.lobster} → "${t.lobster} ${t.title}" (${t.reason})`);
    }
  } else {
    lines.push("None assigned.");
  }
  lines.push("", "=== RIVALRY ARCS ===");
  if (analysis.rivalries.length > 0) {
    for (const r of analysis.rivalries) {
      lines.push(`${r.lobsterA} vs ${r.lobsterB}: ${r.count} clashes, status ${r.status}. Wins: ${r.winsA}-${r.winsB}.`);
    }
  } else {
    lines.push("None.");
  }
  lines.push("", "=== DEFENSE CLUSTERS ===");
  if (analysis.defenseClusters.length > 0) {
    for (const d of analysis.defenseClusters) {
      lines.push(`${d.defendedLobster} was defended by: ${d.defenders.join(", ")} (${d.count} interventions).`);
    }
  } else {
    lines.push("None.");
  }
  lines.push("", "=== GRUDGES ===");
  if (analysis.grudges.length > 0) {
    for (const g of analysis.grudges) {
      lines.push(`${g.who} declared hostility toward ${g.against}.`);
    }
  } else {
    lines.push("None.");
  }
  lines.push("", "=== LEVEL-UPS ===");
  if (analysis.levelUps.length > 0) {
    const high = analysis.levelUps.filter((l) => l.level >= 14);
    if (high.length > 0) {
      lines.push(high.map((l) => `${l.lobster} reached level ${l.level}`).join(". "));
    }
    lines.push(analysis.levelUps.map((l) => `${l.lobster} → Lv.${l.level}`).join(". "));
  } else {
    lines.push("None.");
  }
  lines.push("", "=== KILLS ===");
  if (analysis.kills.length > 0) {
    lines.push(analysis.kills.map((k) => `${k.killer} killed ${k.victim}`).join(". "));
  } else {
    lines.push("None.");
  }
  lines.push("", "=== PREDATOR KILLS (octopus killed lobster) ===");
  if (analysis.predatorKills.length > 0) {
    lines.push(analysis.predatorKills.join(", ") + " fell to the predator.");
  } else {
    lines.push("None.");
  }
  lines.push("", "=== LOBSTER KILLED OCTOPUS ===");
  if (analysis.predatorKilledBy.length > 0) {
    lines.push(analysis.predatorKilledBy.join(", ") + " slew the predator.");
  } else {
    lines.push("None.");
  }
  lines.push("", "=== FRIENDSHIPS / BONDS ===");
  if (analysis.friendships.length > 0) {
    lines.push(analysis.friendships.map((f) => `${f.a} and ${f.b}${f.joined ? " (joined community)" : ""}`).join(". "));
  } else {
    lines.push("None.");
  }
  lines.push("", "=== NEW COMMUNITIES FORMED ===");
  if (analysis.gangForms.length > 0) {
    lines.push(analysis.gangForms.map((g) => `${g.community} formed by ${g.founder} and ${g.other}`).join(". "));
  } else {
    lines.push("None.");
  }
  lines.push("", "=== COMMUNITY DEFENSE / GANG EVENTS ===");
  if (analysis.communityDefenseLines.length > 0) {
    lines.push(analysis.communityDefenseLines.join(" "));
  } else {
    lines.push("None.");
  }
  return lines.join("\n");
}
