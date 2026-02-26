import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { pgPingWithError } from "@/lib/db-pg";

/**
 * GET /api/db-status
 * Returns { configured: boolean, error?: string } so the UI can show "Connected" vs "Not configured" and the real failure reason.
 */
export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ configured: false, error: "env_missing" });
  }
  const db = getPrisma();
  if (db) {
    try {
      await db.$queryRaw`SELECT 1`;
      return NextResponse.json({ configured: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ configured: false, error: "query_failed", detail: msg });
    }
  }
  const { ok, errorDetail } = await pgPingWithError();
  return NextResponse.json({
    configured: ok,
    error: ok ? undefined : "query_failed",
    detail: errorDetail,
  });
}
