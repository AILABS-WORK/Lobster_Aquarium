import { NextResponse } from "next/server";
import { z } from "zod";
import { Connection, PublicKey, ParsedInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { env, getSolanaRpcUrl } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { requireWalletAuth } from "@/lib/wallet-auth";
import { checkOwnerTierServer } from "@/lib/wallet/require-owner";
import { rateLimit } from "@/lib/rate-limit";
import { applyFeedEffects } from "@/sim/traits";
import { syncLobsterStatsIntoSim } from "@/lib/server-sim";

const levelThreshold = (level: number) => 40 + level * 25;
const PET_BOOST_DURATION_MS = 30_000; // 30 seconds
const FEED_COOLDOWN_MS = 10_000;

const bodySchema = z
  .object({
    txHash: z.string().optional(),
    registeredWallet: z.string().optional(),
  })
  .passthrough();

function isRpcRateLimitError(err: unknown): boolean {
  const s = err instanceof Error ? err.message : String(err);
  return s.includes("429") || s.toLowerCase().includes("too many requests");
}

export async function POST(request: Request) {
  try {
    return await handleFeedVerify(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[feed/verify] Error:", err);
    if (isRpcRateLimitError(err)) {
      return NextResponse.json(
        {
          error: "Blockchain RPC rate limit reached.",
          detail: "Paste your transaction hash above and click Verify feed (one RPC call). Or try again in a minute.",
        },
        { status: 429 },
      );
    }
    return NextResponse.json(
      { error: "Feed verification failed.", detail: message },
      { status: 500 },
    );
  }
}

async function handleFeedVerify(request: Request) {
  const ip = request.headers.get("x-forwarded-for") ?? "local";
  const limit = rateLimit(ip, 10, 120_000);
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

  // If this wallet already owns a lobster, they passed the 10k check at claim time — allow feed without re-checking balance (avoids RPC failures).
  const ownedLobster = await db.lobster.findFirst({
    where: { ownerUserId: auth.user.id },
    select: { id: true },
  });
  if (!ownedLobster) {
    const isOwnerTier = await checkOwnerTierServer(auth.wallet);
    if (!isOwnerTier) {
      return NextResponse.json(
        { error: "Owner tier required (hold ≥10k tokens) to feed the tank. Claim a lobster first." },
        { status: 403 },
      );
    }
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  let txHash: string | undefined = parsed.data.txHash?.trim() || undefined;
  const registeredWallet = (parsed.data.registeredWallet?.trim() || auth.wallet).trim();
  const feedMin = env.TOKEN_FEED_MIN != null && env.TOKEN_FEED_MIN !== "" ? Number(env.TOKEN_FEED_MIN) : 100;

  const connection = new Connection(getSolanaRpcUrl(), "confirmed");

  let tx: Awaited<ReturnType<Connection["getParsedTransaction"]>>;
  if (txHash) {
    tx = await connection.getParsedTransaction(txHash, {
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) {
      return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
    }
  } else {
    // Auto-find latest valid feed: SPL transfer from auth.wallet to tank bank, correct mint/amount, not replayed
    const tankBankWallet = new PublicKey(env.TANK_BANK_ADDRESS);
    const tokenMint = new PublicKey(env.TOKEN_MINT);
    const tankBankAta = getAssociatedTokenAddressSync(tokenMint, tankBankWallet);
    const walletPk = new PublicKey(auth.wallet);
    const sigs = await connection.getSignaturesForAddress(walletPk, { limit: 5 });
    const usedHashes = await db.feedEvent.findMany({ where: { userId: auth.user.id }, select: { txHash: true } }).then((r) => new Set(r.map((e) => e.txHash)));
    let found: { signature: string; tx: NonNullable<typeof tx> } | null = null;
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (const { signature } of sigs) {
      if (usedHashes.has(signature)) continue;
      await delay(150);
      const parsedTx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
      if (!parsedTx) continue;
      const ix = parsedTx.transaction.message.instructions.find(
        (i) => (i as ParsedInstruction).program === "spl-token",
      ) as ParsedInstruction | undefined;
      if (!ix?.parsed) continue;
      const info = ix.parsed.info as Record<string, unknown>;
      const dest = typeof info.destination === "string" ? info.destination : undefined;
      const mint = typeof info.mint === "string" ? info.mint : undefined;
      const validMint = mint === env.TOKEN_MINT || (env.PUM_TOKEN_MINT && mint === env.PUM_TOKEN_MINT);
      if (!dest || !validMint) continue;
      const isTankBankDest = dest === tankBankAta.toBase58();
      if (!isTankBankDest) {
        const destInfo = await connection.getParsedAccountInfo(new PublicKey(dest));
        const owner = (destInfo.value?.data as { parsed?: { info?: { owner?: string } } })?.parsed?.info?.owner;
        if (owner !== env.TANK_BANK_ADDRESS) continue;
      }
      const rawAuthority = info.authority ?? info.owner;
      let sender: string | null =
        typeof rawAuthority === "string"
          ? rawAuthority.trim()
          : rawAuthority && typeof rawAuthority === "object" && "pubkey" in rawAuthority && typeof (rawAuthority as { pubkey: string }).pubkey === "string"
            ? (rawAuthority as { pubkey: string }).pubkey.trim()
            : null;
      if (!sender && parsedTx.transaction.message.accountKeys?.length) {
        const firstSigner = parsedTx.transaction.message.accountKeys.find(
          (k) => "signer" in k && (k as { signer?: boolean }).signer === true,
        );
        if (firstSigner && "pubkey" in firstSigner) {
          const p = (firstSigner as { pubkey: PublicKey | string }).pubkey;
          sender = typeof p === "string" ? p.trim() : (p as PublicKey).toBase58().trim();
        }
      }
      if (sender !== auth.wallet.trim()) continue;
      const tokenAmount = info.tokenAmount && typeof info.tokenAmount === "object" && "amount" in info.tokenAmount ? info.tokenAmount as { amount?: string; decimals?: number } : null;
      const rawAmount = typeof info.amount === "string" ? Number(info.amount) : tokenAmount?.amount != null ? Number(tokenAmount.amount) : 0;
      const decimals = typeof tokenAmount?.decimals === "number" ? tokenAmount.decimals : 0;
      const amount = decimals ? rawAmount / Math.pow(10, decimals) : rawAmount;
      if (!Number.isFinite(amount) || amount < feedMin) continue;
      found = { signature, tx: parsedTx };
      break;
    }
    if (!found) {
      return NextResponse.json(
        { error: "No recent valid feed transaction found. Send tokens from this wallet to the tank bank, then try again (or paste the transaction hash)." },
        { status: 404 },
      );
    }
    txHash = found.signature;
    tx = found.tx;
  }

  if (!txHash) {
    return NextResponse.json({ error: "Missing transaction" }, { status: 400 });
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
  const mint = typeof info.mint === "string" ? info.mint : undefined;
  const destination = typeof info.destination === "string" ? info.destination : undefined;
  // RPC can return sender as "authority" or "owner"; owner can be object with pubkey
  const rawAuthority = info.authority ?? info.owner;
  let senderFromTx: string | null =
    typeof rawAuthority === "string"
      ? rawAuthority.trim()
      : rawAuthority && typeof rawAuthority === "object" && "pubkey" in rawAuthority && typeof (rawAuthority as { pubkey: string }).pubkey === "string"
        ? (rawAuthority as { pubkey: string }).pubkey.trim()
        : null;
  if (!senderFromTx && tx.transaction.message.accountKeys?.length) {
    const firstSigner = tx.transaction.message.accountKeys.find(
      (k) => "signer" in k && (k as { signer?: boolean }).signer === true,
    );
    if (firstSigner && "pubkey" in firstSigner) {
      const p = (firstSigner as { pubkey: PublicKey | string }).pubkey;
      senderFromTx = typeof p === "string" ? p.trim() : (p as PublicKey).toBase58().trim();
    }
  }

  const authWallet = auth.wallet.trim();
  const registered = String(registeredWallet).trim();

  if (!senderFromTx) {
    return NextResponse.json(
      { error: "Could not determine transaction sender. Ensure the tx is a token transfer from your wallet." },
      { status: 400 },
    );
  }
  if (senderFromTx !== authWallet || senderFromTx !== registered) {
    return NextResponse.json(
      {
        error: "Transaction sender must match your wallet",
        detail: "The wallet that sent the tokens must be the same as the one in 'Wallet address' above (the one that owns your lobster).",
        senderFromTx: senderFromTx.slice(0, 8) + "…" + senderFromTx.slice(-8),
        expectedWallet: authWallet.slice(0, 8) + "…" + authWallet.slice(-8),
      },
      { status: 400 },
    );
  }

  // Token-to-food: 1 token unit = 1 feed amount (stored and applied). Set PUM_TOKEN_MINT to also accept a test token.
  const validMint = mint === env.TOKEN_MINT || (env.PUM_TOKEN_MINT && mint === env.PUM_TOKEN_MINT);
  if (!mint || !validMint) {
    return NextResponse.json({ error: "Invalid mint" }, { status: 400 });
  }

  if (!destination) {
    return NextResponse.json({ error: "Missing recipient" }, { status: 400 });
  }

  const destinationInfo = await connection.getParsedAccountInfo(
    new PublicKey(destination),
  );
  const destinationOwner =
    (destinationInfo.value?.data as any)?.parsed?.info?.owner ?? null;
  if (destinationOwner !== env.TANK_BANK_ADDRESS) {
    return NextResponse.json({ error: "Invalid recipient" }, { status: 400 });
  }

  const tokenAmount = info.tokenAmount && typeof info.tokenAmount === "object" && "amount" in info.tokenAmount ? info.tokenAmount as { amount?: string; decimals?: number } : null;
  const rawAmount =
    typeof info.amount === "string"
      ? Number(info.amount)
      : tokenAmount?.amount != null ? Number(tokenAmount.amount) : 0;
  const decimals =
    typeof tokenAmount?.decimals === "number" ? tokenAmount.decimals : 0;
  const amount = decimals ? rawAmount / Math.pow(10, decimals) : rawAmount;
  if (!amount || amount <= 0) {
    return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
  }
  if (Number.isFinite(feedMin) && amount < feedMin) {
    return NextResponse.json(
      { error: `Minimum feed amount is ${feedMin} tokens` },
      { status: 400 },
    );
  }

  const lobster = await db.lobster.findFirst({
    where: { ownerUserId: auth.user.id },
  });
  if (!lobster) {
    return NextResponse.json(
      { error: "No lobster owned" },
      { status: 404 },
    );
  }

  const nowDate = new Date();
  if (lobster.lastFed && nowDate.getTime() - lobster.lastFed.getTime() < FEED_COOLDOWN_MS) {
    const remainingMs = FEED_COOLDOWN_MS - (nowDate.getTime() - lobster.lastFed.getTime());
    const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    return NextResponse.json(
      { error: `Feeding cooldown active. Try again in ${remainingSeconds}s.` },
      { status: 429 },
    );
  }

  const existing = await db.feedEvent.findUnique({
    where: { txHash },
  });
  if (existing) {
    return NextResponse.json({ error: "Replay detected" }, { status: 409 });
  }

  await db.feedEvent.create({
    data: {
      id: crypto.randomUUID(),
      userId: auth.user.id,
      lobsterId: lobster.id,
      txHash,
      amount,
    },
  });

  const effects = applyFeedEffects(amount);
  let nextLevel = lobster.level;
  let nextXp = lobster.xp + effects.xp;
  let nextSize = lobster.size + effects.size;
  while (nextXp >= levelThreshold(nextLevel)) {
    nextXp -= levelThreshold(nextLevel);
    nextLevel += 1;
    nextSize += 0.06;
  }

  const petBoostUntil = new Date(nowDate.getTime() + PET_BOOST_DURATION_MS);
  const creditsFromTx = Math.floor(amount / feedMin);
  const extraCredits = Math.max(0, creditsFromTx - 1);
  const newFeedCredits = (lobster.feedCredits ?? 0) + extraCredits;

  await db.lobster.update({
    where: { id: lobster.id },
    data: {
      xp: nextXp,
      level: nextLevel,
      size: nextSize,
      lastFed: nowDate,
      petBoostUntil,
      feedCredits: newFeedCredits,
    },
  });

  // Keep the running global sim in sync so in-tank level/size and health reflect feed effects immediately.
  const HEAL_PERCENT = 0.6; // Heal 60% of missing HP per verified feed.
  void syncLobsterStatsIntoSim(
    lobster.id,
    {
      level: nextLevel,
      xp: nextXp,
      size: nextSize,
      petBoostUntil: petBoostUntil.getTime(),
      healPercent: HEAL_PERCENT,
    },
    lobster.aquariumId ?? undefined,
  );

  return NextResponse.json(
    {
      lobsterId: lobster.id,
      amount,
      feedCredits: newFeedCredits,
      effects,
      level: nextLevel,
      size: nextSize,
      petBoostUntil: petBoostUntil.getTime(),
    },
    { status: 200 },
  );
}
