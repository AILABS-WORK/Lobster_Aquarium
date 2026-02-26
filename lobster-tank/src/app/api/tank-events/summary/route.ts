import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { getTankEventsSince } from "@/lib/db-pg";
import { buildNarratorSummary, canPostNow, createPost, getLastPostAt, setLastPostAt } from "@/lib/moltbook";
import { renderNarration } from "@/narration/templates";

const SUMMARY_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

export type TankEventForSummary = {
  id: string;
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
};

/**
 * GET /api/tank-events/summary
 * Fetches recent tank events from the DB (last 30 min), builds the narrator script,
 * and returns it so you can see what would be posted. Optional ?post=1 to actually post
 * if 30 min have passed.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const db = getPrisma();

  const notConfiguredPayload = () => {
    const help =
      "To enable narrator scripts and the feed:\n\n" +
      "1. Set DATABASE_URL in .env (see .env.example).\n" +
      "2. Use PostgreSQL (e.g. Supabase).\n" +
      "3. Run from the lobster-tank folder: cd lobster-tank && npx prisma migrate deploy\n" +
      "4. Restart the app.\n\n" +
      "Until then, no events are stored and Generate will show this message.\n\n" +
      "Once the database is connected: events and your claimed lobster are saved. Lobster list and positions reset on full page reload.";
    return NextResponse.json({
      title: "Database not configured",
      content: help,
      eventCount: 0,
      lastPostAt: 0,
      canPost: false,
      error: "Database not configured",
      scope: searchParams.get("scope") ?? "last",
    });
  };

  const shouldPost = searchParams.get("post") === "1";
  if (shouldPost && env.CRON_SECRET) {
    const secret = request.headers.get("x-cron-secret") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (secret !== env.CRON_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  const scope = searchParams.get("scope") ?? "last";
  const sinceMs = Math.min(
    SUMMARY_WINDOW_MS,
    Math.max(60_000, parseInt(searchParams.get("since") ?? String(SUMMARY_WINDOW_MS), 10) || SUMMARY_WINDOW_MS),
  );
  const lastPostAt = getLastPostAt();
  const since = scope === "all"
    ? new Date(0)
    : scope === "sincePost"
      ? new Date(Math.max(0, lastPostAt))
      : new Date(Date.now() - sinceMs);

  if (!env.DATABASE_URL) {
    if (process.env.NODE_ENV === "development") {
      console.warn("[db] Summary: DATABASE_URL not set in env.");
    }
    return notConfiguredPayload();
  }

  if (!db) {
    try {
      const pgEvents = await getTankEventsSince(since);
      const eventsForSummary: TankEventForSummary[] = pgEvents.map((e) => ({
        id: e.id,
        type: e.type,
        createdAt: e.createdAt.getTime(),
        payload: e.payload,
      }));
      const { title, content } = buildNarratorSummary(
        eventsForSummary,
        (e) => renderNarration(e as Parameters<typeof renderNarration>[0]),
        [],
      );
      const canPost = canPostNow();
      return NextResponse.json({
        title,
        content,
        posted: false,
        eventCount: pgEvents.length,
        lastPostAt,
        canPost,
        windowMs: sinceMs,
        scope,
      });
    } catch (e) {
      if (process.env.NODE_ENV === "development") {
        console.warn("[db] Summary: DATABASE_URL set, Prisma null, pg fallback failed:", (e as Error)?.message ?? e);
      }
      return notConfiguredPayload();
    }
  }

  try {
    await db.$queryRaw`SELECT 1`;
  } catch (e) {
    if (process.env.NODE_ENV === "development") {
      console.warn("[db] Summary: DATABASE_URL set but SELECT 1 failed:", (e as Error)?.message ?? e);
    }
    return notConfiguredPayload();
  }

  try {
    const [events, topLobsters] = await Promise.all([
      db.tankEvent.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: "asc" },
      }),
      db.lobster.findMany({
        orderBy: [{ level: "desc" }, { wins: "desc" }],
        take: 5,
        select: { id: true, level: true, wins: true },
      }),
    ]);

    const eventsForSummary: TankEventForSummary[] = events.map((e) => ({
      id: e.id,
      type: e.type,
      createdAt: e.createdAt.getTime(),
      payload: (e.payload as Record<string, unknown>) ?? {},
    }));

    const { title, content } = buildNarratorSummary(
      eventsForSummary,
      (e) => renderNarration(e as Parameters<typeof renderNarration>[0]),
      topLobsters.map((l) => ({ id: l.id, level: l.level, wins: l.wins })),
    );

    const canPost = canPostNow();

    if (shouldPost && canPost && env.MOLTBOOK_POSTING_ENABLED === "true" && env.MOLTBOOK_API_KEY && env.MOLTBOOK_SUBMOLT) {
      const result = await createPost(
        env.MOLTBOOK_API_KEY,
        env.MOLTBOOK_SUBMOLT,
        title,
        content,
      );
      if (result.success) {
        setLastPostAt(Date.now());
        return NextResponse.json({
          title,
          content,
          posted: true,
          eventCount: events.length,
          lastPostAt: Date.now(),
          windowMs: sinceMs,
          scope,
        });
      }
      return NextResponse.json({
        title,
        content,
        posted: false,
        error: result.error,
        eventCount: events.length,
        lastPostAt,
        canPost,
        windowMs: sinceMs,
        scope,
      });
    }

    return NextResponse.json({
      title,
      content,
      posted: false,
      eventCount: events.length,
      lastPostAt,
      canPost,
      windowMs: sinceMs,
      scope,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to build summary" },
      { status: 500 },
    );
  }
}
