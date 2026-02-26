import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { getTankEventsSince } from "@/lib/db-pg";
import { renderNarration } from "@/narration/templates";
import {
  analyzeForHistorian,
  buildHistorianUserPrompt,
  filterNarrativeEvents,
  HISTORIAN_SYSTEM_PROMPT,
} from "@/lib/historian-narrative";

const POSTS_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

type TankEventForSummary = {
  id: string;
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
};

/**
 * GET /api/narrator/posts
 * Returns stored AI story posts (10-min summaries), newest first.
 */
export async function GET() {
  const db = getPrisma();
  if (!db) {
    return NextResponse.json({ posts: [] }, { status: 200 });
  }
  try {
    const rows = await db.narratorPost.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return NextResponse.json({
      posts: rows.map((p) => ({
        id: p.id,
        title: p.title,
        content: p.content,
        createdAt: new Date(p.createdAt).getTime(),
      })),
    });
  } catch {
    return NextResponse.json({ posts: [] }, { status: 200 });
  }
}

/**
 * POST /api/narrator/posts
 * Generates an AI story summary for the last 10 minutes and stores it.
 * Requires GPT_API_KEY and database.
 */
export async function POST() {
  const apiKey = process.env.GPT_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "GPT_API_KEY is not set. Add it to .env to use AI story posts." },
      { status: 400 },
    );
  }
  const db = getPrisma();
  if (!db) {
    return NextResponse.json(
      { error: "Database is required to store posts." },
      { status: 503 },
    );
  }

  const since = new Date(Date.now() - POSTS_WINDOW_MS);
  let eventsForSummary: TankEventForSummary[] = [];
  let topLobsters: { id: string; level: number; wins?: number; displayName?: string | null }[] = [];
  let communitiesWithMembers: { name: string; id: string; members: string[] }[] = [];

  try {
    const [events, lobsters, communities] = await Promise.all([
      db.tankEvent.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: "asc" },
      }),
      db.lobster.findMany({
        orderBy: [{ level: "desc" }, { wins: "desc" }],
        take: 15,
        select: { id: true, level: true, wins: true, displayName: true, communityId: true },
      }),
      db.community.findMany({
        include: { lobsters: { select: { id: true, displayName: true } } },
      }),
    ]);
    eventsForSummary = events.map((e) => ({
      id: e.id,
      type: e.type,
      createdAt: e.createdAt.getTime(),
      payload: (e.payload as Record<string, unknown>) ?? {},
    }));
    topLobsters = lobsters.map((l) => ({
      id: l.id,
      level: l.level,
      wins: l.wins,
      displayName: l.displayName,
    }));
    communitiesWithMembers = communities.map((c) => ({
      name: c.name,
      id: c.id,
      members: c.lobsters.map((l) => (l.displayName ?? l.id).toString()),
    }));
  } catch {
    try {
      const pgEvents = await getTankEventsSince(since);
      eventsForSummary = pgEvents.map((e) => ({
        id: e.id,
        type: e.type,
        createdAt: e.createdAt.getTime(),
        payload: e.payload,
      }));
    } catch {
      // leave eventsForSummary as []
    }
    if (db) {
      try {
        const [lobsters, communities] = await Promise.all([
          db.lobster.findMany({
            orderBy: [{ level: "desc" }, { wins: "desc" }],
            take: 15,
            select: { id: true, level: true, wins: true, displayName: true },
          }),
          db.community.findMany({
            include: { lobsters: { select: { id: true, displayName: true } } },
          }),
        ]);
        topLobsters = lobsters.map((l) => ({ id: l.id, level: l.level, wins: l.wins, displayName: l.displayName }));
        communitiesWithMembers = communities.map((c) => ({
          name: c.name,
          id: c.id,
          members: c.lobsters.map((l) => (l.displayName ?? l.id).toString()),
        }));
      } catch {
        // keep defaults
      }
    }
  }

  const narrativeEvents = filterNarrativeEvents(eventsForSummary);
  const analysis = analyzeForHistorian(
    narrativeEvents,
    topLobsters,
    communitiesWithMembers,
    (e) => renderNarration(e as Parameters<typeof renderNarration>[0]),
  );
  const userPrompt = buildHistorianUserPrompt(analysis);
  const systemPrompt = HISTORIAN_SYSTEM_PROMPT;

  const model = (process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini").replace(/^["']|["']$/g, "");

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 1400,
        temperature: 0.7,
      }),
    });

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string; code?: string };
    };

    if (!res.ok) {
      const msg = data.error?.message ?? `HTTP ${res.status}`;
      return NextResponse.json(
        { error: res.status === 429 ? "Rate limit exceeded. Try again later." : msg },
        { status: res.status === 429 ? 429 : 500 },
      );
    }

    const content = data.choices?.[0]?.message?.content?.trim() ?? "";
    const title = "Observatory Story";

    const post = await db.narratorPost.create({
      data: {
        title,
        content: content || "No story could be generated for this window.",
      },
    });

    return NextResponse.json({
      id: post.id,
      title: post.title,
      content: post.content,
      createdAt: new Date(post.createdAt).getTime(),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Request to OpenAI failed." },
      { status: 500 },
    );
  }
}
