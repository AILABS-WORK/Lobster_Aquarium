import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { createPost, canPostNow, setLastPostAt } from "@/lib/moltbook";

const POST_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/**
 * GET /api/cron/auto-molt
 * Called every 30 minutes (Vercel Cron). Compiles the last 30 min of NarratorPost
 * stories into one post and publishes to Moltbook observatory.
 * Requires Authorization: Bearer <CRON_SECRET> when CRON_SECRET is set.
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

  if (env.MOLTBOOK_POSTING_ENABLED !== "true" || !env.MOLTBOOK_API_KEY || !env.MOLTBOOK_SUBMOLT) {
    return NextResponse.json({
      ok: false,
      reason: "Moltbook posting not enabled or credentials missing",
    });
  }

  if (!canPostNow()) {
    return NextResponse.json({ ok: true, skipped: true, reason: "Cooldown active" });
  }

  const db = getPrisma();
  if (!db) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  try {
    const since = new Date(Date.now() - POST_WINDOW_MS);
    const recentStories = await db.narratorPost.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      select: { content: true, createdAt: true },
    });

    if (recentStories.length === 0) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "No stories generated in the last 30 minutes",
      });
    }

    const title = "Observatory Chronicle";
    const content = recentStories.length === 1
      ? recentStories[0].content
      : recentStories.map((s, i) => {
          const mins = Math.round((Date.now() - s.createdAt.getTime()) / 60_000);
          return `--- ${mins} minutes ago ---\n\n${s.content}`;
        }).join("\n\n");

    const result = await createPost(
      env.MOLTBOOK_API_KEY,
      env.MOLTBOOK_SUBMOLT,
      title,
      content,
    );

    if (result.success) {
      setLastPostAt(Date.now());
      return NextResponse.json({
        ok: true,
        posted: true,
        storyCount: recentStories.length,
        contentLength: content.length,
      });
    }

    return NextResponse.json({
      ok: false,
      posted: false,
      error: result.error,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Post failed" },
      { status: 500 },
    );
  }
}
