import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { requireWalletAuth } from "@/lib/wallet-auth";

const bodySchema = z.object({
  name: z.string().min(2).max(60),
  maxLobsters: z.number().int().min(1).max(500).optional(),
  description: z.string().max(200).optional(),
});

type DbClient = NonNullable<ReturnType<typeof getPrisma>>;

async function ensureGlobalAquarium(db: DbClient) {
  const existing = await db.aquarium.findUnique({ where: { id: "global" } });
  if (existing) return existing;
  return db.aquarium.create({
    data: {
      id: "global",
      name: "Global Tank",
      maxLobsters: 120,
    },
  });
}

export async function GET() {
  const db = getPrisma();
  if (!env.DATABASE_URL || !db) {
    return NextResponse.json(
      { aquariums: [{ id: "global", name: "Global Tank", maxLobsters: 120 }] },
      { status: 200 },
    );
  }

  try {
    await ensureGlobalAquarium(db);
    const aquariums = await db.aquarium.findMany({
      orderBy: { name: "asc" },
    });
    return NextResponse.json({ aquariums }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      {
        aquariums: [{ id: "global", name: "Global Tank", maxLobsters: 120 }],
      },
      { status: 200 },
    );
  }
}

export async function POST(request: Request) {
  const auth = await requireWalletAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Wallet required" }, { status: 401 });
  }

  const db = getPrisma();
  if (!env.DATABASE_URL || !db) {
    return NextResponse.json(
      { error: "Database not configured" },
      { status: 503 },
    );
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  try {
    const aquarium = await db.aquarium.create({
      data: {
        id: randomUUID(),
        name: parsed.data.name,
        maxLobsters: parsed.data.maxLobsters ?? 120,
        description: parsed.data.description,
      },
    });

    return NextResponse.json({ aquarium }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Database unavailable",
        detail: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 503 },
    );
  }
}
