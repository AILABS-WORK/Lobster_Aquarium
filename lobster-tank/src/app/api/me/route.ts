import { NextResponse } from "next/server";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { env, getSolanaRpcUrl } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { getWalletFromRequest, requireWalletAuth } from "@/lib/wallet-auth";
import { getEligibilityTier } from "@/lib/wallet/gating";
import { getSolanaTokenBalance } from "@/lib/wallet/solana";

export async function GET(request: Request) {
  const db = getPrisma();
  if (!env.DATABASE_URL || !db) {
    const wallet = getWalletFromRequest(request);
    if (!wallet) {
      return NextResponse.json({ error: "Wallet required" }, { status: 401 });
    }
    return NextResponse.json(
      {
        profile: { id: wallet, walletAddress: wallet },
        lobster: null,
        eligibility: { tier: "viewer" as const, balance: 0 },
        events: [],
        databaseConfigured: false,
      },
      { status: 200 },
    );
  }

  const auth = await requireWalletAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Wallet required" }, { status: 401 });
  }

  const { user, wallet } = auth;

  const lobster = await db.lobster.findFirst({
    where: { ownerUserId: user.id },
    include: { community: true },
  });

  const recentEvents = await db.tankEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  let eligibility: { tier: "viewer" | "caretaker" | "owner"; balance: number } = {
    tier: "viewer",
    balance: 0,
  };
  if (env.DEV_OWNER_WALLET && wallet === env.DEV_OWNER_WALLET) {
    eligibility = { tier: "owner", balance: 0 };
  } else if (user.walletAddress && env.TOKEN_MINT) {
    const connection = new Connection(getSolanaRpcUrl(), "confirmed");
    try {
      const balance = await getSolanaTokenBalance(
        connection,
        new PublicKey(user.walletAddress),
        env.TOKEN_MINT,
      );
      eligibility = {
        tier: getEligibilityTier(balance),
        balance: balance.amount,
      };
    } catch {
      eligibility = { tier: "viewer", balance: 0 };
    }
  }

  return NextResponse.json(
    {
      profile: user,
      lobster: lobster
        ? {
            ...lobster,
            petBoostUntil: lobster.petBoostUntil?.getTime() ?? null,
            communityColor: lobster.community?.color ?? null,
          }
        : null,
      eligibility,
      events: recentEvents,
    },
    { status: 200 },
  );
}
