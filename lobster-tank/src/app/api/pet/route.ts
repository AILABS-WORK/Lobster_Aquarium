import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { requireWalletAuth } from "@/lib/wallet-auth";
import { checkOwnerTierServer } from "@/lib/wallet/require-owner";

const PET_COOLDOWN_MS = 60 * 1000;
const PET_BOOST_DURATION_MS = 30_000; // 30 seconds (align with feed boost)
const RECENT_FEED_WINDOW_MS = 10 * 60 * 1000;

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

  const isOwnerTier = await checkOwnerTierServer(auth.wallet);
  if (!isOwnerTier) {
    return NextResponse.json(
      { error: "Owner tier required (hold ≥10k tokens) to pet your lobster." },
      { status: 403 },
    );
  }

  const lobster = await db.lobster.findFirst({
    where: { ownerUserId: auth.user.id },
  });

  if (!lobster) {
    return NextResponse.json({ error: "No lobster owned" }, { status: 404 });
  }

  const now = new Date();
  if (lobster.lastPet && now.getTime() - lobster.lastPet.getTime() < PET_COOLDOWN_MS) {
    return NextResponse.json(
      { error: "Pet cooldown active" },
      { status: 429 },
    );
  }

  const recentFeed = await db.feedEvent.findFirst({
    where: {
      userId: auth.user.id,
      createdAt: { gte: new Date(now.getTime() - RECENT_FEED_WINDOW_MS) },
    },
    orderBy: { createdAt: "desc" },
  });
  const petBoostUntil = recentFeed
    ? new Date(now.getTime() + PET_BOOST_DURATION_MS)
    : null;

  await db.lobster.update({
    where: { id: lobster.id },
    data: { lastPet: now, petBoostUntil },
  });

  await db.petEvent.create({
    data: {
      id: crypto.randomUUID(),
      userId: auth.user.id,
      lobsterId: lobster.id,
    },
  });

  return NextResponse.json({
    ok: true,
    petBoostUntil: petBoostUntil?.getTime() ?? null,
  }, { status: 200 });
}
