/**
 * Server-side simulation singleton.
 * Ticks the engine every 500ms on the server so the tank is "always online".
 * Persists state to DB every 30 seconds and restores from DB on startup.
 */
import type { TankState, Food, Lobster } from "@/sim/types";
import type { TankEvent } from "@/sim/events";
import {
  createInitialTankState,
  createInitialTankStateFromLobsters,
  createPredators,
  TANK_WALL_MARGIN,
  MAX_SPAWN_ELEVATION,
} from "@/sim/factory";
import type { ApiLobster } from "@/sim/factory";
import { tickTankV2 } from "@/sim/engine-v2";
import { getPrisma } from "@/lib/prisma";
import { getSimDimensions } from "@/lib/sim-config";
import { insertTankEvents } from "@/lib/db-pg";
import { applyTankEventUpdatesToDb } from "@/lib/apply-tank-event-updates";

const SERVER_EVENTS_MAX = 200;

const TANK_SCALE = Math.max(0.25, Math.min(10, Number(process.env.TANK_SCALE) || 1));
const { width: SIM_WIDTH, height: SIM_HEIGHT, lobsterCount: LOBSTER_COUNT } = getSimDimensions(TANK_SCALE);

const TICK_INTERVAL_MS = 500;
const PERSIST_INTERVAL_MS = 30_000;

export type SimEntry = {
  aquariumId: string;
  state: TankState;
  interval: ReturnType<typeof setInterval> | null;
  lastPersist: number;
  lastPersistedEventCreatedAt: number;
  initialized: boolean;
  eventsBuffer: TankEvent[];
};

type SimGlobal = {
  __serverSimByAquarium?: Record<string, SimEntry>;
};

const g = globalThis as unknown as SimGlobal;

function getSimMap(): Record<string, SimEntry> {
  if (!g.__serverSimByAquarium) g.__serverSimByAquarium = {};
  return g.__serverSimByAquarium;
}

function createFreshState(): TankState {
  const base = createInitialTankState(LOBSTER_COUNT, SIM_WIDTH, SIM_HEIGHT, Math.random);
  if (!base.predators || base.predators.length < 3) {
    return { ...base, predators: createPredators(SIM_WIDTH, SIM_HEIGHT, Math.random) };
  }
  return base;
}

async function loadFromDb(aquariumId: string): Promise<TankState | null> {
  try {
    const prisma = getPrisma();
    if (!prisma) return null;
    const snapshot = await prisma.tankSnapshot.findUnique({
      where: { aquariumId },
    });
    if (snapshot?.state) {
      return snapshot.state as unknown as TankState;
    }
  } catch {
    // DB not available or no snapshot
  }
  return null;
}

/** Load claimed lobsters for an aquarium and map to ApiLobster for sim. */
async function loadLobstersFromDb(aquariumId: string): Promise<ApiLobster[]> {
  try {
    const prisma = getPrisma();
    if (!prisma) return [];
    const rows = await prisma.lobster.findMany({
      where: { aquariumId },
      select: {
        id: true,
        displayName: true,
        level: true,
        xp: true,
        size: true,
        wins: true,
        losses: true,
        status: true,
        traits: true,
        communityId: true,
        bodyColor: true,
        clawColor: true,
        bandanaColor: true,
        maxHp: true,
        attackDamage: true,
        friendshipChance: true,
        attackHitChance: true,
        critChance: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      level: r.level,
      xp: r.xp,
      size: r.size,
      wins: r.wins,
      losses: r.losses,
      status: r.status,
      traits: r.traits as ApiLobster["traits"],
      communityId: r.communityId,
      bodyColor: r.bodyColor,
      clawColor: r.clawColor,
      bandanaColor: r.bandanaColor,
      maxHp: r.maxHp,
      attackDamage: r.attackDamage,
      friendshipChance: r.friendshipChance,
      attackHitChance: r.attackHitChance,
      critChance: r.critChance,
    }));
  } catch {
    return [];
  }
}

async function persistToDb(state: TankState, aquariumId: string): Promise<void> {
  try {
    const prisma = getPrisma();
    if (!prisma) return;
    const stateJson = JSON.parse(JSON.stringify(state));
    await prisma.tankSnapshot.upsert({
      where: { aquariumId },
      update: { state: stateJson },
      create: {
        id: aquariumId,
        aquariumId,
        state: stateJson,
      },
    });
  } catch {
    // ignore persistence errors
  }
}

const SIM_STEP_MS = 50;

function tick(sim: SimEntry): void {
  let state = sim.state;
  const now = Date.now();
  let remaining = TICK_INTERVAL_MS;
  const allEvents: ReturnType<typeof tickTankV2>["events"] = [];
  while (remaining >= SIM_STEP_MS) {
    const result = tickTankV2(state, SIM_STEP_MS, Math.random, now);
    state = result.state;
    allEvents.push(...result.events);
    remaining -= SIM_STEP_MS;
  }
  if (remaining > 0) {
    const result = tickTankV2(state, remaining, Math.random, now);
    state = result.state;
    allEvents.push(...result.events);
  }
  sim.state = state;

  if (allEvents.length > 0) {
    sim.eventsBuffer.push(...allEvents);
    if (sim.eventsBuffer.length > SERVER_EVENTS_MAX) {
      sim.eventsBuffer.splice(0, sim.eventsBuffer.length - SERVER_EVENTS_MAX);
    }
  }

  if (now - sim.lastPersist >= PERSIST_INTERVAL_MS) {
    sim.lastPersist = now;
    void persistToDb(sim.state, sim.aquariumId);
    const toPersist = sim.eventsBuffer.filter((e) => e.createdAt > sim.lastPersistedEventCreatedAt);
    if (toPersist.length > 0) {
      const maxCreated = Math.max(...toPersist.map((e) => e.createdAt));
      sim.lastPersistedEventCreatedAt = maxCreated;
      const rows = toPersist.map((e) => ({
        id: e.id,
        type: e.type,
        payload: e.payload,
        createdAt: new Date(e.createdAt),
      }));
      void insertTankEvents(rows);
      void applyTankEventUpdatesToDb(
        toPersist.map((e) => ({
          id: e.id,
          type: e.type,
          createdAt: e.createdAt,
          payload: e.payload,
        })),
      );
    }
  }
}

export function getServerTankEventsSince(since: number, aquariumId: string): TankEvent[] {
  const sim = getSimMap()[aquariumId];
  if (!sim) return [];
  return sim.eventsBuffer.filter((e) => e.createdAt >= since);
}

type LobsterStatPatch = {
  level?: number;
  xp?: number;
  size?: number;
  maxHp?: number;
  /** Temporary combat/haste boost window end (ms since epoch). */
  petBoostUntil?: number;
  /**
   * Heal this percentage of missing HP immediately in the running sim.
   * 0–1, where 1 = fully heal from current health up to maxHp.
   */
  healPercent?: number;
};

/**
 * Sync updated lobster stats (e.g. from feed verification) into the running server sim
 * so in-tank level/size reflect DB changes without waiting for a full reload.
 */
export async function syncLobsterStatsIntoSim(
  lobsterId: string,
  patch: LobsterStatPatch,
  aquariumId?: string,
): Promise<void> {
  const map = getSimMap();
  if (aquariumId && map[aquariumId]) {
    const lobster = map[aquariumId].state.lobsters.find((l) => l.id === lobsterId);
    if (lobster) {
      if (typeof patch.level === "number") lobster.level = patch.level;
      if (typeof patch.xp === "number") lobster.xp = patch.xp;
      if (typeof patch.size === "number") lobster.size = patch.size;
      if (typeof patch.maxHp === "number") lobster.maxHp = patch.maxHp;
      if (typeof patch.petBoostUntil === "number") {
        (lobster as { petBoostUntil?: number }).petBoostUntil = patch.petBoostUntil;
      }
      if (typeof patch.healPercent === "number" && patch.healPercent > 0) {
        const hpMax = lobster.maxHp ?? 100;
        const currentHp = lobster.health ?? hpMax;
        const missing = hpMax - currentHp;
        if (missing > 0) {
          const heal = missing * Math.min(1, patch.healPercent);
          lobster.health = Math.min(hpMax, currentHp + heal);
        }
      }
    }
    return;
  }
  for (const sim of Object.values(map)) {
    const lobster = sim.state.lobsters.find((l) => l.id === lobsterId);
    if (lobster) {
      if (typeof patch.level === "number") lobster.level = patch.level;
      if (typeof patch.xp === "number") lobster.xp = patch.xp;
      if (typeof patch.size === "number") lobster.size = patch.size;
      if (typeof patch.maxHp === "number") lobster.maxHp = patch.maxHp;
      if (typeof patch.petBoostUntil === "number") {
        (lobster as { petBoostUntil?: number }).petBoostUntil = patch.petBoostUntil;
      }
      if (typeof patch.healPercent === "number" && patch.healPercent > 0) {
        const hpMax = lobster.maxHp ?? 100;
        const currentHp = lobster.health ?? hpMax;
        const missing = hpMax - currentHp;
        if (missing > 0) {
          const heal = missing * Math.min(1, patch.healPercent);
          lobster.health = Math.min(hpMax, currentHp + heal);
        }
      }
      return;
    }
  }
}

/** Start from scratch: no preformed communities, force 3D spread for foods and lobster elevations. */
function normalizeState(state: TankState): void {
  state.communities = [];
  state.lostShrimpToWinner = {};
  state.friendlyEncounterCount = {};
  state.lastFriendlyEncounterTime = {};
  const margin = TANK_WALL_MARGIN;
  const { width: defaultW, height: defaultH } = getSimDimensions(TANK_SCALE);
  if (state.width == null || state.width <= 0) state.width = defaultW;
  if (state.height == null || state.height <= 0) state.height = defaultH;
  const innerW = Math.max(100, state.width - margin * 2);
  const innerH = Math.max(100, state.height - margin * 2);
  const rng = Math.random;

  state.lobsters.forEach((l, i) => {
    l.communityId = undefined;
    l.behaviorState = "seeking-food";
    l.hostileTargetId = null;
    l.attackTargetId = null;
    l.lastAttackedById = null;
    l.lastAttackedAt = undefined;
    l.fleeFromId = null;
    l.targetFoodId = null;
    l.elevation = (i * 1.31) % (MAX_SPAWN_ELEVATION + 1) + rng() * 4;
    if (l.elevation > MAX_SPAWN_ELEVATION) l.elevation = MAX_SPAWN_ELEVATION;
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
  state.foods = Array.from({ length: initialFoodCount }, (_, i) => {
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
    } as Food;
  });
  state.lastFoodSpawn = now;
}

async function ensureInitialized(aquariumId: string): Promise<SimEntry> {
  const map = getSimMap();
  const existing = map[aquariumId];
  if (existing?.initialized) return existing;

  let dbState = await loadFromDb(aquariumId);
  if (dbState && (dbState.width !== SIM_WIDTH || dbState.height !== SIM_HEIGHT)) {
    dbState = null;
  }
  let state: TankState;
  if (dbState) {
    state = dbState;
    const emptyForTesting = (dbState as Record<string, unknown>)._emptyForTesting === true;
    if (!emptyForTesting) {
      const apiLobsters = await loadLobstersFromDb(aquariumId);
      const dbIds = new Set(apiLobsters.map((l) => l.id));
      state.lobsters = state.lobsters.filter((l) => dbIds.has(l.id));
      for (const api of apiLobsters) {
        if (!state.lobsters.some((l) => l.id === api.id)) {
          const one = createInitialTankStateFromLobsters([api], state.width, state.height, Math.random);
          if (one.lobsters.length > 0) state.lobsters.push(one.lobsters[0]);
        }
      }
    }
  } else {
    const apiLobsters = await loadLobstersFromDb(aquariumId);
    state = createInitialTankStateFromLobsters(apiLobsters, SIM_WIDTH, SIM_HEIGHT, Math.random);
    normalizeState(state);
  }

  if (!state.predators || state.predators.length < 3) {
    state.predators = createPredators(SIM_WIDTH, SIM_HEIGHT, Math.random);
  }

  const sim: SimEntry = {
    aquariumId,
    state,
    interval: null,
    lastPersist: Date.now(),
    lastPersistedEventCreatedAt: 0,
    initialized: true,
    eventsBuffer: [],
  };

  sim.interval = setInterval(() => tick(sim), TICK_INTERVAL_MS);
  map[aquariumId] = sim;

  return sim;
}

/** Reset tank to match DB only: only claimed lobsters for this aquarium remain; empty if none. */
export async function resetServerTankToFresh(aquariumId: string): Promise<void> {
  const map = getSimMap();
  const sim = map[aquariumId];
  if (sim) sim.eventsBuffer.length = 0;
  const apiLobsters = await loadLobstersFromDb(aquariumId);
  const fresh = createInitialTankStateFromLobsters(apiLobsters, SIM_WIDTH, SIM_HEIGHT, Math.random);
  normalizeState(fresh);
  if (!fresh.predators || fresh.predators.length < 3) {
    fresh.predators = createPredators(SIM_WIDTH, SIM_HEIGHT, Math.random);
  }
  if (sim) {
    sim.state = fresh;
    await persistToDb(sim.state, aquariumId);
  } else {
    await persistToDb(fresh, aquariumId);
  }
}

/** Empty tank (testing): persist state with 0 lobsters and _emptyForTesting flag; next load skips reconcile until inject clears flag. */
export async function resetServerTankToEmpty(aquariumId: string): Promise<void> {
  const map = getSimMap();
  const sim = map[aquariumId];
  if (sim) sim.eventsBuffer.length = 0;
  const fresh = createInitialTankStateFromLobsters([], SIM_WIDTH, SIM_HEIGHT, Math.random);
  normalizeState(fresh);
  if (!fresh.predators || fresh.predators.length < 3) {
    fresh.predators = createPredators(SIM_WIDTH, SIM_HEIGHT, Math.random);
  }
  (fresh as Record<string, unknown>)._emptyForTesting = true;
  if (sim) {
    sim.state = fresh;
    await persistToDb(sim.state, aquariumId);
  } else {
    await persistToDb(fresh, aquariumId);
  }
}

export async function getServerTankState(aquariumId: string): Promise<TankState> {
  const sim = await ensureInitialized(aquariumId);
  return sim.state;
}

/** Seed tank with N test lobsters (bypasses DB). Useful for stress-testing sim. */
export async function seedTestLobsters(aquariumId: string, count: number): Promise<void> {
  const sim = await ensureInitialized(aquariumId);
  sim.eventsBuffer.length = 0;
  const fresh = createInitialTankState(count, SIM_WIDTH, SIM_HEIGHT, Math.random);
  normalizeState(fresh);
  if (!fresh.predators || fresh.predators.length < 3) {
    fresh.predators = createPredators(SIM_WIDTH, SIM_HEIGHT, Math.random);
  }
  (fresh as Record<string, unknown>)._emptyForTesting = true;
  sim.state = fresh;
  void persistToDb(sim.state, aquariumId);
}

/**
 * Add a newly claimed lobster into the running sim for the given aquarium.
 * Pass name and colors so the tank, leaderboard, and feed show them immediately.
 */
export async function injectLobsterIntoSim(
  lobsterId: string,
  displayName?: string | null,
  aquariumId: string = "global",
  options?: { bodyColor?: string | null; clawColor?: string | null },
): Promise<void> {
  const sim = await ensureInitialized(aquariumId);
  const state = sim.state;
  if (state.lobsters.some((l) => l.id === lobsterId)) return;
  const margin = TANK_WALL_MARGIN;
  const innerW = Math.max(1, state.width - margin * 2);
  const innerH = Math.max(1, state.height - margin * 2);
  const rng = Math.random;
  const newLobster: Lobster = {
    id: lobsterId,
    displayName: displayName ?? lobsterId,
    bodyColor: options?.bodyColor ?? undefined,
    clawColor: options?.clawColor ?? undefined,
    position: { x: margin + rng() * innerW, y: margin + rng() * innerH },
    velocity: { x: 0, y: 0 },
    motionMode: "crawl",
    motionTimer: 1 + rng() * 3,
    heading: rng() * Math.PI * 2,
    targetSpeed: 0.35 + rng() * 0.7,
    speedMult: 0.7 + rng() * 0.6,
    elevation: rng() * MAX_SPAWN_ELEVATION,
    pitch: 0,
    size: 1.25 + rng() * 0.75,
    level: 1,
    xp: 0,
    courage: 1,
    likeability: 1,
    status: "Neutral",
    age: 0,
    shrimpEaten: 0,
    health: 100,
    maxHp: 100,
    lobsterKills: 0,
    losses: 0,
    deathsFromLobsters: 0,
    deathsFromOctopuses: 0,
    behaviorState: "seeking-food",
  };
  state.lobsters.push(newLobster);
  (state as Record<string, unknown>)._emptyForTesting = false;
  void persistToDb(state, aquariumId);
}

export async function getServerTankStateSerialized(aquariumId: string): Promise<{
  lobsters: TankState["lobsters"];
  predators: TankState["predators"];
  foods: TankState["foods"];
  communities: TankState["communities"];
  time: number;
  width: number;
  height: number;
  relationships?: TankState["relationships"];
  lostShrimpToWinner?: TankState["lostShrimpToWinner"];
}> {
  const state = await getServerTankState(aquariumId);
  return {
    lobsters: state.lobsters,
    predators: state.predators,
    foods: state.foods ?? [],
    communities: state.communities ?? [],
    time: state.time,
    width: state.width,
    height: state.height,
    relationships: state.relationships,
    lostShrimpToWinner: state.lostShrimpToWinner,
  };
}
