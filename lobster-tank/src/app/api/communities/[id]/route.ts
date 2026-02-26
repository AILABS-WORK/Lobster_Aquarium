import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { requireWalletAuth } from "@/lib/wallet-auth";

const bodySchema = z.object({
  name: z.string().min(2).max(64),
});

/**
 * PATCH /api/communities/[id] - Rename a community.
 * Requires wallet auth; caller must own a lobster that is a member of the community.
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

  const { id: communityId } = await params;

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const community = await db.community.findUnique({
    where: { id: communityId },
    include: { lobsters: true },
  });
  if (!community) {
    return NextResponse.json({ error: "Community not found" }, { status: 404 });
  }

  const lobster = await db.lobster.findFirst({
    where: { ownerUserId: auth.user.id },
  });
  if (!lobster) {
    return NextResponse.json(
      { error: "You must own a lobster to rename" },
      { status: 403 },
    );
  }
  if (lobster.communityId !== communityId) {
    return NextResponse.json(
      { error: "Your lobster must be in this community to rename it" },
      { status: 403 },
    );
  }

  const updated = await db.community.update({
    where: { id: communityId },
    data: { name: parsed.data.name },
  });

  return NextResponse.json({ community: updated }, { status: 200 });
}
