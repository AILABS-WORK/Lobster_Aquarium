/**
 * Lobster Tank Engine — full behavioral rewrite.
 *
 * Per-entity state machines:
 *   Lobster: seeking-food | hostile | fighting | fleeing | defending
 *   Shrimp:  drifting | fleeing (implicit via proximity check)
 *   Octopus: hunting (lowest-health lobster) | attacking | wandering
 *
 * Key mechanics:
 *   - Shrimp drift slowly and flee from nearby lobsters
 *   - Octopus targets the lobster with the lowest health, locks on until dead
 *   - Lobsters seek food, get angry after losing shrimp 4x to same rival
 *   - At <=30% HP lobsters flee toward community allies
 *   - Community allies rush to defend attacked members
 *   - Communities form from friendly interactions between passing lobsters (threshold 2, 8s apart)
 *   - On death all aggression toward that entity resets
 */
import { createEvent, TankEvent } from "./events";
import { TANK_WALL_MARGIN } from "./factory";
import { shrimpToReachLevel } from "./engine";
import type { Community, Food, Lobster, Predator, RandomFn, TankState } from "./types";

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_DELTA_MS = 50;
const MARGIN = TANK_WALL_MARGIN;
const MAX_ELEVATION = 470;
/** Fallback so sim never clamps everyone into one corner when dimensions are missing/wrong. */
const FALLBACK_WIDTH = 800;
const FALLBACK_HEIGHT = 600;

const LOBSTER_BASE_SPEED = 26;
const SHRIMP_DRIFT_SPEED = 3;
const SHRIMP_FLEE_SPEED = 9;
const SHRIMP_FLEE_RADIUS = 35;
const SHRIMP_DIRECTION_CHANGE_MS = 3000;
const PREDATOR_SPEED = 28;
const EAT_RADIUS = 6;
const PREDATOR_ATTACK_RADIUS = 18;
const PREDATOR_DAMAGE = 30;
const PREDATOR_ATTACK_COOLDOWN_MS = 1200;
const LOBSTER_ATTACK_RADIUS = 14;
const LOBSTER_ATTACK_DAMAGE = 7;
const LOBSTER_ATTACK_COOLDOWN_MS = 1000;
const SHRIMP_XP = 12;
const LOBSTER_KILL_XP = 120;
const PREDATOR_KILL_XP = 600;
/** Level at which lobster matches octopus speed and has 1/2 octopus HP, 1/3 octopus damage */
const REFERENCE_LEVEL = 10;
const PREDATOR_MAX_HP = 500;
const FLEE_HP_THRESHOLD = 0.30;
/** When a predator is this close or targeting this lobster, lobster flees (avoids corner-stuck). */
const FLEE_PREDATOR_RADIUS = 95;
/** When fleeing to community, stay within this distance of group (no chasing one lobster). */
const STAY_NEAR_ALLIES_RADIUS = 72;
/** Max distance to consider allies when computing "group" to stay near. */
const ALLIES_GROUP_RADIUS = 140;
const MIN_LEVEL_ATTACK_LOBSTER = 3;
const MIN_LEVEL_ATTACK_PREDATOR = 5;
const SHRIMP_LOSS_ANGER_COUNT = 4;
const FRIENDLY_INTERACTION_RADIUS = 30;
const FRIENDLY_INTERACTION_COOLDOWN_MS = 8_000;
const COMMUNITY_FORM_THRESHOLD = 2;
const COMMUNITY_MAX_SIZE = 5;
const COMMUNITY_DEFEND_RADIUS = 280;
/** How long an ally is considered "under attack" for defenders to respond (longer = more help). */
const ALLY_ATTACK_MEMORY_MS = 6_000;
const RESPAWN_DELAY_MS = 20_000;
const FOOD_COUNT_TARGET = 78;
/** Primary radius to pick nearest shrimp; lobster always targets the closest in this range. */
const SEEK_FOOD_RADIUS = 120;
/** Fallback radius when no food in SEEK_FOOD_RADIUS (e.g. one lobster alone) so we still seek across the whole tank. */
const SEEK_FOOD_RADIUS_FALLBACK = 9999;
const ATTACK_MEMORY_MS = 3000;
/** Tiny heading wobble so lobsters don't move in perfect lockstep; kept minimal to avoid looping. */
const HEADING_WOBBLE = 0.02;
/** Spread of food target offset so lobsters don't all converge on the exact same point. */

const COMMUNITY_NAMES = [
  "Pearl Ring", "Deep Current", "Rust Claw", "Coral Guard",
  "Shale Band", "Briny Pact", "Silt Crew", "Reef Watch",
];
const COMMUNITY_COLORS = [
  "#0d9488", "#d97706", "#475569", "#be123c",
  "#4f46e5", "#059669", "#7c3aed", "#0369a1",
];

/** Throttle: log each lobster at most once per 2s when near wall (dev diagnostic for wall-seeking). */
const _wallLogLast = new Map<string, number>();
const WALL_LOG_THROTTLE_MS = 2000;
/** Throttle: log first lobster every 1.5s so we see behavior/heading even when not near wall. */
let _diagLogLast = 0;
let _dtLogLast = 0;
const DIAG_LOG_THROTTLE_MS = 1500;
const DT_LOG_THROTTLE_MS = 1000;
/** Set window.__LOBSTER_DEBUG = true in console to force behavior logs even when NODE_ENV !== "development". */
function _devLog(...args: unknown[]) {
  const dev = typeof process !== "undefined" && process.env.NODE_ENV === "development";
  const force = typeof globalThis !== "undefined" && (globalThis as unknown as { __LOBSTER_DEBUG?: boolean }).__LOBSTER_DEBUG;
  if (dev || force) console.log("[lobster]", ...args);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Lobster speed scales with level; at REFERENCE_LEVEL (10) equals PREDATOR_SPEED */
function speedForLevel(level: number): number {
  const L = Math.min(level, REFERENCE_LEVEL);
  return LOBSTER_BASE_SPEED + ((L - 1) / (REFERENCE_LEVEL - 1)) * (PREDATOR_SPEED - LOBSTER_BASE_SPEED);
}

/** Lobster maxHp scales with level; at level 10 = 1/2 octopus maxHp (250) */
function maxHpForLevel(level: number): number {
  const L = Math.min(level, REFERENCE_LEVEL);
  const hpAt10 = Math.floor(PREDATOR_MAX_HP / 2);
  return 100 + Math.floor(((L - 1) / (REFERENCE_LEVEL - 1)) * (hpAt10 - 100));
}

/** Lobster attack damage scales with level; at level 10 = 1/3 octopus damage (10). Callers multiply by (l.damageMult ?? 1). */
function attackDamageForLevel(level: number): number {
  const L = Math.min(level, REFERENCE_LEVEL);
  const dmgAt10 = Math.floor(PREDATOR_DAMAGE / 3);
  return 4 + Math.floor(((L - 1) / (REFERENCE_LEVEL - 1)) * (dmgAt10 - 4));
}

function effectiveAttackDamage(l: Lobster): number {
  const base = l.attackDamage ?? attackDamageForLevel(l.level ?? 1);
  return Math.max(1, Math.round(base * (l.damageMult ?? 1)));
}

function dist3D(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return Math.hypot(bx - ax, by - ay, bz - az);
}

function lobsterAlive(l: Lobster): boolean {
  return (l.health ?? 100) > 0 && l.respawnAt == null;
}

function sortedPairKey(a: string, b: string): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

const TURN_RATE = 4;
const TURN_RATE_CLOSE = 5.5;
const CLOSE_DIST = 25;

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function steerToward3D(
  entity: { position: { x: number; y: number }; elevation?: number; heading: number; pitch?: number },
  tx: number, ty: number, tz: number,
  speed: number, dtSec: number
): { dx: number; dy: number; dz: number; dist: number } {
  const gapX = tx - entity.position.x;
  const gapY = ty - entity.position.y;
  const gapZ = tz - (entity.elevation ?? 0);
  const dist = Math.hypot(gapX, gapY, gapZ) || 1;

  const desiredHeading = Math.atan2(gapY, gapX);
  const desiredPitch = Math.atan2(gapZ, Math.hypot(gapX, gapY));

  const rate = dist < CLOSE_DIST ? TURN_RATE_CLOSE : TURN_RATE;
  const maxTurn = rate * dtSec;

  const hDiff = angleDiff(desiredHeading, entity.heading);
  entity.heading += clamp(hDiff, -maxTurn, maxTurn);

  const pDiff = angleDiff(desiredPitch, entity.pitch ?? 0);
  entity.pitch = (entity.pitch ?? 0) + clamp(pDiff, -maxTurn, maxTurn);

  const cosP = Math.cos(entity.pitch!);
  const cosH = Math.cos(entity.heading);
  const sinH = Math.sin(entity.heading);
  const sinP = Math.sin(entity.pitch!);

  const step = Math.min(speed * dtSec, dist);
  const moveDx = cosH * cosP * step;
  const moveDy = sinH * cosP * step;
  const moveDz = sinP * step;

  entity.position.x += moveDx;
  entity.position.y += moveDy;
  entity.elevation = clamp((entity.elevation ?? 0) + moveDz, 0, MAX_ELEVATION);
  return { dx: moveDx, dy: moveDy, dz: moveDz, dist };
}

function steerAway3D(
  entity: { position: { x: number; y: number }; elevation?: number; heading: number; pitch?: number },
  fx: number, fy: number, fz: number,
  speed: number, dtSec: number
): { dx: number; dy: number; dz: number } {
  const awayX = entity.position.x - fx;
  const awayY = entity.position.y - fy;
  const awayZ = (entity.elevation ?? 0) - fz;

  const desiredHeading = Math.atan2(awayY, awayX);
  const desiredPitch = Math.atan2(awayZ, Math.hypot(awayX, awayY));

  const maxTurn = TURN_RATE * dtSec;
  const hDiff = angleDiff(desiredHeading, entity.heading);
  entity.heading += clamp(hDiff, -maxTurn, maxTurn);
  const pDiff = angleDiff(desiredPitch, entity.pitch ?? 0);
  entity.pitch = (entity.pitch ?? 0) + clamp(pDiff, -maxTurn, maxTurn);

  const cosP = Math.cos(entity.pitch!);
  const cosH = Math.cos(entity.heading);
  const sinH = Math.sin(entity.heading);
  const sinP = Math.sin(entity.pitch!);

  const step = speed * dtSec;
  const moveDx = cosH * cosP * step;
  const moveDy = sinH * cosP * step;
  const moveDz = sinP * step;

  entity.position.x += moveDx;
  entity.position.y += moveDy;
  entity.elevation = clamp((entity.elevation ?? 0) + moveDz, 0, MAX_ELEVATION);
  return { dx: moveDx, dy: moveDy, dz: moveDz };
}

function moveAway3D(
  entity: { position: { x: number; y: number }; elevation?: number },
  fx: number, fy: number, fz: number,
  speed: number, dtSec: number
): void {
  const dx = entity.position.x - fx;
  const dy = entity.position.y - fy;
  const dz = (entity.elevation ?? 0) - fz;
  const dist = Math.hypot(dx, dy, dz) || 1;
  const step = speed * dtSec;
  entity.position.x += (dx / dist) * step;
  entity.position.y += (dy / dist) * step;
  entity.elevation = clamp((entity.elevation ?? 0) + (dz / dist) * step, 0, MAX_ELEVATION);
}

function moveToward3D(
  entity: { position: { x: number; y: number }; elevation?: number },
  tx: number, ty: number, tz: number,
  speed: number, dtSec: number
): { dx: number; dy: number; dz: number; dist: number } {
  const dx = tx - entity.position.x;
  const dy = ty - entity.position.y;
  const dz = tz - (entity.elevation ?? 0);
  const dist = Math.hypot(dx, dy, dz) || 1;
  const step = speed * dtSec;
  entity.position.x += (dx / dist) * step;
  entity.position.y += (dy / dist) * step;
  entity.elevation = clamp((entity.elevation ?? 0) + (dz / dist) * step, 0, MAX_ELEVATION);
  return { dx, dy, dz, dist };
}

function setFacing(entity: { heading: number; pitch?: number }, dx: number, dy: number, dz: number): void {
  entity.heading = Math.atan2(dy, dx);
  entity.pitch = Math.atan2(dz, Math.hypot(dx, dy));
}

/** Inner-zone margin: food within this of the wall is down-ranked so lobsters prefer shrimp away from walls. */
const WALL_AVOID_MARGIN = 80;

/** Nearest food within radius (3D distance). Prefers food in the inner zone when distance is similar (fix 1). */
function findNearestFood(
  l: Lobster,
  foods: Food[],
  radius: number,
  margin?: number,
  maxX?: number,
  maxY?: number
): Food | null {
  let best: Food | null = null;
  let bestScore = radius * radius;
  const lz = l.elevation ?? 0;
  const haveBounds = typeof margin === "number" && typeof maxX === "number" && typeof maxY === "number";
  for (const f of foods) {
    const dx = f.position.x - l.position.x;
    const dy = f.position.y - l.position.y;
    const dz = f.elevation - lz;
    const d2 = dx * dx + dy * dy + dz * dz;
    let score = d2;
    if (haveBounds) {
      const nearWall =
        f.position.x < margin + WALL_AVOID_MARGIN || f.position.x > maxX! - WALL_AVOID_MARGIN ||
        f.position.y < margin + WALL_AVOID_MARGIN || f.position.y > maxY! - WALL_AVOID_MARGIN;
      if (nearWall) score += 2500;
    }
    if (score < bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return best;
}

function findLowestHealthLobster(lobsters: Lobster[]): Lobster | null {
  let best: Lobster | null = null;
  let bestHp = Infinity;
  for (const l of lobsters) {
    if (!lobsterAlive(l)) continue;
    const hp = l.health ?? 100;
    if (hp < bestHp) { bestHp = hp; best = l; }
  }
  return best;
}

function communityMembers(lobsters: Lobster[], communityId: string | undefined): Lobster[] {
  if (!communityId) return [];
  return lobsters.filter(l => l.communityId === communityId && lobsterAlive(l));
}

function smartSpawnPos(state: TankState, rng: RandomFn): { x: number; y: number; z: number } {
  const w = Math.max(100, (state.width ?? FALLBACK_WIDTH) - MARGIN * 2);
  const h = Math.max(100, (state.height ?? FALLBACK_HEIGHT) - MARGIN * 2);
  let bestX = MARGIN + rng() * w;
  let bestY = MARGIN + rng() * h;
  let bestZ = rng() * MAX_ELEVATION;
  let bestScore = -Infinity;
  for (let attempt = 0; attempt < 8; attempt++) {
    const cx = MARGIN + rng() * w;
    const cy = MARGIN + rng() * h;
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

// ── Main tick ──────────────────────────────────────────────────────────────────

export function tickTankSimple(
  state: TankState,
  deltaMs: number,
  rng: RandomFn,
  now: number
): { state: TankState; events: TankEvent[] } {
  const cappedDelta = Math.min(deltaMs, MAX_DELTA_MS);
  const dtSec = cappedDelta / 1000;
  if (dtSec <= 0) return { state, events: [] };
  const devOrDebug = typeof process !== "undefined" && process.env.NODE_ENV === "development" ||
    (typeof globalThis !== "undefined" && (globalThis as unknown as { __LOBSTER_DEBUG?: boolean }).__LOBSTER_DEBUG);
  if (devOrDebug && now - _dtLogLast >= DT_LOG_THROTTLE_MS) {
    _dtLogLast = now;
    _devLog("dtSec", dtSec.toFixed(4), "deltaMs", deltaMs);
  }
  const events: TankEvent[] = [];

  const lobsters = state.lobsters;
  const predators = state.predators ?? [];
  if (!state.foods) state.foods = [];
  if (!state.communities) state.communities = [];
  if (!state.lostShrimpToWinner) state.lostShrimpToWinner = {};
  if (!state.friendlyEncounterCount) state.friendlyEncounterCount = {};
  if (!state.lastFriendlyEncounterTime) state.lastFriendlyEncounterTime = {};

  const simTime = (state.time ?? now) + cappedDelta;
  state.time = simTime;

  if (state.width == null || state.width < MARGIN * 2 || state.width < 100) state.width = FALLBACK_WIDTH;
  if (state.height == null || state.height < MARGIN * 2 || state.height < 100) state.height = FALLBACK_HEIGHT;

  const margin = MARGIN;
  const maxX = state.width - margin;
  const maxY = state.height - margin;

  const nextEventId = () => `ev-${simTime}-${events.length}-${rng().toString(36).slice(2, 9)}`;

  // Build lobster lookup by id for O(1) access
  const lobsterById = new Map<string, Lobster>();
  for (const l of lobsters) lobsterById.set(l.id, l);

  // ────────────────────────────────────────────────────────────────────────────
  // 1. RESPAWN dead lobsters
  // ────────────────────────────────────────────────────────────────────────────
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
    // Clear grudges: this lobster starts fresh (no shrimp-rivalry memory)
    if (state.lostShrimpToWinner) {
      for (const key of Object.keys(state.lostShrimpToWinner)) {
        if (key.startsWith(`${l.id}-`) || key.endsWith(`-${l.id}`)) delete state.lostShrimpToWinner![key];
      }
    }
    events.push(createEvent("respawn", {
      lobsterId: l.id, displayName: l.displayName ?? l.id,
    }, simTime, nextEventId()));
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 2. MOVE SHRIMP (drift + flee)
  // ────────────────────────────────────────────────────────────────────────────
  for (const f of state.foods) {
    let nearestLobDist = Infinity;
    let nearestLobX = 0, nearestLobY = 0, nearestLobZ = 0;
    for (const l of lobsters) {
      if (!lobsterAlive(l)) continue;
      const d = dist3D(f.position.x, f.position.y, f.elevation,
                       l.position.x, l.position.y, l.elevation ?? 0);
      if (d < nearestLobDist) {
        nearestLobDist = d;
        nearestLobX = l.position.x;
        nearestLobY = l.position.y;
        nearestLobZ = l.elevation ?? 0;
      }
    }

    if (nearestLobDist < SHRIMP_FLEE_RADIUS) {
      moveAway3D(f, nearestLobX, nearestLobY, nearestLobZ, SHRIMP_FLEE_SPEED, dtSec);
      const dx = f.position.x - nearestLobX;
      const dy = f.position.y - nearestLobY;
      const dz = f.elevation - nearestLobZ;
      setFacing(f, dx, dy, dz);
    } else {
      if (!f.motionTimer || f.motionTimer <= 0) {
        f.motionTimer = SHRIMP_DIRECTION_CHANGE_MS / 1000 + rng() * 2;
        const angle = rng() * Math.PI * 2;
        const pitchAngle = (rng() - 0.5) * 0.6;
        f.velocity.x = Math.cos(angle) * SHRIMP_DRIFT_SPEED;
        f.velocity.y = Math.sin(angle) * SHRIMP_DRIFT_SPEED;
        f.targetSpeed = Math.sin(pitchAngle) * SHRIMP_DRIFT_SPEED * 0.3;
      }
      f.motionTimer = (f.motionTimer ?? 1) - dtSec;
      f.position.x += (f.velocity.x ?? 0) * dtSec;
      f.position.y += (f.velocity.y ?? 0) * dtSec;
      f.elevation = clamp(f.elevation + (f.targetSpeed ?? 0) * dtSec, 0, MAX_ELEVATION);
      setFacing(f, f.velocity.x || 0.01, f.velocity.y || 0, f.targetSpeed ?? 0);
    }
    f.position.x = clamp(f.position.x, margin, maxX);
    f.position.y = clamp(f.position.y, margin, maxY);
    f.elevation = clamp(f.elevation, 0, MAX_ELEVATION);
  }

  // Top up shrimp count
  while (state.foods.length < FOOD_COUNT_TARGET) {
    const pos = smartSpawnPos(state, rng);
    state.foods.push({
      id: `food-${simTime}-${state.foods.length}-${rng().toString(36).slice(2, 8)}`,
      position: { x: pos.x, y: pos.y },
      velocity: { x: 0, y: 0 },
      heading: rng() * Math.PI * 2,
      elevation: pos.z,
      targetElevation: 0,
      createdAt: simTime,
      ttlMs: 120_000,
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 3. OCTOPUS BEHAVIOR (target lowest-health lobster, lock on)
  // ────────────────────────────────────────────────────────────────────────────
  const claimedTargets = new Set<string>();
  for (const p of predators) {
    if (p.targetLobsterId) claimedTargets.add(p.targetLobsterId);
  }
  for (const p of predators) {
    // If current target is dead or gone, clear it
    if (p.targetLobsterId) {
      const cur = lobsterById.get(p.targetLobsterId);
      if (!cur || !lobsterAlive(cur)) {
        claimedTargets.delete(p.targetLobsterId);
        p.targetLobsterId = null;
      }
    }
    // Pick new target: lowest health NOT already targeted by another octopus
    if (!p.targetLobsterId) {
      let best: Lobster | null = null;
      let bestHp = Infinity;
      for (const l of lobsters) {
        if (!lobsterAlive(l)) continue;
        if (claimedTargets.has(l.id)) continue;
        const hp = l.health ?? 100;
        if (hp < bestHp) { bestHp = hp; best = l; }
      }
      if (!best) {
        const fallback = findLowestHealthLobster(lobsters);
        if (fallback && lobsterAlive(fallback) && !claimedTargets.has(fallback.id))
          best = fallback;
      }
      if (best) {
        p.targetLobsterId = best.id;
        claimedTargets.add(best.id);
      }
    }

    const target = p.targetLobsterId ? lobsterById.get(p.targetLobsterId) : null;
    if (target && lobsterAlive(target)) {
      const { dx, dy, dz, dist } = steerToward3D(
        p, target.position.x, target.position.y, target.elevation ?? 0,
        PREDATOR_SPEED, dtSec
      );

      if (dist < PREDATOR_ATTACK_RADIUS && (p.attackCooldownUntil ?? 0) <= now) {
        p.attackCooldownUntil = now + PREDATOR_ATTACK_COOLDOWN_MS;
        target.health = Math.max(0, (target.health ?? 100) - PREDATOR_DAMAGE);
        target.lastAttackedById = p.id;
        target.lastAttackedAt = now;

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
          events.push(createEvent("predator-kill", {
            predatorId: p.id, lobsterId: target.id, victimId: target.id, victimName: target.displayName ?? target.id,
            displayName: target.displayName ?? target.id,
          }, simTime, nextEventId()));
        }
      }
    } else {
      // Wander randomly
      if (!p.velocity.x && !p.velocity.y) {
        const angle = rng() * Math.PI * 2;
        p.velocity.x = Math.cos(angle) * PREDATOR_SPEED * 0.3;
        p.velocity.y = Math.sin(angle) * PREDATOR_SPEED * 0.3;
      }
      p.position.x += p.velocity.x * dtSec;
      p.position.y += p.velocity.y * dtSec;
      if (rng() < 0.02) { p.velocity.x = 0; p.velocity.y = 0; }
    }
    p.position.x = clamp(p.position.x, margin, maxX);
    p.position.y = clamp(p.position.y, margin, maxY);
    p.elevation = clamp(p.elevation ?? 0, 0, MAX_ELEVATION);
  }
  // Separate octopuses from each other (softer, won't interfere with hunting)
  for (let i = 0; i < predators.length; i++) {
    for (let j = i + 1; j < predators.length; j++) {
      const a = predators[i], b = predators[j];
      const pdx = a.position.x - b.position.x;
      const pdy = a.position.y - b.position.y;
      const pdz = (a.elevation ?? 0) - (b.elevation ?? 0);
      const pDist = Math.hypot(pdx, pdy, pdz);
      const PRED_SEP = 20;
      if (pDist < PRED_SEP && pDist > 0.01) {
        const push = ((PRED_SEP - pDist) / PRED_SEP) * 25 * dtSec;
        const nx = pdx / pDist, ny = pdy / pDist, nz = pdz / pDist;
        a.position.x += nx * push; a.position.y += ny * push;
        a.elevation = clamp((a.elevation ?? 0) + nz * push, 0, MAX_ELEVATION);
        b.position.x -= nx * push; b.position.y -= ny * push;
        b.elevation = clamp((b.elevation ?? 0) - nz * push, 0, MAX_ELEVATION);
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 4. LOBSTER BEHAVIOR (priority-based state machine)
  // Each branch sets l._lastBehavior so UI can show which behavior ran (diagnostic for wall-seeking).
  // If lobster goes to wall: check _lastBehavior in right panel; fix that branch only (seek-food → prefer inner shrimp; wander → safe target; flee/defend → bias away from walls).
  // ────────────────────────────────────────────────────────────────────────────
  const eaten = new Set<string>();

  for (const l of lobsters) {
    if (!lobsterAlive(l)) continue;
    // Engine runs for all lobsters; first-person control only overrides position when user is pressing keys
    if (typeof l.heading !== "number" || Number.isNaN(l.heading)) l.heading = 0;
    if (typeof l.pitch !== "number" || Number.isNaN(l.pitch)) l.pitch = 0;

    const hp = l.health ?? 100;
    const maxHp = l.maxHp ?? 100;
    const hpPct = hp / maxHp;
    const speed = speedForLevel(l.level ?? 1) * (l.speedMult ?? 1);

    // ── Priority A: FLEE if health <= 30% — go toward group (centroid), stay nearby to regain health, don't chase one lobster ──
    if (hpPct <= FLEE_HP_THRESHOLD && l.lastAttackedById) {
      l.behaviorState = "fleeing";
      l.fleeFromId = l.lastAttackedById;
      const attacker = lobsterById.get(l.lastAttackedById) ??
                       predators.find(p => p.id === l.lastAttackedById);
      let fleeDx = 0, fleeDy = 0;
      let fleeSpeedMult = 1.15;
      if (attacker) {
        const allies = communityMembers(lobsters, l.communityId)
          .filter(a => a.id !== l.id && dist3D(l.position.x, l.position.y, l.elevation ?? 0, a.position.x, a.position.y, a.elevation ?? 0) <= ALLIES_GROUP_RADIUS);
        if (allies.length > 0) {
          let cx = 0, cy = 0, cz = 0;
          for (const a of allies) {
            cx += a.position.x; cy += a.position.y; cz += (a.elevation ?? 0);
          }
          cx /= allies.length; cy /= allies.length; cz /= allies.length;
          const toCentroid = dist3D(l.position.x, l.position.y, l.elevation ?? 0, cx, cy, cz);
          if (toCentroid <= STAY_NEAR_ALLIES_RADIUS) {
            fleeSpeedMult = 0.5;
            const r = steerAway3D(l, attacker.position.x, attacker.position.y,
                       (attacker as Lobster).elevation ?? (attacker as Predator).elevation ?? 0,
                       speed * 0.5, dtSec);
            fleeDx = r.dx; fleeDy = r.dy;
          } else {
            const jitterX = (rng() - 0.5) * 38;
            const jitterY = (rng() - 0.5) * 38;
            const jitterZ = (rng() - 0.5) * 25;
            const tx = clamp(cx + jitterX, margin, maxX);
            const ty = clamp(cy + jitterY, margin, maxY);
            const tz = cz + jitterZ;
            const r = steerToward3D(l, tx, ty, tz, speed * 1.1, dtSec);
            fleeDx = r.dx; fleeDy = r.dy;
          }
        } else {
          const r = steerAway3D(l, attacker.position.x, attacker.position.y,
                     (attacker as Lobster).elevation ?? (attacker as Predator).elevation ?? 0,
                     speed * 1.2, dtSec);
          fleeDx = r.dx;
          fleeDy = r.dy;
        }
      }
      const fleeDist = Math.hypot(fleeDx, fleeDy) || 1;
      l.velocity.x = (fleeDx / fleeDist) * speed * fleeSpeedMult;
      l.velocity.y = (fleeDy / fleeDist) * speed * fleeSpeedMult;
      clampLobster(l, margin, maxX, maxY);
      l._lastBehavior = "flee-low-hp";
      continue;
    }

    // ── Priority A': FLEE from octopus when targeted or predator very close (so lobster doesn't stay in corner) ──
    const predatorTargetingMe = predators.find(p => p.targetLobsterId === l.id);
    let nearestPredator: (typeof predators)[0] | null = null;
    let nearestPredDist = FLEE_PREDATOR_RADIUS;
    for (const p of predators) {
      const d = dist3D(l.position.x, l.position.y, l.elevation ?? 0,
                       p.position.x, p.position.y, p.elevation ?? 0);
      if (d < nearestPredDist || p.targetLobsterId === l.id) {
        nearestPredDist = d;
        nearestPredator = p;
      }
    }
    if (predatorTargetingMe || (nearestPredator && nearestPredDist < FLEE_PREDATOR_RADIUS)) {
      const pred = predatorTargetingMe ?? nearestPredator!;
      l.behaviorState = "fleeing";
      l.fleeFromId = pred.id;
      const centerX = (margin + maxX) / 2, centerY = (margin + maxY) / 2;
      const toCenterX = centerX - l.position.x, toCenterY = centerY - l.position.y;
      const tc = Math.hypot(toCenterX, toCenterY) || 1;
      const nearWall = l.position.x < margin + 60 || l.position.x > maxX - 60 ||
                       l.position.y < margin + 60 || l.position.y > maxY - 60;
      const centerPull = nearWall ? 1.1 : 0.45;
      const r = steerAway3D(l, pred.position.x, pred.position.y, pred.elevation ?? 0,
                            speed * 1.15, dtSec);
      if (nearWall && tc > 1) {
        const centerStep = speed * centerPull * dtSec * 0.25;
        l.position.x += (toCenterX / tc) * centerStep;
        l.position.y += (toCenterY / tc) * centerStep;
        const desiredH = Math.atan2(toCenterY, toCenterX);
        const maxTurn = TURN_RATE * dtSec * 0.8;
        const hDiff = angleDiff(desiredH, l.heading);
        l.heading += clamp(hDiff, -maxTurn, maxTurn);
      }
      let vx = r.dx / dtSec;
      let vy = r.dy / dtSec;
      vx += (toCenterX / tc) * speed * centerPull;
      vy += (toCenterY / tc) * speed * centerPull;
      const vlen = Math.hypot(vx, vy) || 1;
      l.velocity.x = (vlen > 0 ? vx / vlen : 0) * speed * 1.15;
      l.velocity.y = (vlen > 0 ? vy / vlen : 0) * speed * 1.15;
      clampLobster(l, margin, maxX, maxY);
      l._lastBehavior = "flee-octopus";
      continue;
    }

    // ── Priority B: DEFEND community ally under attack ──
    if (l.communityId) {
      const allies = communityMembers(lobsters, l.communityId).filter(a => a.id !== l.id);
      let allyUnderAttack: Lobster | null = null;
      let assailantId: string | null = null;
      for (const ally of allies) {
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
        const assailantIsLobster = lobsterById.has(assailantId);
        if (assailantIsLobster) l.hostileTargetId = assailantId;
        const assailant = lobsterById.get(assailantId) ??
                          predators.find(p => p.id === assailantId);
        if (assailant) {
          const ax = clamp(assailant.position.x, margin, maxX);
          const ay = clamp(assailant.position.y, margin, maxY);
          const { dx, dy, dz, dist } = steerToward3D(
            l, ax, ay,
            (assailant as Lobster).elevation ?? (assailant as Predator).elevation ?? 0,
            speed * 1.1, dtSec
          );
          const dDist = Math.hypot(dx, dy) || 1;
          l.velocity.x = (dx / dDist) * speed * 1.1;
          l.velocity.y = (dy / dDist) * speed * 1.1;
          const isAssailantPredator = predators.some(pr => pr.id === assailantId);
          const lvl = l.level ?? 1;
          const meetsLevelReq = isAssailantPredator
            ? lvl >= MIN_LEVEL_ATTACK_PREDATOR
            : lvl >= MIN_LEVEL_ATTACK_LOBSTER;
          if (meetsLevelReq && dist < LOBSTER_ATTACK_RADIUS && (l.attackCooldownUntil ?? 0) <= now) {
            l.attackCooldownUntil = now + LOBSTER_ATTACK_COOLDOWN_MS;
            const dmg = effectiveAttackDamage(l);
            if ("health" in assailant && typeof (assailant as Lobster).health === "number") {
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
        clampLobster(l, margin, maxX, maxY);
        l._lastBehavior = "defend";
        continue;
      }
    }

    // ── Priority C: HOSTILE — attack grudge target (requires level 3+) ──
    if (l.hostileTargetId) {
      const target = lobsterById.get(l.hostileTargetId);
      if (!target || !lobsterAlive(target) || (l.level ?? 1) < MIN_LEVEL_ATTACK_LOBSTER) {
        l.hostileTargetId = null;
        l.behaviorState = "seeking-food";
      } else {
        l.behaviorState = "hostile";
        l.attackTargetId = target.id;
        const tx = clamp(target.position.x, margin, maxX);
        const ty = clamp(target.position.y, margin, maxY);
        const { dx, dy, dz, dist } = steerToward3D(
          l, tx, ty, target.elevation ?? 0,
          speed, dtSec
        );
        if (dist < LOBSTER_ATTACK_RADIUS && (l.attackCooldownUntil ?? 0) <= now) {
          l.attackCooldownUntil = now + LOBSTER_ATTACK_COOLDOWN_MS;
          const dmg = effectiveAttackDamage(l);
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
        l.velocity.x = Math.cos(l.heading) * Math.cos(l.pitch ?? 0) * speed;
        l.velocity.y = Math.sin(l.heading) * Math.cos(l.pitch ?? 0) * speed;
        clampLobster(l, margin, maxX, maxY);
        l._lastBehavior = "hostile";
        continue;
      }
    }

    // ── Priority D: FIGHT BACK if recently attacked and health > 30% ──
    if (l.lastAttackedById && l.lastAttackedAt && (now - l.lastAttackedAt < ATTACK_MEMORY_MS) && hpPct > FLEE_HP_THRESHOLD) {
      const lobAttacker = lobsterById.get(l.lastAttackedById);
      const predAttacker = !lobAttacker ? predators.find(p => p.id === l.lastAttackedById) : null;
      const lvl = l.level ?? 1;
      const canFightLobster = lobAttacker && lobsterAlive(lobAttacker) && lvl >= MIN_LEVEL_ATTACK_LOBSTER;
      const canFightPredator = predAttacker && lvl >= MIN_LEVEL_ATTACK_PREDATOR;

      if (canFightLobster && lobAttacker) {
        l.behaviorState = "fighting";
        l.attackTargetId = lobAttacker.id;
        const tx = clamp(lobAttacker.position.x, margin, maxX);
        const ty = clamp(lobAttacker.position.y, margin, maxY);
        const { dx, dy, dz, dist } = steerToward3D(
          l, tx, ty, lobAttacker.elevation ?? 0,
          speed, dtSec
        );
        if (dist < LOBSTER_ATTACK_RADIUS && (l.attackCooldownUntil ?? 0) <= now) {
          l.attackCooldownUntil = now + LOBSTER_ATTACK_COOLDOWN_MS;
          const dmg = effectiveAttackDamage(l);
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
        l.velocity.x = Math.cos(l.heading) * Math.cos(l.pitch ?? 0) * speed;
        l.velocity.y = Math.sin(l.heading) * Math.cos(l.pitch ?? 0) * speed;
        clampLobster(l, margin, maxX, maxY);
        l._lastBehavior = "fighting";
        continue;
      }

      if (canFightPredator && predAttacker) {
        l.behaviorState = "fighting";
        l.attackTargetId = predAttacker.id;
        const tx = clamp(predAttacker.position.x, margin, maxX);
        const ty = clamp(predAttacker.position.y, margin, maxY);
        const { dx, dy, dz, dist } = steerToward3D(
          l, tx, ty, predAttacker.elevation ?? 0,
          speed, dtSec
        );
        if (dist < LOBSTER_ATTACK_RADIUS && (l.attackCooldownUntil ?? 0) <= now) {
          l.attackCooldownUntil = now + LOBSTER_ATTACK_COOLDOWN_MS;
          const dmg = effectiveAttackDamage(l);
          predAttacker.health = Math.max(0, predAttacker.health - dmg);
          if (predAttacker.health <= 0) {
            predAttacker.health = predAttacker.maxHp;
            predAttacker.targetLobsterId = null;
            predAttacker.position.x = margin + rng() * (maxX - margin);
            predAttacker.position.y = margin + rng() * (maxY - margin);
            predAttacker.elevation = rng() * MAX_ELEVATION;
            clearAggressionToward(predAttacker.id, lobsters, predators);
            l.xp = (l.xp ?? 0) + PREDATOR_KILL_XP;
            events.push(createEvent("predator-killed", {
              killerId: l.id, killerName: l.displayName ?? l.id,
              predatorId: predAttacker.id,
            }, simTime, nextEventId()));
          }
        }
        l.velocity.x = Math.cos(l.heading) * Math.cos(l.pitch ?? 0) * speed;
        l.velocity.y = Math.sin(l.heading) * Math.cos(l.pitch ?? 0) * speed;
        clampLobster(l, margin, maxX, maxY);
        l._lastBehavior = "fighting";
        continue;
      }
    }

    // ── Priority D': BETRAY — target lowest-health ally in same community (Priority C will do the attack) ──
    if (l.betrayMode && l.communityId && (l.level ?? 1) >= MIN_LEVEL_ATTACK_LOBSTER) {
      const allies = communityMembers(lobsters, l.communityId).filter(a => a.id !== l.id && lobsterAlive(a));
      let weakest: Lobster | null = null;
      let weakestHp = Infinity;
      for (const a of allies) {
        const hp = a.health ?? 100;
        if (hp < weakestHp && hp > 0) {
          weakestHp = hp;
          weakest = a;
        }
      }
      if (weakest) {
        l.hostileTargetId = weakest.id;
        l.behaviorState = "hostile";
        l.attackTargetId = weakest.id;
        const tx = clamp(weakest.position.x, margin, maxX);
        const ty = clamp(weakest.position.y, margin, maxY);
        const { dist } = steerToward3D(
          l, tx, ty, weakest.elevation ?? 0,
          speed, dtSec
        );
        if (dist < LOBSTER_ATTACK_RADIUS && (l.attackCooldownUntil ?? 0) <= now) {
          l.attackCooldownUntil = now + LOBSTER_ATTACK_COOLDOWN_MS;
          const dmg = effectiveAttackDamage(l);
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
        l.velocity.x = Math.cos(l.heading) * Math.cos(l.pitch ?? 0) * speed;
        l.velocity.y = Math.sin(l.heading) * Math.cos(l.pitch ?? 0) * speed;
        clampLobster(l, margin, maxX, maxY);
        l._lastBehavior = "hostile";
        continue;
      }
    }

    // ── Priority D'': AGGRESSIVE — prefer attacking a non-ally lobster over seeking food ──
    if (l.aggressiveMode && !l.hostileTargetId && (l.level ?? 1) >= MIN_LEVEL_ATTACK_LOBSTER) {
      const nonAllies = lobsters.filter(
        (o) => o.id !== l.id && lobsterAlive(o) && o.communityId !== l.communityId
      );
      let nearest: Lobster | null = null;
      let nearestScore = SEEK_FOOD_RADIUS;
      for (const o of nonAllies) {
        const d = dist3D(l.position.x, l.position.y, l.elevation ?? 0, o.position.x, o.position.y, o.elevation ?? 0);
        const nearWall = o.position.x < margin + WALL_AVOID_MARGIN || o.position.x > maxX - WALL_AVOID_MARGIN ||
          o.position.y < margin + WALL_AVOID_MARGIN || o.position.y > maxY - WALL_AVOID_MARGIN;
        const score = d + (nearWall ? 120 : 0);
        if (score < nearestScore) {
          nearestScore = score;
          nearest = o;
        }
      }
      if (nearest) {
        l.hostileTargetId = nearest.id;
        l.behaviorState = "hostile";
        l.attackTargetId = nearest.id;
        const tx = clamp(nearest.position.x, margin, maxX);
        const ty = clamp(nearest.position.y, margin, maxY);
        const { dist } = steerToward3D(
          l, tx, ty, nearest.elevation ?? 0,
          speed, dtSec
        );
        if (dist < LOBSTER_ATTACK_RADIUS && (l.attackCooldownUntil ?? 0) <= now) {
          l.attackCooldownUntil = now + LOBSTER_ATTACK_COOLDOWN_MS;
          const dmg = effectiveAttackDamage(l);
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
        l.velocity.x = Math.cos(l.heading) * Math.cos(l.pitch ?? 0) * speed;
        l.velocity.y = Math.sin(l.heading) * Math.cos(l.pitch ?? 0) * speed;
        clampLobster(l, margin, maxX, maxY);
        l._lastBehavior = "aggressive";
        continue;
      }
    }

    // ── Priority E: SEEK FOOD (default) ──
    l.behaviorState = "seeking-food";
    l.attackTargetId = null;
    l.fleeFromId = null;

    // Persist food target: keep current target if it still exists and hasn't been eaten
    let food: Food | null = null;
    if (l.targetFoodId) {
      food = state.foods.find(f => f.id === l.targetFoodId && !eaten.has(f.id)) ?? null;
    }
    if (!food) {
      food = findNearestFood(l, state.foods, SEEK_FOOD_RADIUS, margin, maxX, maxY);
      if (!food && state.foods.length > 0) {
        food = findNearestFood(l, state.foods, SEEK_FOOD_RADIUS_FALLBACK, margin, maxX, maxY);
      }
      if (food && eaten.has(food.id)) food = null;
    }
    if (food) {
      l._lastBehavior = "seek-food";
      l.targetFoodId = food.id;
      const tx = food.position.x;
      const ty = food.position.y;
      const tz = food.elevation;

      if (Math.hypot(food.position.x - l.position.x, food.position.y - l.position.y, food.elevation - (l.elevation ?? 0)) <= EAT_RADIUS) {
        // EAT the shrimp
        eaten.add(food.id);
        l.shrimpEaten = (l.shrimpEaten ?? 0) + 1;
        l.xp = (l.xp ?? 0) + SHRIMP_XP;

        // Shrimp competition: find other lobsters targeting same food
        for (const rival of lobsters) {
          if (rival.id === l.id || !lobsterAlive(rival)) continue;
          if (rival.targetFoodId === food.id) {
            const key = `${rival.id}-${l.id}`;
            state.lostShrimpToWinner![key] = (state.lostShrimpToWinner![key] ?? 0) + 1;
            if (state.lostShrimpToWinner![key] >= SHRIMP_LOSS_ANGER_COUNT && (rival.level ?? 1) >= MIN_LEVEL_ATTACK_LOBSTER) {
              rival.hostileTargetId = l.id;
              events.push(createEvent("shrimp-rivalry", {
                loserId: rival.id, loserName: rival.displayName ?? rival.id,
                winnerId: l.id, winnerName: l.displayName ?? l.id,
                count: state.lostShrimpToWinner![key],
              }, simTime, nextEventId()));
            }
            rival.targetFoodId = null;
          }
        }

        // Remove eaten food and spawn replacement
        const idx = state.foods.findIndex(f => f.id === food.id);
        if (idx >= 0) state.foods.splice(idx, 1);
        const pos = smartSpawnPos(state, rng);
        state.foods.push({
          id: `food-${simTime}-${state.foods.length}-${rng().toString(36).slice(2, 8)}`,
          position: { x: pos.x, y: pos.y },
          velocity: { x: 0, y: 0 },
          heading: rng() * Math.PI * 2,
          elevation: pos.z,
          targetElevation: 0,
          createdAt: simTime,
          ttlMs: 120_000,
        });

        events.push(createEvent("food", {
          lobsterId: l.id, displayName: l.displayName ?? l.id, foodId: food.id,
        }, simTime, nextEventId()));

        // Level up check
        const level = l.level ?? 1;
        const shrimpEaten = l.shrimpEaten ?? 0;
        if (level < 20 && shrimpEaten >= shrimpToReachLevel(level + 1)) {
          l.level = level + 1;
          const newMaxHp = maxHpForLevel(l.level);
          const newDmg = attackDamageForLevel(l.level);
          l.maxHp = newMaxHp;
          l.attackDamage = newDmg;
          l.health = Math.min(newMaxHp, (l.health ?? 100) + 5);
          events.push(createEvent("level", {
            lobsterId: l.id, displayName: l.displayName ?? l.id,
            level: l.level, source: "shrimp", shrimpEaten: l.shrimpEaten,
          }, simTime, nextEventId()));
        }
        l.velocity.x = 0; l.velocity.y = 0;
      } else {
        const steerTx = clamp(tx, margin, maxX);
        const steerTy = clamp(ty, margin, maxY);
        steerToward3D(l, steerTx, steerTy, tz, speed, dtSec);
        l.velocity.x = Math.cos(l.heading) * Math.cos(l.pitch ?? 0) * speed;
        l.velocity.y = Math.sin(l.heading) * Math.cos(l.pitch ?? 0) * speed;
      }
    } else {
      l._lastBehavior = "wander";
      // Wander if no food found — targets only in inner area
      l.targetFoodId = null;
      const inset = Math.max(60, Math.min(state.width, state.height) * 0.20);
      const safeMinX = margin + inset;
      const safeMaxX = maxX - inset;
      const safeMinY = margin + inset;
      const safeMaxY = maxY - inset;
      const currentTargetOutsideSafe =
        l.exploreTarget &&
        (l.exploreTarget.x < safeMinX || l.exploreTarget.x > safeMaxX ||
         l.exploreTarget.y < safeMinY || l.exploreTarget.y > safeMaxY);
      const currentTargetInWallZone =
        l.exploreTarget &&
        (l.exploreTarget.x < margin + WALL_AVOID_MARGIN || l.exploreTarget.x > maxX - WALL_AVOID_MARGIN ||
         l.exploreTarget.y < margin + WALL_AVOID_MARGIN || l.exploreTarget.y > maxY - WALL_AVOID_MARGIN);
      const distToTarget = l.exploreTarget
        ? Math.hypot(l.exploreTarget.x - l.position.x, l.exploreTarget.y - l.position.y)
        : Infinity;
      const reachedTarget = distToTarget < 45;
      const wanderChance = 0.0003;
      const forceNewTarget = currentTargetOutsideSafe || currentTargetInWallZone || !l.exploreTarget ||
        (reachedTarget && rng() < 0.4) || (!reachedTarget && rng() < wanderChance);
      if (forceNewTarget) {
        const innerW = Math.max(0, safeMaxX - safeMinX);
        const innerH = Math.max(0, safeMaxY - safeMinY);
        const jitter = (rng() - 0.5) * 30;
        l.exploreTarget = {
          x: clamp(safeMinX + rng() * innerW + jitter, safeMinX, safeMaxX),
          y: clamp(safeMinY + rng() * innerH + (rng() - 0.5) * 20, safeMinY, safeMaxY),
        };
        l.exploreElevation = rng() * MAX_ELEVATION;
      } else {
        l.exploreTarget!.x = clamp(l.exploreTarget!.x, safeMinX, safeMaxX);
        l.exploreTarget!.y = clamp(l.exploreTarget!.y, safeMinY, safeMaxY);
      }
      const steerTx = clamp(l.exploreTarget!.x, margin, maxX);
      const steerTy = clamp(l.exploreTarget!.y, margin, maxY);
      steerToward3D(l, steerTx, steerTy, l.exploreElevation ?? 0, speed * 0.5, dtSec);
      l.velocity.x = Math.cos(l.heading) * Math.cos(l.pitch ?? 0) * speed * 0.5;
      l.velocity.y = Math.sin(l.heading) * Math.cos(l.pitch ?? 0) * speed * 0.5;
    }
    clampLobster(l, margin, maxX, maxY);

    if (!l._lastBehavior) {
      const cx = (margin + maxX) / 2;
      const cy = (margin + maxY) / 2;
      steerToward3D(l, cx, cy, l.elevation ?? 0, speed * 0.5, dtSec);
      l.velocity.x = Math.cos(l.heading) * Math.cos(l.pitch ?? 0) * speed * 0.5;
      l.velocity.y = Math.sin(l.heading) * Math.cos(l.pitch ?? 0) * speed * 0.5;
      clampLobster(l, margin, maxX, maxY);
      l._lastBehavior = "fallback";
    }

    const nearWall =
      l.position.x < margin + 80 || l.position.x > maxX - 80 ||
      l.position.y < margin + 80 || l.position.y > maxY - 80;
    if (nearWall) {
      const last = _wallLogLast.get(l.id) ?? 0;
      if (now - last > WALL_LOG_THROTTLE_MS) {
        _wallLogLast.set(l.id, now);
        _devLog(l.id, "near wall, _lastBehavior:", l._lastBehavior ?? "(none)");
      }
    }
    if (lobsters[0] === l && now - _diagLogLast > DIAG_LOG_THROTTLE_MS) {
      _diagLogLast = now;
      _devLog("tick", l.id, "behavior:", l._lastBehavior ?? "(none)", "pos:", [l.position.x.toFixed(0), l.position.y.toFixed(0)], "heading:", (l.heading * 180 / Math.PI).toFixed(1) + "°", "food?", l.targetFoodId ?? "no", "explore?", l.exploreTarget ? "yes" : "no");
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 4b. SEPARATION — push overlapping lobsters apart so they never touch (skip only when actively fighting each other)
  // ────────────────────────────────────────────────────────────────────────────
  const SEP_RADIUS = 22;
  const SEP_FORCE = 55;
  for (let i = 0; i < lobsters.length; i++) {
    const a = lobsters[i];
    if (!lobsterAlive(a)) continue;
    for (let j = i + 1; j < lobsters.length; j++) {
      const b = lobsters[j];
      if (!lobsterAlive(b)) continue;
      const inCombat =
        (a.attackTargetId === b.id || a.hostileTargetId === b.id) ||
        (b.attackTargetId === a.id || b.hostileTargetId === a.id);
      if (inCombat) continue;
      const sameCommunity = a.communityId && a.communityId === b.communityId;
      const eitherDefendingOrFleeing =
        a.behaviorState === "defending" || a.behaviorState === "fleeing" ||
        b.behaviorState === "defending" || b.behaviorState === "fleeing";
      if (sameCommunity && eitherDefendingOrFleeing) continue;
      const sameFoodTarget = a.targetFoodId != null && a.targetFoodId === b.targetFoodId;
      if (sameFoodTarget) continue;
      const sdx = a.position.x - b.position.x;
      const sdy = a.position.y - b.position.y;
      const sdz = (a.elevation ?? 0) - (b.elevation ?? 0);
      const sDist = Math.hypot(sdx, sdy, sdz);
      if (sDist < SEP_RADIUS && sDist > 0.01) {
        const overlap = (SEP_RADIUS - sDist) / SEP_RADIUS;
        const push = SEP_FORCE * overlap * dtSec;
        const nx = sdx / sDist;
        const ny = sdy / sDist;
        const nz = sdz / sDist;
        a.position.x += nx * push;
        a.position.y += ny * push;
        a.elevation = clamp((a.elevation ?? 0) + nz * push, 0, MAX_ELEVATION);
        b.position.x -= nx * push;
        b.position.y -= ny * push;
        b.elevation = clamp((b.elevation ?? 0) - nz * push, 0, MAX_ELEVATION);
      }
    }
    clampLobster(a, margin, maxX, maxY);
  }
  for (const l of lobsters) {
    if (lobsterAlive(l)) clampLobster(l, margin, maxX, maxY);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 5. FRIENDLY INTERACTIONS & COMMUNITY FORMATION
  // ────────────────────────────────────────────────────────────────────────────
  for (let i = 0; i < lobsters.length; i++) {
    const a = lobsters[i];
    if (!lobsterAlive(a)) continue;
    if (a.behaviorState === "hostile" || a.behaviorState === "fighting" || a.behaviorState === "fleeing") continue;

    for (let j = i + 1; j < lobsters.length; j++) {
      const b = lobsters[j];
      if (!lobsterAlive(b)) continue;
      if (b.behaviorState === "hostile" || b.behaviorState === "fighting" || b.behaviorState === "fleeing") continue;

      const d = dist3D(a.position.x, a.position.y, a.elevation ?? 0,
                       b.position.x, b.position.y, b.elevation ?? 0);
      if (d > FRIENDLY_INTERACTION_RADIUS) continue;

      const key = sortedPairKey(a.id, b.id);
      // Do not count as friendly when both are competing for the same food (reduces friendship, increases rivalry)
      const sameFood = a.targetFoodId != null && a.targetFoodId === b.targetFoodId;
      if (sameFood) {
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
        const members = communityMembers(lobsters, commId);
        if (members.length < COMMUNITY_MAX_SIZE) {
          if (!a.communityId) {
            a.communityId = commId;
            const comm = state.communities.find(c => c.id === commId);
            events.push(createEvent("gang-join", {
              communityId: commId, communityName: comm?.name ?? "Unknown",
              lobsterId: a.id, displayName: a.displayName ?? a.id,
            }, simTime, nextEventId()));
          } else {
            b.communityId = commId;
            const comm = state.communities.find(c => c.id === commId);
            events.push(createEvent("gang-join", {
              communityId: commId, communityName: comm?.name ?? "Unknown",
              lobsterId: b.id, displayName: b.displayName ?? b.id,
            }, simTime, nextEventId()));
          }
          state.friendlyEncounterCount![key] = 0;
        }
      }
      if (count >= COMMUNITY_FORM_THRESHOLD && !a.communityId && !b.communityId) {
        const commId = createCommunity(state, rng);
        a.communityId = commId;
        b.communityId = commId;
        const comm = state.communities.find(c => c.id === commId);
        events.push(createEvent("gang-form", {
          communityId: commId, communityName: comm?.name ?? "Unknown",
          memberIds: [a.id, b.id],
          memberNames: [a.displayName ?? a.id, b.displayName ?? b.id],
        }, simTime, nextEventId()));
        state.friendlyEncounterCount![key] = 0;
      } else if (count === 1 || count === 2) {
        events.push(createEvent("friendship", {
          lobster1Id: a.id, lobster1Name: a.displayName ?? a.id,
          lobster2Id: b.id, lobster2Name: b.displayName ?? b.id,
          interactionCount: count,
        }, simTime, nextEventId()));
      }
    }
  }

  return { state, events };
}

// ── Death aggression clear ─────────────────────────────────────────────────────

function clearAggressionToward(
  deadId: string,
  lobsters: Lobster[],
  predators: Predator[]
): void {
  for (const l of lobsters) {
    if (l.hostileTargetId === deadId) l.hostileTargetId = null;
    if (l.attackTargetId === deadId) l.attackTargetId = null;
    if (l.lastAttackedById === deadId) {
      l.lastAttackedById = null;
      l.lastAttackedAt = undefined;
    }
    if (l.fleeFromId === deadId) l.fleeFromId = null;
  }
  for (const p of predators) {
    if (p.targetLobsterId === deadId) p.targetLobsterId = null;
  }
}

// ── Community creation helper ──────────────────────────────────────────────────

function createCommunity(state: TankState, rng: RandomFn): string {
  const idx = (state.communities?.length ?? 0) % COMMUNITY_NAMES.length;
  const name = COMMUNITY_NAMES[idx];
  const color = COMMUNITY_COLORS[idx];
  const id = `comm-${name.replace(/\s/g, "-")}-${Date.now()}-${rng().toString(36).slice(2, 6)}`;
  const community: Community = { id, name, color };
  if (!state.communities) state.communities = [];
  state.communities.push(community);
  return id;
}

// ── Position clamping helper ───────────────────────────────────────────────────

function clampLobster(l: Lobster, margin: number, maxX: number, maxY: number): void {
  l.position.x = clamp(l.position.x, margin, maxX);
  l.position.y = clamp(l.position.y, margin, maxY);
  l.elevation = clamp(l.elevation ?? 0, 0, MAX_ELEVATION);
}
