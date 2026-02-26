import { NextResponse } from "next/server";
import { env } from "@/lib/env";

const SUMMARY_WINDOW_MS = 30 * 60 * 1000;

/**
 * GET /api/cron/auto-molt
 * Call from a 30-minute cron job (e.g. Vercel Cron) to post the narrator summary to Molt.
 * Requires Authorization: Bearer <CRON_SECRET> or x-cron-secret header when CRON_SECRET is set.
 */
export async function GET(request: Request) {
  if (env.CRON_SECRET) {
    const secret =
      request.headers.get("x-cron-secret") ??
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (secret !== env.CRON_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const base =
    process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const url = `${base}/api/tank-events/summary?post=1&scope=last&since=${SUMMARY_WINDOW_MS}`;
  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (env.CRON_SECRET) {
    headers["x-cron-secret"] = env.CRON_SECRET;
  }
  try {
    const res = await fetch(url, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: data.error ?? "Summary request failed", status: res.status },
        { status: res.status >= 500 ? 502 : 200 },
      );
    }
    return NextResponse.json({
      ok: true,
      posted: data.posted ?? false,
      eventCount: data.eventCount ?? 0,
      lastPostAt: data.lastPostAt,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Request failed" },
      { status: 502 },
    );
  }
}
