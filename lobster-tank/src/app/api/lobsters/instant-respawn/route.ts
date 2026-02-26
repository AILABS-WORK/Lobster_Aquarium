import { NextResponse } from "next/server";
import { z } from "zod";
import { Connection, PublicKey, ParsedInstruction } from "@solana/web3.js";
import { env, getSolanaRpcUrl } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { requireWalletAuth } from "@/lib/wallet-auth";
import { rateLimit } from "@/lib/rate-limit";

const INSTANT_RESPAWN_TOKENS = 20;

const bodySchema = z
  .object({
    lobsterId: z.string().min(1),
    txHash: z.string().min(1),
    registeredWallet: z.string().min(1),
  })
  .passthrough();

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for") ?? "local";
  const limit = rateLimit(ip, 5, 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429 },
    );
  }

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

  if (!env.TANK_BANK_ADDRESS || !env.TOKEN_MINT) {
    return NextResponse.json(
      { error: "Server configuration missing" },
      { status: 500 },
    );
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { lobsterId, txHash, registeredWallet } = parsed.data;

  const lobster = await db.lobster.findUnique({
    where: { id: lobsterId },
  });
  if (!lobster) {
    return NextResponse.json({ error: "Lobster not found" }, { status: 404 });
  }
  if (lobster.ownerUserId !== auth.user.id) {
    return NextResponse.json(
      { error: "You do not own this lobster" },
      { status: 403 },
    );
  }

  const connection = new Connection(
    getSolanaRpcUrl(),
    "confirmed",
  );
  const tx = await connection.getParsedTransaction(txHash, {
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) {
    return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
  }

  const parsedInstruction = tx.transaction.message.instructions.find(
    (ix) => (ix as ParsedInstruction).program === "spl-token",
  ) as ParsedInstruction | undefined;
  if (!parsedInstruction || !parsedInstruction.parsed) {
    return NextResponse.json(
      { error: "No token transfer found" },
      { status: 400 },
    );
  }

  const info = parsedInstruction.parsed.info as Record<string, unknown>;
  const mint = info.mint as string | undefined;
  const destination = info.destination as string | undefined;
  const authority = info.authority as string | undefined;

  if (!authority || authority !== auth.wallet || registeredWallet !== auth.wallet) {
    return NextResponse.json(
      { error: "Sender wallet must match connected wallet" },
      { status: 400 },
    );
  }

  if (!mint || mint !== env.TOKEN_MINT) {
    return NextResponse.json({ error: "Invalid mint" }, { status: 400 });
  }

  if (!destination) {
    return NextResponse.json({ error: "Missing recipient" }, { status: 400 });
  }

  const destinationInfo = await connection.getParsedAccountInfo(
    new (await import("@solana/web3.js")).PublicKey(destination),
  );
  const destinationOwner =
    (destinationInfo.value?.data as { parsed?: { info?: { owner?: string } } })?.parsed?.info?.owner ?? null;
  if (destinationOwner !== env.TANK_BANK_ADDRESS) {
    return NextResponse.json({ error: "Invalid recipient" }, { status: 400 });
  }

  const rawAmount =
    typeof info.amount === "string"
      ? Number(info.amount)
      : Number((info as { tokenAmount?: { amount?: string; decimals?: number } }).tokenAmount?.amount ?? 0);
  const tokenAmount = (info as { tokenAmount?: { decimals?: number } }).tokenAmount;
  const decimals =
    typeof tokenAmount?.decimals === "number" ? tokenAmount.decimals : 0;
  const amount = decimals ? rawAmount / Math.pow(10, decimals) : rawAmount;
  if (amount < INSTANT_RESPAWN_TOKENS - 0.01) {
    return NextResponse.json(
      { error: `Minimum ${INSTANT_RESPAWN_TOKENS} tokens required` },
      { status: 400 },
    );
  }

  const existing = await db.instantRespawnEvent.findUnique({
    where: { txHash },
  });
  if (existing) {
    return NextResponse.json({ error: "Replay detected" }, { status: 409 });
  }

  await db.instantRespawnEvent.create({
    data: {
      id: crypto.randomUUID(),
      userId: auth.user.id,
      lobsterId,
      txHash,
    },
  });

  return NextResponse.json(
    { ok: true, lobsterId },
    { status: 200 },
  );
}
