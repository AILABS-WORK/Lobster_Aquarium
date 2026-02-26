import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { getTankEventsSince } from "@/lib/db-pg";
import { renderNarration } from "@/narration/templates";
import { getLastPostAt } from "@/lib/moltbook";
import {
  analyzeForHistorian,
  buildHistorianUserPrompt,
  filterNarrativeEvents,
  HISTORIAN_SYSTEM_PROMPT,
} from "@/lib/historian-narrative";

const SUMMARY_WINDOW_MS = 30 * 60 * 1000;

type TankEventForSummary = {
  id: string;
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
};

/**
 * POST /api/narrator/ai-summary
 * Fetches recent tank events and top lobsters (same as GET /api/tank-events/summary),
 * builds a structured prompt, and calls OpenAI GPT to return 2–3 paragraphs of
 * story-like prose. Requires GPT_API_KEY in .env.
 */
export async function POST(request: Request) {
  const apiKey = process.env.GPT_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "GPT_API_KEY is not set. Add it to .env to use AI story summary." },
      { status: 400 },
    );
  }

  const model = (process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini").replace(/^["']|["']$/g, "");

  let since: Date;
  let scope = "last";
  try {
    const body = await request.json().catch(() => ({}));
    scope = (body.scope as string) ?? "last";
    const sinceMs = Math.min(
      SUMMARY_WINDOW_MS,
      Math.max(60_000, parseInt(String(body.since ?? SUMMARY_WINDOW_MS), 10) || SUMMARY_WINDOW_MS),
    );
    const lastPostAt = getLastPostAt();
    since =
      scope === "all"
        ? new Date(0)
        : scope === "sincePost"
          ? new Date(Math.max(0, lastPostAt))
          : new Date(Date.now() - sinceMs);
  } catch {
    since = new Date(Date.now() - SUMMARY_WINDOW_MS);
  }

  const db = getPrisma();
  let eventsForSummary: TankEventForSummary[] = [];
  let topLobsters: { id: string; level: number; wins?: number; displayName?: string | null }[] = [];
  let communitiesWithMembers: { name: string; id: string; members: string[] }[] = [];

  if (db) {
    try {
      const [events, lobsters, communities] = await Promise.all([
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
    } catch (e) {
      return NextResponse.json(
        { error: "Failed to fetch events from database." },
        { status: 500 },
      );
    }
  } else {
    try {
      const pgEvents = await getTankEventsSince(since);
      eventsForSummary = pgEvents.map((e) => ({
        id: e.id,
        type: e.type,
        createdAt: e.createdAt.getTime(),
        payload: e.payload,
      }));
    } catch {
      // no events without DB
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
      const isRateLimit = res.status === 429 || String(data.error?.code).includes("rate");
      return NextResponse.json(
        { error: isRateLimit ? "Rate limit exceeded. Try again in a moment." : msg },
        { status: res.status === 429 ? 429 : 500 },
      );
    }

    const content = data.choices?.[0]?.message?.content?.trim() ?? "";
    const title = "Observatory Story";

    return NextResponse.json({
      title,
      content: content || "No story could be generated for this window.",
      eventCount: eventsForSummary.length,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Request to OpenAI failed." },
      { status: 500 },
    );
  }
}
