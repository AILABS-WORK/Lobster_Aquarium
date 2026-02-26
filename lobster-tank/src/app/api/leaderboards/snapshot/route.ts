import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";

const POINTS_SHRIMP = 1;
const POINTS_LOBSTER_KILL = 10;

/** Unified global leaderboard snapshot across all tanks for prize distribution. Returns wallet addresses and ranks. */
export async function GET(request: Request) {
  const db = getPrisma();
  if (!env.DATABASE_URL || !db) {
    return NextResponse.json(
      { entries: [], databaseConfigured: false },
      { status: 200 },
    );
  }

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));

  const raw = await db.lobster.findMany({
    include: { owner: true },
    orderBy: [{ xp: "desc" }, { wins: "desc" }, { level: "desc" }, { size: "desc" }],
  });

  const entries = raw
    .map((l) => {
      const shrimpEaten = Math.floor(l.xp / 10);
      const points = shrimpEaten * POINTS_SHRIMP + l.wins * POINTS_LOBSTER_KILL;
      const walletAddress = l.owner?.walletAddress ?? l.owner?.id ?? null;
      return {
        lobsterId: l.id,
        displayName: l.displayName ?? l.id,
        walletAddress,
        level: l.level,
        xp: l.xp,
        wins: l.wins,
        losses: l.losses,
        shrimpEaten,
        points,
        aquariumId: l.aquariumId,
      };
    })
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.shrimpEaten !== a.shrimpEaten) return b.shrimpEaten - a.shrimpEaten;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return b.level - a.level;
    })
    .slice(0, limit)
    .map((e, i) => ({ rank: i + 1, ...e }));

  return NextResponse.json(
    {
      entries,
      snapshotAt: new Date().toISOString(),
      limit,
    },
    { status: 200 },
  );
}
