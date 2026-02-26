import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { getWalletFromRequest } from "@/lib/wallet-auth";

/**
 * GET /api/auth/status
 * Returns whether the connected wallet has a password set (for UI: show "Set password" vs "Enter password").
 */
export async function GET(request: Request) {
  const wallet = getWalletFromRequest(request);
  if (!wallet) {
    return NextResponse.json({ hasPassword: false, wallet: null }, { status: 200 });
  }

  const db = getPrisma();
  if (!env.DATABASE_URL || !db) {
    return NextResponse.json(
      { hasPassword: false, wallet },
      { status: 200 },
    );
  }

  const user = await db.user.findFirst({
    where: { walletAddress: wallet },
    select: { id: true, passwordHash: true },
  });

  return NextResponse.json({
    hasPassword: Boolean(user?.passwordHash),
    wallet,
  });
}
