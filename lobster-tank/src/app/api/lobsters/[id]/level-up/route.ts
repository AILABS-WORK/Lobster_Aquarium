import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { requireWalletAuth } from "@/lib/wallet-auth";
import { checkOwnerTierServer } from "@/lib/wallet/require-owner";

const bodySchema = z.object({
  stat: z.enum(["hp", "attackDamage", "friendshipChance", "attackHitChance", "critChance"]),
});

const STAT_DELTAS = {
  hp: { maxHp: 10 },
  attackDamage: { attackDamage: 2 },
  friendshipChance: { friendshipChance: 0.05 },
  attackHitChance: { attackHitChance: 0.03 },
  critChance: { critChance: 0.02 },
} as const;

/**
 * POST /api/lobsters/[id]/level-up
 * Choose which stat to improve after a level-up. Requires pendingLevelUpLevel to be set.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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
      { error: "Owner tier required (hold ≥10k tokens) to level up." },
      { status: 403 },
    );
  }

  const { id: lobsterId } = await params;
  const lobster = await db.lobster.findUnique({
    where: { id: lobsterId },
  });
  if (!lobster || lobster.ownerUserId !== auth.user.id) {
    return NextResponse.json({ error: "Lobster not found or not owned by you" }, { status: 404 });
  }

  if (lobster.pendingLevelUpLevel == null || lobster.pendingLevelUpLevel !== lobster.level) {
    return NextResponse.json(
      { error: "No pending level-up choice for this lobster" },
      { status: 400 },
    );
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid payload" },
      { status: 400 },
    );
  }

  const stat = parsed.data.stat;
  const deltas = STAT_DELTAS[stat];
  const data: { pendingLevelUpLevel: null; maxHp?: number; attackDamage?: number; friendshipChance?: number; attackHitChance?: number; critChance?: number } = {
    pendingLevelUpLevel: null,
  };
  if ("maxHp" in deltas) data.maxHp = lobster.maxHp + deltas.maxHp;
  if ("attackDamage" in deltas) data.attackDamage = lobster.attackDamage + deltas.attackDamage;
  if ("friendshipChance" in deltas) data.friendshipChance = Math.min(1, lobster.friendshipChance + deltas.friendshipChance);
  if ("attackHitChance" in deltas) data.attackHitChance = Math.min(1, lobster.attackHitChance + deltas.attackHitChance);
  if ("critChance" in deltas) data.critChance = Math.min(1, lobster.critChance + deltas.critChance);

  await db.lobster.update({
    where: { id: lobsterId },
    data,
  });

  return NextResponse.json({ ok: true });
}
