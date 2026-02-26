import { Lobster, RandomFn } from "./types";

export type ConflictContext = {
  allySupportA: number;
  allySupportB: number;
  tension: number;
  /** Temporary combat probability bonus (e.g. from verified token send + pet). */
  petBoostA?: boolean;
  petBoostB?: boolean;
  /** Min level required to deal combat damage; if either lobster is below, damage is 0. Default 3. */
  minLevelToAttack?: number;
};

export type ConflictResult = {
  winnerId: string;
  loserId: string;
  probability: number;
  damage: number;
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const PET_BOOST_SCORE = 4;

const scoreLobster = (
  lobster: Lobster,
  allySupport: number,
  petBoost: boolean,
) => {
  return (
    lobster.level * 1.2 +
    lobster.size * 1.0 +
    lobster.courage * 0.9 +
    lobster.likeability * 0.6 +
    allySupport * 0.8 +
    (petBoost ? PET_BOOST_SCORE : 0)
  );
};

export const resolveConflict = (
  a: Lobster,
  b: Lobster,
  context: ConflictContext,
  rng: RandomFn,
): ConflictResult => {
  const scoreA = scoreLobster(a, context.allySupportA, context.petBoostA ?? false);
  const scoreB = scoreLobster(b, context.allySupportB, context.petBoostB ?? false);
  const total = scoreA + scoreB;
  const rawProbability = total === 0 ? 0.5 : scoreA / total;

  // Never deterministic outcomes: keep a soft chance floor/ceiling.
  const probability = clamp(rawProbability, 0.12, 0.88);
  const roll = rng();

  const winner = roll < probability ? a : b;
  const loser = roll < probability ? b : a;
  const winProb = roll < probability ? probability : 1 - probability;

  const minLevel = context.minLevelToAttack ?? 3;
  const canDealDamage = winner.level >= minLevel && loser.level >= minLevel;
  let damage = 0;
  if (canDealDamage) {
    // Level-based damage: L1=10, L2=12, L3=14, etc. (8 + level*2) with ±2 variance
    const base = 8 + winner.level * 2;
    const variance = (rng() * 2 - 1) * 2; // -2 to +2
    damage = Math.round(clamp(base + variance, 6, 25));
  }

  return {
    winnerId: winner.id,
    loserId: loser.id,
    probability: winProb,
    damage,
  };
};
