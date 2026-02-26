import type { TankEvent, TankEventType } from "@/sim/events";

/** Filter categories for the tank feed. When a filter is off, those events are hidden. */
export type FeedFilterKey =
  | "shrimp"
  | "lobsterFight"
  | "lobsterKill"
  | "lobsterDeath"
  | "octopusKill"
  | "communityAttack"
  | "friendly"
  | "community";

export const FEED_FILTER_LABELS: Record<FeedFilterKey, string> = {
  shrimp: "Shrimp",
  lobsterFight: "Lobster fight",
  lobsterKill: "Lobster kill",
  lobsterDeath: "Lobster death",
  octopusKill: "Octopus kill",
  communityAttack: "Community attacking",
  friendly: "Friendly",
  community: "Community",
};

/** Event types included in each filter. An event is shown if any of its filters is enabled. */
const FILTER_EVENT_TYPES: Record<FeedFilterKey, TankEventType[]> = {
  shrimp: ["food"],
  lobsterFight: ["conflict", "territory-fight", "food-fight", "shrimp-rivalry"],
  lobsterKill: ["kill"],
  lobsterDeath: ["kill", "predator-kill", "respawn"],
  octopusKill: ["predator-attack", "predator-kill"],
  communityAttack: ["gang-attack"],
  friendly: ["friendship", "social"],
  community: ["gang-form", "gang-join", "community-defend"],
};

const EVENT_TYPE_TO_FILTERS = new Map<TankEventType, FeedFilterKey[]>();
for (const [key, types] of Object.entries(FILTER_EVENT_TYPES) as [FeedFilterKey, TankEventType[]][]) {
  for (const t of types) {
    const existing = EVENT_TYPE_TO_FILTERS.get(t) ?? [];
    if (!existing.includes(key)) existing.push(key);
    EVENT_TYPE_TO_FILTERS.set(t, existing);
  }
}

/** Returns which filter keys include this event type. Empty = event is not in any filter (show by default). */
export function getFilterKeysForEventType(type: TankEventType): FeedFilterKey[] {
  return EVENT_TYPE_TO_FILTERS.get(type) ?? [];
}

/** Default: all filters enabled (show everything). */
export const DEFAULT_FEED_FILTERS: Record<FeedFilterKey, boolean> = {
  shrimp: true,
  lobsterFight: true,
  lobsterKill: true,
  lobsterDeath: true,
  octopusKill: true,
  communityAttack: true,
  friendly: true,
  community: true,
};

export type FeedFilterState = Record<FeedFilterKey, boolean>;

/** Filter events: show if type has no filter (other) or at least one of its filters is enabled. */
export function filterTankEvents(
  events: TankEvent[],
  enabled: FeedFilterState,
): TankEvent[] {
  return events.filter((event) => {
    const keys = getFilterKeysForEventType(event.type);
    if (keys.length === 0) return true;
    return keys.some((k) => enabled[k]);
  });
}

export const FEED_FILTER_KEYS: FeedFilterKey[] = Object.keys(DEFAULT_FEED_FILTERS) as FeedFilterKey[];
