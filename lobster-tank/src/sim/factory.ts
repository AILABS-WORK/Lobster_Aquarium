import { pickRandomName } from "./names";
import { Food, Lobster as SimLobster, Predator, RandomFn, TankState } from "./types";

/** Sim inner margin so lobsters never touch walls (used by engine + TankScene). */
export const TANK_WALL_MARGIN = 2;

/** Max level in sim so lobsters don't run away to Lv.109+ from old DB XP. */
export const SIM_LEVEL_CAP = 20;

/** Max elevation (sim units) for 3D volume spawn so entities fill the tank. */
export const MAX_SPAWN_ELEVATION = 470;

const PREDATOR_IDS = ["PRED-1", "PRED-2", "PRED-3"] as const;

const TEST_BODY_COLORS = [
  "#c85c42", "#8b2500", "#b03060", "#2e8b57", "#4682b4",
  "#8b6914", "#6a5acd", "#cd5c5c", "#2f4f4f", "#d2691e",
  "#556b2f", "#8b0000",
];
const TEST_CLAW_COLORS = [
  "#a04030", "#6b1c00", "#8b1a4a", "#1b5e20", "#2c5f8a",
  "#6b4f0a", "#4a3fb5", "#a04040", "#1a3a3a", "#a05020",
  "#3e5021", "#6b0000",
];
// Octopus stats: fast enough to catch lobsters (lobsters ~780 u/s), can land hits.
const PREDATOR_MAX_HP = 500;
const PREDATOR_DAMAGE = 45;
const PREDATOR_SPEED = 12000;
const PREDATOR_ATTACK_RADIUS = 24;

export function createPredators(
  width: number,
  height: number,
  rng: RandomFn,
): Predator[] {
  const margin = TANK_WALL_MARGIN;
  const innerW = Math.max(1, width - margin * 2);
  const innerH = Math.max(1, height - margin * 2);
  const jitter = 0.2;
  return PREDATOR_IDS.map((id, i) => {
    const nx = (i + 1) / (PREDATOR_IDS.length + 1) + (rng() - 0.5) * jitter;
    const ny = (i * 0.37 + 0.5) % 1 + (rng() - 0.5) * jitter;
    const nz = (i * 0.23 + 0.33) % 1 + (rng() - 0.5) * jitter;
    return {
      id,
      position: {
        x: margin + Math.max(0, Math.min(1, nx)) * innerW,
        y: margin + Math.max(0, Math.min(1, ny)) * innerH,
      },
      velocity: { x: 0, y: 0 },
      heading: rng() * Math.PI * 2,
      targetLobsterId: null,
      health: PREDATOR_MAX_HP,
      maxHp: PREDATOR_MAX_HP,
      damage: PREDATOR_DAMAGE,
      speed: PREDATOR_SPEED,
      attackRadius: PREDATOR_ATTACK_RADIUS,
      elevation: Math.max(0, Math.min(MAX_SPAWN_ELEVATION, nz * MAX_SPAWN_ELEVATION)),
    };
  });
}

/** API lobster shape returned from GET /api/lobsters (subset of fields). */
export type ApiLobster = {
  id: string;
  displayName?: string | null;
  level: number;
  xp: number;
  size: number;
  wins: number;
  losses: number;
  deathsFromLobsters?: number;
  deathsFromOctopuses?: number;
  status: string;
  traits?: unknown;
  communityId?: string | null;
  bodyColor?: string | null;
  clawColor?: string | null;
  bandanaColor?: string | null;
  maxHp?: number;
  attackDamage?: number;
  friendshipChance?: number;
  attackHitChance?: number;
  critChance?: number;
};

/**
 * Create initial tank state from DB lobsters (claimed only). Used when sim is
 * hydrated from API so only existing lobsters spawn.
 */
export const createInitialTankStateFromLobsters = (
  apiLobsters: ApiLobster[],
  width: number,
  height: number,
  rng: RandomFn,
): TankState => {
  const margin = TANK_WALL_MARGIN;
  const innerW = Math.max(1, width - margin * 2);
  const innerH = Math.max(1, height - margin * 2);
  const traits = (t: unknown): { courage?: number; likeability?: number } =>
    t && typeof t === "object" && "courage" in t && "likeability" in t
      ? { courage: (t as { courage: number }).courage, likeability: (t as { likeability: number }).likeability }
      : { courage: 1, likeability: 1 };

  const n = apiLobsters.length;
  const cols = Math.max(1, Math.ceil(Math.pow(n, 1 / 3)));
  const rows = Math.max(1, Math.ceil(Math.sqrt(n / cols)));
  const layers = Math.max(1, Math.ceil(n / (cols * rows)));
  const stepX = innerW / Math.max(1, cols + 1);
  const stepY = innerH / Math.max(1, rows + 1);
  const stepZ = MAX_SPAWN_ELEVATION / Math.max(1, layers);
  const jitter = 0.55;

  const lobsters: SimLobster[] = apiLobsters.map((api, index) => {
    const layer = Math.floor(index / (cols * rows));
    const rest = index % (cols * rows);
    const row = Math.floor(rest / cols);
    const col = rest % cols;
    const baseX = margin + stepX * (col + 1);
    const baseY = margin + stepY * (row + 1);
    const baseZ = stepZ * (layer + 0.5) + (rng() - 0.5) * stepZ * 0.6;
    const { courage, likeability } = traits(api.traits);
    const level = Math.min(api.level, SIM_LEVEL_CAP);
    const baseMaxHp = 100;
    const perLevel = 20;
    const cappedMaxHp = baseMaxHp + (level - 1) * perLevel;
    const maxX = width - margin;
    const maxY = height - margin;
    return {
      id: api.id,
      position: {
        x: Math.max(margin, Math.min(maxX, baseX + (rng() - 0.5) * stepX * jitter)),
        y: Math.max(margin, Math.min(maxY, baseY + (rng() - 0.5) * stepY * jitter)),
      },
      velocity: { x: 0, y: 0 },
      motionMode: "crawl" as const,
      motionTimer: 1 + rng() * 3,
      heading: rng() * Math.PI * 2,
      targetSpeed: 0.35 + rng() * 0.7,
      speedMult: 0.7 + rng() * 0.6,
      damageMult: 1,
      elevation: Math.max(0, Math.min(MAX_SPAWN_ELEVATION, baseZ)),
      pitch: 0,
      size: api.size,
      level,
      xp: Math.min(api.xp, 999),
      courage: courage ?? 1,
      likeability: likeability ?? 1,
      status: (api.status === "Dominant" || api.status === "Weak" || api.status === "Molting" ? api.status : "Neutral") as SimLobster["status"],
      age: 0,
      shrimpEaten: Math.floor(Math.min(api.xp, 999) / 10) * 10,
      health: Math.min(api.maxHp ?? 100, cappedMaxHp),
      lobsterKills: api.wins,
      losses: api.losses,
      deathsFromLobsters: api.deathsFromLobsters,
      deathsFromOctopuses: api.deathsFromOctopuses,
      displayName: api.displayName ?? api.id,
      communityId: undefined,
      bodyColor: api.bodyColor ?? null,
      clawColor: api.clawColor ?? null,
      maxHp: cappedMaxHp,
      attackDamage: api.attackDamage,
      friendshipChance: api.friendshipChance,
      attackHitChance: api.attackHitChance,
      critChance: api.critChance,
    };
  });

  const now = Date.now();
  const initialFoodCount = 55;
  const foodCols = 5;
  const foodRows = 4;
  const foodLayers = 3;
  const foodStepX = innerW / Math.max(1, foodCols + 1);
  const foodStepY = innerH / Math.max(1, foodRows + 1);
  const foodStepZ = MAX_SPAWN_ELEVATION / Math.max(1, foodLayers);
  const foodJitter = 0.35;
  const foods: Food[] = Array.from({ length: initialFoodCount }, (_, i) => {
    const layer = Math.floor(i / (foodCols * foodRows)) % foodLayers;
    const rest = i % (foodCols * foodRows);
    const row = Math.floor(rest / foodCols);
    const col = rest % foodCols;
    const baseX = margin + foodStepX * (col + 1);
    const baseY = margin + foodStepY * (row + 1);
    const baseZ = foodStepZ * (layer + 0.5) + (rng() - 0.5) * foodStepZ * 0.6;
    return {
      id: `food-initial-${now}-${i}`,
      position: {
        x: baseX + (rng() - 0.5) * foodStepX * foodJitter,
        y: baseY + (rng() - 0.5) * foodStepY * foodJitter,
      },
      velocity: { x: 0, y: 0 },
      heading: rng() * Math.PI * 2,
      elevation: Math.max(0, Math.min(MAX_SPAWN_ELEVATION, baseZ)),
      targetElevation: 0,
      createdAt: now,
      ttlMs: 60000,
    };
  });

  return {
    width,
    height,
    time: now,
    lobsters,
    predators: createPredators(width, height, rng),
    communities: [],
    foods,
    lastFoodSpawn: now,
  };
}

export const createInitialTankState = (
  count: number,
  width: number,
  height: number,
  rng: RandomFn,
): TankState => {
  const usedNames = new Set<string>();
  const margin = TANK_WALL_MARGIN;
  const innerW = Math.max(1, width - margin * 2);
  const innerH = Math.max(1, height - margin * 2);
  const cols = Math.max(1, Math.ceil(Math.pow(count, 1 / 3)));
  const rows = Math.max(1, Math.ceil(Math.sqrt(count / cols)));
  const layers = Math.max(1, Math.ceil(count / (cols * rows)));
  const stepX = innerW / Math.max(1, cols + 1);
  const stepY = innerH / Math.max(1, rows + 1);
  const stepZ = MAX_SPAWN_ELEVATION / Math.max(1, layers);
  const jitter = 0.55;
  const lobsters = Array.from({ length: count }, (_, index) => {
    const layer = Math.floor(index / (cols * rows));
    const rest = index % (cols * rows);
    const row = Math.floor(rest / cols);
    const col = rest % cols;
    const baseX = margin + stepX * (col + 1);
    const baseY = margin + stepY * (row + 1);
    const baseZ = stepZ * (layer + 0.5) + (rng() - 0.5) * stepZ * 0.6;
    const id = `LOB-${String(index + 1).padStart(3, "0")}`;
    const displayName = pickRandomName(rng, usedNames, index);
    usedNames.add(displayName);
    const maxX = width - margin;
    const maxY = height - margin;
    return {
      id,
      position: {
        x: Math.max(margin, Math.min(maxX, baseX + (rng() - 0.5) * stepX * jitter)),
        y: Math.max(margin, Math.min(maxY, baseY + (rng() - 0.5) * stepY * jitter)),
      },
      velocity: {
        x: 0,
        y: 0,
      },
      motionMode: "crawl" as const,
      motionTimer: 1 + rng() * 3,
      heading: rng() * Math.PI * 2,
      targetSpeed: 0.35 + rng() * 0.7,
      speedMult: 0.7 + rng() * 0.6,
      damageMult: 1,
      elevation: Math.max(0, Math.min(MAX_SPAWN_ELEVATION, baseZ)),
      pitch: 0,
      size: 1.25 + rng() * 0.75,
      level: Math.min(SIM_LEVEL_CAP, 1 + Math.floor(rng() * 8)),
      xp: 0,
      courage: 0.5 + rng() * 1.5,
      likeability: 0.5 + rng() * 1.5,
      status: "Neutral" as const,
      age: 0,
      shrimpEaten: 0,
      health: 100 + index * 4,
      maxHp: 100 + index * 4,
      lobsterKills: 0,
      losses: 0,
      deathsFromLobsters: 0,
      deathsFromOctopuses: 0,
      displayName,
      bodyColor: TEST_BODY_COLORS[index % TEST_BODY_COLORS.length],
      clawColor: TEST_CLAW_COLORS[index % TEST_CLAW_COLORS.length],
    };
  });

  const now = Date.now();
  const initialFoodCount = 55;
  const foodCols = 5;
  const foodRows = 4;
  const foodLayers = 3;
  const foodStepX = innerW / Math.max(1, foodCols + 1);
  const foodStepY = innerH / Math.max(1, foodRows + 1);
  const foodStepZ = MAX_SPAWN_ELEVATION / Math.max(1, foodLayers);
  const foodJitter = 0.35;
  const foods: Food[] = Array.from({ length: initialFoodCount }, (_, i) => {
    const layer = Math.floor(i / (foodCols * foodRows)) % foodLayers;
    const rest = i % (foodCols * foodRows);
    const row = Math.floor(rest / foodCols);
    const col = rest % foodCols;
    const baseX = margin + foodStepX * (col + 1);
    const baseY = margin + foodStepY * (row + 1);
    const baseZ = foodStepZ * (layer + 0.5) + (rng() - 0.5) * foodStepZ * 0.6;
    return {
      id: `food-initial-${now}-${i}`,
      position: {
        x: baseX + (rng() - 0.5) * foodStepX * foodJitter,
        y: baseY + (rng() - 0.5) * foodStepY * foodJitter,
      },
      velocity: { x: 0, y: 0 },
      heading: rng() * Math.PI * 2,
      elevation: Math.max(0, Math.min(MAX_SPAWN_ELEVATION, baseZ)),
      targetElevation: 0,
      createdAt: now,
      ttlMs: 60000,
    };
  });

  return {
    width,
    height,
    time: now,
    lobsters,
    predators: createPredators(width, height, rng),
    communities: [],
    foods,
    lastFoodSpawn: now,
  };
};
