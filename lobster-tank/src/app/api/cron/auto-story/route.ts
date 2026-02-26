import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { renderNarration } from "@/narration/templates";
import {
  analyzeForHistorian,
  buildHistorianUserPrompt,
  filterNarrativeEvents,
  HISTORIAN_SYSTEM_PROMPT,
} from "@/lib/historian-narrative";

const STORY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * GET /api/cron/auto-story
 * Called every 10 minutes (Vercel Cron). Generates an AI story from the last 10 min
 * of tank events, includes the previous story as context for continuity, and stores
 * the result as a NarratorPost in the DB.
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

  const apiKey = process.env.GPT_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: "GPT_API_KEY not set" }, { status: 400 });
  }

  const db = getPrisma();
  if (!db) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  const model = (process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini").replace(/^["']|["']$/g, "");
  const since = new Date(Date.now() - STORY_WINDOW_MS);

  try {
    const [events, topLobsters, communities, previousPost] = await Promise.all([
      db.tankEvent.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: "asc" },
      }),
      db.lobster.findMany({
        orderBy: [{ level: "desc" }, { wins: "desc" }],
        take: 15,
        select: { id: true, level: true, wins: true, displayName: true },
      }),
      db.community.findMany({
        include: { lobsters: { select: { id: true, displayName: true } } },
      }),
      db.narratorPost.findFirst({
        orderBy: { createdAt: "desc" },
        select: { content: true, createdAt: true },
      }),
    ]);

    const eventsForSummary = events.map((e) => ({
      id: e.id,
      type: e.type,
      createdAt: e.createdAt.getTime(),
      payload: (e.payload as Record<string, unknown>) ?? {},
    }));

    if (eventsForSummary.length === 0) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "No events in the last 10 minutes",
      });
    }

    const narrativeEvents = filterNarrativeEvents(eventsForSummary);
    const analysis = analyzeForHistorian(
      narrativeEvents,
      topLobsters.map((l) => ({ id: l.id, level: l.level, wins: l.wins, displayName: l.displayName })),
      communities.map((c) => ({
        name: c.name,
        id: c.id,
        members: c.lobsters.map((l) => (l.displayName ?? l.id).toString()),
      })),
      (e) => renderNarration(e as Parameters<typeof renderNarration>[0]),
    );

    const userPrompt = buildHistorianUserPrompt(analysis);

    const previousSummary = previousPost
      ? `\n\n=== PREVIOUS 10-MINUTE STORY (for continuity — reference ongoing arcs, don't repeat) ===\n${previousPost.content.slice(0, 1200)}`
      : "";

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: HISTORIAN_SYSTEM_PROMPT },
          { role: "user", content: userPrompt + previousSummary },
        ],
        max_tokens: 1400,
        temperature: 0.7,
      }),
    });

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };

    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: data.error?.message ?? `HTTP ${res.status}` },
        { status: res.status === 429 ? 429 : 500 },
      );
    }

    const content = data.choices?.[0]?.message?.content?.trim() ?? "";
    if (!content) {
      return NextResponse.json({ ok: true, skipped: true, reason: "Empty AI response" });
    }

    const post = await db.narratorPost.create({
      data: {
        title: "Observatory Chronicle",
        content,
      },
    });

    return NextResponse.json({
      ok: true,
      postId: post.id,
      eventCount: eventsForSummary.length,
      contentLength: content.length,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Story generation failed" },
      { status: 500 },
    );
  }
}
