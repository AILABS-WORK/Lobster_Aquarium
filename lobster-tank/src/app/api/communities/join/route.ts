import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { requireWalletAuth } from "@/lib/wallet-auth";

const LEAVE_COOLDOWN_MS = 5 * 60 * 1000;

const bodySchema = z.object({
  communityId: z.string().min(1),
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

  const community = await db.community.findUnique({
    where: { id: parsed.data.communityId },
  });
  if (!community) {
    return NextResponse.json({ error: "Community not found" }, { status: 404 });
  }

  const lobster = await db.lobster.findFirst({
    where: { ownerUserId: auth.user.id },
  });
  if (!lobster) {
    return NextResponse.json({ error: "No lobster owned" }, { status: 404 });
  }
  if (lobster.communityId) {
    return NextResponse.json(
      { error: "Already in a community" },
      { status: 400 },
    );
  }
  if (
    lobster.leftCommunityAt &&
    Date.now() - lobster.leftCommunityAt.getTime() < LEAVE_COOLDOWN_MS
  ) {
    return NextResponse.json(
      { error: "Leave cooldown active" },
      { status: 400 },
    );
  }

  await db.lobster.update({
    where: { id: lobster.id },
    data: { communityId: community.id },
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
