import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { requireWalletAuth } from "@/lib/wallet-auth";

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

  const lobster = await db.lobster.findFirst({
    where: { ownerUserId: auth.user.id },
  });
  if (!lobster || !lobster.communityId) {
    return NextResponse.json(
      { error: "Not in a community" },
      { status: 400 },
    );
  }

  await db.lobster.update({
    where: { id: lobster.id },
    data: { communityId: null, leftCommunityAt: new Date() },
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
