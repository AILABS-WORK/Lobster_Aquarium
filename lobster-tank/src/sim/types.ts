export type Vector2 = {
  x: number;
  y: number;
};

export type LobsterStatus = "Neutral" | "Dominant" | "Molting" | "Weak";

export type Lobster = {
  id: string;
  position: Vector2;
  velocity: Vector2;
  motionMode: "crawl" | "swim";
  motionTimer: number;
  heading: number;
  targetHeading?: number;
  targetSpeed: number;
  /** Per-lobster speed multiplier (e.g. 0.7–1.3) so some move faster. */
  speedMult?: number;
  /** Per-lobster damage multiplier (e.g. 1.0–1.5); applied on top of level-based damage. */
  damageMult?: number;
  /** When true, lobster prefers attacking other lobsters over seeking shrimp (level 3+). */
  aggressiveMode?: boolean;
  /** When true, lobster targets the ally in same community with lowest health (betray). */
  betrayMode?: boolean;
  elevation: number;
  pitch: number;
  size: number;
  level: number;
  xp: number;
  courage: number;
  likeability: number;
  status: LobsterStatus;
  age: number;
  communityId?: string;
  lastFed?: number;
  lastPet?: number;
  /** Debug: which behavior ran last tick (not persisted). Use to diagnose wall-seeking. */
  _lastBehavior?: string;
  exploreTarget?: Vector2 | null;
  /** Optional target elevation for vertical exploration (swim up then sink). */
  exploreElevation?: number | null;
  /** Shrimp eaten this lifetime; every 10 = level up. */
  shrimpEaten?: number;
  /** Current health; 0 = death then respawn. */
  health?: number;
  /** Display name from user (e.g. from wallet/claim). */
  displayName?: string | null;
  /** Number of other lobsters this one has killed (lifetime). Only counts actual kills (health→0). */
  lobsterKills?: number;
  /** Number of times this lobster has died (lifetime). */
  losses?: number;
  /** Deaths caused by another lobster (subset of losses). */
  deathsFromLobsters?: number;
  /** Deaths caused by octopus/predator (subset of losses). */
  deathsFromOctopuses?: number;
  /** User-chosen body color (hex). */
  bodyColor?: string | null;
  /** User-chosen claw color (hex). */
  clawColor?: string | null;
  /** When set, this lobster pursues and attacks this target until it is dead. */
  hostileTargetId?: string | null;
  /** When health <= 0, respawn at this timestamp (e.g. now + 15000); or clear for instant respawn. */
  respawnAt?: number | null;
  /** When lobster detected stuck near wall; used to apply corner-kick after delay. */
  wallStuckSince?: number | null;
  /** Current behavioral state for the state-machine engine. */
  behaviorState?: "seeking-food" | "hostile" | "fighting" | "fleeing" | "defending";
  /** Who this lobster is currently attacking (lobster id). */
  attackTargetId?: string | null;
  /** Who last dealt damage to this lobster (lobster or predator id). */
  lastAttackedById?: string | null;
  /** Timestamp of when this lobster was last attacked. */
  lastAttackedAt?: number;
  /** Timestamp until which this lobster cannot attack again. */
  attackCooldownUntil?: number;
  /** Entity id this lobster is fleeing from. */
  fleeFromId?: string | null;
  /** Food id this lobster is currently targeting (for shrimp competition tracking). */
  targetFoodId?: string | null;
  /** Level-up stats from DB (optional for backward compat). */
  maxHp?: number;
  attackDamage?: number;
  friendshipChance?: number;
  attackHitChance?: number;
  critChance?: number;
  /** RL: learned weight for food-seeking (higher = more aggressive food chase). 0-1. */
  rlFoodWeight?: number;
  /** RL: learned weight for flee response (higher = flees earlier/faster). 0-1. */
  rlFleeWeight?: number;
  /** RL: learned weight for social interaction (higher = seeks more social encounters). 0-1. */
  rlSocialWeight?: number;
  /** RL: cumulative reward signal used to adjust weights. */
  rlRewardAccum?: number;
  /** RL: total rewards earned (lifetime stat for display). */
  rlTotalReward?: number;
  /** Temporary combat/speed boost window end (ms since epoch) from verified feed/pet. */
  petBoostUntil?: number;
};

export type Community = {
  id: string;
  name: string;
  color: string;
  description?: string;
  /** Lobster ids that founded the community (initial members when formed). Owners can rename. */
  founderIds?: string[];
};

export type Food = {
  id: string;
  position: Vector2;
  velocity: Vector2;
  heading: number;
  elevation: number;
  targetElevation: number;
  createdAt: number;
  ttlMs: number;
  /** Same 3D motion as lobster: crawl (bottom) vs swim (can climb/dive). */
  motionMode?: "crawl" | "swim";
  motionTimer?: number;
  pitch?: number;
  targetSpeed?: number;
};

export type Predator = {
  id: string;
  position: Vector2;
  velocity: Vector2;
  heading: number;
  targetLobsterId?: string | null;
  health: number;
  maxHp: number;
  damage: number;
  speed: number;
  attackRadius: number;
  attackCooldownUntil?: number;
  elevation?: number;
  /** Pitch (radians) for 3D orientation: face toward target elevation. */
  pitch?: number;
};

export type RelationshipCounts = { likes: number; conflicts: number };

export type TankState = {
  width: number;
  height: number;
  time: number;
  lobsters: Lobster[];
  predators: Predator[];
  communities: Community[];
  foods: Food[];
  lastFoodSpawn: number;
  /** Key: sorted pair "id1-id2". Tracks likes and conflicts for friendship/rivalry. */
  relationships?: Record<string, RelationshipCounts>;
  /** Key: sorted pair "id1-id2". Tracks proximity time for community formation. */
  communityEncounters?: Record<string, number>;
  /** Key: "lobsterId-communityId". Tracks proximity time for community joining. */
  communityJoinAffinity?: Record<string, number>;
  /** Key: sorted pair "id1-id2". Proximity time when from different communities (rivals); after 3+ sec = annoyed. */
  rivalEncounters?: Record<string, number>;
  /** Key: sorted pair "id1-id2". Number of successful friendly (like) interactions, each at least 10s apart. */
  friendlyEncounterCount?: Record<string, number>;
  /** Key: sorted pair "id1-id2". Timestamp of last friendly encounter for 10s spacing. */
  lastFriendlyEncounterTime?: Record<string, number>;
  /** Key: "loserId-winnerId". Times this lobster lost a shrimp to that lobster; 3+ and level 3+ => hostile. */
  lostShrimpToWinner?: Record<string, number>;
  /** Key: sorted pair. Number of same-shrimp contest encounters (throttled). */
  sameShrimpContests?: Record<string, number>;
  /** Key: sorted pair. Timestamp of last same-shrimp contest for throttling. */
  _lastShrimpContestTime?: Record<string, number>;
};

export type RandomFn = () => number;
