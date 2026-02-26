/**
 * engine-v2.ts — Clean unified tank simulation engine.
 *
 * Wall-aware heading-based 3D steering, spatial indexing, 8-phase tick.
 *
 * Creature state machines:
 *   Lobster: flee | defending | hostile | fighting | seeking-food (+ betray, aggressive variants)
 *   Shrimp:  drift | flee (implicit proximity)
 *   Octopus: hunt (lowest-HP lobster) | attack | patrol
 *
 * Tick phases (strict order):
 *   0. Init caches (spatial grid, alive list, community map)
 *   1. Respawn dead lobsters
 *   2. Shrimp movement (drift + flee)
 *   3. Octopus behavior (target + chase + attack + patrol)
 *   4. Lobster behavior (priority state machine + health regen)
 *   5. Eating (fair contest resolution)
 *   6. Separation (push overlapping entities apart)
 *   7. Social (friendly encounters + community formation)
 *   8. Food maintenance (spawn up to target count)
 */

import { createEvent, TankEvent } from "./events";
import { TANK_WALL_MARGIN, MAX_SPAWN_ELEVATION } from "./factory";
import type { Community, Food, Lobster, Predator, RandomFn, TankState } from "./types";

// ─── Constants ──────────────────────────────────────────────────────────────────

const MAX_DELTA_MS = 50;
const MAX_ELEVATION = MAX_SPAWN_ELEVATION; // 470
const FALLBACK_WIDTH = 800;
const FALLBACK_HEIGHT = 600;

// Movement
const LOBSTER_BASE_SPEED = 26;
const PREDATOR_SPEED = 28;
const SHRIMP_DRIFT_SPEED = 3;
const SHRIMP_FLEE_SPEED = 9;
const SHRIMP_FLEE_RADIUS = 35;
const SHRIMP_DIRECTION_CHANGE_MS = 3000;
const TURN_RATE = 3.5;
const TURN_RATE_CLOSE = 5.5;
const CLOSE_DIST = 25;
const WALL_BUFFER = 40;

// Combat
const EAT_RADIUS = 6;
const PREDATOR_ATTACK_RADIUS = 18;
const PREDATOR_DAMAGE = 30;
const PREDATOR_ATTACK_COOLDOWN_MS = 1200;
const PREDATOR_MAX_HP = 500;
const LOBSTER_ATTACK_RADIUS = 14;
const LOBSTER_ATTACK_COOLDOWN_MS = 1000;
const FLEE_PREDATOR_RADIUS = 95;
const FLEE_HP_THRESHOLD = 0.30;
const STAY_NEAR_ALLIES_RADIUS = 72;
const ALLIES_GROUP_RADIUS = 140;
const MIN_LEVEL_ATTACK_LOBSTER = 3;
const MIN_LEVEL_ATTACK_PREDATOR = 5;
const COMMUNITY_DEFEND_RADIUS = 280;
const ALLY_ATTACK_MEMORY_MS = 6_000;
const ATTACK_MEMORY_MS = 3_000;

// Progression
const SHRIMP_XP = 12;
const LOBSTER_KILL_XP = 120;
const PREDATOR_KILL_XP = 600;
const REFERENCE_LEVEL = 10;
const SIM_LEVEL_CAP = 20;
const SHRIMP_LOSS_ANGER_COUNT = 4;

// Social
const FRIENDLY_INTERACTION_RADIUS = 30;
const FRIENDLY_INTERACTION_COOLDOWN_MS = 8_000;
const COMMUNITY_FORM_THRESHOLD = 1;
const COMMUNITY_MAX_SIZE = 6;

const COMMUNITY_NAMES = [
  "Pearl Ring", "Deep Current", "Rust Claw", "Coral Guard",
  "Shale Band", "Briny Pact", "Silt Crew", "Reef Watch",
];
const COMMUNITY_COLORS = [
  "#0d9488", "#d97706", "#475569", "#be123c",
  "#4f46e5", "#059669", "#7c3aed", "#0369a1",
];

// Health
const RESPAWN_DELAY_MS = 20_000;
const HEALTH_REGEN_RATE = 0.5;
const COMBAT_COOLDOWN_FOR_REGEN = 5_000;

// Food
const FOOD_COUNT_TARGET = 78;
const SEEK_FOOD_RADIUS = 120;
const SEEK_FOOD_RADIUS_FALLBACK = 9999;
const WALL_AVOID_MARGIN = 80;

// Separation
const SEP_RADIUS = 22;
const SEP_FORCE = 55;
const PRED_SEP_RADIUS = 20;

// Spatial
const SPATIAL_CELL_SIZE = 60;

// ─── Types ──────────────────────────────────────────────────────────────────────

type Bounds = { margin: number; maxX: number; maxY: number };

type Steerable = {
  position: { x: number; y: number };
  velocity: { x: number; y: number };
  elevation?: number;
  heading: number;
  pitch?: number;
};

type GridCell = { lobsters: Lobster[] };
type Grid = Map<string, GridCell>;

// ─── Helpers ────────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function angleDiff(a: number, b: number): number {
  let d = a - b;
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function dist3D(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): number {
  return Math.hypot(bx - ax, by - ay, bz - az);
}

function lobsterAlive(l: Lobster): boolean {
  return (l.health ?? 100) > 0 && l.respawnAt == null;
}

function sortedPairKey(a: string, b: string): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

// ─── Level Scaling ──────────────────────────────────────────────────────────────

export function shrimpToReachLevel(nextLevel: number): number {
  return (nextLevel - 1) * 5;
}

function speedForLevel(level: number): number {
  const L = Math.min(level, REFERENCE_LEVEL);
  return LOBSTER_BASE_SPEED + ((L - 1) / Math.max(1, REFERENCE_LEVEL - 1)) * (PREDATOR_SPEED - LOBSTER_BASE_SPEED);
}

function maxHpForLevel(level: number): number {
  const L = Math.min(level, REFERENCE_LEVEL);
  const hpAt10 = Math.floor(PREDATOR_MAX_HP / 2);
  return 100 + Math.floor(((L - 1) / Math.max(1, REFERENCE_LEVEL - 1)) * (hpAt10 - 100));
}

function attackDamageForLevel(level: number): number {
  const L = Math.min(level, REFERENCE_LEVEL);
  const dmgAt10 = Math.floor(PREDATOR_DAMAGE / 3);
  return 4 + Math.floor(((L - 1) / Math.max(1, REFERENCE_LEVEL - 1)) * (dmgAt10 - 4));
}

const PET_SPEED_MULT = 3;   // Triple speed when boosted
const PET_DAMAGE_MULT = 3;  // Triple damage when boosted

function effectiveAttackDamage(l: Lobster, boostActive: boolean): number {
  const base = l.attackDamage ?? attackDamageForLevel(l.level ?? 1);
  const dmg = base * (l.damageMult ?? 1) * (boostActive ? PET_DAMAGE_MULT : 1);
  return Math.max(1, Math.round(dmg));
}

// ─── Spatial Grid ───────────────────────────────────────────────────────────────

function gridKey(x: number, y: number): string {
  return `${Math.floor(x / SPATIAL_CELL_SIZE)},${Math.floor(y / SPATIAL_CELL_SIZE)}`;
}

function buildLobsterGrid(lobsters: Lobster[]): Grid {
  const grid: Grid = new Map();
  for (const l of lobsters) {
    if (!lobsterAlive(l)) continue;
    const key = gridKey(l.position.x, l.position.y);
    let cell = grid.get(key);
    if (!cell) { cell = { lobsters: [] }; grid.set(key, cell); }
    cell.lobsters.push(l);
  }
  return grid;
}

function getNearbyLobsters(x: number, y: number, grid: Grid): Lobster[] {
  const cx = Math.floor(x / SPATIAL_CELL_SIZE);
  const cy = Math.floor(y / SPATIAL_CELL_SIZE);
  const out: Lobster[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const cell = grid.get(`${cx + dx},${cy + dy}`);
      if (cell) {
        for (const l of cell.lobsters) out.push(l);
      }
    }
  }
  return out;
}

// ─── Wall-Aware Steering ────────────────────────────────────────────────────────

/**
 * If entity is near a wall and the desired heading points into it, deflect to
 * a tangent direction (run along the wall) blended with away-from-wall.
 * Returns the (possibly deflected) desired heading.
 */
function wallDeflect(
  x: number, y: number,
  desiredH: number,
  bounds: Bounds,
): number {
  const { margin, maxX, maxY } = bounds;
  let nx = 0, ny = 0;

  const dL = x - margin;
  const dR = maxX - x;
  const dT = y - margin;
  const dB = maxY - y;

  if (dL < WALL_BUFFER) nx += (WALL_BUFFER - dL) / WALL_BUFFER;
  if (dR < WALL_BUFFER) nx -= (WALL_BUFFER - dR) / WALL_BUFFER;
  if (dT < WALL_BUFFER) ny += (WALL_BUFFER - dT) / WALL_BUFFER;
  if (dB < WALL_BUFFER) ny -= (WALL_BUFFER - dB) / WALL_BUFFER;

  const nLen = Math.hypot(nx, ny);
  if (nLen < 0.001) return desiredH;
  nx /= nLen;
  ny /= nLen;

  const hDx = Math.cos(desiredH);
  const hDy = Math.sin(desiredH);
  const dot = hDx * nx + hDy * ny;

  if (dot >= 0) return desiredH;

  const t1x = ny, t1y = -nx;
  const t2x = -ny, t2y = nx;
  const dot1 = hDx * t1x + hDy * t1y;
  const dot2 = hDx * t2x + hDy * t2y;
  const tx = dot1 >= dot2 ? t1x : t2x;
  const ty = dot1 >= dot2 ? t1y : t2y;

  const bx = 0.7 * tx + 0.3 * nx;
  const by = 0.7 * ty + 0.3 * ny;
  return Math.atan2(by, bx);
}

/**
 * Unified heading-based 3D steering with wall awareness.
 * Moves the entity and derives velocity from heading (for rendering).
 * Returns distance to target.
 */
function steer(
  e: Steerable,
  tx: number, ty: number, tz: number,
  speed: number, dtSec: number,
  away: boolean,
  bounds: Bounds,
): number {
  const gapX = tx - e.position.x;
  const gapY = ty - e.position.y;
  const gapZ = tz - (e.elevation ?? 0);
  const dist2D = Math.hypot(gapX, gapY) || 0.001;
  const d3D = Math.hypot(gapX, gapY, gapZ) || 0.001;

  let desiredH: number;
  let desiredP: number;
  if (away) {
    desiredH = Math.atan2(-gapY, -gapX);
    desiredP = Math.atan2(-gapZ, dist2D);
  } else {
    desiredH = Math.atan2(gapY, gapX);
    desiredP = Math.atan2(gapZ, dist2D);
  }

  const rate = d3D < CLOSE_DIST ? TURN_RATE_CLOSE : TURN_RATE;
  const maxTurn = rate * dtSec;

  e.heading += clamp(angleDiff(desiredH, e.heading), -maxTurn, maxTurn);
  e.pitch = (e.pitch ?? 0) + clamp(angleDiff(desiredP, e.pitch ?? 0), -maxTurn * 0.8, maxTurn * 0.8);

  const cosP = Math.cos(e.pitch!);
  const cosH = Math.cos(e.heading);
  const sinH = Math.sin(e.heading);
  const sinP = Math.sin(e.pitch!);

  const step = away ? speed * dtSec : Math.min(speed * dtSec, d3D);
  e.position.x += cosH * cosP * step;
  e.position.y += sinH * cosP * step;
  e.elevation = clamp((e.elevation ?? 0) + sinP * step, 0, MAX_ELEVATION);

  e.position.x = clamp(e.position.x, bounds.margin, bounds.maxX);
  e.position.y = clamp(e.position.y, bounds.margin, bounds.maxY);

  e.velocity.x = cosH * cosP * speed;
  e.velocity.y = sinH * cosP * speed;

  return d3D;
}

// ─── Target Finding ─────────────────────────────────────────────────────────────

function findNearestFood(
  l: Lobster,
  foods: Food[],
): Food | null {
  let best: Food | null = null;
  let bestDist = Infinity;
  const lz = l.elevation ?? 0;
  for (const f of foods) {
    const d = dist3D(l.position.x, l.position.y, lz, f.position.x, f.position.y, f.elevation);
    if (d < bestDist) {
      bestDist = d;
      best = f;
    }
  }
  return best;
}

function smartSpawnPos(state: TankState, rng: RandomFn): { x: number; y: number; z: number } {
  const margin = TANK_WALL_MARGIN;
  const w = Math.max(100, (state.width ?? FALLBACK_WIDTH) - margin * 2);
  const h = Math.max(100, (state.height ?? FALLBACK_HEIGHT) - margin * 2);
  let bestX = margin + rng() * w;
  let bestY = margin + rng() * h;
  let bestZ = rng() * MAX_ELEVATION;
  let bestScore = -Infinity;
  for (let i = 0; i < 8; i++) {
    const cx = margin + rng() * w;
    const cy = margin + rng() * h;
    const cz = rng() * MAX_ELEVATION;
    let minFoodDist = Infinity;
    for (const f of state.foods) {
      const d = dist3D(cx, cy, cz, f.position.x, f.position.y, f.elevation);
      if (d < minFoodDist) minFoodDist = d;
    }
    let minLobDist = Infinity;
    for (const l of state.lobsters) {
      if (!lobsterAlive(l)) continue;
      const d = dist3D(cx, cy, cz, l.position.x, l.position.y, l.elevation ?? 0);
      if (d < minLobDist) minLobDist = d;
    }
    const score = Math.min(minFoodDist, 200) + Math.min(minLobDist, 100) * 0.3;
    if (score > bestScore) { bestScore = score; bestX = cx; bestY = cy; bestZ = cz; }
  }
  return { x: bestX, y: bestY, z: bestZ };
}

// ─── Aggression / Community Helpers ─────────────────────────────────────────────

function clearAggressionToward(deadId: string, lobsters: Lobster[], predators: Predator[]): void {
  for (const l of lobsters) {
    if (l.hostileTargetId === deadId) l.hostileTargetId = null;
    if (l.attackTargetId === deadId) l.attackTargetId = null;
    if (l.lastAttackedById === deadId) { l.lastAttackedById = null; l.lastAttackedAt = undefined; }
    if (l.fleeFromId === deadId) l.fleeFromId = null;
  }
  for (const p of predators) {
    if (p.targetLobsterId === deadId) p.targetLobsterId = null;
  }
}

function createCommunity(state: TankState, rng: RandomFn): string {
  const idx = (state.communities?.length ?? 0) % COMMUNITY_NAMES.length;
  const id = `comm-${COMMUNITY_NAMES[idx].replace(/\s/g, "-")}-${Date.now()}-${rng().toString(36).slice(2, 6)}`;
  const community: Community = { id, name: COMMUNITY_NAMES[idx], color: COMMUNITY_COLORS[idx] };
  if (!state.communities) state.communities = [];
  state.communities.push(community);
  return id;
}

// ─── Main Tick ──────────────────────────────────────────────────────────────────

export function tickTankV2(
  state: TankState,
  deltaMs: number,
  rng: RandomFn,
  now: number,
): { state: TankState; events: TankEvent[] } {
  const cappedDelta = Math.min(deltaMs, MAX_DELTA_MS);
  const dtSec = cappedDelta / 1000;
  if (dtSec <= 0) return { state, events: [] };

  const events: TankEvent[] = [];
  const lobsters = state.lobsters;
  const predators = state.predators ?? [];
  if (!state.predators) state.predators = [];
  if (!state.foods) state.foods = [];
  if (!state.communities) state.communities = [];
  if (!state.lostShrimpToWinner) state.lostShrimpToWinner = {};
  if (!state.friendlyEncounterCount) state.friendlyEncounterCount = {};
  if (!state.lastFriendlyEncounterTime) state.lastFriendlyEncounterTime = {};
  state.relationships ??= {};

  const simTime = (state.time ?? now) + cappedDelta;
  state.time = simTime;

  if (!state.width || state.width < 100) state.width = FALLBACK_WIDTH;
  if (!state.height || state.height < 100) state.height = FALLBACK_HEIGHT;

  const margin = TANK_WALL_MARGIN;
  const maxX = state.width - margin;
  const maxY = state.height - margin;
  const bounds: Bounds = { margin, maxX, maxY };

  const nextEventId = () => `ev-${simTime}-${events.length}-${rng().toString(36).slice(2, 9)}`;

  // ── Phase 0: Init caches ──────────────────────────────────────────────────

  for (const l of lobsters) {
    l.age += cappedDelta;
    l.health ??= 100;
    l.maxHp ??= 100;
    l.shrimpEaten ??= 0;
    l.lobsterKills ??= 0;
    l.losses ??= 0;
    l.deathsFromLobsters ??= 0;
    l.deathsFromOctopuses ??= 0;
    l.velocity ??= { x: 0, y: 0 };
    if (typeof l.heading !== "number" || Number.isNaN(l.heading)) l.heading = 0;
    if (typeof l.pitch !== "number" || Number.isNaN(l.pitch)) l.pitch = 0;
  }
  for (const p of predators) {
    p.targetLobsterId ??= null;
    p.attackCooldownUntil ??= 0;
    p.velocity ??= { x: 0, y: 0 };
    p.elevation ??= 0;
    if (typeof p.heading !== "number" || Number.isNaN(p.heading)) p.heading = rng() * Math.PI * 2;
    if (typeof p.pitch !== "number" || Number.isNaN(p.pitch)) p.pitch = 0;
  }

  const aliveLobsters = lobsters.filter(lobsterAlive);
  const lobsterById = new Map<string, Lobster>();
  for (const l of lobsters) lobsterById.set(l.id, l);
  const foodById = new Map<string, Food>();
  for (const f of state.foods) foodById.set(f.id, f);
  const lobsterGrid = buildLobsterGrid(lobsters);

  const communityMap = new Map<string, Lobster[]>();
  for (const l of aliveLobsters) {
    if (!l.communityId) continue;
    let members = communityMap.get(l.communityId);
    if (!members) { members = []; communityMap.set(l.communityId, members); }
    members.push(l);
  }

  const communityCentroid = new Map<string, { x: number; y: number; z: number }>();
  for (const [cid, members] of communityMap) {
    let cx = 0, cy = 0, cz = 0;
    for (const m of members) { cx += m.position.x; cy += m.position.y; cz += (m.elevation ?? 0); }
    const n = members.length;
    communityCentroid.set(cid, { x: cx / n, y: cy / n, z: cz / n });
  }

  // ── Phase 1: Respawn dead lobsters ────────────────────────────────────────

  for (const l of lobsters) {
    if ((l.health ?? 100) > 0) continue;
    if (l.respawnAt == null) l.respawnAt = now + RESPAWN_DELAY_MS;
    if (now < l.respawnAt) continue;
    const pos = smartSpawnPos(state, rng);
    l.position.x = pos.x;
    l.position.y = pos.y;
    l.elevation = pos.z;
    l.velocity = { x: 0, y: 0 };
    l.health = l.maxHp ?? 100;
    l.respawnAt = undefined;
    l.heading = rng() * Math.PI * 2;
    l.pitch = 0;
    l.behaviorState = "seeking-food";
    l.hostileTargetId = null;
    l.attackTargetId = null;
    l.lastAttackedById = null;
    l.lastAttackedAt = undefined;
    l.fleeFromId = null;
    l.targetFoodId = null;
    l.exploreTarget = null;
    if (state.lostShrimpToWinner) {
      for (const key of Object.keys(state.lostShrimpToWinner)) {
        if (key.startsWith(`${l.id}-`) || key.endsWith(`-${l.id}`)) {
          delete state.lostShrimpToWinner[key];
        }
      }
    }
    events.push(createEvent("respawn", {
      lobsterId: l.id, displayName: l.displayName ?? l.id,
    }, simTime, nextEventId()));
  }

  // ── Phase 2: Shrimp movement (drift + flee) ──────────────────────────────

  for (const f of state.foods) {
    const nearby = getNearbyLobsters(f.position.x, f.position.y, lobsterGrid);
    let nearestDist = Infinity;
    let nearestLx = 0, nearestLy = 0, nearestLz = 0;
    for (const l of nearby) {
      const d = dist3D(f.position.x, f.position.y, f.elevation, l.position.x, l.position.y, l.elevation ?? 0);
      if (d < nearestDist) {
        nearestDist = d;
        nearestLx = l.position.x;
        nearestLy = l.position.y;
        nearestLz = l.elevation ?? 0;
      }
    }
    if (nearby.length === 0) {
      for (const l of aliveLobsters) {
        const d = dist3D(f.position.x, f.position.y, f.elevation, l.position.x, l.position.y, l.elevation ?? 0);
        if (d < nearestDist) {
          nearestDist = d;
          nearestLx = l.position.x;
          nearestLy = l.position.y;
          nearestLz = l.elevation ?? 0;
        }
      }
    }

    if (nearestDist < SHRIMP_FLEE_RADIUS) {
      const dx = f.position.x - nearestLx;
      const dy = f.position.y - nearestLy;
      const dz = f.elevation - nearestLz;
      const d = Math.hypot(dx, dy, dz) || 1;
      const step = SHRIMP_FLEE_SPEED * dtSec;
      f.position.x += (dx / d) * step;
      f.position.y += (dy / d) * step;
      f.elevation = clamp(f.elevation + (dz / d) * step, 0, MAX_ELEVATION);
      f.heading = Math.atan2(dy, dx);
      f.pitch = Math.atan2(dz, Math.hypot(dx, dy));
    } else {
      if (!f.motionTimer || f.motionTimer <= 0) {
        f.motionTimer = SHRIMP_DIRECTION_CHANGE_MS / 1000 + rng() * 2;
        const angle = rng() * Math.PI * 2;
        const pitchA = (rng() - 0.5) * 0.6;
        f.velocity.x = Math.cos(angle) * SHRIMP_DRIFT_SPEED;
        f.velocity.y = Math.sin(angle) * SHRIMP_DRIFT_SPEED;
        f.targetSpeed = Math.sin(pitchA) * SHRIMP_DRIFT_SPEED * 0.3;
      }
      f.motionTimer = (f.motionTimer ?? 1) - dtSec;
      f.position.x += (f.velocity.x ?? 0) * dtSec;
      f.position.y += (f.velocity.y ?? 0) * dtSec;
      f.elevation = clamp(f.elevation + (f.targetSpeed ?? 0) * dtSec, 0, MAX_ELEVATION);
      f.heading = Math.atan2(f.velocity.y || 0.01, f.velocity.x || 0);
      f.pitch = Math.atan2(f.targetSpeed ?? 0, Math.hypot(f.velocity.x || 0, f.velocity.y || 0));
    }
    f.position.x = clamp(f.position.x, margin, maxX);
    f.position.y = clamp(f.position.y, margin, maxY);
    f.elevation = clamp(f.elevation, 0, MAX_ELEVATION);
  }

  // ── Phase 3: Octopus behavior ─────────────────────────────────────────────

  const claimedTargets = new Set<string>();
  for (const p of predators) {
    if (p.targetLobsterId) claimedTargets.add(p.targetLobsterId);
  }

  for (const p of predators) {
    // Validate current target
    if (p.targetLobsterId) {
      const cur = lobsterById.get(p.targetLobsterId);
      if (!cur || !lobsterAlive(cur)) {
        claimedTargets.delete(p.targetLobsterId);
        p.targetLobsterId = null;
      }
    }

    // Pick new target: lowest HP, not already claimed by another octopus
    if (!p.targetLobsterId) {
      let best: Lobster | null = null;
      let bestHp = Infinity;
      for (const l of aliveLobsters) {
        if (claimedTargets.has(l.id)) continue;
        const hp = l.health ?? 100;
        if (hp < bestHp) { bestHp = hp; best = l; }
      }
      if (!best) {
        for (const l of aliveLobsters) {
          const hp = l.health ?? 100;
          if (hp < bestHp) { bestHp = hp; best = l; }
        }
      }
      if (best) {
        p.targetLobsterId = best.id;
        claimedTargets.add(best.id);
      }
    }

    const target = p.targetLobsterId ? lobsterById.get(p.targetLobsterId) : null;

    if (target && lobsterAlive(target)) {
      // Chase target
      const chaseSpeed = PREDATOR_SPEED * (
        dist3D(p.position.x, p.position.y, p.elevation ?? 0,
          target.position.x, target.position.y, target.elevation ?? 0) < CLOSE_DIST
          ? 0.7 : 1
      );
      const d = steer(p as Steerable, target.position.x, target.position.y, target.elevation ?? 0,
        chaseSpeed, dtSec, false, bounds);

      // Attack
      if (d < PREDATOR_ATTACK_RADIUS && (p.attackCooldownUntil ?? 0) <= now) {
        p.attackCooldownUntil = now + PREDATOR_ATTACK_COOLDOWN_MS;

        const allies = communityMap.get(target.communityId ?? "") ?? [];
        const defendersNearby = allies.filter(a =>
          a.id !== target.id &&
          dist3D(a.position.x, a.position.y, a.elevation ?? 0,
            target.position.x, target.position.y, target.elevation ?? 0) < 35
        );
        const dmg = defendersNearby.length >= 2 ? PREDATOR_DAMAGE * 0.6 : PREDATOR_DAMAGE;
        target.health = Math.max(0, (target.health ?? 100) - dmg);
        target.lastAttackedById = p.id;
        target.lastAttackedAt = now;

        for (const def of defendersNearby.slice(0, 2)) {
          p.health = Math.max(0, p.health - 12);
          // Mark defender as having "fought" predator
          def.lastAttackedById = p.id;
          def.lastAttackedAt = now;
        }

        events.push(createEvent("predator-attack", {
          predatorId: p.id, lobsterId: target.id, victimId: target.id,
          displayName: target.displayName ?? target.id,
        }, simTime, nextEventId()));

        if ((target.health ?? 0) <= 0) {
          target.respawnAt = now + RESPAWN_DELAY_MS;
          target.losses = (target.losses ?? 0) + 1;
          target.deathsFromOctopuses = (target.deathsFromOctopuses ?? 0) + 1;
          clearAggressionToward(target.id, lobsters, predators);
          p.targetLobsterId = null;
          claimedTargets.delete(target.id);
          events.push(createEvent("predator-kill", {
            predatorId: p.id, lobsterId: target.id, victimId: target.id,
            victimName: target.displayName ?? target.id,
            displayName: target.displayName ?? target.id,
          }, simTime, nextEventId()));
        }

        if (p.health <= 0) {
          p.health = p.maxHp ?? PREDATOR_MAX_HP;
          p.targetLobsterId = null;
          const pos = smartSpawnPos(state, rng);
          p.position.x = pos.x;
          p.position.y = pos.y;
          p.elevation = pos.z;
        }
      }
    } else {
      // Patrol: gentle random roaming
      p.heading += (rng() - 0.5) * 1.5 * dtSec;
      p.heading = wallDeflect(p.position.x, p.position.y, p.heading, bounds);
      const patrolSpeed = PREDATOR_SPEED * 0.3;
      const step = patrolSpeed * dtSec;
      p.position.x += Math.cos(p.heading) * step;
      p.position.y += Math.sin(p.heading) * step;
      p.elevation = clamp((p.elevation ?? 0) + (rng() - 0.5) * 5 * dtSec, 0, MAX_ELEVATION);
      p.position.x = clamp(p.position.x, margin, maxX);
      p.position.y = clamp(p.position.y, margin, maxY);
      p.velocity.x = Math.cos(p.heading) * patrolSpeed;
      p.velocity.y = Math.sin(p.heading) * patrolSpeed;
    }
  }

  // Octopus separation
  for (let i = 0; i < predators.length; i++) {
    for (let j = i + 1; j < predators.length; j++) {
      const a = predators[i], b = predators[j];
      const dx = a.position.x - b.position.x;
      const dy = a.position.y - b.position.y;
      const dz = (a.elevation ?? 0) - (b.elevation ?? 0);
      const d = Math.hypot(dx, dy, dz);
      if (d < PRED_SEP_RADIUS && d > 0.01) {
        const push = ((PRED_SEP_RADIUS - d) / PRED_SEP_RADIUS) * 25 * dtSec;
        const nx = dx / d, ny = dy / d, nz = dz / d;
        a.position.x += nx * push; a.position.y += ny * push;
        a.elevation = clamp((a.elevation ?? 0) + nz * push, 0, MAX_ELEVATION);
        b.position.x -= nx * push; b.position.y -= ny * push;
        b.elevation = clamp((b.elevation ?? 0) - nz * push, 0, MAX_ELEVATION);
      }
    }
  }

  // ── Phase 4: Lobster behavior ─────────────────────────────────────────────

  for (const l of aliveLobsters) {
    const hp = l.health ?? 100;
    const hpMax = l.maxHp ?? 100;
    const hpPct = hp / hpMax;
    const boostActive = typeof l.petBoostUntil === "number" && l.petBoostUntil > now;
    const baseSpeed = speedForLevel(l.level ?? 1) * (l.speedMult ?? 1);
    const speed = boostActive ? baseSpeed * PET_SPEED_MULT : baseSpeed;

    if (typeof process !== "undefined" && process.env?.NODE_ENV === "development" &&
        l === aliveLobsters[0] && simTime % 1000 < cappedDelta) {
      const nearPred = predators.length > 0
        ? Math.min(...predators.map(p => dist3D(l.position.x, l.position.y, l.elevation ?? 0, p.position.x, p.position.y, p.elevation ?? 0))).toFixed(0)
        : "none";
      console.log(`[v2] ${l.id} prev=${l._lastBehavior ?? "?"} pos=(${l.position.x.toFixed(0)},${l.position.y.toFixed(0)}) el=${(l.elevation ?? 0).toFixed(0)} hp=${hp.toFixed(0)}/${hpMax} food#=${state.foods.length} target=${l.targetFoodId ?? "none"} nearPred=${nearPred} heading=${l.heading.toFixed(2)}`);
    }

    // ── A: FLEE low HP ──────────────────────────────────────────────
    if (hpPct <= FLEE_HP_THRESHOLD && l.lastAttackedById) {
      l.behaviorState = "fleeing";
      l.fleeFromId = l.lastAttackedById;
      const attacker = lobsterById.get(l.lastAttackedById) ??
        predators.find(p => p.id === l.lastAttackedById);

      if (attacker) {
        const allies = (communityMap.get(l.communityId ?? "") ?? [])
          .filter(a => a.id !== l.id &&
            dist3D(l.position.x, l.position.y, l.elevation ?? 0,
              a.position.x, a.position.y, a.elevation ?? 0) <= ALLIES_GROUP_RADIUS);

        if (allies.length > 0) {
          const centroid = communityCentroid.get(l.communityId ?? "");
          const toCentroid = centroid
            ? dist3D(l.position.x, l.position.y, l.elevation ?? 0, centroid.x, centroid.y, centroid.z)
            : Infinity;

          if (toCentroid <= STAY_NEAR_ALLIES_RADIUS) {
            steer(l as Steerable, attacker.position.x, attacker.position.y,
              (attacker as Lobster).elevation ?? (attacker as Predator).elevation ?? 0,
              speed * 0.5, dtSec, true, bounds);
          } else if (centroid) {
            steer(l as Steerable, centroid.x, centroid.y, centroid.z,
              speed * 1.1, dtSec, false, bounds);
          }
        } else {
          steer(l as Steerable, attacker.position.x, attacker.position.y,
            (attacker as Lobster).elevation ?? (attacker as Predator).elevation ?? 0,
            speed * 1.2, dtSec, true, bounds);
        }
      }
      l._lastBehavior = "flee-low-hp";
      continue;
    }

    // ── A': FLEE from close octopus → toward safe food ──────────────
    {
      let closestPredDist = Infinity;
      let closestPred: Predator | null = null;
      for (const p of predators) {
        const d = dist3D(l.position.x, l.position.y, l.elevation ?? 0,
          p.position.x, p.position.y, p.elevation ?? 0);
        if (d < closestPredDist) { closestPredDist = d; closestPred = p; }
      }

      if (closestPred && closestPredDist < 25) {
        l.behaviorState = "fleeing";
        l.fleeFromId = closestPred.id;

        const awayAngle = Math.atan2(
          l.position.y - closestPred.position.y,
          l.position.x - closestPred.position.x
        );

        let safeFood: Food | null = null;
        let safeDist = Infinity;
        const lz = l.elevation ?? 0;
        for (const f of state.foods) {
          const toFoodAngle = Math.atan2(
            f.position.y - l.position.y,
            f.position.x - l.position.x
          );
          const angDiff = Math.abs(angleDiff(toFoodAngle, awayAngle));
          if (angDiff > Math.PI * 0.6) continue;
          const d = dist3D(l.position.x, l.position.y, lz,
            f.position.x, f.position.y, f.elevation);
          if (d < safeDist) { safeDist = d; safeFood = f; }
        }

        if (safeFood) {
          steer(l as Steerable, safeFood.position.x, safeFood.position.y,
            safeFood.elevation, speed * 1.3, dtSec, false, bounds);
          l.targetFoodId = safeFood.id;
          l._lastBehavior = "flee-to-food";
        } else {
          const fleeX = l.position.x + Math.cos(awayAngle) * 120;
          const fleeY = l.position.y + Math.sin(awayAngle) * 120;
          steer(l as Steerable,
            clamp(fleeX, margin, maxX),
            clamp(fleeY, margin, maxY),
            clamp(lz, 0, MAX_ELEVATION),
            speed * 1.3, dtSec, false, bounds);
          l._lastBehavior = "flee-away";
        }
        continue;
      }
    }

    // ── B: DEFEND community ally ────────────────────────────────────
    if (l.communityId) {
      const allies = communityMap.get(l.communityId) ?? [];
      let allyUnderAttack: Lobster | null = null;
      let assailantId: string | null = null;
      for (const ally of allies) {
        if (ally.id === l.id) continue;
        if (ally.lastAttackedById && ally.lastAttackedAt &&
          (now - ally.lastAttackedAt < ALLY_ATTACK_MEMORY_MS) &&
          ((ally.health ?? 100) / (ally.maxHp ?? 100)) < 1) {
          const d = dist3D(l.position.x, l.position.y, l.elevation ?? 0,
            ally.position.x, ally.position.y, ally.elevation ?? 0);
          if (d < COMMUNITY_DEFEND_RADIUS) {
            allyUnderAttack = ally;
            assailantId = ally.lastAttackedById;
            break;
          }
        }
      }

      if (allyUnderAttack && assailantId) {
        l.behaviorState = "defending";
        const assailant = lobsterById.get(assailantId) ?? predators.find(p => p.id === assailantId);
        if (lobsterById.has(assailantId)) l.hostileTargetId = assailantId;

        if (assailant) {
          const d = steer(l as Steerable, assailant.position.x, assailant.position.y,
            (assailant as Lobster).elevation ?? (assailant as Predator).elevation ?? 0,
            speed * 1.1, dtSec, false, bounds);

          const isAssailantPredator = predators.some(pr => pr.id === assailantId);
          const meetsLevel = isAssailantPredator
            ? (l.level ?? 1) >= MIN_LEVEL_ATTACK_PREDATOR
            : (l.level ?? 1) >= MIN_LEVEL_ATTACK_LOBSTER;

          if (meetsLevel && d < LOBSTER_ATTACK_RADIUS && (l.attackCooldownUntil ?? 0) <= now) {
            l.attackCooldownUntil = now + LOBSTER_ATTACK_COOLDOWN_MS;
            const dmg = effectiveAttackDamage(l, boostActive);

            if (isAssailantPredator) {
              const pred = assailant as Predator;
              pred.health = Math.max(0, pred.health - dmg);
              if (pred.health <= 0) {
                pred.health = pred.maxHp ?? PREDATOR_MAX_HP;
                pred.targetLobsterId = null;
                const pos = smartSpawnPos(state, rng);
                pred.position.x = pos.x; pred.position.y = pos.y; pred.elevation = pos.z;
                clearAggressionToward(pred.id, lobsters, predators);
                l.xp = (l.xp ?? 0) + PREDATOR_KILL_XP;
                events.push(createEvent("predator-killed", {
                  killerId: l.id, killerName: l.displayName ?? l.id, predatorId: pred.id,
                }, simTime, nextEventId()));
              }
            } else {
              const target = assailant as Lobster;
              target.health = Math.max(0, (target.health ?? 100) - dmg);
              target.lastAttackedById = l.id;
              target.lastAttackedAt = now;
              events.push(createEvent("community-defend", {
                defenderId: l.id, defenderName: l.displayName ?? l.id,
                allyId: allyUnderAttack.id, allyName: allyUnderAttack.displayName ?? allyUnderAttack.id,
                assailantId: target.id, assailantName: target.displayName ?? target.id,
              }, simTime, nextEventId()));
              if ((target.health ?? 0) <= 0) {
                target.respawnAt = now + RESPAWN_DELAY_MS;
                l.lobsterKills = (l.lobsterKills ?? 0) + 1;
                l.xp = (l.xp ?? 0) + LOBSTER_KILL_XP;
                target.losses = (target.losses ?? 0) + 1;
                target.deathsFromLobsters = (target.deathsFromLobsters ?? 0) + 1;
                clearAggressionToward(target.id, lobsters, predators);
                events.push(createEvent("kill", {
                  killerId: l.id, killerName: l.displayName ?? l.id,
                  victimId: target.id, victimName: target.displayName ?? target.id,
                }, simTime, nextEventId()));
              }
            }
          }
        }
        l._lastBehavior = "defend";
        continue;
      }
    }

    // ── C: HOSTILE (grudge target) ──────────────────────────────────
    if (l.hostileTargetId) {
      const target = lobsterById.get(l.hostileTargetId);
      if (!target || !lobsterAlive(target) || (l.level ?? 1) < MIN_LEVEL_ATTACK_LOBSTER) {
        l.hostileTargetId = null;
        l.behaviorState = "seeking-food";
      } else {
        l.behaviorState = "hostile";
        l.attackTargetId = target.id;
        const d = steer(l as Steerable, target.position.x, target.position.y, target.elevation ?? 0,
          speed, dtSec, false, bounds);

        if (d < LOBSTER_ATTACK_RADIUS && (l.attackCooldownUntil ?? 0) <= now) {
          l.attackCooldownUntil = now + LOBSTER_ATTACK_COOLDOWN_MS;
          const dmg = effectiveAttackDamage(l, boostActive);
          target.health = Math.max(0, (target.health ?? 100) - dmg);
          target.lastAttackedById = l.id;
          target.lastAttackedAt = now;
          events.push(createEvent("conflict", {
            attackerId: l.id, attackerName: l.displayName ?? l.id,
            defenderId: target.id, defenderName: target.displayName ?? target.id,
            reason: "shrimp-rivalry",
          }, simTime, nextEventId()));
          if ((target.health ?? 0) <= 0) {
            target.respawnAt = now + RESPAWN_DELAY_MS;
            l.lobsterKills = (l.lobsterKills ?? 0) + 1;
            l.xp = (l.xp ?? 0) + LOBSTER_KILL_XP;
            target.losses = (target.losses ?? 0) + 1;
            target.deathsFromLobsters = (target.deathsFromLobsters ?? 0) + 1;
            clearAggressionToward(target.id, lobsters, predators);
            l.hostileTargetId = null;
            l.behaviorState = "seeking-food";
            events.push(createEvent("kill", {
              killerId: l.id, killerName: l.displayName ?? l.id,
              victimId: target.id, victimName: target.displayName ?? target.id,
            }, simTime, nextEventId()));
          }
        }
        l._lastBehavior = "hostile";
        continue;
      }
    }

    // ── D: FIGHT BACK ───────────────────────────────────────────────
    if (l.lastAttackedById && l.lastAttackedAt && (now - l.lastAttackedAt < ATTACK_MEMORY_MS) && hpPct > FLEE_HP_THRESHOLD) {
      const lobAttacker = lobsterById.get(l.lastAttackedById);
      const predAttacker = !lobAttacker ? predators.find(p => p.id === l.lastAttackedById) : null;
      const canFightLob = lobAttacker && lobsterAlive(lobAttacker) && (l.level ?? 1) >= MIN_LEVEL_ATTACK_LOBSTER;
      const canFightPred = predAttacker && (l.level ?? 1) >= MIN_LEVEL_ATTACK_PREDATOR;

      if (canFightLob && lobAttacker) {
        l.behaviorState = "fighting";
        l.attackTargetId = lobAttacker.id;
        const d = steer(l as Steerable, lobAttacker.position.x, lobAttacker.position.y, lobAttacker.elevation ?? 0,
          speed, dtSec, false, bounds);

        if (d < LOBSTER_ATTACK_RADIUS && (l.attackCooldownUntil ?? 0) <= now) {
          l.attackCooldownUntil = now + LOBSTER_ATTACK_COOLDOWN_MS;
          const dmg = effectiveAttackDamage(l, boostActive);
          lobAttacker.health = Math.max(0, (lobAttacker.health ?? 100) - dmg);
          lobAttacker.lastAttackedById = l.id;
          lobAttacker.lastAttackedAt = now;
          events.push(createEvent("conflict", {
            attackerId: l.id, attackerName: l.displayName ?? l.id,
            defenderId: lobAttacker.id, defenderName: lobAttacker.displayName ?? lobAttacker.id,
            reason: "fight-back",
          }, simTime, nextEventId()));
          if ((lobAttacker.health ?? 0) <= 0) {
            lobAttacker.respawnAt = now + RESPAWN_DELAY_MS;
            l.lobsterKills = (l.lobsterKills ?? 0) + 1;
            l.xp = (l.xp ?? 0) + LOBSTER_KILL_XP;
            lobAttacker.losses = (lobAttacker.losses ?? 0) + 1;
            lobAttacker.deathsFromLobsters = (lobAttacker.deathsFromLobsters ?? 0) + 1;
            clearAggressionToward(lobAttacker.id, lobsters, predators);
            l.lastAttackedById = null;
            events.push(createEvent("kill", {
              killerId: l.id, killerName: l.displayName ?? l.id,
              victimId: lobAttacker.id, victimName: lobAttacker.displayName ?? lobAttacker.id,
            }, simTime, nextEventId()));
          }
        }
        l._lastBehavior = "fighting";
        continue;
      }

      if (canFightPred && predAttacker) {
        l.behaviorState = "fighting";
        l.attackTargetId = predAttacker.id;
        const d = steer(l as Steerable, predAttacker.position.x, predAttacker.position.y, predAttacker.elevation ?? 0,
          speed, dtSec, false, bounds);

        if (d < LOBSTER_ATTACK_RADIUS && (l.attackCooldownUntil ?? 0) <= now) {
          l.attackCooldownUntil = now + LOBSTER_ATTACK_COOLDOWN_MS;
          const dmg = effectiveAttackDamage(l, boostActive);
          predAttacker.health = Math.max(0, predAttacker.health - dmg);
          if (predAttacker.health <= 0) {
            predAttacker.health = predAttacker.maxHp ?? PREDATOR_MAX_HP;
            predAttacker.targetLobsterId = null;
            const pos = smartSpawnPos(state, rng);
            predAttacker.position.x = pos.x; predAttacker.position.y = pos.y;
            predAttacker.elevation = pos.z;
            clearAggressionToward(predAttacker.id, lobsters, predators);
            l.xp = (l.xp ?? 0) + PREDATOR_KILL_XP;
            events.push(createEvent("predator-killed", {
              killerId: l.id, killerName: l.displayName ?? l.id, predatorId: predAttacker.id,
            }, simTime, nextEventId()));
          }
        }
        l._lastBehavior = "fighting";
        continue;
      }
    }

    // ── D': BETRAY ──────────────────────────────────────────────────
    if (l.betrayMode && l.communityId && (l.level ?? 1) >= MIN_LEVEL_ATTACK_LOBSTER) {
      const allies = (communityMap.get(l.communityId) ?? []).filter(a => a.id !== l.id);
      let weakest: Lobster | null = null;
      let weakestHp = Infinity;
      for (const a of allies) {
        const aHp = a.health ?? 100;
        if (aHp > 0 && aHp < weakestHp) { weakestHp = aHp; weakest = a; }
      }
      if (weakest) {
        l.hostileTargetId = weakest.id;
        l.behaviorState = "hostile";
        l.attackTargetId = weakest.id;
        const d = steer(l as Steerable, weakest.position.x, weakest.position.y, weakest.elevation ?? 0,
          speed, dtSec, false, bounds);
        if (d < LOBSTER_ATTACK_RADIUS && (l.attackCooldownUntil ?? 0) <= now) {
          l.attackCooldownUntil = now + LOBSTER_ATTACK_COOLDOWN_MS;
          const dmg = effectiveAttackDamage(l, boostActive);
          weakest.health = Math.max(0, (weakest.health ?? 100) - dmg);
          weakest.lastAttackedById = l.id;
          weakest.lastAttackedAt = now;
          if ((weakest.health ?? 0) <= 0) {
            weakest.respawnAt = now + RESPAWN_DELAY_MS;
            l.lobsterKills = (l.lobsterKills ?? 0) + 1;
            l.xp = (l.xp ?? 0) + LOBSTER_KILL_XP;
            weakest.losses = (weakest.losses ?? 0) + 1;
            weakest.deathsFromLobsters = (weakest.deathsFromLobsters ?? 0) + 1;
            clearAggressionToward(weakest.id, lobsters, predators);
            l.hostileTargetId = null;
            l.betrayMode = false;
            events.push(createEvent("kill", {
              killerId: l.id, killerName: l.displayName ?? l.id,
              victimId: weakest.id, victimName: weakest.displayName ?? weakest.id,
            }, simTime, nextEventId()));
          }
        }
        l._lastBehavior = "betray";
        continue;
      }
    }

    // ── D'': AGGRESSIVE ─────────────────────────────────────────────
    if (l.aggressiveMode && !l.hostileTargetId && (l.level ?? 1) >= MIN_LEVEL_ATTACK_LOBSTER) {
      const nonAllies = aliveLobsters.filter(o =>
        o.id !== l.id && o.communityId !== l.communityId);
      let nearest: Lobster | null = null;
      let nearestScore = SEEK_FOOD_RADIUS;
      for (const o of nonAllies) {
        const d = dist3D(l.position.x, l.position.y, l.elevation ?? 0,
          o.position.x, o.position.y, o.elevation ?? 0);
        const nearWall = o.position.x < margin + WALL_AVOID_MARGIN || o.position.x > maxX - WALL_AVOID_MARGIN ||
          o.position.y < margin + WALL_AVOID_MARGIN || o.position.y > maxY - WALL_AVOID_MARGIN;
        const score = d + (nearWall ? 120 : 0);
        if (score < nearestScore) { nearestScore = score; nearest = o; }
      }
      if (nearest) {
        l.hostileTargetId = nearest.id;
        l.behaviorState = "hostile";
        l.attackTargetId = nearest.id;
        const d = steer(l as Steerable, nearest.position.x, nearest.position.y, nearest.elevation ?? 0,
          speed, dtSec, false, bounds);
        if (d < LOBSTER_ATTACK_RADIUS && (l.attackCooldownUntil ?? 0) <= now) {
          l.attackCooldownUntil = now + LOBSTER_ATTACK_COOLDOWN_MS;
          const dmg = effectiveAttackDamage(l, boostActive);
          nearest.health = Math.max(0, (nearest.health ?? 100) - dmg);
          nearest.lastAttackedById = l.id;
          nearest.lastAttackedAt = now;
          events.push(createEvent("conflict", {
            attackerId: l.id, attackerName: l.displayName ?? l.id,
            defenderId: nearest.id, defenderName: nearest.displayName ?? nearest.id,
            reason: "aggressive",
          }, simTime, nextEventId()));
          if ((nearest.health ?? 0) <= 0) {
            nearest.respawnAt = now + RESPAWN_DELAY_MS;
            l.lobsterKills = (l.lobsterKills ?? 0) + 1;
            l.xp = (l.xp ?? 0) + LOBSTER_KILL_XP;
            nearest.losses = (nearest.losses ?? 0) + 1;
            nearest.deathsFromLobsters = (nearest.deathsFromLobsters ?? 0) + 1;
            clearAggressionToward(nearest.id, lobsters, predators);
            l.hostileTargetId = null;
            events.push(createEvent("kill", {
              killerId: l.id, killerName: l.displayName ?? l.id,
              victimId: nearest.id, victimName: nearest.displayName ?? nearest.id,
            }, simTime, nextEventId()));
          }
        }
        l._lastBehavior = "aggressive";
        continue;
      }
    }

    // ── E: SEEK FOOD (default) ──────────────────────────────────────
    l.behaviorState = "seeking-food";
    l.attackTargetId = null;
    l.fleeFromId = null;

    let food: Food | null = null;
    if (l.targetFoodId) {
      food = foodById.get(l.targetFoodId) ?? null;
    }
    if (!food) {
      food = findNearestFood(l, state.foods);
    }

    if (food) {
      l._lastBehavior = "seek-food";
      l.targetFoodId = food.id;
      steer(l as Steerable, food.position.x, food.position.y, food.elevation,
        speed, dtSec, false, bounds);
    } else {
      l._lastBehavior = "idle";
      l.targetFoodId = null;
      steer(l as Steerable, state.width / 2, state.height / 2, MAX_ELEVATION / 2,
        speed * 0.5, dtSec, false, bounds);
    }

    // ── Health regen (out of combat) ────────────────────────────────
    const inCombat = l.attackTargetId || l.hostileTargetId ||
      (l.lastAttackedAt && (now - l.lastAttackedAt < COMBAT_COOLDOWN_FOR_REGEN));
    if (!inCombat && (l.health ?? 100) < (l.maxHp ?? 100)) {
      l.health = Math.min(l.maxHp ?? 100, (l.health ?? 100) + HEALTH_REGEN_RATE * dtSec);
    }

  }

  // ── Phase 5: Eating (fair contest resolution) ─────────────────────────────

  const eatCandidates = new Map<string, Lobster[]>();
  for (const l of aliveLobsters) {
    if (!l.targetFoodId) continue;
    const food = foodById.get(l.targetFoodId);
    if (!food) { l.targetFoodId = null; continue; }
    const d = dist3D(l.position.x, l.position.y, l.elevation ?? 0,
      food.position.x, food.position.y, food.elevation);
    if (d > EAT_RADIUS) continue;
    let list = eatCandidates.get(food.id);
    if (!list) { list = []; eatCandidates.set(food.id, list); }
    list.push(l);
  }

  const eatenFoodIds = new Set<string>();
  for (const [foodId, candidates] of eatCandidates) {
    if (eatenFoodIds.has(foodId)) continue;
    const food = foodById.get(foodId);
    if (!food) continue;

    const winner = candidates[Math.floor(rng() * candidates.length)];

    winner.shrimpEaten = (winner.shrimpEaten ?? 0) + 1;
    winner.xp = (winner.xp ?? 0) + SHRIMP_XP;

    // Rivalry: aggressive / any lobster that was going for this food gets angry at winner
    // only when different communities or both not in a community (same-community don't turn hostile over shrimp)
    for (const l of aliveLobsters) {
      if (l.id === winner.id) continue;
      if (l.targetFoodId === foodId) {
        const key = `${l.id}-${winner.id}`;
        state.lostShrimpToWinner![key] = (state.lostShrimpToWinner![key] ?? 0) + 1;
        const sameCommunity = l.communityId && l.communityId === winner.communityId;
        const differentOrBothSolo = !sameCommunity; // different communities or both solo
        const count = state.lostShrimpToWinner![key] ?? 0;
        const levelOk = (l.level ?? 1) >= MIN_LEVEL_ATTACK_LOBSTER;
        const chanceAngry = rng() < 0.85; // chance they don't like each other; can still become friends later
        if (differentOrBothSolo && count >= SHRIMP_LOSS_ANGER_COUNT && levelOk && chanceAngry) {
          l.hostileTargetId = winner.id;
          events.push(createEvent("shrimp-rivalry", {
            loserId: l.id, loserName: l.displayName ?? l.id,
            winnerId: winner.id, winnerName: winner.displayName ?? winner.id,
            count,
          }, simTime, nextEventId()));
        }
        l.targetFoodId = null;
      }
    }

    events.push(createEvent("food", {
      lobsterId: winner.id, displayName: winner.displayName ?? winner.id, foodId,
    }, simTime, nextEventId()));

    // Level up
    const lvl = winner.level ?? 1;
    const eaten = winner.shrimpEaten ?? 0;
    if (lvl < SIM_LEVEL_CAP && eaten >= shrimpToReachLevel(lvl + 1)) {
      winner.level = lvl + 1;
      winner.maxHp = maxHpForLevel(winner.level);
      winner.attackDamage = attackDamageForLevel(winner.level);
      winner.health = Math.min(winner.maxHp, (winner.health ?? 100) + 5);
      events.push(createEvent("level", {
        lobsterId: winner.id, displayName: winner.displayName ?? winner.id,
        level: winner.level, source: "shrimp", shrimpEaten: winner.shrimpEaten,
      }, simTime, nextEventId()));
    }

    winner.velocity.x = 0;
    winner.velocity.y = 0;

    eatenFoodIds.add(foodId);
    const idx = state.foods.findIndex(f => f.id === foodId);
    if (idx >= 0) state.foods.splice(idx, 1);
    foodById.delete(foodId);

    const pos = smartSpawnPos(state, rng);
    const newFood: Food = {
      id: `food-${simTime}-${state.foods.length}-${rng().toString(36).slice(2, 8)}`,
      position: { x: pos.x, y: pos.y },
      velocity: { x: 0, y: 0 },
      heading: rng() * Math.PI * 2,
      elevation: pos.z,
      targetElevation: 0,
      createdAt: simTime,
      ttlMs: 120_000,
    };
    state.foods.push(newFood);
    foodById.set(newFood.id, newFood);
  }

  // ── Phase 6: Separation ───────────────────────────────────────────────────

  for (let i = 0; i < lobsters.length; i++) {
    const a = lobsters[i];
    if (!lobsterAlive(a)) continue;
    for (let j = i + 1; j < lobsters.length; j++) {
      const b = lobsters[j];
      if (!lobsterAlive(b)) continue;
      const inCombat =
        a.attackTargetId === b.id || a.hostileTargetId === b.id ||
        b.attackTargetId === a.id || b.hostileTargetId === a.id;
      if (inCombat) continue;
      const sameComm = a.communityId && a.communityId === b.communityId;
      const eitherDefOrFlee =
        a.behaviorState === "defending" || a.behaviorState === "fleeing" ||
        b.behaviorState === "defending" || b.behaviorState === "fleeing";
      if (sameComm && eitherDefOrFlee) continue;
      if (a.targetFoodId != null && a.targetFoodId === b.targetFoodId) continue;

      const dx = a.position.x - b.position.x;
      const dy = a.position.y - b.position.y;
      const dz = (a.elevation ?? 0) - (b.elevation ?? 0);
      const d = Math.hypot(dx, dy, dz);
      if (d < SEP_RADIUS && d > 0.01) {
        const overlap = (SEP_RADIUS - d) / SEP_RADIUS;
        const push = SEP_FORCE * overlap * dtSec;
        const nx = dx / d, ny = dy / d, nz = dz / d;
        a.position.x += nx * push; a.position.y += ny * push;
        a.elevation = clamp((a.elevation ?? 0) + nz * push, 0, MAX_ELEVATION);
        b.position.x -= nx * push; b.position.y -= ny * push;
        b.elevation = clamp((b.elevation ?? 0) - nz * push, 0, MAX_ELEVATION);
      }
    }
    a.position.x = clamp(a.position.x, margin, maxX);
    a.position.y = clamp(a.position.y, margin, maxY);
  }

  // ── Phase 7: Social (friendly encounters + community formation + rivalry) ──

  for (let i = 0; i < aliveLobsters.length; i++) {
    const a = aliveLobsters[i];
    if (a.behaviorState === "hostile" || a.behaviorState === "fighting" || a.behaviorState === "fleeing") continue;

    for (let j = i + 1; j < aliveLobsters.length; j++) {
      const b = aliveLobsters[j];
      if (b.behaviorState === "hostile" || b.behaviorState === "fighting" || b.behaviorState === "fleeing") continue;

      const d = dist3D(a.position.x, a.position.y, a.elevation ?? 0,
        b.position.x, b.position.y, b.elevation ?? 0);
      if (d > FRIENDLY_INTERACTION_RADIUS) continue;

      const bothInDiffComm = a.communityId && b.communityId && a.communityId !== b.communityId;
      if (bothInDiffComm) {
        if ((a.level ?? 1) >= MIN_LEVEL_ATTACK_LOBSTER && (b.level ?? 1) >= MIN_LEVEL_ATTACK_LOBSTER) {
          if (!a.hostileTargetId && !b.hostileTargetId) {
            a.hostileTargetId = b.id;
            b.hostileTargetId = a.id;
            a.behaviorState = "hostile";
            b.behaviorState = "hostile";
            const commA = state.communities.find(c => c.id === a.communityId);
            const commB = state.communities.find(c => c.id === b.communityId);
            events.push(createEvent("conflict", {
              attackerId: a.id, attackerName: a.displayName ?? a.id,
              targetId: b.id, targetName: b.displayName ?? b.id,
              reason: `Rival communities ${commA?.name ?? "?"} vs ${commB?.name ?? "?"}`,
            }, simTime, nextEventId()));
          }
        }
        continue;
      }

      const sameComm = a.communityId && a.communityId === b.communityId;
      if (sameComm) continue;

      const key = sortedPairKey(a.id, b.id);

      if (a.targetFoodId != null && a.targetFoodId === b.targetFoodId) {
        state.lastFriendlyEncounterTime![key] = now;
        const cur = state.friendlyEncounterCount![key] ?? 0;
        if (cur > 0) state.friendlyEncounterCount![key] = Math.max(0, cur - 1);
        continue;
      }

      const lastTime = state.lastFriendlyEncounterTime![key] ?? 0;
      if (now - lastTime < FRIENDLY_INTERACTION_COOLDOWN_MS) continue;

      state.lastFriendlyEncounterTime![key] = now;
      state.friendlyEncounterCount![key] = (state.friendlyEncounterCount![key] ?? 0) + 1;
      const count = state.friendlyEncounterCount![key];

      const oneHasCommOtherNot = (a.communityId && !b.communityId) || (!a.communityId && b.communityId);
      if (count >= 1 && oneHasCommOtherNot) {
        const commId = a.communityId ?? b.communityId!;
        const members = communityMap.get(commId) ?? [];
        if (members.length < COMMUNITY_MAX_SIZE) {
          const joiner = a.communityId ? b : a;
          joiner.communityId = commId;
          members.push(joiner);
          const comm = state.communities.find(c => c.id === commId);
          events.push(createEvent("gang-join", {
            communityId: commId, communityName: comm?.name ?? "Unknown",
            lobsterId: joiner.id, displayName: joiner.displayName ?? joiner.id,
          }, simTime, nextEventId()));
          state.friendlyEncounterCount![key] = 0;
          continue;
        }
      }

      if (count >= COMMUNITY_FORM_THRESHOLD && !a.communityId && !b.communityId) {
        const commId = createCommunity(state, rng);
        a.communityId = commId;
        b.communityId = commId;
        const newMembers = [a, b];
        communityMap.set(commId, newMembers);
        const comm = state.communities.find(c => c.id === commId);
        events.push(createEvent("gang-form", {
          communityId: commId, communityName: comm?.name ?? "Unknown",
          memberIds: [a.id, b.id],
          memberNames: [a.displayName ?? a.id, b.displayName ?? b.id],
        }, simTime, nextEventId()));
        state.friendlyEncounterCount![key] = 0;
      } else if (count >= 1) {
        events.push(createEvent("friendship", {
          lobster1Id: a.id, lobster1Name: a.displayName ?? a.id,
          lobster2Id: b.id, lobster2Name: b.displayName ?? b.id,
          interactionCount: count,
        }, simTime, nextEventId()));
      }
    }
  }

  // ── Phase 8: Food maintenance ─────────────────────────────────────────────

  while (state.foods.length < FOOD_COUNT_TARGET) {
    const pos = smartSpawnPos(state, rng);
    const newFood: Food = {
      id: `food-${simTime}-${state.foods.length}-${rng().toString(36).slice(2, 8)}`,
      position: { x: pos.x, y: pos.y },
      velocity: { x: 0, y: 0 },
      heading: rng() * Math.PI * 2,
      elevation: pos.z,
      targetElevation: 0,
      createdAt: simTime,
      ttlMs: 120_000,
    };
    state.foods.push(newFood);
  }

  return { state, events };
}
