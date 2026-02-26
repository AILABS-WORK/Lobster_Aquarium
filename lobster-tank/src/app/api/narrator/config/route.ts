import { NextResponse } from "next/server";
import { env } from "@/lib/env";

/**
 * GET /api/narrator/config
 * Returns whether narrator/Moltbook posting is live or preview-only.
 * Use MOLTBOOK_POSTING_ENABLED=true in .env to go live; false or unset = preview (generate & view only).
 */
export async function GET() {
  const postingEnabled = env.MOLTBOOK_POSTING_ENABLED === "true";
  return NextResponse.json({
    postingEnabled,
    message: postingEnabled
      ? "Posting is live. Posts will go to Moltbook."
      : "Preview mode. Generate and view only. Set MOLTBOOK_POSTING_ENABLED=true in .env to post live.",
  });
}
