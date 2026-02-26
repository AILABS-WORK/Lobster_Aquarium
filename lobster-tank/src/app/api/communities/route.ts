import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";

export async function GET() {
  const db = getPrisma();
  if (!env.DATABASE_URL || !db) {
    return NextResponse.json({ communities: [] }, { status: 200 });
  }

  try {
    const communities = await db.community.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { lobsters: true } } },
    });

    return NextResponse.json(
      {
        communities: communities.map((community) => ({
          id: community.id,
          name: community.name,
          color: community.color,
          description: community.description,
          memberCount: community._count.lobsters,
        })),
      },
      { status: 200 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        communities: [],
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 200 },
    );
  }
}
