import { TankEvent } from "@/sim/events";

const templates = {
  feed: [
    "A keeper fed {displayName}; the lobster took the offering and energy rose.",
    "{displayName} was fed by a keeper — the tank notes the offering.",
    "Feeding: {displayName} received nourishment from a keeper.",
    "A keeper dropped food for {displayName}; the lobster moved in.",
  ],
  pet: [
    "A keeper petted {displayName}. Likeability up.",
    "{displayName} was petted by a keeper.",
    "Petting: {displayName} acknowledged the contact.",
    "A keeper gave {displayName} a gentle touch.",
  ],
  social: [
    "{displayName} and {otherName} lingered nearby. Likeability may have played a role.",
    "{displayName} and {otherName} kept their distance. The tank holds many moods.",
    "{displayName} and {otherName} drifted together for a moment.",
    "{displayName} and {otherName} avoided each other. Boundaries matter.",
    "A brief alliance formed between {displayName} and {otherName}, then faded.",
    "{displayName} and {otherName} circled cautiously before parting.",
  ],
  food: [
    "{displayName} caught and ate a shrimp.",
    "{displayName} ate a shrimp — energy restored.",
    "{displayName} hunted down and ate a shrimp.",
    "{displayName} snapped up a shrimp from the current.",
    "{displayName} claimed a drifting shrimp.",
  ],
  "food-fight": [
    "{winnerName} beat {loserName} to the shrimp and ate it. {winnerName} dealt {damage} damage.",
    "Food fight: {winnerName} won over {loserName} for the shrimp ({damage} damage).",
    "{winnerName} and {loserName} fought for a shrimp; {winnerName} got it after dealing {damage} damage.",
    "{winnerName} took the shrimp from {loserName} (hit for {damage}).",
    "{winnerName} and {loserName} lunged for the same shrimp—{winnerName} won it and dealt {damage} damage.",
    "Shrimp dispute: {winnerName} outmatched {loserName} for the same bite ({damage} damage).",
  ],
  kill: [
    "Killed by lobster: {killerName} killed {victimName}. The fallen respawns.",
    "Death: {victimName} was killed by {killerName} (lobster).",
    "{killerName} defeated {victimName} — killed by lobster. {victimName} is out this round.",
    "{victimName} fell to {killerName}. Killed by lobster. Tank reclaims the fallen.",
    "{killerName} finished {victimName}. Killed by lobster. Respawn incoming.",
  ],
  conflict: [
    "{winnerName} beat {loserName} in a fight.",
    "Fight: {winnerName} won against {loserName}.",
    "{winnerName} attacked {loserName} and prevailed.",
    "Clash: {winnerName} defeated {loserName}.",
    "{winnerName} and {loserName} collided in a clash for territory.",
  ],
  "territory-fight": [
    "{winnerName} and {loserName} fought over territory. {winnerName} dealt {damage} damage.",
    "Territory clash: {winnerName} hit {loserName} for {damage} damage.",
    "{winnerName} struck {loserName} for {damage} damage in a territorial dispute.",
    "{winnerName} and {loserName} clashed; {winnerName} dealt {damage} damage.",
  ],
  "gang-form": [
    "New community {communityName} formed — {size} lobsters banded together after friendly encounters.",
    "{communityName} has formed with {size} members; friendships in the tank crystallized into a herd.",
    "Alliance: {communityName} now has {size} lobsters holding the same patch, drawn by trust.",
    "{communityName} emerged; {memberNames} are now a crew, forged from repeated positive interactions.",
    "From shared shrimp and mutual tolerance, {communityName} was born — {size} lobsters united.",
    "The tank saw a new herd: {communityName}, {size} strong, built on friendship not fear.",
  ],
  "gang-join": [
    "{displayName} joined {communityName} after swimming alongside them and building rapport.",
    "{displayName} joined the community {communityName} — friendships paid off.",
    "{communityName} gained a new member: {displayName} chose the herd after friendly encounters.",
    "{displayName} swam into {communityName} after repeated runs and positive interactions.",
    "{displayName} found kinship with {communityName} and joined the herd.",
  ],
  "gang-leave": [
    "{displayName} left {communityName}.",
    "{displayName} left the community {communityName}.",
    "{communityName} lost {displayName}.",
    "{displayName} broke from {communityName}.",
  ],
  "gang-attack": [
    "Gang fight: {attackerCommunityName} vs {defenderCommunityName}. {outcome}.",
    "{attackerCommunityName} and {defenderCommunityName} clashed. {outcome}.",
    "Community skirmish: {attackerCommunityName} attacked {defenderCommunityName}.",
    "{attackerCommunityName} and {defenderCommunityName} collided over contested food.",
    "Tensions between {attackerCommunityName} and {defenderCommunityName} — {outcome}.",
    "{attackerCommunityName} and {defenderCommunityName} have been clashing; this time {outcome}.",
  ],
  "gang-event": [
    "A shift in {communityName}: the group holds its ground.",
    "{communityName} stirred — territory or tension in the current.",
    "Activity in {communityName}: the currents shift.",
  ],
  friendship: [
    "{displayName} and {otherName} became friends after sharing the current peacefully.",
    "New friendship: {displayName} and {otherName} — a bond that can lead to community.",
    "{displayName} and {otherName} are now friends; such ties often seed new herds.",
    "Bond formed between {displayName} and {otherName}; the tank's social fabric strengthens.",
    "{displayName} and {otherName} struck up a friendship; alliances grow from such moments.",
  ],
  rivalry: [
    "{displayName} and {otherName} became rivals.",
    "Rivalry: {displayName} vs {otherName}.",
    "{displayName} and {otherName} are now rivals.",
    "{displayName} and {otherName} are annoyed at each other after repeated clashes.",
    "Tensions: {displayName} and {otherName} have grown into rivals.",
  ],
  "explore-high": [
    "{displayName} swam up to the high water. Exploration.",
    "{displayName} reached the upper tank. Krill beware.",
    "{displayName} ascended to the shallows.",
  ],
  level: [
    "{displayName} leveled up to level {level}.",
    "{displayName} reached level {level}. Size and influence up.",
    "Level-up: {displayName} is now level {level}.",
  ],
  promotion: [
    "{displayName} is ready for a higher-tier aquarium.",
    "Promotion threshold reached by {displayName}.",
    "{displayName} has earned a move upward. The tank opens.",
    "A promotion signal flashed for {displayName}.",
  ],
  respawn: [
    "{displayName} fell and respawned. A new beginning in the tank.",
    "The tank reclaimed {displayName}; it returns from the depths.",
    "{displayName} re-enters the fray after a brief rest.",
  ],
  "predator-attack": [
    "An octopus struck {lobsterName}.",
    "{lobsterName} was struck by a predator (octopus).",
    "A predator hit {lobsterName}.",
    "{lobsterName} took damage from an octopus.",
  ],
  "predator-kill": [
    "An octopus killed {victimName}. The tank reclaims the fallen.",
    "Killed by octopus: {victimName} was taken by a predator. The tank reclaims the fallen.",
    "A predator (octopus) claimed {victimName}.",
    "{victimName} fell to an octopus.",
  ],
  "predator-driven-off": [
    "{communityName} drove off the predator near {lobsterName}.",
    "The predator was driven off by {communityName} near {lobsterName}.",
    "{communityName} banded together and chased the predator away from {lobsterName}.",
  ],
  "shrimp-rivalry": [
    "{lobsterName} snapped — tired of {rivalName} stealing shrimp. A grudge is born.",
    "{lobsterName} has had enough of {rivalName} snatching food. Now it's personal.",
    "Shrimp rivalry: {lobsterName} vs {rivalName}. Too many stolen meals — hostility declared.",
    "{lobsterName} grew furious at {rivalName} over contested shrimp. Attack mode engaged.",
    "After losing shrimp to {rivalName} repeatedly, {lobsterName} wants payback.",
  ],
  "community-defend": [
    "{defenderName} rushed to defend {allyName} from {attackerName}.",
    "{defenderName} intervened to protect community member {allyName}.",
    "Community defense: {defenderName} came to {allyName}'s aid against {attackerName}.",
  ],
  "predator-killed": [
    "{killerName} drove off the octopus. The predator retreated.",
    "The octopus was driven off by {killerName}. Victory for the tank.",
    "{killerName} defeated the predator — the octopus fled.",
  ],
  status: [
    "{displayName} shows signs of change. The tank adjusts around it.",
    "{displayName} shifted behavior subtly. Observers remain alert.",
    "Status change recorded for {displayName}.",
  ],
  system: [
    "The tank breathes and settles. No guarantees are given.",
    "Background currents stabilize. The cycle continues.",
    "System calm returns. The tank waits.",
  ],
};

const pickTemplate = (choices: string[], seed: number) => {
  if (!choices || choices.length === 0) return "";
  const idx = Number.isFinite(seed) ? Math.abs(seed) % choices.length : 0;
  return choices[idx] ?? choices[0] ?? "";
};

export const renderNarration = (event: TankEvent): string => {
  const seed = event.createdAt;
  const payload = event.payload as Record<string, unknown>;
  const resolvedPayload: Record<string, unknown> = { ...payload };
  if (resolvedPayload.displayName === undefined && payload.lobsterId !== undefined) {
    resolvedPayload.displayName = payload.lobsterId;
  }
  if (resolvedPayload.winnerName === undefined && payload.winnerId !== undefined) {
    resolvedPayload.winnerName = payload.winnerId;
  }
  if (resolvedPayload.loserName === undefined && payload.loserId !== undefined) {
    resolvedPayload.loserName = payload.loserId;
  }
  if (resolvedPayload.otherName === undefined && payload.otherId !== undefined) {
    resolvedPayload.otherName = payload.otherId;
  }
  if (resolvedPayload.killerName === undefined && payload.killerId !== undefined) {
    resolvedPayload.killerName = payload.killerId;
  }
  if (resolvedPayload.victimName === undefined && payload.victimId !== undefined) {
    resolvedPayload.victimName = payload.victimId;
  }
  if (resolvedPayload.lobsterName === undefined && (payload.lobsterId !== undefined || payload.displayName !== undefined)) {
    resolvedPayload.lobsterName = (payload.lobsterName as string) ?? (payload.displayName as string) ?? payload.lobsterId;
  }
  if (resolvedPayload.communityName === undefined && payload.communityId !== undefined) {
    resolvedPayload.communityName = (payload.communityName as string) ?? payload.communityId;
  }
  if (resolvedPayload.attackerCommunityName === undefined && payload.attackerCommunityId !== undefined) {
    resolvedPayload.attackerCommunityName = payload.attackerCommunityId;
  }
  if (resolvedPayload.defenderCommunityName === undefined && payload.defenderCommunityId !== undefined) {
    resolvedPayload.defenderCommunityName = payload.defenderCommunityId;
  }
  if (resolvedPayload.outcome === undefined && (payload.winnerName != null || payload.loserName != null)) {
    resolvedPayload.outcome = `${String(payload.winnerName ?? "Winner")} prevailed over ${String(payload.loserName ?? "loser")}.`;
  }
  // conflict: winner/loser = attacker/defender
  if (resolvedPayload.winnerName === undefined && payload.attackerName !== undefined) resolvedPayload.winnerName = payload.attackerName;
  if (resolvedPayload.winnerName === undefined && payload.attackerId !== undefined) resolvedPayload.winnerName = payload.attackerId;
  if (resolvedPayload.loserName === undefined && payload.defenderName !== undefined) resolvedPayload.loserName = payload.defenderName;
  if (resolvedPayload.loserName === undefined && payload.defenderId !== undefined) resolvedPayload.loserName = payload.defenderId;
  // community-defend: attacker = assailant, ally = ally
  if (resolvedPayload.attackerName === undefined && payload.assailantName !== undefined) resolvedPayload.attackerName = payload.assailantName;
  if (resolvedPayload.attackerName === undefined && payload.assailantId !== undefined) resolvedPayload.attackerName = payload.assailantId;
  if (resolvedPayload.allyName === undefined && payload.allyId !== undefined) resolvedPayload.allyName = (payload.allyName as string) ?? payload.allyId;
  // predator-kill: victim = lobster
  if (resolvedPayload.victimName === undefined && (payload.displayName !== undefined || payload.lobsterId !== undefined)) {
    resolvedPayload.victimName = (payload.displayName as string) ?? payload.lobsterId;
  }
  if (resolvedPayload.victimId === undefined && payload.lobsterId !== undefined) resolvedPayload.victimId = payload.lobsterId;
  // shrimp-rivalry: lobster = loser (who got angry), rival = winner (who stole)
  if (resolvedPayload.lobsterName === undefined && payload.loserName !== undefined) resolvedPayload.lobsterName = payload.loserName;
  if (resolvedPayload.lobsterName === undefined && payload.loserId !== undefined) resolvedPayload.lobsterName = payload.loserId;
  if (resolvedPayload.rivalName === undefined && payload.winnerName !== undefined) resolvedPayload.rivalName = payload.winnerName;
  if (resolvedPayload.rivalName === undefined && payload.winnerId !== undefined) resolvedPayload.rivalName = payload.winnerId;
  // friendship: displayName/otherName from lobster1/lobster2
  if (resolvedPayload.displayName === undefined && (payload.lobster1Name !== undefined || payload.lobster1Id !== undefined)) {
    resolvedPayload.displayName = (payload.lobster1Name as string) ?? payload.lobster1Id;
  }
  if (resolvedPayload.otherName === undefined && (payload.lobster2Name !== undefined || payload.lobster2Id !== undefined)) {
    resolvedPayload.otherName = (payload.lobster2Name as string) ?? payload.lobster2Id;
  }
  // gang-form: memberNames array -> string, size from member count
  if (payload.memberNames !== undefined && Array.isArray(payload.memberNames)) {
    resolvedPayload.memberNames = (payload.memberNames as string[]).join(", ");
  }
  if (resolvedPayload.size === undefined && (payload.memberIds !== undefined || payload.memberNames !== undefined)) {
    const arr = Array.isArray(payload.memberIds) ? payload.memberIds : payload.memberNames;
    resolvedPayload.size = Array.isArray(arr) ? arr.length : undefined;
  }

  if (event.type === "feed") {
    return injectTokens(pickTemplate(templates.feed, seed), resolvedPayload);
  }
  if (event.type === "pet") {
    return injectTokens(pickTemplate(templates.pet, seed), resolvedPayload);
  }
  if (event.type === "conflict") {
    return injectTokens(pickTemplate(templates.conflict, seed), resolvedPayload);
  }
  if (event.type === "territory-fight") {
    return injectTokens(pickTemplate(templates["territory-fight"], seed), resolvedPayload);
  }
  if (event.type === "social") {
    return injectTokens(pickTemplate(templates.social, seed), resolvedPayload);
  }
  if (event.type === "food") {
    return injectTokens(pickTemplate(templates.food, seed), resolvedPayload);
  }
  if (event.type === "food-fight") {
    return injectTokens(pickTemplate(templates["food-fight"], seed), resolvedPayload);
  }
  if (event.type === "kill") {
    return injectTokens(pickTemplate(templates.kill, seed), resolvedPayload);
  }
  if (event.type === "gang-form") {
    return injectTokens(pickTemplate(templates["gang-form"], seed), resolvedPayload);
  }
  if (event.type === "gang-join") {
    return injectTokens(pickTemplate(templates["gang-join"], seed), resolvedPayload);
  }
  if (event.type === "gang-leave") {
    return injectTokens(pickTemplate(templates["gang-leave"], seed), resolvedPayload);
  }
  if (event.type === "gang-attack") {
    return injectTokens(pickTemplate(templates["gang-attack"], seed), resolvedPayload);
  }
  if (event.type === "gang-event") {
    return injectTokens(pickTemplate(templates["gang-event"], seed), resolvedPayload);
  }
  if (event.type === "friendship") {
    return injectTokens(pickTemplate(templates.friendship, seed), resolvedPayload);
  }
  if (event.type === "rivalry") {
    return injectTokens(pickTemplate(templates.rivalry, seed), resolvedPayload);
  }
  if (event.type === "explore-high") {
    return injectTokens(pickTemplate(templates["explore-high"], seed), resolvedPayload);
  }
  if (event.type === "level") {
    return injectTokens(pickTemplate(templates.level, seed), resolvedPayload);
  }
  if (event.type === "promotion") {
    return injectTokens(pickTemplate(templates.promotion, seed), resolvedPayload);
  }
  if (event.type === "respawn") {
    return injectTokens(pickTemplate(templates.respawn, seed), resolvedPayload);
  }
  if (event.type === "predator-attack") {
    return injectTokens(pickTemplate(templates["predator-attack"], seed), resolvedPayload);
  }
  if (event.type === "predator-kill") {
    return injectTokens(pickTemplate(templates["predator-kill"], seed), resolvedPayload);
  }
  if (event.type === "predator-driven-off") {
    return injectTokens(pickTemplate(templates["predator-driven-off"], seed), resolvedPayload);
  }
  if (event.type === "shrimp-rivalry") {
    return injectTokens(pickTemplate(templates["shrimp-rivalry"], seed), resolvedPayload);
  }
  if (event.type === "community-defend") {
    return injectTokens(pickTemplate(templates["community-defend"], seed), resolvedPayload);
  }
  if (event.type === "predator-killed") {
    return injectTokens(pickTemplate(templates["predator-killed"], seed), resolvedPayload);
  }
  if (event.type === "status") {
    return injectTokens(pickTemplate(templates.status, seed), resolvedPayload);
  }
  // Fallback so any event type (except wall collisions — sim does not emit those) still appears in the feed
  const name = String(resolvedPayload.displayName ?? resolvedPayload.victimName ?? resolvedPayload.lobsterName ?? payload.lobsterId ?? "a lobster");
  return `Tank: ${event.type} — ${name}.`;
};

const injectTokens = (template: string, payload: Record<string, unknown>) => {
  if (!template) return "Tank event.";
  return template.replace(/\{(\w+)\}/g, (_, key) =>
    payload[key] !== undefined ? String(payload[key]) : "Unknown",
  );
};
