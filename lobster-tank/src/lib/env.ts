import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  TANK_BANK_ADDRESS: z.string().min(1).optional(),
  TOKEN_MINT: z.string().min(1).optional(),
  /** Optional: test token mint (e.g. PUM) for feed verify; when set, either TOKEN_MINT or PUM_TOKEN_MINT is accepted. */
  PUM_TOKEN_MINT: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  /** Helius API key; required for all server-side Solana RPC (feed, wallet, claim, etc.). */
  HELIUS_API_KEY: z.string().optional(),
  SUPABASE_URL: z.string().min(1).optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  MOLTBOOK_API_KEY: z.string().min(1).optional(),
  MOLTBOOK_SUBMOLT: z.string().min(1).optional(),
  /** Set to "true" to allow automated and manual posts to Moltbook. Omit or false = no posting (for testing). */
  MOLTBOOK_POSTING_ENABLED: z.string().optional(),
  AUTH_SECRET: z.string().min(1).optional(),
  CRON_SECRET: z.string().min(1).optional(),
  DEV_OWNER_WALLET: z.string().min(1).optional(),
  NEXT_PUBLIC_DEV_OWNER_WALLET: z.string().min(1).optional(),
  /** Set to "true" to require wallet to have a password set before claiming a lobster. */
  REQUIRE_PASSWORD_TO_CLAIM: z.string().optional(),
  /** Min token balance to be "owner" (claim, feed, pet, level-up). Default 10000. */
  TOKEN_OWNER_MIN: z.string().optional(),
  /** Min token balance to be "caretaker". Default 1000. */
  TOKEN_CARETAKER_MIN: z.string().optional(),
  /** Min tokens per feed transaction to accept. Default 100. */
  TOKEN_FEED_MIN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  TANK_BANK_ADDRESS: process.env.TANK_BANK_ADDRESS,
  TOKEN_MINT: process.env.TOKEN_MINT,
  PUM_TOKEN_MINT: process.env.PUM_TOKEN_MINT,
  DATABASE_URL: process.env.DATABASE_URL,
  HELIUS_API_KEY: process.env.HELIUS_API_KEY,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  MOLTBOOK_API_KEY: process.env.MOLTBOOK_API_KEY,
  MOLTBOOK_SUBMOLT: process.env.MOLTBOOK_SUBMOLT,
  MOLTBOOK_POSTING_ENABLED: process.env.MOLTBOOK_POSTING_ENABLED,
  AUTH_SECRET: process.env.AUTH_SECRET,
  CRON_SECRET: process.env.CRON_SECRET,
  DEV_OWNER_WALLET: process.env.DEV_OWNER_WALLET,
  NEXT_PUBLIC_DEV_OWNER_WALLET: process.env.NEXT_PUBLIC_DEV_OWNER_WALLET,
  REQUIRE_PASSWORD_TO_CLAIM: process.env.REQUIRE_PASSWORD_TO_CLAIM,
  TOKEN_OWNER_MIN: process.env.TOKEN_OWNER_MIN,
  TOKEN_CARETAKER_MIN: process.env.TOKEN_CARETAKER_MIN,
  TOKEN_FEED_MIN: process.env.TOKEN_FEED_MIN,
});

/** Server RPC: Helius mainnet only. Requires HELIUS_API_KEY in .env. */
export function getSolanaRpcUrl(): string {
  const helius = env.HELIUS_API_KEY?.trim();
  if (!helius) {
    throw new Error("HELIUS_API_KEY is required. Add it to .env for server-side Solana RPC.");
  }
  return `https://mainnet.helius-rpc.com/?api-key=${helius}`;
}
