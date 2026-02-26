"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  getServerSnapshotCommunities,
  getServerSnapshotLobsters,
  getTankCommunities,
  getTankLobsters,
  subscribeTankLobsters,
} from "@/lib/tank-lobsters";

type Community = {
  id: string;
  name: string;
  color: string;
  description?: string;
  memberCount?: number;
};

type CommunityStatsRow = {
  id: string;
  name: string;
  color: string;
  members: number;
  kills: number;
  deaths: number;
  deathsFromLobsters: number;
  deathsFromOctopuses: number;
  shrimp: number;
};

type MeLobster = {
  id: string;
  communityId?: string | null;
  community?: { id: string; name: string; color: string } | null;
};

export const CommunityPanel = () => {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#7dd3fc");
  const [status, setStatus] = useState<string | null>(null);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasLobster, setHasLobster] = useState<boolean | null>(null);
  const [myLobster, setMyLobster] = useState<MeLobster | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameSubmitting, setRenameSubmitting] = useState(false);
  const [selectedCommunityId, setSelectedCommunityId] = useState<string | null>(null);
  const { publicKey } = useWallet();
  const tankLobsters = useSyncExternalStore(subscribeTankLobsters, getTankLobsters, getServerSnapshotLobsters);
  const tankCommunities = useSyncExternalStore(subscribeTankLobsters, getTankCommunities, getServerSnapshotCommunities);
  const headers = useMemo(() => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (publicKey) h["x-wallet-address"] = publicKey.toBase58();
    return h;
  }, [publicKey]);

  useEffect(() => {
    if (!publicKey) {
      setHasLobster(null);
      setMyLobster(null);
      return;
    }
    let cancelled = false;
    fetch("/api/me", { headers: { "x-wallet-address": publicKey.toBase58() } })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          setHasLobster(!!data.lobster);
          setMyLobster(data.lobster ?? null);
          if (data.lobster?.community) {
            setRenameName(data.lobster.community.name);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHasLobster(false);
          setMyLobster(null);
        }
      });
    return () => { cancelled = true; };
  }, [publicKey]);

  const loadCommunities = async () => {
    try {
      const response = await fetch("/api/communities");
      const data = await response.json();
      if (response.ok && Array.isArray(data.communities)) {
        setCommunities(data.communities);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCommunities();
  }, []);

  const handleCreate = async () => {
    setStatus(null);
    try {
      const response = await fetch("/api/communities/create", {
        method: "POST",
        headers,
        body: JSON.stringify({ name, color }),
      });
      const data = await response.json();
      if (!response.ok) {
        setStatus(data.error ?? "Create failed.");
        return;
      }
      setStatus(`Created ${data.community.name}.`);
      void loadCommunities();
    } catch {
      setStatus("Create failed.");
    }
  };

  const handleJoin = async (communityId: string) => {
    setStatus(null);
    try {
      const response = await fetch("/api/communities/join", {
        method: "POST",
        headers,
        body: JSON.stringify({ communityId }),
      });
      const data = await response.json();
      if (!response.ok) {
        setStatus(data.error ?? "Join failed.");
        return;
      }
      setStatus("Joined community.");
      void loadCommunities();
    } catch {
      setStatus("Join failed.");
    }
  };

  const handleRename = async () => {
    if (!myLobster?.communityId || !renameName.trim()) return;
    setStatus(null);
    setRenameSubmitting(true);
    try {
      const response = await fetch(`/api/communities/${encodeURIComponent(myLobster.communityId)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: renameName.trim() }),
      });
      const data = await response.json();
      if (!response.ok) {
        setStatus(data.error ?? "Rename failed.");
        return;
      }
      setStatus(`Renamed to ${renameName}.`);
      void loadCommunities();
    } catch {
      setStatus("Rename failed.");
    } finally {
      setRenameSubmitting(false);
    }
  };

  const handleLeave = async () => {
    setStatus(null);
    try {
      const response = await fetch("/api/communities/leave", {
        method: "POST",
        headers,
      });
      const data = await response.json();
      if (!response.ok) {
        setStatus(data.error ?? "Leave failed.");
        return;
      }
      setStatus("Left community.");
      void loadCommunities();
    } catch {
      setStatus("Leave failed.");
    }
  };

  const demoCommunities: Community[] = [
    { id: "community-1", name: "Pearl Ring", color: "#22d3ee", memberCount: 12 },
    { id: "community-2", name: "Deep Current", color: "#38bdf8", memberCount: 7 },
  ];

  const communityStats: CommunityStatsRow[] = useMemo(() => {
    const byComm = new Map<string, { name: string; color: string; kills: number; deaths: number; deathsFromLobsters: number; deathsFromOctopuses: number; shrimp: number }>();
    for (const comm of tankCommunities) {
      byComm.set(comm.id, { name: comm.name, color: comm.color, kills: 0, deaths: 0, deathsFromLobsters: 0, deathsFromOctopuses: 0, shrimp: 0 });
    }
    for (const l of tankLobsters) {
      if (!l.communityId) continue;
      const agg = byComm.get(l.communityId);
      if (!agg) continue;
      agg.kills += l.lobsterKills ?? 0;
      agg.deaths += l.losses ?? 0;
      agg.deathsFromLobsters += l.deathsFromLobsters ?? 0;
      agg.deathsFromOctopuses += l.deathsFromOctopuses ?? 0;
      agg.shrimp += l.shrimpEaten ?? Math.floor(l.xp / 10);
    }
    return tankCommunities.map((comm) => {
      const agg = byComm.get(comm.id);
      const members = tankLobsters.filter((l) => l.communityId === comm.id).length;
      return {
        id: comm.id,
        name: comm.name,
        color: comm.color,
        members,
        kills: agg?.kills ?? 0,
        deaths: agg?.deaths ?? 0,
        deathsFromLobsters: agg?.deathsFromLobsters ?? 0,
        deathsFromOctopuses: agg?.deathsFromOctopuses ?? 0,
        shrimp: agg?.shrimp ?? 0,
      };
    });
  }, [tankCommunities, tankLobsters]);

  const list = useMemo(() => {
    const fromApi = communities.length > 0 ? communities : demoCommunities;
    const merged = new Map<string, Community & { memberCount: number }>();
    for (const c of fromApi) {
      const stats = communityStats.find((s) => s.id === c.id);
      merged.set(c.id, { ...c, memberCount: stats?.members ?? c.memberCount ?? 0 });
    }
    for (const s of communityStats) {
      if (!merged.has(s.id)) merged.set(s.id, { id: s.id, name: s.name, color: s.color, memberCount: s.members });
    }
    return Array.from(merged.values());
  }, [communities, communityStats]);

  const [searchFilter, setSearchFilter] = useState("");

  const myCommunityStats: CommunityStatsRow | null = useMemo(() => {
    if (!myLobster?.communityId) return null;
    return communityStats.find((s) => s.id === myLobster.communityId) ?? null;
  }, [myLobster, communityStats]);

  const selectedDetail: CommunityStatsRow | null = selectedCommunityId
    ? communityStats.find((s) => s.id === selectedCommunityId) ??
      (() => {
        const fromList = list.find((c) => c.id === selectedCommunityId);
        if (!fromList) return null;
        const members = tankLobsters.filter((l) => l.communityId === selectedCommunityId).length;
        return {
          id: fromList.id,
          name: fromList.name,
          color: fromList.color,
          members: fromList.memberCount ?? members,
          kills: 0,
          deaths: 0,
          deathsFromLobsters: 0,
          deathsFromOctopuses: 0,
          shrimp: 0,
        };
      })()
    : null;
  const selectedMembers = selectedCommunityId ? tankLobsters.filter((l) => l.communityId === selectedCommunityId) : [];

  return (
    <div className="space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
          Community
        </p>
        <h3 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
          Gang Directory
        </h3>
        <p className="mt-3 text-sm text-slate-600 leading-relaxed">
          Communities form when lobsters befriend each other. Join one to share strength and compete as a group. View details to see member count, shrimp eaten, and kills.
        </p>
      </div>

      {myCommunityStats ? (
        <div className="rounded-xl border-2 border-teal-200 bg-teal-50/40 p-4 space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-teal-600">Your community</p>
          <h4 className="text-lg font-semibold" style={{ color: myCommunityStats.color }}>
            {myCommunityStats.name}
          </h4>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
            <span className="text-slate-500">Members</span>
            <span className="font-medium text-slate-900">{myCommunityStats.members}</span>
            <span className="text-slate-500">Shrimp</span>
            <span className="font-medium text-slate-900">{myCommunityStats.shrimp}</span>
            <span className="text-slate-500">Kills</span>
            <span className="font-medium text-slate-900">{myCommunityStats.kills}</span>
            <span className="text-slate-500">Deaths</span>
            <span className="font-medium text-slate-900">{myCommunityStats.deaths}</span>
          </div>
        </div>
      ) : null}

      <div className="space-y-4">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-500">
          Join a community
        </p>
        <input
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
          placeholder="Search communities..."
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400"
        />
        {hasLobster === false && publicKey ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50/50 p-3 text-xs text-amber-800">
            You need to own a lobster to join a community. Claim one in the Tank view (hold 10,000 tokens, then Connect and save).
          </p>
        ) : null}
        {loading ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3 text-xs text-slate-600">
            Loading communities...
          </div>
        ) : null}
        {list.filter((c) => c.name.toLowerCase().includes(searchFilter.toLowerCase())).map((community) => {
          const stats = communityStats.find((s) => s.id === community.id);
          const memberCount = stats?.members ?? community.memberCount ?? 0;
          const shrimp = stats?.shrimp ?? 0;
          const kills = stats?.kills ?? 0;
          return (
          <div
            key={community.id}
            className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/50 p-4"
          >
            <button
              type="button"
              onClick={() => setSelectedCommunityId(selectedCommunityId === community.id ? null : community.id)}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: community.color }}
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-700">{community.name}</p>
                <p className="text-xs text-slate-500">
                  {memberCount} member(s) · {kills} lobster kills · {shrimp} shrimp
                </p>
              </div>
            </button>
            <button
              onClick={() => handleJoin(community.id)}
              disabled={hasLobster === false}
              title={hasLobster === false ? "You need to own a lobster to join." : undefined}
              className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Join
            </button>
          </div>
          );
        })}
      </div>

      {selectedDetail ? (
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h4 className="text-lg font-semibold" style={{ color: selectedDetail.color }}>
              {selectedDetail.name}
            </h4>
            <button
              type="button"
              onClick={() => setSelectedCommunityId(null)}
              className="rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              Back to list
            </button>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
            <span className="text-slate-500">Members</span>
            <span className="font-medium text-slate-900">{selectedDetail.members}</span>
            <span className="text-slate-500">Shrimp eaten</span>
            <span className="font-medium text-slate-900">{selectedDetail.shrimp}</span>
            <span className="text-slate-500">Lobster kills</span>
            <span className="font-medium text-slate-900">{selectedDetail.kills}</span>
            <span className="text-slate-500">Deaths</span>
            <span className="font-medium text-slate-900">{selectedDetail.deaths}</span>
            <span className="text-slate-500">Deaths (from lobsters)</span>
            <span className="font-medium text-slate-900">{selectedDetail.deathsFromLobsters}</span>
            <span className="text-slate-500">Deaths (from octopus)</span>
            <span className="font-medium text-slate-900">{selectedDetail.deathsFromOctopuses}</span>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-500">Members</p>
            <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
              {selectedMembers.length > 0 ? (
                selectedMembers.map((lobster) => (
                  <li key={lobster.id} className="text-xs text-slate-700">
                    {lobster.displayName ?? lobster.id} · Lv.{lobster.level} · {(lobster.shrimpEaten ?? Math.floor(lobster.xp / 10))} shrimp
                  </li>
                ))
              ) : (
                <li className="text-xs text-slate-500">No members in tank view.</li>
              )}
            </ul>
          </div>
        </div>
      ) : null}

      <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/50 p-4">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-500">
          Create your own
        </p>
        <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3">
          <span className="h-8 w-8 shrink-0 rounded-full" style={{ backgroundColor: color }} />
          <span className="text-sm font-medium text-slate-700">{name || "Community name"}</span>
        </div>
        <div className="grid gap-3">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Community name"
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
          />
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500">Color</span>
            <input
              value={color}
              onChange={(event) => setColor(event.target.value)}
              type="color"
              className="h-10 w-20 cursor-pointer rounded-lg border border-slate-200 bg-white p-1"
            />
          </div>
          <button
            onClick={handleCreate}
            className="rounded-full bg-teal-500 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-teal-600"
          >
            Create Community
          </button>
        </div>
      </div>

      {myLobster?.community ? (
        <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/50 p-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-500">
            Rename your community
          </p>
          <p className="text-xs text-slate-600">
            You are in <strong>{myLobster.community.name}</strong>. You can rename it.
          </p>
          <div className="flex gap-2">
            <input
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              placeholder="New name"
              className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
            />
            <button
              onClick={handleRename}
              disabled={renameSubmitting || renameName.trim().length < 2}
              className="rounded-full bg-teal-500 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-teal-600 disabled:opacity-50"
            >
              {renameSubmitting ? "Renaming…" : "Rename"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="border-t border-slate-100 pt-3">
        <button
          onClick={handleLeave}
          className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
        >
          Leave Current Community
        </button>
      </div>

      {status ? (
        <p className="text-xs text-slate-600">{status}</p>
      ) : null}
    </div>
  );
};
