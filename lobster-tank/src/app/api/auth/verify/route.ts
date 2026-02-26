import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { getWalletFromRequest } from "@/lib/wallet-auth";
import { verifyPassword } from "@/lib/auth-password";

const bodySchema = z.object({ password: z.string().min(1) });

/**
 * POST /api/auth/verify
 * Verify wallet password. Returns ok: true if correct.
 */
export async function POST(request: Request) {
  const wallet = getWalletFromRequest(request);
  if (!wallet) {
    return NextResponse.json({ error: "Wallet required" }, { status: 401 });
  }

  if (!env.AUTH_SECRET) {
    return NextResponse.json(
      { error: "Auth not configured (set AUTH_SECRET in .env)" },
      { status: 503 },
    );
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
    return NextResponse.json({ error: "Password required" }, { status: 400 });
  }

  const user = await db.user.findFirst({
    where: { walletAddress: wallet },
  });

  if (!user || !user.passwordHash) {
    return NextResponse.json(
      { error: "No password set for this wallet; set one first" },
      { status: 404 },
    );
  }

  const valid = verifyPassword(parsed.data.password, user.passwordHash, env.AUTH_SECRET!);
  if (!valid) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  return NextResponse.json({ ok: true });
}
