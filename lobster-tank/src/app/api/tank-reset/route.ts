import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { resetServerTankToFresh, resetServerTankToEmpty, seedTestLobsters } from "@/lib/server-sim";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

/** Clear AI narrator posts. Called on every reset so summaries match fresh tank state. */
async function clearNarratorPosts(): Promise<void> {
  const prisma = getPrisma();
  if (prisma) await prisma.narratorPost.deleteMany({});
}

/** Reset tank. ?empty=1 = empty tank (testing). When NEXT_PUBLIC_SHOW_RESET_TANK=true, allow without x-cron-secret so the UI button works. */
export async function POST(request: Request) {
  const allowTestingButton = process.env.NEXT_PUBLIC_SHOW_RESET_TANK === "true";
  if (env.CRON_SECRET && !allowTestingButton) {
    const secret = request.headers.get("x-cron-secret");
    if (secret !== env.CRON_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  const url = new URL(request.url);
  const aquariumId = url.searchParams.get("aquarium") ?? "global";
  const emptyParam = url.searchParams.get("empty");
  let empty = emptyParam === "1" || emptyParam === "true";
  if (!empty) {
    try {
      const body = await request.clone().json().catch(() => ({}));
      empty = body?.empty === true || body?.empty === 1;
    } catch {
      // no body
    }
  }
  const seedCount = parseInt(url.searchParams.get("seed") ?? "0", 10);
  try {
    if (seedCount > 0) {
      await seedTestLobsters(aquariumId, Math.min(seedCount, 120));
    } else if (empty) {
      await resetServerTankToEmpty(aquariumId);
    } else {
      await resetServerTankToFresh(aquariumId);
    }
    await clearNarratorPosts();
    return NextResponse.json({ ok: true, empty, seed: seedCount > 0 ? seedCount : undefined }, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to reset tank" },
      { status: 500 },
    );
  }
}
