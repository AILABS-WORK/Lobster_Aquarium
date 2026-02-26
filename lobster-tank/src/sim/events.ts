export type TankEventType =
  | "feed"
  | "pet"
  | "conflict"
  | "social"
  | "food"
  | "food-fight"
  | "kill"
  | "level"
  | "promotion"
  | "status"
  | "respawn"
  | "system"
  | "gang-form"
  | "gang-join"
  | "gang-leave"
  | "gang-attack"
  | "gang-event"
  | "friendship"
  | "rivalry"
  | "explore-high"
  | "territory-fight"
  | "predator-attack"
  | "predator-kill"
  | "predator-killed"
  | "predator-driven-off"
  | "shrimp-rivalry"
  | "community-defend";

export type TankEvent = {
  id: string;
  type: TankEventType;
  createdAt: number;
  payload: Record<string, unknown>;
};

export const createEvent = (
  type: TankEventType,
  payload: Record<string, unknown>,
  now: number,
  id: string,
): TankEvent => ({
  id,
  type,
  createdAt: now,
  payload,
});
