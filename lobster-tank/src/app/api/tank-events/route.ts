import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { insertTankEvents } from "@/lib/db-pg";
import { applyOneEventToLobsters } from "@/lib/apply-tank-event-updates";
import { postFromTankEvents } from "@/lib/moltbook";
import { renderNarration } from "@/narration/templates";

const bodySchema = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      createdAt: z.number(),
      payload: z.record(z.string(), z.unknown()),
    }),
  ),
});

export async function POST(request: Request) {
  const db = getPrisma();
  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  if (!env.DATABASE_URL) {
    return NextResponse.json({ ok: true, skipped: true }, { status: 200 });
  }

  if (!db) {
    const inserted = await insertTankEvents(
      parsed.data.events.map((e) => ({
        id: e.id,
        type: e.type,
        payload: e.payload,
        createdAt: new Date(e.createdAt),
      })),
    );
    return NextResponse.json({ ok: true, viaPg: inserted > 0 }, { status: 200 });
  }

  try {
    await db.$transaction(async (tx) => {
      const eventIds = parsed.data.events.map((e) => e.id);
      const existingRows = await tx.tankEvent.findMany({
        where: { id: { in: eventIds } },
        select: { id: true },
      });
      const existingIds = new Set(existingRows.map((r) => r.id));

      await tx.tankEvent.createMany({
        data: parsed.data.events.map((event) => ({
          id: event.id,
          type: event.type,
          payload: event.payload as Prisma.InputJsonValue,
          createdAt: new Date(event.createdAt),
        })),
        skipDuplicates: true,
      });

      for (const event of parsed.data.events) {
        if (existingIds.has(event.id)) continue;
        await applyOneEventToLobsters(tx, event);
      }
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
      },
      { status: 200 },
    );
  }

  // Only post to Moltbook when explicitly enabled (skip during testing).
  // Use last 30 min of events from DB for the summary so the post reflects the full window.
  if (
    env.MOLTBOOK_POSTING_ENABLED === "true" &&
    env.MOLTBOOK_API_KEY &&
    env.MOLTBOOK_SUBMOLT
  ) {
    let topLobsters: { id: string; level: number; wins: number }[] = [];
    let recentEvents: { id: string; type: string; createdAt: number; payload: Record<string, unknown> }[] = [];
    try {
      const since = new Date(Date.now() - 30 * 60 * 1000);
      [topLobsters, recentEvents] = await Promise.all([
        db.lobster.findMany({
          orderBy: { level: "desc" },
          take: 5,
          select: { id: true, level: true, wins: true },
        }),
        db.tankEvent.findMany({
          where: { createdAt: { gte: since } },
          orderBy: { createdAt: "asc" },
        }).then((rows) =>
          rows.map((e) => ({
            id: e.id,
            type: e.type,
            createdAt: e.createdAt.getTime(),
            payload: (e.payload as Record<string, unknown>) ?? {},
          })),
        ),
      ]);
    } catch {
      // fallback to this request's events if DB read fails
      recentEvents = parsed.data.events;
    }
    void postFromTankEvents(
      env.MOLTBOOK_API_KEY,
      env.MOLTBOOK_SUBMOLT,
      recentEvents.length > 0 ? recentEvents : parsed.data.events,
      (e) => renderNarration(e as Parameters<typeof renderNarration>[0]),
      topLobsters.map((l) => ({ id: l.id, level: l.level, wins: l.wins })),
    );
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
