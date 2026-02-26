import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { requireWalletAuth } from "@/lib/wallet-auth";

const patchSchema = z.object({
  displayName: z.string().min(0).max(64).optional().nullable(),
  bodyColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().nullable(),
  clawColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().nullable(),
  bandanaColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().nullable(),
});

/**
 * PATCH /api/lobsters/[id]
 * Update display name and colors for the authenticated user's lobster.
 */
export async function PATCH(
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

  const { id: lobsterId } = await params;
  const lobster = await db.lobster.findUnique({
    where: { id: lobsterId },
  });
  if (!lobster || lobster.ownerUserId !== auth.user.id) {
    return NextResponse.json({ error: "Lobster not found or not owned by you" }, { status: 404 });
  }

  const json = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid payload" },
      { status: 400 },
    );
  }

  const update: { displayName?: string | null; bodyColor?: string | null; clawColor?: string | null; bandanaColor?: string | null } = {};
  if (parsed.data.displayName !== undefined) update.displayName = parsed.data.displayName;
  if (parsed.data.bodyColor !== undefined) update.bodyColor = parsed.data.bodyColor;
  if (parsed.data.clawColor !== undefined) update.clawColor = parsed.data.clawColor;
  if (parsed.data.bandanaColor !== undefined) update.bandanaColor = parsed.data.bandanaColor;

  await db.lobster.update({
    where: { id: lobsterId },
    data: update,
  });

  return NextResponse.json({ ok: true });
}
