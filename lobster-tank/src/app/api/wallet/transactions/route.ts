import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { env, getSolanaRpcUrl } from "@/lib/env";

/**
 * GET /api/wallet/transactions?address=...
 * Returns recent SPL token transfers FROM the given wallet TO the tank bank
 * (so you can confirm "last tx was 100 tokens" without pasting a hash).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");
  if (!address || !env.TANK_BANK_ADDRESS || !env.TOKEN_MINT) {
    return NextResponse.json(
      { error: "Address and tank bank config required", transfers: [] },
      { status: 400 },
    );
  }

  try {
    const connection = new Connection(getSolanaRpcUrl(), "confirmed");
    const walletPk = new PublicKey(address);
    const tankBankWallet = new PublicKey(env.TANK_BANK_ADDRESS);
    const tokenMint = new PublicKey(env.TOKEN_MINT);
    const tankBankAta = getAssociatedTokenAddressSync(tokenMint, tankBankWallet);

    const sigs = await connection.getSignaturesForAddress(walletPk, { limit: 20 });
    const transfers: { signature: string; amount: number; time: number }[] = [];

    for (const { signature } of sigs) {
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) continue;
      const ix = tx.transaction.message.instructions.find(
        (i) => (i as { program?: string }).program === "spl-token",
      ) as { parsed?: { info?: Record<string, unknown> } } | undefined;
      if (!ix?.parsed?.info) continue;
      const info = ix.parsed.info;
      const dest = typeof info.destination === "string" ? info.destination : undefined;
      const mint = typeof info.mint === "string" ? info.mint : undefined;
      const validMint = mint === env.TOKEN_MINT || (env.PUM_TOKEN_MINT && mint === env.PUM_TOKEN_MINT);
      if (!dest || !validMint) continue;
      if (dest !== tankBankAta.toBase58()) continue;

      const tokenAmount =
        info.tokenAmount && typeof info.tokenAmount === "object" && "amount" in info.tokenAmount
          ? (info.tokenAmount as { amount?: string; decimals?: number })
          : null;
      const rawAmount =
        typeof info.amount === "string"
          ? Number(info.amount)
          : tokenAmount?.amount != null
            ? Number(tokenAmount.amount)
            : 0;
      const decimals = typeof tokenAmount?.decimals === "number" ? tokenAmount.decimals : 0;
      const amount = decimals ? rawAmount / Math.pow(10, decimals) : rawAmount;
      const blockTime = tx.blockTime ?? 0;

      transfers.push({ signature, amount, time: blockTime });
    }

    return NextResponse.json(
      { transfers: transfers.slice(0, 10) },
      { status: 200 },
    );
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: raw || "Failed to fetch transactions", transfers: [] },
      { status: 200 },
    );
  }
}
