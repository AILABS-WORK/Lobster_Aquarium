import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const db = getPrisma();
  if (!env.DATABASE_URL || !db) {
    return NextResponse.json(
      { lobsters: [], databaseConfigured: false },
      { status: 200 },
    );
  }

  const url = new URL(request.url);
  const aquariumId = url.searchParams.get("aquarium");

  const raw = await db.lobster.findMany({
    where: aquariumId ? { aquariumId } : undefined,
    orderBy: [
      { level: "desc" },
      { xp: "desc" },
      { wins: "desc" },
      { size: "desc" },
    ],
    take: 25,
  });

  const lobsters = raw.map((l) => ({
    ...l,
    shrimpEaten: Math.floor(l.xp / 10),
  }));

  return NextResponse.json({ lobsters }, { status: 200 });
}
