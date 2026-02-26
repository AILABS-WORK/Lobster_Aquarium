import { NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import { getSolanaRpcUrl } from "@/lib/env";

/**
 * GET /api/rpc-test
 * Verifies Helius RPC is reachable. Does not expose API keys.
 * Disabled in production to avoid info disclosure.
 */
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return new Response(null, { status: 404 });
  }
  try {
    const url = getSolanaRpcUrl();
    const connection = new Connection(url, "confirmed");
    const slot = await connection.getSlot();
    return NextResponse.json(
      { ok: true, source: "helius", slot, endpointHint: "Helius mainnet" },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 502 },
    );
  }
}
