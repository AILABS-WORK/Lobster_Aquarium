import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { getWalletFromRequest, getOrCreateUserByWallet } from "@/lib/wallet-auth";
import { hashPassword } from "@/lib/auth-password";

const bodySchema = z.object({ password: z.string().min(6, "At least 6 characters") });

/**
 * POST /api/auth/set-password
 * Set password once for the wallet (from header). Creates user if not exists. Requires AUTH_SECRET and DB.
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
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid payload" },
      { status: 400 },
    );
  }

  const user = await getOrCreateUserByWallet(wallet);
  if (!user) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  if (user.passwordHash) {
    return NextResponse.json(
      { error: "Password already set for this wallet" },
      { status: 409 },
    );
  }

  const passwordHash = hashPassword(parsed.data.password, env.AUTH_SECRET);
  await db.user.update({
    where: { id: user.id },
    data: { passwordHash },
  });

  return NextResponse.json({ ok: true });
}
