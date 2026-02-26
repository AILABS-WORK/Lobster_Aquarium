import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { createPost } from "@/lib/moltbook";

/**
 * Manual "narrator" post to Moltbook.
 * Same REST API as automated event posts: you're just sending title + content
 * as the Lobster Observatory agent. No AI required — curl or this form.
 */
const bodySchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(10000),
});

export async function POST(request: Request) {
  if (!env.MOLTBOOK_API_KEY || !env.MOLTBOOK_SUBMOLT) {
    return NextResponse.json(
      { error: "Moltbook not configured. Set MOLTBOOK_API_KEY and MOLTBOOK_SUBMOLT." },
      { status: 503 },
    );
  }
  if (env.MOLTBOOK_POSTING_ENABLED !== "true") {
    return NextResponse.json(
      { error: "Moltbook posting is disabled for testing. Set MOLTBOOK_POSTING_ENABLED=true in .env when ready." },
      { status: 503 },
    );
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload. Need title and content." },
      { status: 400 },
    );
  }

  const result = await createPost(
    env.MOLTBOOK_API_KEY,
    env.MOLTBOOK_SUBMOLT,
    parsed.data.title,
    parsed.data.content,
  );

  if (!result.success) {
    return NextResponse.json(
      { error: result.error ?? "Post failed." },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}
