import { Connection, PublicKey } from "@solana/web3.js";
import { env, getSolanaRpcUrl } from "@/lib/env";
import { getEligibilityTier, getOwnerMin } from "@/lib/wallet/gating";
import { getSolanaTokenBalance } from "@/lib/wallet/solana";

/**
 * Server-side: returns true if the wallet is considered "owner" tier (can claim, pet, level-up as owner).
 * True when: DEV_OWNER_WALLET matches, or TOKEN_MINT is set and balance >= TOKEN_OWNER_MIN (env).
 * When TOKEN_MINT is not set, returns true (no gating).
 */
export async function checkOwnerTierServer(wallet: string): Promise<boolean> {
  if (env.DEV_OWNER_WALLET && wallet === env.DEV_OWNER_WALLET) return true;
  if (!env.TOKEN_MINT) return true;
  try {
    const connection = new Connection(
      getSolanaRpcUrl(),
      "confirmed",
    );
    const balance = await getSolanaTokenBalance(
      connection,
      new PublicKey(wallet),
      env.TOKEN_MINT,
    );
    return getEligibilityTier(balance) === "owner";
  } catch {
    return false;
  }
}
