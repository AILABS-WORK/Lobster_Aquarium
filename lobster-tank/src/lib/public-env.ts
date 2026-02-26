import { z } from "zod";

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SOLANA_RPC_URL: z.string().optional(),
  NEXT_PUBLIC_TOKEN_MINT: z.string().optional(),
  /** Tank bank address for instant respawn (20 tokens). Shown in UI when lobster is dead. */
  NEXT_PUBLIC_TANK_BANK_ADDRESS: z.string().optional(),
  /** Lobster Observatory submolt URL on Moltbook (tank monitoring feed). */
  NEXT_PUBLIC_MOLTBOOK_OBSERVATORY_URL: z.string().url().optional(),
  /** Set to "true" to show "Post to Molt (as narrator)" in the UI. Omit or false = hidden (manual posts via script only). */
  NEXT_PUBLIC_SHOW_MOLT_POST: z.string().optional(),
  /** When "true", hide manual Molt UI (Generate, Post now to Molt, Refresh script); use cron/API for 30-min auto-post only. */
  NEXT_PUBLIC_MOLT_AUTO_ONLY: z.string().optional(),
  /** When "true", show "Reset tank (testing)" in aquarium. Omit or false for production. */
  NEXT_PUBLIC_SHOW_RESET_TANK: z.string().optional(),
});

export const publicEnv = publicEnvSchema.parse({
  NEXT_PUBLIC_SOLANA_RPC_URL: process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
  NEXT_PUBLIC_TOKEN_MINT: process.env.NEXT_PUBLIC_TOKEN_MINT,
  NEXT_PUBLIC_TANK_BANK_ADDRESS: process.env.NEXT_PUBLIC_TANK_BANK_ADDRESS,
  NEXT_PUBLIC_MOLTBOOK_OBSERVATORY_URL:
    process.env.NEXT_PUBLIC_MOLTBOOK_OBSERVATORY_URL ??
    "https://www.moltbook.com/m/lobster-observatory",
  NEXT_PUBLIC_SHOW_MOLT_POST: process.env.NEXT_PUBLIC_SHOW_MOLT_POST,
  NEXT_PUBLIC_MOLT_AUTO_ONLY: process.env.NEXT_PUBLIC_MOLT_AUTO_ONLY,
  NEXT_PUBLIC_DEV_OWNER_WALLET: process.env.NEXT_PUBLIC_DEV_OWNER_WALLET,
  NEXT_PUBLIC_SHOW_RESET_TANK: process.env.NEXT_PUBLIC_SHOW_RESET_TANK,
});
