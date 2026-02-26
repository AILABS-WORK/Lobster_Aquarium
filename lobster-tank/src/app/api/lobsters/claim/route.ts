import { NextResponse } from "next/server";
import { z } from "zod";
import { Connection, PublicKey } from "@solana/web3.js";
import { env, getSolanaRpcUrl } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { requireWalletAuth } from "@/lib/wallet-auth";
import { getEligibilityTier } from "@/lib/wallet/gating";
import { getSolanaTokenBalance } from "@/lib/wallet/solana";
import { injectLobsterIntoSim } from "@/lib/server-sim";

const bodySchema = z.object({
  tier: z.enum(["viewer", "caretaker", "owner"]),
  aquariumId: z.string().optional(),
  displayName: z.string().min(0).max(64).optional().nullable(),
  bodyColor: z.string().min(0).max(32).optional().nullable(),
  clawColor: z.string().min(0).max(32).optional().nullable(),
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

  const isDevOwner = !!env.DEV_OWNER_WALLET && auth.wallet === env.DEV_OWNER_WALLET;
  if (parsed.data.tier !== "owner" && !isDevOwner) {
    return NextResponse.json(
      { error: "Owner tier required (hold ≥10k tokens)" },
      { status: 403 },
    );
  }

  if (env.REQUIRE_PASSWORD_TO_CLAIM === "true" && !isDevOwner) {
    const userWithPassword = await db.user.findUnique({
      where: { id: auth.user.id },
      select: { passwordHash: true },
    });
    if (!userWithPassword?.passwordHash) {
      return NextResponse.json(
        { error: "Set a password for this wallet before claiming a lobster (use Login or Set password)." },
        { status: 403 },
      );
    }
  }

  if (!isDevOwner && env.TOKEN_MINT) {
    try {
      const connection = new Connection(getSolanaRpcUrl(), "confirmed");
      const balance = await getSolanaTokenBalance(
        connection,
        new PublicKey(auth.wallet),
        env.TOKEN_MINT,
      );
      const tier = getEligibilityTier(balance);
      if (tier !== "owner") {
        return NextResponse.json(
          { error: "Owner tier required (hold ≥10k tokens). Current balance too low." },
          { status: 403 },
        );
      }
    } catch {
      return NextResponse.json(
        { error: "Could not verify token balance. Try again." },
        { status: 503 },
      );
    }
  }

  const existing = await db.lobster.findFirst({
    where: { ownerUserId: auth.user.id },
  });
  if (existing) {
    return NextResponse.json(
      { error: "User already owns a lobster", lobsterId: existing.id },
      { status: 409 },
    );
  }

  let aquariumId = parsed.data.aquariumId;
  let aquarium: { id: string; maxLobsters: number } | null = null;

  if (aquariumId != null && aquariumId !== "") {
    aquarium = await db.aquarium.findUnique({
      where: { id: aquariumId },
      select: { id: true, maxLobsters: true },
    });
    if (!aquarium && aquariumId === "global") {
      const created = await db.aquarium.create({
        data: { id: "global", name: "Global Tank", maxLobsters: 120 },
        select: { id: true, maxLobsters: true },
      });
      aquarium = created;
    }
    if (!aquarium) {
      return NextResponse.json(
        { error: "Aquarium not found" },
        { status: 404 },
      );
    }
  } else {
    // Auto-assign: first aquarium with space (ordered by id)
    const aquariums = await db.aquarium.findMany({
      orderBy: { id: "asc" },
      select: { id: true, maxLobsters: true },
    });
    for (const aq of aquariums) {
      const count = await db.lobster.count({ where: { aquariumId: aq.id } });
      if (count < aq.maxLobsters) {
        aquarium = aq;
        aquariumId = aq.id;
        break;
      }
    }
    if (!aquarium) {
      return NextResponse.json(
        { error: "All aquariums are full. Try again later." },
        { status: 409 },
      );
    }
  }

  if (!aquarium) {
    return NextResponse.json(
      { error: "All aquariums are full. Try again later." },
      { status: 409 },
    );
  }

  const aquariumLobsterCount = await db.lobster.count({
    where: { aquariumId: aquarium.id },
  });
  if (aquariumLobsterCount >= aquarium.maxLobsters) {
    return NextResponse.json(
      { error: "Aquarium is full" },
      { status: 409 },
    );
  }

  const lobsterCount = await db.lobster.count();
  const lobsterId = `LOB-${String(lobsterCount + 1).padStart(3, "0")}`;

  const displayName = parsed.data.displayName?.trim() || null;
  const bodyColor = parsed.data.bodyColor?.trim() || null;
  const clawColor = parsed.data.clawColor?.trim() || null;

  await db.lobster.create({
    data: {
      id: lobsterId,
      ownerUserId: auth.user.id,
      aquariumId: aquarium.id,
      level: 1,
      xp: 0,
      size: 1,
      status: "Neutral",
      traits: { courage: 1, likeability: 1 },
      displayName: displayName ?? undefined,
      bodyColor: bodyColor ?? undefined,
      clawColor: clawColor ?? undefined,
    },
  });

  await injectLobsterIntoSim(lobsterId, displayName ?? undefined, aquarium.id, {
    bodyColor: bodyColor ?? undefined,
    clawColor: clawColor ?? undefined,
  });

  return NextResponse.json({ lobsterId }, { status: 200 });
}
