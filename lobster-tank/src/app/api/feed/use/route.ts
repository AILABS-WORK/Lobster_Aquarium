import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { requireWalletAuth } from "@/lib/wallet-auth";
import { rateLimit } from "@/lib/rate-limit";
import { applyFeedEffects } from "@/sim/traits";
import { syncLobsterStatsIntoSim } from "@/lib/server-sim";

const levelThreshold = (level: number) => 40 + level * 25;
const PET_BOOST_DURATION_MS = 30_000; // 30 seconds
const FEED_COOLDOWN_MS = 10_000;
const ONE_FEED_AMOUNT = 100;

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for") ?? "local";
  const limit = rateLimit(ip, 15, 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again in a minute." },
      { status: 429 },
    );
  }

  const auth = await requireWalletAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Wallet required" }, { status: 401 });
  }

  const db = getPrisma();
  if (!db) {
    return NextResponse.json(
      { error: "Database not configured" },
      { status: 503 },
    );
  }

  const lobster = await db.lobster.findFirst({
    where: { ownerUserId: auth.user.id },
  });
  if (!lobster) {
    return NextResponse.json(
      { error: "No lobster owned" },
      { status: 404 },
    );
  }

  const credits = lobster.feedCredits ?? 0;
  if (credits < 1) {
    return NextResponse.json(
      { error: "No feeds remaining. Send tokens to the tank bank and verify to add feeds." },
      { status: 400 },
    );
  }

  const nowDate = new Date();
  if (lobster.lastFed && nowDate.getTime() - lobster.lastFed.getTime() < FEED_COOLDOWN_MS) {
    const remainingMs = FEED_COOLDOWN_MS - (nowDate.getTime() - lobster.lastFed.getTime());
    const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    return NextResponse.json(
      { error: `Feeding cooldown active. Try again in ${remainingSeconds}s.` },
      { status: 429 },
    );
  }

  const effects = applyFeedEffects(ONE_FEED_AMOUNT);
  let nextLevel = lobster.level;
  let nextXp = lobster.xp + effects.xp;
  let nextSize = lobster.size + effects.size;
  while (nextXp >= levelThreshold(nextLevel)) {
    nextXp -= levelThreshold(nextLevel);
    nextLevel += 1;
    nextSize += 0.06;
  }

  const petBoostUntil = new Date(nowDate.getTime() + PET_BOOST_DURATION_MS);
  const newCredits = credits - 1;

  await db.lobster.update({
    where: { id: lobster.id },
    data: {
      xp: nextXp,
      level: nextLevel,
      size: nextSize,
      lastFed: nowDate,
      petBoostUntil,
      feedCredits: newCredits,
    },
  });

  const HEAL_PERCENT = 0.6;
  void syncLobsterStatsIntoSim(
    lobster.id,
    {
      level: nextLevel,
      xp: nextXp,
      size: nextSize,
      petBoostUntil: petBoostUntil.getTime(),
      healPercent: HEAL_PERCENT,
    },
    lobster.aquariumId ?? undefined,
  );

  return NextResponse.json(
    {
      lobsterId: lobster.id,
      feedCredits: newCredits,
      effects,
      level: nextLevel,
      size: nextSize,
      petBoostUntil: petBoostUntil.getTime(),
    },
    { status: 200 },
  );
}
