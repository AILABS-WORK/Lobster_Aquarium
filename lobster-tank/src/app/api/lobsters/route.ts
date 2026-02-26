import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";

/**
 * GET /api/lobsters?aquarium=<id>
 * Returns all lobsters in the given aquarium for sim hydration (no pagination, up to max).
 */
const MAX_LOBSTERS = 200;

export async function GET(request: Request) {
  const db = getPrisma();
  if (!env.DATABASE_URL || !db) {
    return NextResponse.json(
      { lobsters: [], databaseConfigured: false },
      { status: 200 },
    );
  }

  const url = new URL(request.url);
  const aquariumId = url.searchParams.get("aquarium") ?? "global";

  const lobsters = await db.lobster.findMany({
    where: { aquariumId },
    orderBy: [{ level: "desc" }, { xp: "desc" }],
    take: MAX_LOBSTERS,
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

  return NextResponse.json({
    lobsters,
    databaseConfigured: true,
  });
}
