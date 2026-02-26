/**
 * Tank simulation engine — behavior rewrite from scratch.
 * Spec: Octopus lock-on until kill/death; Lobster priority = closest shrimp, touch-to-eat,
 * 5 stolen shrimp → attack; community defense; flee octopus; fight until <30% HP then flee to community.
 * Shrimp flee to empty space; instant respawn when eaten.
 */
import { createEvent, TankEvent } from "./events";
import { resolveConflict } from "./conflict";
import { SIM_LEVEL_CAP, TANK_WALL_MARGIN } from "./factory";
import { applyFeedEffects, applyPetEffects } from "./traits";
import type { RelationshipCounts } from "./types";
import { Community, Food, Lobster, Predator, RandomFn, TankState, Vector2 } from "./types";

export const GANG_FORM_MAX = 5;

const COMMUNITY_NAMES = [
  "Pearl Ring", "Deep Current", "Rust Claw", "Coral Guard",
  "Shale Band", "Briny Pact", "Silt Crew", "Reef Watch",
];
const COMMUNITY_COLORS = [
  "#0d9488", "#d97706", "#475569", "#be123c",
  "#4f46e5", "#059669", "#7c3aed", "#0369a1",
];

export type EngineConfig = {
  maxSpeed: number;
  driftStrength: number;
  collisionPadding: number;
  conflictRadius: number;
  overcrowdingThreshold: number;
  tensionChance: number;
  socialChance: number;
  socialRadius: number;
  petBoostEndByLobsterId?: Record<string, number>;
};

/** Max elevation (sim units) for spawns so entities fill the 3D tank volume. */
const MAX_SPAWN_ELEVATION = 65;

export const defaultConfig: EngineConfig = {
  maxSpeed: 26 * 30 * 5000,
  driftStrength: 0.5,
  collisionPadding: 2,
  conflictRadius: 80,
  overcrowdingThreshold: 40,
  tensionChance: 0.006,
  socialChance: 0.42,
  socialRadius: 110,
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const SPATIAL_CELL_SIZE = 50;

function buildLobsterGrid(lobsters: Lobster[], state: TankState): Map<string, Lobster[]> {
  const grid = new Map<string, Lobster[]>();
  const margin = TANK_WALL_MARGIN;
  const minX = margin;
  const minY = margin;
  for (const l of lobsters) {
    const cx = Math.floor((l.position.x - minX) / SPATIAL_CELL_SIZE);
    const cy = Math.floor((l.position.y - minY) / SPATIAL_CELL_SIZE);
    const key = `${cx},${cy}`;
    let cell = grid.get(key);
    if (!cell) {
      cell = [];
      grid.set(key, cell);
    }
    cell.push(l);
  }
  return grid;
}

function getLobstersNearPosition(
  x: number,
  y: number,
  grid: Map<string, Lobster[]>,
): Lobster[] {
  const margin = TANK_WALL_MARGIN;
  const cx = Math.floor((x - margin) / SPATIAL_CELL_SIZE);
  const cy = Math.floor((y - margin) / SPATIAL_CELL_SIZE);
  const out: Lobster[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const key = `${cx + dx},${cy + dy}`;
      const cell = grid.get(key);
      if (cell) out.push(...cell);
    }
  }
  return out;
}

const length = (vec: Vector2) => Math.hypot(vec.x, vec.y);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const randomBetween = (rng: RandomFn, min: number, max: number) =>
  min + (max - min) * rng();

function limitSpeed(vec: Vector2, maxSpeed: number): Vector2 {
  const s = length(vec);
  if (s <= maxSpeed) return vec;
  const f = maxSpeed / s;
  return { x: vec.x * f, y: vec.y * f };
}

/** Cumulative shrimp needed to reach level. */
export const shrimpToReachLevel = (nextLevel: number): number => {
  return (nextLevel - 1) * 5;
};

export function getFriendshipChance(
  _relationships: Record<string, RelationshipCounts>,
  _id1: string,
  _id2: string,
): number {
  return 0.5;
}

export function getAttackChance(
  _relationships: Record<string, RelationshipCounts>,
  _id1: string,
  _id2: string,
): number {
  return 0.1;
}

const randomPosition = (state: TankState, rng: RandomFn): Vector2 => {
  const margin = TANK_WALL_MARGIN;
  return {
    x: margin + rng() * (state.width - margin * 2),
    y: margin + rng() * (state.height - margin * 2),
  };
};

function spawnPositionFurthestFromLobsters(
  state: TankState,
  lobsters: Lobster[],
  foods: Food[],
  rng: RandomFn,
): Vector2 {
  const margin = TANK_WALL_MARGIN;
  const innerW = state.width - margin * 2;
  const innerH = state.height - margin * 2;
  const SAMPLE_COUNT = 20;
  let bestPos = randomPosition(state, rng);
  let bestScore = -Infinity;
  for (let s = 0; s < SAMPLE_COUNT; s++) {
    const pos = {
      x: margin + rng() * innerW,
      y: margin + rng() * innerH,
    };
    let minLobsterSq = Infinity;
    for (const l of lobsters) {
      const dx = l.position.x - pos.x;
      const dy = l.position.y - pos.y;
      const dSq = dx * dx + dy * dy;
      if (dSq < minLobsterSq) minLobsterSq = dSq;
    }
    let minFoodSq = Infinity;
    for (const f of foods) {
      const dx = f.position.x - pos.x;
      const dy = f.position.y - pos.y;
      const dSq = dx * dx + dy * dy;
      if (dSq < minFoodSq) minFoodSq = dSq;
    }
    const score = (Number.isFinite(minLobsterSq) ? minLobsterSq : 0) * 1.5 +
      (Number.isFinite(minFoodSq) ? minFoodSq : 0) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      bestPos = pos;
    }
  }
  return bestPos;
}

function findNearestFood(lobster: Lobster, foods: Food[], radius: number): Food | null {
  let nearest: Food | null = null;
  const radiusSq = radius * radius;
  let bestDistSq = radiusSq;
  for (const food of foods) {
    const dx = food.position.x - lobster.position.x;
    const dy = food.position.y - lobster.position.y;
    const dz = (food.elevation ?? 0) - (lobster.elevation ?? 0);
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      nearest = food;
    }
  }
  return nearest;
}

/** Like findNearestFood but when lobster has a community, prefers shrimp no nearby ally is closer to (spread out). */
function findBestFoodForLobster(
  lobster: Lobster,
  foods: Food[],
  radius: number,
  lobsters: Lobster[],
  lobsterGrid: Map<string, Lobster[]>,
): Food | null {
  const radiusSq = radius * radius;
  const allies = lobster.communityId
    ? getLobstersNearPosition(lobster.position.x, lobster.position.y, lobsterGrid).filter(
        (l) => l.id !== lobster.id && l.communityId === lobster.communityId && (l.health ?? 100) > 0,
      )
    : [];
  let best: Food | null = null;
  let bestDistSq = radiusSq;
  for (const food of foods) {
    const dx = food.position.x - lobster.position.x;
    const dy = food.position.y - lobster.position.y;
    const dz = (food.elevation ?? 0) - (lobster.elevation ?? 0);
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq >= bestDistSq) continue;
    if (allies.length > 0) {
      const myDist = Math.sqrt(distSq);
      const allyCloser = allies.some((ally) => {
        const adx = food.position.x - ally.position.x;
        const ady = food.position.y - ally.position.y;
        const adz = (food.elevation ?? 0) - (ally.elevation ?? 0);
        const aDist = Math.hypot(adx, ady, adz);
        return aDist < myDist - 5;
      });
      if (allyCloser) continue;
    }
    bestDistSq = distSq;
    best = food;
  }
  return best ?? findNearestFood(lobster, foods, radius);
}

/** Steer away from walls so lobsters don't hug corners when they have no goal. */
function wallRepelVector(x: number, y: number, state: TankState): Vector2 {
  const m = TANK_WALL_MARGIN;
  const w = state.width;
  const h = state.height;
  const pad = 60;
  let vx = 0;
  let vy = 0;
  if (x < m + pad) vx += 1;
  if (x > w - m - pad) vx -= 1;
  if (y < m + pad) vy += 1;
  if (y > h - m - pad) vy -= 1;
  const len = Math.hypot(vx, vy) || 1;
  return { x: vx / len, y: vy / len };
}

const MAX_DELTA_MS = 50;
const RESPAWN_DELAY_MS = 20000;
const FOOD_EAT_RADIUS = 3;
/** Lobsters seek shrimp within this radius so they don't sit at walls with no goal. */
const FOOD_ATTRACT_RADIUS = 520;
const LOST_SHRIMP_TO_ATTACK = 5;
const SAME_SHRIMP_VERY_CLOSE_RADIUS = 18;
const PREDATOR_CHASE_RADIUS = 180;
const PREDATOR_ATTACK_COOLDOWN_MS = 400;
const PREDATOR_AID_RADIUS = 120;
const LOBSTER_ATTACK_RADIUS = 16;
const FLEE_HP_PCT = 0.30;
const SHRIMP_FLEE_SPEED = 4;
const SHRIMP_WALL_STEER = 0.2;
const MAX_FOOD = 600;
const FOOD_SPAWN_MS = 400;
const FOOD_SPAWN_BATCH = 18;
const XP_LOSS_ON_DEATH = 15;

const pairKey = (idA: string, idB: string) =>
  idA < idB ? `${idA}-${idB}` : `${idB}-${idA}`;

function ensureCommunity(state: TankState, lobster: Lobster, rng: RandomFn): string {
  if (lobster.communityId) return lobster.communityId;
  const idx = (state.communities?.length ?? 0) % COMMUNITY_NAMES.length;
  const name = COMMUNITY_NAMES[idx];
  const color = COMMUNITY_COLORS[idx];
  const id = `comm-${name.replace(/\s/g, "-")}-${Date.now()}-${rng().toString(36).slice(2, 6)}`;
  const community: Community = { id, name, color };
  if (!state.communities) state.communities = [];
  state.communities.push(community);
  lobster.communityId = id;
  return id;
}

function nearbyAllies(lobster: Lobster, lobsters: Lobster[], radius: number): Lobster[] {
  if (!lobster.communityId) return [];
  const out: Lobster[] = [];
  const r2 = radius * radius;
  for (const other of lobsters) {
    if (other.id === lobster.id) continue;
    if (other.communityId !== lobster.communityId) continue;
    const dx = other.position.x - lobster.position.x;
    const dy = other.position.y - lobster.position.y;
    if (dx * dx + dy * dy <= r2) out.push(other);
  }
  return out;
}

function distSq(a: { position: Vector2 }, b: { position: Vector2 }): number {
  const dx = b.position.x - a.position.x;
  const dy = b.position.y - a.position.y;
  return dx * dx + dy * dy;
}

/** Prune state maps to prevent unbounded memory growth. */
function pruneStateMaps(state: TankState, now: number): void {
  const MAX_KEYS = 500;
  const MAX_AGE_MS = 10 * 60 * 1000; // 10 min
  const prune = (map: Record<string, unknown>, ageKey?: Record<string, number>) => {
    const keys = Object.keys(map);
    if (keys.length <= MAX_KEYS) return;
    const sorted = ageKey
      ? keys.sort((a, b) => (ageKey[b] ?? 0) - (ageKey[a] ?? 0))
      : keys;
    for (let i = MAX_KEYS; i < sorted.length; i++) {
      delete map[sorted[i]];
    }
  };
  if (state.relationships && Object.keys(state.relationships).length > MAX_KEYS)
    prune(state.relationships as Record<string, unknown>);
  if (state.lostShrimpToWinner && Object.keys(state.lostShrimpToWinner).length > MAX_KEYS)
    prune(state.lostShrimpToWinner as Record<string, unknown>);
}

export const tickTank = (
  state: TankState,
  deltaMs: number,
  rng: RandomFn,
  now: number,
  config: EngineConfig = defaultConfig,
): { state: TankState; events: TankEvent[] } => {
  const cappedDelta = Math.min(deltaMs, MAX_DELTA_MS);
  const dt = Math.max(0.001, cappedDelta / 1000);
  const margin = TANK_WALL_MARGIN;
  const events: TankEvent[] = [];

  const lobsters = state.lobsters;
  const predators = state.predators ?? [];
  if (!state.predators) state.predators = [];
  let foods = state.foods;
  if (!state.foods) state.foods = [];

  state.relationships ??= {};
  state.lostShrimpToWinner ??= {};
  const lostShrimpToWinner = state.lostShrimpToWinner;
  const relationships = state.relationships;
  const getRel = (key: string) => {
    if (!relationships[key]) relationships[key] = { likes: 0, conflicts: 0 };
    return relationships[key];
  };

  for (const l of lobsters) {
    l.age += cappedDelta;
    l.shrimpEaten ??= 0;
    l.health ??= 100;
    l.maxHp ??= 100;
    l.lobsterKills ??= 0;
    l.deathsFromLobsters ??= 0;
    l.deathsFromOctopuses ??= 0;
    l.hostileTargetId ??= null;
    l.respawnAt ??= null;
    l.velocity ??= { x: 0, y: 0 };
  }
  for (const p of predators) {
    p.targetLobsterId ??= null;
    p.attackCooldownUntil ??= 0;
    p.velocity ??= { x: 0, y: 0 };
    p.elevation ??= 0;
  }
  for (const f of foods) {
    f.elevation ??= 0;
    f.velocity ??= { x: 0, y: 0 };
  }

  const aliveLobsters = lobsters.filter(
    (l) => (l.health ?? 100) > 0 && (l.respawnAt == null || now >= l.respawnAt),
  );

  const lobsterGrid = buildLobsterGrid(lobsters, state);

  // ----- Food movement: flee from lobsters + toward biggest empty space -----
  for (const food of foods) {
    let fx = 0;
    let fy = 0;
    const near = getLobstersNearPosition(food.position.x, food.position.y, lobsterGrid);
    for (const l of near) {
      const dx = food.position.x - l.position.x;
      const dy = food.position.y - l.position.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < 80) {
        const w = 1 / (d * d);
        fx += (dx / d) * w;
        fy += (dy / d) * w;
      }
    }
    const flen = Math.hypot(fx, fy);
    if (flen > 0.01) {
      const s = Math.min(SHRIMP_FLEE_SPEED, flen * 8);
      food.velocity.x = lerp(food.velocity.x, (fx / flen) * s, 0.15);
      food.velocity.y = lerp(food.velocity.y, (fy / flen) * s, 0.15);
      } else {
      food.velocity.x = lerp(food.velocity.x, 0, 0.05);
      food.velocity.y = lerp(food.velocity.y, 0, 0.05);
    }
    const spd = length(food.velocity);
    if (spd > SHRIMP_FLEE_SPEED) {
      const f = SHRIMP_FLEE_SPEED / spd;
      food.velocity.x *= f;
      food.velocity.y *= f;
    }
    if (food.position.x < margin + 15 && food.velocity.x < 0)
      food.velocity.x += SHRIMP_WALL_STEER;
    if (food.position.x > state.width - margin - 15 && food.velocity.x > 0)
      food.velocity.x -= SHRIMP_WALL_STEER;
    if (food.position.y < margin + 15 && food.velocity.y < 0)
      food.velocity.y += SHRIMP_WALL_STEER;
    if (food.position.y > state.height - margin - 15 && food.velocity.y > 0)
      food.velocity.y -= SHRIMP_WALL_STEER;
    food.position.x += food.velocity.x * dt;
    food.position.y += food.velocity.y * dt;
    food.position.x = clamp(food.position.x, margin, state.width - margin);
    food.position.y = clamp(food.position.y, margin, state.height - margin);
  }

  // ----- Predator: target choice (closest or closest furthest from community), lock-on, move, attack -----
  for (const pred of predators) {
    let target: Lobster | null = null;
    const currentTarget = pred.targetLobsterId
      ? lobsters.find((l) => l.id === pred.targetLobsterId)
      : null;
    const targetValid =
      currentTarget &&
      (currentTarget.health ?? 100) > 0 &&
      (currentTarget.respawnAt == null || now >= currentTarget.respawnAt);

    if (targetValid) {
      target = currentTarget;
    } else {
      pred.targetLobsterId = null;
      let bestScore = -Infinity;
      for (const l of aliveLobsters) {
        const dx = l.position.x - pred.position.x;
        const dy = l.position.y - pred.position.y;
          const dSq = dx * dx + dy * dy;
        if (dSq > PREDATOR_CHASE_RADIUS * PREDATOR_CHASE_RADIUS) continue;
        const dist = Math.sqrt(dSq);
        const allies = nearbyAllies(l, lobsters, 60);
        const minAllyDist = allies.length === 0
          ? Infinity
          : Math.min(...allies.map((a) => Math.sqrt(distSq(a, l))));
        const score = -dist + minAllyDist * 0.3;
        if (score > bestScore) {
          bestScore = score;
          target = l;
        }
      }
      if (target) pred.targetLobsterId = target.id;
    }

    if (target) {
      const dx = target.position.x - pred.position.x;
      const dy = target.position.y - pred.position.y;
      const dz = (target.elevation ?? 0) - (pred.elevation ?? 0);
      const dist = Math.hypot(dx, dy) || 1;
      const dist3D = Math.hypot(dist, dz);
      pred.heading = Math.atan2(dy, dx);
      pred.pitch = clamp(Math.atan2(dz, dist), -0.85, 0.85);
      const speed = pred.speed * (dist3D < 25 ? 0.7 : 1);
      pred.velocity.x = (dx / dist) * speed;
      pred.velocity.y = (dy / dist) * speed;
      pred.position.x += pred.velocity.x * dt;
      pred.position.y += pred.velocity.y * dt;
      const elevStep = Math.sign(dz) * Math.min(80 * dt, Math.abs(dz));
      pred.elevation = clamp((pred.elevation ?? 0) + elevStep, 0, MAX_SPAWN_ELEVATION);
      pred.position.x = clamp(pred.position.x, margin, state.width - margin);
      pred.position.y = clamp(pred.position.y, margin, state.height - margin);

      if (dist3D < pred.attackRadius && (pred.attackCooldownUntil ?? 0) <= now) {
        pred.attackCooldownUntil = now + PREDATOR_ATTACK_COOLDOWN_MS;
        const damage = pred.damage ?? 45;
        const defenders = nearbyAllies(target, lobsters, 35);
        const reduced = defenders.length >= 2 ? damage * 0.6 : damage;
        target.health = Math.max(0, (target.health ?? 100) - reduced);
        events.push(
          createEvent("predator-attack", {
            predatorId: pred.id,
            lobsterId: target.id,
            displayName: target.displayName ?? target.id,
          }, now, `pred-attack-${pred.id}-${target.id}-${now}`),
        );
        for (const d of defenders.slice(0, 2)) {
          const dmg = 12;
          pred.health = Math.max(0, (pred.health ?? 500) - dmg);
        }
        if ((target.health ?? 0) <= 0) {
          target.respawnAt = now + RESPAWN_DELAY_MS;
          target.losses = (target.losses ?? 0) + 1;
          target.deathsFromOctopuses = (target.deathsFromOctopuses ?? 0) + 1;
          target.xp = Math.max(0, (target.xp ?? 0) - XP_LOSS_ON_DEATH);
          pred.targetLobsterId = null;
          events.push(
            createEvent("predator-kill", {
              predatorId: pred.id,
              lobsterId: target.id,
              displayName: target.displayName ?? target.id,
            }, now, `pred-kill-${pred.id}-${target.id}-${now}`),
          );
        }
        if ((pred.health ?? 0) <= 0) {
          pred.targetLobsterId = null;
          pred.health = pred.maxHp ?? 500;
          pred.position = randomPosition(state, rng);
          pred.elevation = rng() * MAX_SPAWN_ELEVATION;
        }
      }
    } else {
      pred.velocity.x = 0;
      pred.velocity.y = 0;
    }
  }

  // ----- Lobster: community defense (ally attacked → go help; if attacker is lobster, set hostile) -----
  for (const lobster of aliveLobsters) {
    if (lobster.hostileTargetId) continue;
    if (!lobster.communityId) continue;
    const allies = nearbyAllies(lobster, lobsters, PREDATOR_AID_RADIUS);
    for (const ally of allies) {
      const lobsterAttacker = lobsters.find(
        (l) => l.hostileTargetId === ally.id && l.communityId !== lobster.communityId && (l.health ?? 100) > 0,
      );
      if (lobsterAttacker) {
        const dx = ally.position.x - lobster.position.x;
        const dy = ally.position.y - lobster.position.y;
        const distSq = dx * dx + dy * dy;
        if (distSq > 0.01 && distSq <= PREDATOR_AID_RADIUS * PREDATOR_AID_RADIUS) {
          ensureCommunity(state, lobster, rng);
          lobster.hostileTargetId = lobsterAttacker.id;
          break;
        }
      }
    }
  }

  // ----- Friendly encounter: within socialRadius, chance to become friends and form/join community -----
  const FRIENDLY_JOIN_COMMUNITY_CHANCE = 0.72;
  const socialR2 = config.socialRadius * config.socialRadius;
  for (const lobster of aliveLobsters) {
    if (lobster.hostileTargetId) continue;
    const nearby = getLobstersNearPosition(lobster.position.x, lobster.position.y, lobsterGrid);
    for (const other of nearby) {
        if (other.id === lobster.id) continue;
      if ((other.health ?? 100) <= 0 || (other.respawnAt != null && now < other.respawnAt)) continue;
      if (other.hostileTargetId || distSq(lobster, other) > socialR2) continue;
      if (rng() >= config.socialChance) continue;
      const a = lobster;
      const b = other;
      if (a.communityId && b.communityId) continue;
      if (a.communityId === b.communityId) continue;
      const oneInOneOut = (a.communityId && !b.communityId) || (!a.communityId && b.communityId);
      if (!oneInOneOut && rng() >= FRIENDLY_JOIN_COMMUNITY_CHANCE) {
        events.push(
          createEvent("social", {
            lobsterId: a.id,
            otherId: b.id,
            displayName: a.displayName ?? a.id,
            otherName: b.displayName ?? b.id,
          }, now, `social-${a.id}-${b.id}-${now}`),
        );
          break;
        }
      if (b.communityId) {
        a.communityId = b.communityId;
        events.push(
          createEvent("friendship", {
            lobsterId: a.id,
            otherId: b.id,
            displayName: a.displayName ?? a.id,
            otherName: b.displayName ?? b.id,
            joinedCommunity: true,
          }, now, `friendship-${a.id}-${b.id}-${now}`),
        );
      } else if (a.communityId) {
        b.communityId = a.communityId;
        events.push(
          createEvent("friendship", {
            lobsterId: b.id,
            otherId: a.id,
            displayName: b.displayName ?? b.id,
            otherName: a.displayName ?? a.id,
            joinedCommunity: true,
          }, now, `friendship-${b.id}-${a.id}-${now}`),
        );
          } else {
        ensureCommunity(state, a, rng);
        b.communityId = a.communityId;
        const comm = state.communities?.find((c) => c.id === a.communityId);
        events.push(
          createEvent("gang-form", {
            lobsterId: a.id,
            otherId: b.id,
            displayName: a.displayName ?? a.id,
            otherName: b.displayName ?? b.id,
            communityName: comm?.name ?? "a crew",
          }, now, `gang-form-${a.id}-${b.id}-${now}`),
        );
      }
      break;
    }
  }

  // ----- Lobster: 5 lost shrimp → hostile -----
  for (const lobster of aliveLobsters) {
    if (lobster.hostileTargetId) continue;
    for (const other of lobsters) {
      if (other.id === lobster.id) continue;
      const key = `${lobster.id}-${other.id}`;
      if ((lostShrimpToWinner[key] ?? 0) >= LOST_SHRIMP_TO_ATTACK) {
        lobster.hostileTargetId = other.id;
        break;
      }
    }
  }

  // ----- Lobster: goal = closest shrimp (or hostile target, or flee to community if <30% HP) -----
  const levelSpeedMult = (l: Lobster) => 1 + (l.level - 1) * 0.05;
  const maxSpeed = (l: Lobster) =>
    config.maxSpeed * levelSpeedMult(l) * (l.speedMult ?? 1);

  for (const lobster of aliveLobsters) {
    const hpPct = (lobster.health ?? 100) / (lobster.maxHp ?? 100);
    const fleeingToCommunity = lobster.hostileTargetId && hpPct < FLEE_HP_PCT;
    if (fleeingToCommunity) {
      const allies = nearbyAllies(lobster, lobsters, 200);
      const nearest = allies.reduce<Lobster | null>((best, a) => {
        const d = distSq(lobster, a);
        if (!best || d < distSq(lobster, best)) return a;
        return best;
      }, null);
      if (nearest) {
        lobster.hostileTargetId = null;
        const dx = nearest.position.x - lobster.position.x;
        const dy = nearest.position.y - lobster.position.y;
        const d = Math.hypot(dx, dy) || 1;
        lobster.heading = Math.atan2(dy, dx);
        lobster.targetSpeed = maxSpeed(lobster) * 1.2;
        lobster.velocity.x = (dx / d) * lobster.targetSpeed;
        lobster.velocity.y = (dy / d) * lobster.targetSpeed;
      }
    }

    if (!fleeingToCommunity && lobster.hostileTargetId) {
      const target = lobsters.find((l) => l.id === lobster.hostileTargetId);
      if (target && (target.health ?? 100) > 0 && (target.respawnAt == null || now >= target.respawnAt)) {
        const dx = target.position.x - lobster.position.x;
        const dy = target.position.y - lobster.position.y;
        const d = Math.hypot(dx, dy) || 1;
        lobster.heading = Math.atan2(dy, dx);
        lobster.targetSpeed = maxSpeed(lobster) * 1.1;
        lobster.velocity.x = (dx / d) * lobster.targetSpeed;
        lobster.velocity.y = (dy / d) * lobster.targetSpeed;
        if (d < LOBSTER_ATTACK_RADIUS) {
          if (rng() < 0.08) {
            const alliesA = nearbyAllies(lobster, lobsters, 50);
            const alliesB = nearbyAllies(target, lobsters, 50);
            const result = resolveConflict(lobster, target, {
              allySupportA: alliesA.length,
              allySupportB: alliesB.length,
              tension: 1.8,
              minLevelToAttack: 1,
            }, rng);
            const winner = result.winnerId === lobster.id ? lobster : target;
            const loser = result.winnerId === lobster.id ? target : lobster;
            const damage = result.damage ?? 10;
            loser.health = Math.max(0, (loser.health ?? 100) - damage);
            if ((loser.health ?? 0) <= 0) {
              loser.respawnAt = now + RESPAWN_DELAY_MS;
              loser.losses = (loser.losses ?? 0) + 1;
              loser.deathsFromLobsters = (loser.deathsFromLobsters ?? 0) + 1;
              loser.xp = Math.max(0, (loser.xp ?? 0) - XP_LOSS_ON_DEATH);
              winner.lobsterKills = (winner.lobsterKills ?? 0) + 1;
              winner.hostileTargetId = null;
              loser.hostileTargetId = null;
          events.push(
                createEvent("kill", {
                  winnerId: winner.id,
                  loserId: loser.id,
                  displayName: winner.displayName ?? winner.id,
                  otherName: loser.displayName ?? loser.id,
                }, now, `kill-${winner.id}-${loser.id}-${now}`),
              );
        } else {
              loser.status = "Weak";
            }
          }
        }
        } else {
        lobster.hostileTargetId = null;
      }
    }

    if (!lobster.hostileTargetId && !fleeingToCommunity) {
      let goalDx = 0;
      let goalDy = 0;
      let goalDz = 0;
      let hasGoal = false;
      const nearbyByDist = lobsters.filter((l) => {
        if (l.id === lobster.id) return false;
        if ((l.health ?? 100) <= 0) return false;
        if (l.respawnAt != null && now < l.respawnAt) return false;
        const d2 = distSq(lobster, l);
        return d2 <= PREDATOR_AID_RADIUS * PREDATOR_AID_RADIUS;
      });
      const threatenedByPredator = nearbyByDist.find((l) =>
        predators.some((p) => p.targetLobsterId === l.id),
      );
      if (threatenedByPredator) {
        ensureCommunity(state, threatenedByPredator, rng);
        const cid = threatenedByPredator.communityId;
        const countInComm = cid ? lobsters.filter((l) => l.communityId === cid).length : 0;
        if (countInComm >= GANG_FORM_MAX) {
          ensureCommunity(state, lobster, rng);
        } else {
          lobster.communityId = cid;
        }
        goalDx = threatenedByPredator.position.x - lobster.position.x;
        goalDy = threatenedByPredator.position.y - lobster.position.y;
        goalDz = (threatenedByPredator.elevation ?? 0) - (lobster.elevation ?? 0);
          hasGoal = true;
      }
      if (!hasGoal) {
        const foodTarget = findBestFoodForLobster(lobster, foods, FOOD_ATTRACT_RADIUS, lobsters, lobsterGrid);
        if (foodTarget) {
          goalDx = foodTarget.position.x - lobster.position.x;
          goalDy = foodTarget.position.y - lobster.position.y;
          goalDz = (foodTarget.elevation ?? 0) - (lobster.elevation ?? 0);
          hasGoal = true;
        }
      }
      const fleeFromPredators: Vector2 = { x: 0, y: 0 };
      for (const p of predators) {
        const dx = lobster.position.x - p.position.x;
        const dy = lobster.position.y - p.position.y;
        const dSq = dx * dx + dy * dy;
        if (dSq < 120 * 120 && dSq > 0.01) {
          const d = Math.sqrt(dSq);
          const w = 1 / d;
          fleeFromPredators.x += (dx / d) * w;
          fleeFromPredators.y += (dy / d) * w;
        }
      }
      if (hasGoal && (goalDx !== 0 || goalDy !== 0)) {
        const d = Math.hypot(goalDx, goalDy) || 1;
        lobster.heading = Math.atan2(goalDy, goalDx);
        lobster.pitch = clamp(Math.atan2(goalDz, d), -0.85, 0.85);
        lobster.targetSpeed = maxSpeed(lobster) * 0.9;
        lobster.velocity.x = (goalDx / d) * lobster.targetSpeed;
        lobster.velocity.y = (goalDy / d) * lobster.targetSpeed;
        const fleeLen = length(fleeFromPredators);
        if (fleeLen > 0.01) {
          const blend = 0.35;
          lobster.velocity.x += fleeFromPredators.x * blend * 4;
          lobster.velocity.y += fleeFromPredators.y * blend * 4;
        }
        const vertSpeed = 28;
        const elevStep = Math.sign(goalDz) * Math.min(vertSpeed * dt, Math.abs(goalDz));
        lobster.elevation = clamp((lobster.elevation ?? 0) + elevStep, 0, MAX_SPAWN_ELEVATION);
    } else {
        const fleeLen = length(fleeFromPredators);
        if (fleeLen > 0.01) {
          lobster.velocity.x = fleeFromPredators.x * 3;
          lobster.velocity.y = fleeFromPredators.y * 3;
        } else {
          const repel = wallRepelVector(lobster.position.x, lobster.position.y, state);
          const speed = maxSpeed(lobster) * 0.25;
          lobster.velocity.x = repel.x * speed;
          lobster.velocity.y = repel.y * speed;
        }
        lobster.pitch = lobster.pitch != null ? lobster.pitch * 0.92 : 0;
      }
    }

    lobster.velocity = limitSpeed(lobster.velocity, maxSpeed(lobster));
    lobster.position.x += lobster.velocity.x * dt;
    lobster.position.y += lobster.velocity.y * dt;

    const wallNudge = 0.5;
    if (lobster.position.x < margin + 25 && lobster.velocity.x < 0)
      lobster.velocity.x += wallNudge;
    if (lobster.position.x > state.width - margin - 25 && lobster.velocity.x > 0)
      lobster.velocity.x -= wallNudge;
    if (lobster.position.y < margin + 25 && lobster.velocity.y < 0)
      lobster.velocity.y += wallNudge;
    if (lobster.position.y > state.height - margin - 25 && lobster.velocity.y > 0)
      lobster.velocity.y -= wallNudge;
      lobster.position.x = clamp(lobster.position.x, margin, state.width - margin);
      lobster.position.y = clamp(lobster.position.y, margin, state.height - margin);
  }

  // ----- Eating: touch radius, instant eat; rivalry (loser gets lostShrimpToWinner++; at 5 already set hostile above) -----
  const eatenFoodIds = new Set<string>();
  for (const lobster of aliveLobsters) {
    const foodTarget = findNearestFood(lobster, foods, FOOD_ATTRACT_RADIUS);
    if (!foodTarget || eatenFoodIds.has(foodTarget.id)) continue;
    const dx = foodTarget.position.x - lobster.position.x;
    const dy = foodTarget.position.y - lobster.position.y;
    const dz = (foodTarget.elevation ?? 0) - (lobster.elevation ?? 0);
    const dist = Math.hypot(dx, dy);
    const dist3D = Math.hypot(dist, dz);
    if (dist3D > FOOD_EAT_RADIUS) continue;

    const contenders = aliveLobsters.filter((l) => {
      const d = Math.hypot(
        foodTarget.position.x - l.position.x,
        foodTarget.position.y - l.position.y,
      );
      return d <= SAME_SHRIMP_VERY_CLOSE_RADIUS;
    });
    const eater = contenders.length === 1
      ? lobster
      : contenders[Math.floor(rng() * contenders.length)];
    const nonEaters = contenders.filter((l) => l.id !== eater.id);

    eater.shrimpEaten = (eater.shrimpEaten ?? 0) + 1;
    const shrimpEaten = eater.shrimpEaten;
        const delta = applyFeedEffects(120);
    eater.xp = (eater.xp ?? 0) + delta.xp;
    eater.size = (eater.size ?? 1) + delta.size * 0.01;
        while (eater.level < SIM_LEVEL_CAP && shrimpEaten >= shrimpToReachLevel(eater.level + 1)) {
          eater.level += 1;
      eater.health = Math.min(eater.maxHp ?? 100, (eater.health ?? 100) + 5);
      eater.maxHp = (eater.maxHp ?? 100) + 20;
          events.push(
        createEvent("level", {
                lobsterId: eater.id,
                displayName: eater.displayName ?? eater.id,
                level: eater.level,
                source: "shrimp",
                shrimpEaten,
        }, now, `level-${eater.id}-${now}`),
          );
        }
        events.push(
      createEvent("food", {
              lobsterId: eater.id,
              displayName: eater.displayName ?? eater.id,
        foodId: foodTarget.id,
      }, now, `food-${foodTarget.id}-${eater.id}-${now}`),
    );

    for (const nonEater of nonEaters) {
        const lostKey = `${nonEater.id}-${eater.id}`;
        lostShrimpToWinner[lostKey] = (lostShrimpToWinner[lostKey] ?? 0) + 1;
      const rel = getRel(pairKey(nonEater.id, eater.id));
      rel.conflicts = (rel.conflicts ?? 0) + 1;
    }

    eatenFoodIds.add(foodTarget.id);
    const idx = state.foods.findIndex((f) => f.id === foodTarget.id);
    if (idx >= 0) state.foods.splice(idx, 1);
    const newPos = spawnPositionFurthestFromLobsters(state, lobsters, state.foods, rng);
    state.foods.push({
      id: `food-${Date.now()}-${rng().toString(36).slice(2, 8)}`,
      position: newPos,
      velocity: { x: 0, y: 0 },
      heading: rng() * Math.PI * 2,
      elevation: rng() * MAX_SPAWN_ELEVATION,
      targetElevation: 0,
      createdAt: now,
      ttlMs: 60000,
    });
    foods = state.foods;
  }

  // ----- Respawn dead lobsters after delay -----
  for (const lobster of lobsters) {
    if ((lobster.health ?? 100) > 0) continue;
    if (lobster.respawnAt == null) lobster.respawnAt = now + RESPAWN_DELAY_MS;
    if (now < lobster.respawnAt) continue;
    lobster.respawnAt = null;
    lobster.health = lobster.maxHp ?? 100;
    lobster.position = randomPosition(state, rng);
    lobster.elevation = rng() * MAX_SPAWN_ELEVATION;
      lobster.velocity = { x: 0, y: 0 };
      lobster.hostileTargetId = null;
      events.push(
      createEvent("respawn", {
              lobsterId: lobster.id,
              displayName: lobster.displayName ?? lobster.id,
      }, now, `respawn-${lobster.id}-${now}`),
    );
  }

  // ----- Spawn food up to MAX_FOOD -----
  let lastFoodSpawn = state.lastFoodSpawn ?? now;
  if (now - lastFoodSpawn >= FOOD_SPAWN_MS && state.foods.length < MAX_FOOD) {
    const toSpawn = Math.min(FOOD_SPAWN_BATCH, MAX_FOOD - state.foods.length);
    for (let i = 0; i < toSpawn; i++) {
      const pos = spawnPositionFurthestFromLobsters(state, lobsters, state.foods, rng);
      state.foods.push({
        id: `food-${Date.now()}-${i}-${rng().toString(36).slice(2, 6)}`,
        position: pos,
        velocity: { x: 0, y: 0 },
        heading: rng() * Math.PI * 2,
        elevation: rng() * MAX_SPAWN_ELEVATION,
        targetElevation: 0,
        createdAt: now,
        ttlMs: 60000,
      });
    }
    lastFoodSpawn = now;
  }
  state.lastFoodSpawn = lastFoodSpawn;

  state.time = now;
  pruneStateMaps(state, now);
  return { state, events };
};

export const applyPet = (
  state: TankState,
  lobsterId: string,
  now: number,
): { state: TankState; events: TankEvent[] } => {
  const lobsterRef = state.lobsters.find((l) => l.id === lobsterId);
  const displayName = lobsterRef?.displayName ?? lobsterId;
  const lobsters = state.lobsters.map((lobster) => {
    if (lobster.id !== lobsterId) return lobster;
    const delta = applyPetEffects();
    return {
      ...lobster,
      likeability: (lobster.likeability ?? 0.5) + delta.likeability,
      lastPet: now,
    };
  });
  return {
    state: { ...state, lobsters },
    events: [
      createEvent("pet", { lobsterId, displayName }, now, `pet-${lobsterId}-${now}`),
    ],
  };
};

export const applyFeed = (
  state: TankState,
  lobsterId: string,
  amount: number,
  now: number,
): { state: TankState; events: TankEvent[] } => {
  const lobsterRef = state.lobsters.find((l) => l.id === lobsterId);
  const displayName = lobsterRef?.displayName ?? lobsterId;
  const lobsters = state.lobsters.map((lobster) => {
    if (lobster.id !== lobsterId) return lobster;
    const delta = applyFeedEffects(amount);
    return {
      ...lobster,
      xp: (lobster.xp ?? 0) + delta.xp,
      courage: (lobster.courage ?? 0.5) + delta.courage,
      likeability: (lobster.likeability ?? 0.5) + delta.likeability,
      size: (lobster.size ?? 1) + delta.size,
      lastFed: now,
    };
  });
  return {
    state: { ...state, lobsters },
    events: [
      createEvent("feed", { lobsterId, displayName, amount }, now, `feed-${lobsterId}-${now}`),
    ],
  };
};
