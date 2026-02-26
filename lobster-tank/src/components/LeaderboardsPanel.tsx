"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSyncExternalStore } from "react";
import { getServerSnapshotCommunities, getServerSnapshotLobsters, getTankCommunities, getTankLobsters, subscribeTankLobsters } from "@/lib/tank-lobsters";

/** Points: 1 per shrimp, 10 per lobster kill. Octopus kills not over-weighted (avoid last-hit luck). */
const POINTS_SHRIMP = 1;
const POINTS_LOBSTER_KILL = 10;

type LobsterRow = {
  id: string;
  displayName?: string | null;
  level: number;
  xp: number;
  size: number;
  wins: number;
  losses: number;
  shrimpEaten?: number;
  aquariumId: string;
  deathsFromLobsters?: number;
  deathsFromOctopuses?: number;
  source: "api" | "sim";
  points: number;
};

function computePoints(row: { shrimpEaten?: number; wins: number; xp: number }): number {
  const shrimp = row.shrimpEaten ?? Math.floor(row.xp / 10);
  return shrimp * POINTS_SHRIMP + (row.wins ?? 0) * POINTS_LOBSTER_KILL;
}

/** Build leaderboard rows from live sim lobsters (ranked by points, then shrimp, then kills, then level). */
function simLobstersToRows(lobsters: ReturnType<typeof getTankLobsters>, aquariumId: string): LobsterRow[] {
  return lobsters
    .map((l) => {
      const shrimpEaten = l.shrimpEaten ?? Math.floor(l.xp / 10);
      const wins = l.lobsterKills ?? 0;
      return {
        id: l.id,
        displayName: l.displayName ?? null,
        level: l.level,
        xp: l.xp,
        size: l.size,
        wins,
        losses: l.losses ?? 0,
        shrimpEaten,
        aquariumId,
        deathsFromLobsters: l.deathsFromLobsters,
        deathsFromOctopuses: l.deathsFromOctopuses,
        source: "sim" as const,
        points: shrimpEaten * POINTS_SHRIMP + wins * POINTS_LOBSTER_KILL,
      };
    })
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if ((b.shrimpEaten ?? 0) !== (a.shrimpEaten ?? 0)) return (b.shrimpEaten ?? 0) - (a.shrimpEaten ?? 0);
      if (b.wins !== a.wins) return b.wins - a.wins;
      return b.level - a.level;
    });
}

export const LeaderboardsPanel = () => {
  const searchParams = useSearchParams();
  const aquariumId = searchParams.get("aquarium") ?? "global";
  const [apiRows, setApiRows] = useState<LobsterRow[]>([]);
  const [loading, setLoading] = useState(true);

  const tankLobsters = useSyncExternalStore(subscribeTankLobsters, getTankLobsters, getServerSnapshotLobsters);
  const tankCommunities = useSyncExternalStore(subscribeTankLobsters, getTankCommunities, getServerSnapshotCommunities);

  const label = useMemo(
    () => (aquariumId === "global" ? "Global" : aquariumId),
    [aquariumId],
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/leaderboards?aquarium=${aquariumId}`);
        const data = await response.json();
        if (!cancelled && response.ok && Array.isArray(data.lobsters)) {
          setApiRows(
            data.lobsters.map((l: { id: string; displayName?: string | null; level: number; xp: number; size: number; wins: number; losses: number; shrimpEaten?: number }) => {
              const shrimpEaten = l.shrimpEaten ?? Math.floor(l.xp / 10);
              const wins = l.wins ?? 0;
              return {
                id: l.id,
                displayName: l.displayName ?? null,
                level: l.level,
                xp: l.xp,
                size: l.size,
                wins,
                losses: l.losses ?? 0,
                shrimpEaten,
                aquariumId,
                source: "api" as const,
                points: shrimpEaten * POINTS_SHRIMP + wins * POINTS_LOBSTER_KILL,
              };
            }).sort((a: LobsterRow, b: LobsterRow) => b.points - a.points),
          );
        } else if (!cancelled) {
          setApiRows([]);
        }
      } catch {
        if (!cancelled) setApiRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [aquariumId]);

  const rows: LobsterRow[] = useMemo(() => {
    const list = apiRows.length > 0 ? apiRows : simLobstersToRows(tankLobsters, aquariumId);
    return list.map((r) => ({ ...r, points: r.points ?? computePoints(r) })).sort((a, b) => b.points - a.points);
  }, [apiRows, tankLobsters, aquariumId]);

  type CommunityStatsRow = { id: string; name: string; color: string; members: number; kills: number; deaths: number; shrimp: number };
  const communityStats: CommunityStatsRow[] = useMemo(() => {
    const byComm = new Map<string, { name: string; color: string; kills: number; deaths: number; shrimp: number }>();
    for (const comm of tankCommunities) {
      byComm.set(comm.id, { name: comm.name, color: comm.color, kills: 0, deaths: 0, shrimp: 0 });
    }
    for (const l of tankLobsters) {
      if (!l.communityId) continue;
      const agg = byComm.get(l.communityId);
      if (!agg) continue;
      agg.kills += l.lobsterKills ?? 0;
      agg.deaths += l.losses ?? 0;
      agg.shrimp += l.shrimpEaten ?? Math.floor(l.xp / 10);
    }
    return tankCommunities
      .map((comm) => {
        const agg = byComm.get(comm.id);
        const members = tankLobsters.filter((l) => l.communityId === comm.id).length;
        return {
          id: comm.id,
          name: comm.name,
          color: comm.color,
          members,
          kills: agg?.kills ?? 0,
          deaths: agg?.deaths ?? 0,
          shrimp: agg?.shrimp ?? 0,
        };
      })
      .sort((a, b) => {
        if (b.kills !== a.kills) return b.kills - a.kills;
        if (b.shrimp !== a.shrimp) return b.shrimp - a.shrimp;
        return b.members - a.members;
      });
  }, [tankCommunities, tankLobsters]);

  return (
    <section className="mt-8 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
            Leaderboards
          </p>
          <h3 className="text-2xl font-semibold text-slate-900">
            {label} Rankings
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Shrimp eaten, lobster kills, and deaths are lifetime stats for this tank.
            {rows.length > 0 && rows[0]?.source === "sim" && (
              <span className="ml-1 text-teal-600">(Live sim rankings)</span>
            )}
          </p>
        </div>
        {loading ? (
          <span className="text-xs text-slate-500">Loading…</span>
        ) : (
          <span className="text-xs text-slate-500">{rows.length} lobsters</span>
        )}
      </div>

      <p className="mt-1 text-xs text-slate-500">
        Points = {POINTS_SHRIMP} per shrimp + {POINTS_LOBSTER_KILL} per lobster kill. Sorted by points.
      </p>
      <div className="mt-4 min-h-0 max-h-[70vh] overflow-auto overflow-x-auto" style={{ WebkitOverflowScrolling: "touch" }}>
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
            <tr className="text-left text-xs uppercase tracking-[0.18em] text-slate-400">
              <th className="py-2">Rank</th>
              <th className="py-2">Lobster</th>
              <th className="py-2">Level</th>
              <th className="py-2">Shrimp</th>
              <th className="py-2">Lobster kills</th>
              <th className="py-2">Deaths</th>
              <th className="py-2">Points</th>
            </tr>
          </thead>
          <tbody className="text-slate-700">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-4 text-slate-500">
                  No leaderboard data yet.
                </td>
              </tr>
            ) : (
              rows.map((row, index) => {
                const rankStyle =
                  index === 0
                    ? "bg-amber-50/80 border-l-2 border-amber-400"
                    : index === 1
                      ? "bg-slate-100/80 border-l-2 border-slate-400"
                      : index === 2
                        ? "bg-orange-50/70 border-l-2 border-orange-300"
                        : index % 2 === 1
                          ? "bg-slate-50/50"
                          : "";
                return (
                  <tr key={row.id} className={`border-t border-slate-100 ${rankStyle}`}>
                    <td className="py-2 font-medium">
                      {index < 3 ? (
                        <span className={index === 0 ? "text-amber-700" : index === 1 ? "text-slate-600" : "text-orange-700"}>
                          #{index + 1}
                        </span>
                      ) : (
                        `#${index + 1}`
                      )}
                    </td>
                    <td className="py-2 font-medium text-slate-900">{row.displayName ?? row.id}</td>
                    <td className="py-2">{row.level}</td>
                    <td className="py-2">{row.shrimpEaten ?? Math.floor(row.xp / 10)}</td>
                    <td className="py-2">{row.wins}</td>
                    <td className="py-2">
                      {row.deathsFromLobsters != null || row.deathsFromOctopuses != null
                        ? `${row.losses} (${row.deathsFromLobsters ?? 0} lobster, ${row.deathsFromOctopuses ?? 0} octopus)`
                        : row.losses}
                    </td>
                    <td className="py-2 font-medium tabular-nums">{row.points}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {communityStats.length > 0 ? (
        <div className="mt-8">
          <h4 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
            Community Stats
          </h4>
          <p className="mt-1 text-xs text-slate-500">
            Aggregated kills, deaths, shrimp eaten, and member count per community.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-[0.18em] text-slate-400">
                  <th className="py-2">Community</th>
                  <th className="py-2">Members</th>
                  <th className="py-2">Kills</th>
                  <th className="py-2">Deaths</th>
                  <th className="py-2">Shrimp</th>
                </tr>
              </thead>
              <tbody className="text-slate-700">
                {communityStats.map((row, index) => (
                  <tr
                    key={row.id}
                    className={`border-t border-slate-100 ${index % 2 === 1 ? "bg-slate-50/50" : ""}`}
                  >
                    <td className="py-2">
                      <span
                        className="mr-2 inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: row.color }}
                      />
                      <span className="font-medium text-slate-900">{row.name}</span>
                    </td>
                    <td className="py-2">{row.members}</td>
                    <td className="py-2">{row.kills}</td>
                    <td className="py-2">{row.deaths}</td>
                    <td className="py-2">{row.shrimp}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
};
