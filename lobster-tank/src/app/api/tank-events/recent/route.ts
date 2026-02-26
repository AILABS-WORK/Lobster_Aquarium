import { NextResponse } from "next/server";
import { getServerTankEventsSince, getServerTankState } from "@/lib/server-sim";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Returns recent tank events for the given ?aquarium= (default global). */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const aquariumId = url.searchParams.get("aquarium") ?? "global";
  try {
    await getServerTankState(aquariumId);
    const sinceParam = url.searchParams.get("since");
    const since = sinceParam ? Math.max(0, parseInt(sinceParam, 10) || 0) : 0;
    const events = getServerTankEventsSince(since, aquariumId);
    return NextResponse.json({ events }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch {
    return NextResponse.json({ events: [] }, { status: 200 });
  }
}
