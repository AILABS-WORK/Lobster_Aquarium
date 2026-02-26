"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTankContext } from "@/contexts/TankContext";
import { getTankEvents, hydrateTankEvents, subscribeTankEvents } from "@/lib/tank-events";
import {
  getServerSnapshotCommunities,
  getServerSnapshotLobsters,
  getTankCommunities,
  getTankLobsters,
  getTankLostShrimpToWinner,
  subscribeTankLobsters,
} from "@/lib/tank-lobsters";
import {
  DEFAULT_FEED_FILTERS,
  FEED_FILTER_KEYS,
  FEED_FILTER_LABELS,
  filterTankEvents,
  type FeedFilterKey,
  type FeedFilterState,
} from "@/lib/feed-filters";
import { renderNarration } from "@/narration/templates";
import type { Lobster } from "@/sim/types";
import { RotatingLobsterPreview } from "@/components/RotatingLobsterPreview";

const POINTS_SHRIMP = 1;
const POINTS_LOBSTER_KILL = 10;

const formatRelativeTime = (timestamp: number) => {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return "just now";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

function leaderboardRows(lobsters: Lobster[]): (Lobster & { points: number })[] {
  return [...lobsters]
    .map((l) => {
      const shrimp = l.shrimpEaten ?? Math.floor(l.xp / 10);
      const kills = l.lobsterKills ?? 0;
      return { ...l, points: shrimp * POINTS_SHRIMP + kills * POINTS_LOBSTER_KILL };
    })
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      const shrimpA = a.shrimpEaten ?? Math.floor(a.xp / 10);
      const shrimpB = b.shrimpEaten ?? Math.floor(b.xp / 10);
      if (shrimpB !== shrimpA) return shrimpB - shrimpA;
      return b.level - a.level;
    });
}

const RANK_STYLES = [
  "border-l-2 border-amber-400 bg-amber-50/60",
  "border-l-2 border-slate-400 bg-slate-50/60",
  "border-l-2 border-orange-300 bg-orange-50/40",
];

const EMPTY_EVENTS: ReturnType<typeof getTankEvents> = [];

export function MainPage() {
  const { myLobsterId, publicKey } = useTankContext();
  const tankLobsters = useSyncExternalStore(
    subscribeTankLobsters,
    getTankLobsters,
    getServerSnapshotLobsters,
  );
  const tankCommunities = useSyncExternalStore(
    subscribeTankLobsters,
    getTankCommunities,
    getServerSnapshotCommunities,
  );
  const tankEvents = useSyncExternalStore(
    subscribeTankEvents,
    getTankEvents,
    () => EMPTY_EVENTS,
  );
  const feedRef = useRef<HTMLDivElement>(null);
  const [feedFilters, setFeedFilters] = useState<FeedFilterState>(() => ({ ...DEFAULT_FEED_FILTERS }));
  const [posts, setPosts] = useState<{ id: string; title: string; content: string; createdAt: number }[]>([]);
  const [postsLoading, setPostsLoading] = useState(false);
  const [apiCommunities, setApiCommunities] = useState<{ id: string; name: string; color: string; memberCount: number }[]>([]);
  const [joinLoading, setJoinLoading] = useState<string | null>(null);

  const toggleFeedFilter = (key: FeedFilterKey) => {
    setFeedFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  const filteredFeedEvents = filterTankEvents(tankEvents, feedFilters);

  useEffect(() => {
    if (!feedRef.current) return;
    // When new events arrive (length grows), scroll feed to top once.
    feedRef.current.scrollTop = 0;
  }, [tankEvents.length]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tank-events/recent?since=0")
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then(({ events: evts }) => {
        if (!cancelled && Array.isArray(evts) && evts.length > 0) hydrateTankEvents(evts);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const fetchPosts = useCallback(() => {
    setPostsLoading(true);
    fetch("/api/narrator/posts")
      .then((r) => (r.ok ? r.json() : { posts: [] }))
      .then((d) => {
        if (Array.isArray(d.posts)) setPosts(d.posts);
      })
      .catch(() => {})
      .finally(() => setPostsLoading(false));
  }, []);
  useEffect(() => {
    fetchPosts();
  }, []); // Initial load only; fetchPosts already updates state internally.

  useEffect(() => {
    if (!myLobsterId) return;
    fetch("/api/communities")
      .then((r) => (r.ok ? r.json() : { communities: [] }))
      .then((d) => setApiCommunities(d.communities ?? []))
      .catch(() => setApiCommunities([]));
  }, [myLobsterId]);

  const myLobster = myLobsterId
    ? tankLobsters.find((l) => l.id === myLobsterId)
    : null;
  const lostShrimpToWinner = getTankLostShrimpToWinner();
  const aggressionTargets =
    myLobsterId && Object.keys(lostShrimpToWinner).length > 0
      ? Object.entries(lostShrimpToWinner)
          .filter(([key]) => key.startsWith(`${myLobsterId}-`))
          .map(([key, count]) => {
            const winnerId = key.slice(myLobsterId!.length + 1);
            const winner = tankLobsters.find((l) => l.id === winnerId);
            return { name: winner?.displayName ?? winnerId, count };
          })
          .filter((t) => t.count > 0)
      : [];
  const topLobsters = leaderboardRows(tankLobsters).slice(0, 10);
  const communityWithMembers = tankCommunities.map((c) => {
    const members = tankLobsters.filter((l) => l.communityId === c.id);
    return {
      ...c,
      memberCount: members.length,
      shrimp: members.reduce((s, l) => s + (l.shrimpEaten ?? 0), 0),
      kills: members.reduce((s, l) => s + (l.lobsterKills ?? 0), 0),
    };
  });

  const recentKills = tankEvents.filter((e) => e.type === "kill").length;
  const recentDeaths = tankEvents.filter(
    (e) => e.type === "predator-kill" || (e.type === "kill" && e.payload?.loserId),
  ).length;
  const eventsSummary =
    recentKills > 0 || recentDeaths > 0
      ? `${recentKills} kill(s), ${recentDeaths} death(s) in feed`
      : "No recent combat in feed";
  const hp = myLobster?.health ?? 100;

  return (
    <div className="space-y-8" role="main" aria-label="Main content">
      {/* 1. Hero block */}
      <section className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-6 shadow-sm">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <div className="flex shrink-0 items-center justify-center w-28 h-28">
            {myLobster ? (
              <RotatingLobsterPreview
                bodyColor={myLobster.bodyColor ?? "#c85c42"}
                clawColor={myLobster.clawColor ?? "#8b4513"}
                bandanaColor={(myLobster as { bandanaColor?: string | null }).bandanaColor ?? (tankCommunities.find((c) => c.id === myLobster.communityId)?.color ?? null)}
                size={112}
              />
            ) : (
              <div className="w-28 h-28 rounded-xl border border-slate-200 bg-slate-200 flex items-center justify-center text-slate-400 text-2xl" title="Your lobster">?</div>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <h2 className="text-xl font-semibold text-slate-900">
              {myLobster ? (myLobster.displayName ?? myLobster.id) : "Your lobster"}
            </h2>
            {myLobster ? (
              <>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-4">
                  <span className="text-slate-500">Level</span>
                  <span className="font-semibold text-slate-900">{myLobster.level}</span>
                  <span className="text-slate-500">Shrimp</span>
                  <span className="font-semibold text-slate-900">
                    {myLobster.shrimpEaten ?? Math.floor(myLobster.xp / 10)}
                  </span>
                  <span className="text-slate-500">Kills</span>
                  <span className="font-semibold text-slate-900">{myLobster.lobsterKills ?? 0}</span>
                  <span className="text-slate-500">Deaths</span>
                  <span className="font-semibold text-slate-900">{myLobster.losses ?? 0}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs font-medium text-slate-500">HP</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-teal-500 transition-all"
                      style={{ width: `${Math.max(0, Math.min(100, hp))}%` }}
                    />
                  </div>
                  <span className="text-xs tabular-nums text-slate-600">{hp}/100</span>
                </div>
                {aggressionTargets.length > 0 ? (
                  <p className="text-xs text-slate-500">
                    Aggression building towards:{" "}
                    {aggressionTargets.map((t) => `${t.name} (${t.count} shrimp lost)`).join(", ")}
                    — may fight when it reaches 4.
                  </p>
                ) : null}
                {myLobster && !myLobster.communityId && apiCommunities.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-500">Join community:</span>
                    {apiCommunities.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        disabled={joinLoading === c.id}
                        onClick={() => {
                          setJoinLoading(c.id);
                          fetch("/api/communities/join", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ communityId: c.id }),
                            credentials: "include",
                          })
                            .then((r) => r.json().then((d) => ({ ok: r.ok, ...d })))
                            .then(({ ok, error }) => {
                              if (ok) {
                                fetch("/api/communities")
                                  .then((res) => (res.ok ? res.json() : null))
                                  .then((d) => d && setApiCommunities(d.communities ?? []));
                              } else {
                                alert(error ?? "Could not join");
                              }
                            })
                            .finally(() => setJoinLoading(null));
                        }}
                        className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        {joinLoading === c.id ? "Joining…" : c.name}
                      </button>
                    ))}
                  </div>
                ) : myLobster?.communityId ? (
                  <p className="text-xs text-slate-500">
                    Community: {tankCommunities.find((c) => c.id === myLobster.communityId)?.name ?? myLobster.communityId}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-slate-600">
                Connect your wallet and claim a lobster to see your stats here.
              </p>
            )}
            <p className="text-xs text-slate-500">{eventsSummary}</p>
          </div>
        </div>
      </section>

      {/* 2. Tank Feed with live indicator */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
            Tank Feed
          </h3>
          <span className="text-[10px] font-medium text-emerald-600">Live</span>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          Shrimp eaten, battles, octopus attacks, friendships and communities — the tank&apos;s story in real time.
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {FEED_FILTER_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => toggleFeedFilter(key)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                feedFilters[key]
                  ? "bg-teal-100 text-teal-800 hover:bg-teal-200"
                  : "bg-slate-100 text-slate-500 hover:bg-slate-200"
              }`}
            >
              {FEED_FILTER_LABELS[key]}
            </button>
          ))}
        </div>
        <div ref={feedRef} className="mt-4 min-h-0 max-h-[320px] space-y-2 overflow-y-auto">
          {filteredFeedEvents.length > 0 ? (
            filteredFeedEvents.slice(0, 80).map((event, idx) => (
              <div
                key={event.id}
                className="rounded-xl border border-slate-100 bg-slate-50/50 p-3 transition-all"
                style={{ animation: idx < 3 ? "fadeSlideIn 0.3s ease-out" : undefined }}
              >
                <p className="text-sm text-slate-700">{renderNarration(event)}</p>
                <p className="mt-1 text-xs text-slate-400">
                  {formatRelativeTime(event.createdAt)}
                </p>
              </div>
            ))
          ) : (
            <p className="text-sm text-slate-500">
              {tankEvents.length > 0
                ? "No events match the current filters. Toggle filters above to see more."
                : "Simulation is running. Events will appear here as lobsters interact."}
            </p>
          )}
        </div>

        {/* Posts: 10‑min AI story summaries */}
        <div className="mt-6 border-t border-slate-200 pt-4">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Posts (10‑min stories)
            </h4>
            <button
              type="button"
              onClick={() => {
                setPostsLoading(true);
                fetch("/api/narrator/posts", { method: "POST" })
                  .then((r) => (r.ok ? r.json() : null))
                  .then(() => fetchPosts())
                  .finally(() => setPostsLoading(false));
              }}
              disabled={postsLoading}
              className="rounded-full bg-violet-100 px-3 py-1.5 text-[11px] font-medium text-violet-800 hover:bg-violet-200 disabled:opacity-50"
            >
              {postsLoading ? "Generating…" : "Generate 10‑min story"}
            </button>
          </div>
          <div className="mt-3 max-h-[280px] space-y-3 overflow-y-auto">
            {posts.length > 0 ? (
              posts.map((post) => (
                <div
                  key={post.id}
                  className="rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-xs"
                >
                  <p className="font-semibold text-slate-800">{post.title}</p>
                  <p className="mt-1.5 text-slate-600 whitespace-pre-wrap">{post.content}</p>
                  <p className="mt-2 text-[10px] text-slate-400">
                    {formatRelativeTime(post.createdAt)}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-xs text-slate-500 py-2">
                No posts yet. Generate a 10‑minute AI story above (requires GPT_API_KEY and database).
              </p>
            )}
          </div>
        </div>
      </section>

      {/* 3. Two-column: Leaderboard | Community */}
      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
              Leaderboards
            </h3>
            <Link
              href="/leaderboards"
              className="text-xs font-medium text-teal-600 hover:text-teal-700"
            >
              View all →
            </Link>
          </div>
          <div className="mt-4 min-h-0 max-h-[300px] overflow-y-auto">
            {topLobsters.length > 0 ? (
              <ul className="space-y-1.5">
                {topLobsters.map((lobster, i) => {
                  const shrimp = lobster.shrimpEaten ?? Math.floor(lobster.xp / 10);
                  const kills = lobster.lobsterKills ?? 0;
                  return (
                    <li
                      key={lobster.id}
                      className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm ${i < 3 ? RANK_STYLES[i] : i % 2 === 1 ? "bg-slate-50/50" : ""}`}
                    >
                      <span className="flex items-center gap-2">
                        <span className={`font-semibold tabular-nums ${i === 0 ? "text-amber-700" : i === 1 ? "text-slate-600" : i === 2 ? "text-orange-700" : "text-slate-500"}`}>
                          #{i + 1}
                        </span>
                        <span className="font-medium text-slate-900">{lobster.displayName ?? lobster.id}</span>
                      </span>
                      <span className="flex items-center gap-3 text-xs text-slate-500">
                        <span>{shrimp} shrimp</span>
                        <span>{kills} kills</span>
                        <span className="font-semibold text-slate-700">{lobster.points} pts</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">No rankings yet.</p>
            )}
          </div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
              Community
            </h3>
            <Link
              href="/community"
              className="text-xs font-medium text-teal-600 hover:text-teal-700"
            >
              View all →
            </Link>
          </div>
          <div className="mt-4 min-h-0 max-h-[300px] overflow-y-auto">
            {communityWithMembers.length > 0 ? (
              <ul className="space-y-1.5">
                {communityWithMembers.map((c) => (
                  <li
                    key={c.id}
                    className="flex flex-wrap items-center justify-between gap-1 rounded-lg border border-slate-100 px-3 py-2.5 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: c.color }}
                      />
                      <span className="font-medium text-slate-900">{c.name}</span>
                    </span>
                    <span className="flex items-center gap-3 text-xs text-slate-500">
                      <span>{c.memberCount} members</span>
                      <span>{c.kills} kills</span>
                      <span>{c.shrimp} shrimp</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">No communities yet.</p>
            )}
          </div>
        </div>
      </section>

      {/* 4. Feed CTA */}
      <section className="rounded-2xl border-2 border-teal-200/60 bg-gradient-to-r from-teal-50/40 to-white p-6 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-800">Feed your lobster</h3>
        <p className="mt-1.5 text-sm text-slate-600">
          Send tokens to the tank bank, then verify your feed with the transaction hash in the
          Actions panel below to give your lobster a temporary combat boost.
        </p>
        <button
          type="button"
          onClick={() => document.getElementById("controls")?.scrollIntoView({ behavior: "smooth" })}
          className="mt-4 rounded-full bg-teal-500 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2"
        >
          Go to Actions to verify feed
        </button>
      </section>

      {/* 5. Login CTA */}
      {(!publicKey || !myLobsterId) && (
        <section className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-800 to-slate-900 p-6 shadow-sm text-white">
          <h3 className="text-base font-semibold">Claim your lobster</h3>
          <p className="mt-1.5 text-sm text-slate-300">
            {!publicKey
              ? "Connect your wallet and set a password to claim a lobster and unlock actions."
              : "Set a password to sign in and claim or manage your lobster."}
          </p>
          <Link
            href="/login"
            className="mt-4 inline-block rounded-full bg-teal-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
          >
            {!publicKey ? "Connect wallet" : "Go to Login"}
          </Link>
        </section>
      )}

      <style jsx>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
