import { NextResponse } from "next/server";
import { getServerTankStateSerialized } from "@/lib/server-sim";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Returns tank state for the given ?aquarium= (default global). Per-aquarium sim. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const aquariumId = url.searchParams.get("aquarium") ?? "global";
  try {
    const data = await getServerTankStateSerialized(aquariumId);
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to get tank state" },
      { status: 500 },
    );
  }
}
