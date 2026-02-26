import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { requireWalletAuth } from "@/lib/wallet-auth";

const bodySchema = z.object({
  name: z.string().min(2),
  color: z.string().min(3),
  description: z.string().optional(),
});

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

  const communityId = `community-${Date.now()}`;
  const community = await db.community.create({
    data: {
      id: communityId,
      name: parsed.data.name,
      color: parsed.data.color,
      description: parsed.data.description,
    },
  });

  return NextResponse.json({ community }, { status: 200 });
}
