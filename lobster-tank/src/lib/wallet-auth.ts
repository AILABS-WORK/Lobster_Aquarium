import { getPrisma } from "@/lib/prisma";

const WALLET_HEADER = "x-wallet-address";

/**
 * Read wallet address from request header.
 * Client must send x-wallet-address when wallet is connected.
 */
export function getWalletFromRequest(request: Request): string | null {
  const wallet = request.headers.get(WALLET_HEADER)?.trim();
  if (!wallet || wallet.length < 32) return null;
  return wallet;
}

/**
 * Find or create user by wallet address.
 * User.id = wallet address for wallet-only users (reward wallet = identity).
 * Returns null if database is not configured.
 */
export async function getOrCreateUserByWallet(walletAddress: string) {
  const db = getPrisma();
  if (!db) return null;
  let user = await db.user.findFirst({
    where: { walletAddress },
  });
  if (!user) {
    user = await db.user.create({
      data: {
        id: walletAddress,
        walletAddress,
      },
    });
  }
  return user;
}

/**
 * Require wallet auth: get wallet from header, find/create user, or return null.
 * Use in API routes; return 401 if result is null.
 */
export async function requireWalletAuth(request: Request) {
  const wallet = getWalletFromRequest(request);
  if (!wallet) return null;
  const user = await getOrCreateUserByWallet(wallet);
  if (!user) return null;
  return { wallet, user };
}
