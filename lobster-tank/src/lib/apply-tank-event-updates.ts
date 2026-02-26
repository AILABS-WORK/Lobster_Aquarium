/**
 * Apply tank event side effects to the Lobster table (wins, losses, level, xp).
 * Used by POST /api/tank-events and by server-sim when persisting events so
 * leaderboards and DB stay in sync with sim activity.
 */
const tierAquariums = [
  { id: "tier-2", name: "Tier II Reef", minLevel: 5, maxLobsters: 160 },
  { id: "tier-3", name: "Tier III Abyss", minLevel: 10, maxLobsters: 200 },
];

// Minimal structural type for the transaction client used here.
// We intentionally keep this loose to avoid depending on generated Prisma types at build time.
type DbClient = any;

async function ensureTierAquarium(db: DbClient, id: string, name: string, maxLobsters: number) {
  await db.aquarium.upsert({
    where: { id },
    update: { name, maxLobsters },
    create: { id, name, maxLobsters },
  });
}

async function promoteLobster(db: DbClient, lobsterId: string, level: number) {
  const existing = await db.lobster.findUnique({ where: { id: lobsterId } });
  if (!existing) return;
  const tier = [...tierAquariums].reverse().find((t) => level >= t.minLevel);
  if (!tier) return;
  await ensureTierAquarium(db, tier.id, tier.name, tier.maxLobsters);
  await db.lobster.update({
    where: { id: lobsterId },
    data: { aquariumId: tier.id },
  });
}

export type TankEventLike = {
  id: string;
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
};

export async function applyOneEventToLobsters(
  tx: DbClient,
  event: TankEventLike,
): Promise<void> {
  if (event.type === "kill") {
    const killerId = event.payload.killerId as string | undefined;
    const victimId = event.payload.victimId as string | undefined;
    if (killerId) {
      const exists = await tx.lobster.findUnique({ where: { id: killerId } });
      if (exists) {
        await tx.lobster.update({
          where: { id: killerId },
          data: { wins: { increment: 1 }, status: "Dominant" },
        });
      }
    }
    if (victimId) {
      const exists = await tx.lobster.findUnique({ where: { id: victimId } });
      if (exists) {
        await tx.lobster.update({
          where: { id: victimId },
          data: { losses: { increment: 1 }, status: "Weak" },
        });
      }
    }
  }

  if (event.type === "predator-kill") {
    const victimId = event.payload.victimId as string | undefined;
    if (victimId) {
      const exists = await tx.lobster.findUnique({ where: { id: victimId } });
      if (exists) {
        await tx.lobster.update({
          where: { id: victimId },
          data: { losses: { increment: 1 }, status: "Weak" },
        });
      }
    }
  }

  if (event.type === "food") {
    const lobsterId = event.payload.lobsterId as string | undefined;
    if (lobsterId) {
      const exists = await tx.lobster.findUnique({ where: { id: lobsterId } });
      if (exists) {
        await tx.lobster.update({
          where: { id: lobsterId },
          data: { xp: { increment: 10 } },
        });
      }
    }
  }

  if (event.type === "level") {
    const lobsterId = event.payload.lobsterId as string | undefined;
    if (lobsterId) {
      const exists = await tx.lobster.findUnique({ where: { id: lobsterId } });
      if (exists) {
        const data: {
          level?: number;
          size?: number;
          xp?: number;
          pendingLevelUpLevel?: number | null;
        } = {};
        if (typeof event.payload.level === "number") data.level = event.payload.level;
        if (typeof event.payload.size === "number") data.size = event.payload.size;
        if (typeof event.payload.xp === "number") data.xp = event.payload.xp;
        else if (typeof event.payload.shrimpEaten === "number")
          data.xp = event.payload.shrimpEaten * 10;
        if (typeof event.payload.level === "number")
          data.pendingLevelUpLevel = event.payload.level;
        if (Object.keys(data).length > 0) {
          await tx.lobster.update({ where: { id: lobsterId }, data });
        }
      }
    }
  }

  if (event.type === "promotion") {
    const lobsterId = event.payload.lobsterId as string | undefined;
    const level = typeof event.payload.level === "number" ? event.payload.level : 0;
    if (lobsterId) await promoteLobster(tx, lobsterId, level);
  }
}

/**
 * Apply a batch of events to the Lobster table inside a transaction.
 * Call this after inserting events (e.g. from server-sim or POST /api/tank-events).
 */
export async function applyTankEventUpdatesToDb(events: TankEventLike[]): Promise<void> {
  const { getPrisma } = await import("@/lib/prisma");
  const db = getPrisma();
  if (!db || events.length === 0) return;
  try {
    await db.$transaction(async (tx) => {
      for (const event of events) {
        await applyOneEventToLobsters(tx, event);
      }
    });
  } catch {
    // avoid crashing the sim; leaderboard may lag until next batch
  }
}
