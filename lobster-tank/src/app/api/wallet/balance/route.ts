import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { env, getSolanaRpcUrl } from "@/lib/env";
import { getSolanaTokenBalance } from "@/lib/wallet/solana";

/** Default to mainnet when RPC not set (most game/Pump tokens live on mainnet). */

/**
 * GET /api/wallet/balance?address=...
 * Returns lobster token balance for the given wallet address (so pasted-address UX can show tier).
 * Uses TOKEN_MINT from env; balance is in human units (after decimals). RPC is Helius mainnet (HELIUS_API_KEY).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");
  if (!address || !env.TOKEN_MINT) {
    return NextResponse.json(
      { error: "Address and token mint required", balance: 0 },
      { status: 400 },
    );
  }

  try {
    const rpc = getSolanaRpcUrl();
    const connection = new Connection(rpc, "confirmed");
    const balance = await getSolanaTokenBalance(
      connection,
      new PublicKey(address),
      env.TOKEN_MINT,
    );
    return NextResponse.json(
      { balance: balance.amount, decimals: balance.decimals },
      { status: 200 },
    );
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const isBlocked =
      raw.includes("403") ||
      raw.toLowerCase().includes("blocked from this endpoint") ||
      raw.toLowerCase().includes("your ip or provider is blocked");
    const message = isBlocked
      ? "RPC blocked this request (403). Check HELIUS_API_KEY in .env and Helius dashboard for rate limits or IP restrictions."
      : raw || "RPC or network error";
    return NextResponse.json(
      { error: message, balance: 0, decimals: 0 },
      { status: 200 },
    );
  }
}
