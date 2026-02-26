"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { Group } from "three";
import { LobsterMesh } from "@/components/LobsterMesh";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { getEligibilityTier, getSolanaTokenBalance } from "@/lib/wallet";
import {
  addTankEvents,
  getTankEvents,
  hydrateTankEvents,
  subscribeTankEvents,
} from "@/lib/tank-events";
import {
  getFocusLobsterSnapshot,
  subscribeFocusLobster,
} from "@/lib/focus-lobster";
import {
  getServerSnapshotCommunities,
  getServerSnapshotLobsters,
  getServerSnapshotRelationships,
  getTankLobsters,
  getTankCommunities,
  getTankLostShrimpToWinner,
  getTankRelationships,
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
import { publicEnv } from "@/lib/public-env";
import { getPetBoostEndByLobsterId, setPetBoostFromMe } from "@/lib/pet-boost";
import { setPendingInstantRespawnLobsterId } from "@/lib/instant-respawn";
import { getFriendshipChance, getAttackChance, GANG_FORM_MAX } from "@/sim/engine";
import type { Lobster } from "@/sim/types";

import type { MyLobsterColors } from "@/components/TankShell";

type RightPanelProps = {
  viewLabel: string;
  lowPower: boolean;
  onToggleLowPower: () => void;
  aquariumId?: string;
  layout?: "sidebar" | "toolbar";
  selectedLobsterId?: string | null;
  onRequestFirstPerson?: (id: string) => void;
  onClearSelection?: () => void;
  myLobsterId?: string | null;
  myLobsterColors?: MyLobsterColors | null;
  onSetMyLobster?: (id: string, colors?: MyLobsterColors) => void;
  onMyLobsterColorsChange?: (colors: MyLobsterColors) => void;
  onRefetchMyLobster?: () => void | Promise<void>;
  aggressiveMode?: boolean;
  onAggressiveChange?: (v: boolean) => void;
  betrayMode?: boolean;
  onBetrayChange?: (v: boolean) => void;
};

type LeaderboardRow = {
  id: string;
  displayName?: string | null;
  level: number;
  xp: number;
  size: number;
  wins: number;
  losses: number;
  shrimpEaten?: number;
};

type LobsterProfile = {
  id: string;
  level: number;
  xp: number;
  size: number;
  wins: number;
  losses: number;
  status?: string | null;
  communityId?: string | null;
  lastFed?: string | null;
  lastPet?: string | null;
  displayName?: string | null;
  bodyColor?: string | null;
  clawColor?: string | null;
  /** Prepaid feeds from verified token sends (e.g. 1000 tokens = 10). */
  feedCredits?: number | null;
};

type EligibilityInfo = {
  tier: "viewer" | "caretaker" | "owner";
  balance: number;
};

const fallbackEvents = [
  { id: "evt-1", text: "Simulation is running. Events will appear here as lobsters interact.", time: "" },
];

const serverTankEvents: ReturnType<typeof getTankEvents> = [];

function JoinCommunityInline({ onJoined }: { onJoined?: () => void }) {
  const [communities, setCommunities] = useState<{ id: string; name: string; color: string }[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/communities")
      .then((r) => (r.ok ? r.json() : { communities: [] }))
      .then((d) => setCommunities(d.communities ?? []))
      .catch(() => setCommunities([]));
  }, []);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] text-slate-500">Join:</span>
      {communities.map((c) => (
        <button
          key={c.id}
          type="button"
          disabled={loading === c.id}
          onClick={() => {
            setLoading(c.id);
            fetch("/api/communities/join", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ communityId: c.id }),
              credentials: "include",
            })
              .then((r) => r.json().then((d) => ({ ok: r.ok, error: d.error })))
              .then(({ ok, error }) => {
                if (ok) onJoined?.();
                else alert(error ?? "Could not join");
              })
              .finally(() => setLoading(null));
          }}
          className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {loading === c.id ? "…" : c.name}
        </button>
      ))}
    </div>
  );
}

function CurrentViewLobsterPreview({
  bodyColor,
  clawColor,
  bandanaColor,
}: {
  bodyColor: string;
  clawColor: string;
  bandanaColor: string;
}) {
  const groupRef = useRef<Group>(null);
  useFrame((_, delta) => {
    if (groupRef.current) groupRef.current.rotation.y += delta * 0.2;
  });
  return (
    <group ref={groupRef} scale={1.2}>
      <LobsterMesh bodyColor={bodyColor} clawColor={clawColor} bandanaColor={bandanaColor} />
    </group>
  );
}

function SaveMyLobsterColorsButton({
  lobsterId,
  colors,
  walletAddress,
  onSaved,
}: {
  lobsterId: string;
  colors: MyLobsterColors;
  walletAddress: string;
  onSaved: () => void | Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const handleSave = useCallback(async () => {
    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/lobsters/${encodeURIComponent(lobsterId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-wallet-address": walletAddress },
        body: JSON.stringify({
          bodyColor: colors.bodyColor,
          clawColor: colors.clawColor,
          bandanaColor: colors.bandanaColor,
        }),
      });
      if (res.ok) {
        setStatus("Saved.");
        await onSaved();
      } else {
        setStatus("Save failed.");
      }
    } catch {
      setStatus("Save failed.");
    } finally {
      setLoading(false);
    }
  }, [lobsterId, colors.bodyColor, colors.clawColor, colors.bandanaColor, walletAddress, onSaved]);
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleSave}
        disabled={loading}
        className="rounded-full bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
      >
        {loading ? "Saving…" : "Save name & colours"}
      </button>
      {status ? <span className="text-xs text-slate-500">{status}</span> : null}
    </div>
  );
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/** Level-based damage (matches engine-simple). Uses damageMult for display. */
const getDamageRange = (lobster: Lobster) => {
  const level = Math.min(lobster.level ?? 1, 10);
  const base = 4 + Math.floor(((level - 1) / 9) * (Math.floor(30 / 3) - 4));
  const mult = lobster.damageMult ?? 1;
  const minDamage = Math.max(1, Math.round((base - 2) * mult));
  const maxDamage = Math.max(1, Math.round((base + 2) * mult));
  return { minDamage, maxDamage };
};

/** Speed (matches engine-simple speedForLevel * speedMult). Level 1 ≈ 26, level 10 ≈ 28. */
const getSpeed = (lobster: Lobster): number => {
  const level = Math.min(lobster.level ?? 1, 10);
  const base = 26 + ((level - 1) / 9) * (28 - 26);
  return Math.round(base * (lobster.speedMult ?? 1) * 10) / 10;
};

/** Boost multiplier in engine (3x speed and damage). Use when displaying stats if boosted. */
const BOOST_MULT = 3;

function walletHeaders(
  publicKey: ReturnType<typeof useWallet>["publicKey"],
  walletOverride?: string,
): HeadersInit {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const address = (walletOverride ?? "").trim() || (publicKey ? publicKey.toBase58() : "");
  if (address) {
    headers["x-wallet-address"] = address;
  }
  return headers;
}

/** Preview of the 30-minute narrator script (from DB). Refreshes on load and every 30 min. */
function NarratorScriptPreviewCard({ cardClass }: { cardClass: string }) {
  const [summary, setSummary] = useState<{ title: string; content: string; eventCount: number; lastPostAt: number; canPost: boolean; scope?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<"last" | "sincePost" | "all">("last");
  const [dbConfigured, setDbConfigured] = useState<boolean | null>(null);
  const [aiGenerated, setAiGenerated] = useState(false);
  const [postingEnabled, setPostingEnabled] = useState(false);
  const [postingConfigMessage, setPostingConfigMessage] = useState<string>("");
  const [postingThis, setPostingThis] = useState(false);

  useEffect(() => {
    fetch("/api/db-status")
      .then((r) => r.json())
      .then((d) => setDbConfigured(d.configured === true))
      .catch(() => setDbConfigured(false));
  }, []);

  useEffect(() => {
    fetch("/api/narrator/config")
      .then((r) => r.json())
      .then((d) => {
        setPostingEnabled(d.postingEnabled === true);
        setPostingConfigMessage(d.message ?? "");
      })
      .catch(() => {
        setPostingEnabled(false);
        setPostingConfigMessage("Could not load posting config.");
      });
  }, []);

  const fetchSummary = useCallback(async (nextScope?: "last" | "sincePost" | "all") => {
    setLoading(true);
    setError(null);
    try {
      const activeScope = nextScope ?? scope;
      const res = await fetch(`/api/tank-events/summary?scope=${activeScope}&since=1800000`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to load summary");
        return;
      }
      setSummary({
        title: data.title ?? "Observatory Summary",
        content: data.content ?? "",
        eventCount: data.eventCount ?? 0,
        lastPostAt: data.lastPostAt ?? 0,
        canPost: data.canPost ?? false,
        scope: data.scope ?? activeScope,
      });
      setError(null);
      setAiGenerated(false);
    } catch {
      setError("Failed to load summary");
    } finally {
      setLoading(false);
    }
  }, [scope]);

  const fetchAiSummary = useCallback(async () => {
    setAiLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/narrator/ai-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, since: 1800000 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to generate AI summary");
        return;
      }
      setSummary({
        title: data.title ?? "Observatory Story",
        content: data.content ?? "",
        eventCount: data.eventCount ?? 0,
        lastPostAt: summary?.lastPostAt ?? 0,
        canPost: false,
        scope,
      });
      setAiGenerated(true);
      setError(null);
    } catch {
      setError("Failed to generate AI summary");
    } finally {
      setAiLoading(false);
    }
  }, [scope, summary?.lastPostAt]);

  useEffect(() => {
    fetchSummary(scope);
    const interval = setInterval(() => fetchSummary(scope), 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchSummary, scope]);

  const handlePostNow = async () => {
    if (!summary?.canPost) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tank-events/summary?post=1&scope=last&since=1800000");
      const data = await res.json();
      if (res.ok && data.posted) {
        setSummary((s) => s ? { ...s, lastPostAt: data.lastPostAt, canPost: false } : null);
      } else if (!res.ok) {
        setError(data.error ?? "Post failed");
      } else {
        setError(data.error ?? "Post not sent (cooldown or disabled)");
      }
    } catch {
      setError("Post failed");
    } finally {
      setLoading(false);
    }
  };

  const handlePostThisStory = async () => {
    if (!summary?.content?.trim() || !postingEnabled) return;
    setPostingThis(true);
    setError(null);
    try {
      const res = await fetch("/api/molt-post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: summary.title || "Observatory Story", content: summary.content.trim() }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Post failed");
        return;
      }
      setSummary((s) => s ? { ...s, lastPostAt: Date.now(), canPost: false } : null);
    } catch {
      setError("Post failed");
    } finally {
      setPostingThis(false);
    }
  };

  return (
    <div className={`${cardClass} space-y-3`}>
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
        Narrator script
      </h3>
      <p className="text-xs text-slate-600">
        Generate a script from the feed (or with AI). You can view the result here; post to Molt only when live.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${postingEnabled ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}
          title={postingConfigMessage}
        >
          {postingEnabled ? "Live" : "Preview"}
        </span>
        {postingConfigMessage ? (
          <span className="text-[10px] text-slate-500" title={postingConfigMessage}>
            {postingEnabled ? "Posting to Moltbook on." : "Posting off — view only. Set MOLTBOOK_POSTING_ENABLED=true to go live."}
          </span>
        ) : null}
      </div>
      {dbConfigured !== null && (
        <p className="text-[10px] text-slate-500">
          {dbConfigured ? "Database connected" : "Database not configured"}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as "last" | "sincePost" | "all")}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
        >
          <option value="last">Last 30 min</option>
          <option value="sincePost">Since last narration</option>
          <option value="all">Since beginning</option>
        </select>
        <button
          type="button"
          onClick={() => fetchSummary(scope)}
          disabled={loading || aiLoading}
          className="rounded-full border border-teal-300 bg-white px-3 py-1.5 text-xs font-semibold text-teal-700 transition hover:bg-teal-50 disabled:opacity-50"
        >
          {loading ? "Generating…" : "Generate"}
        </button>
        <button
          type="button"
          onClick={fetchAiSummary}
          disabled={loading || aiLoading}
          className="rounded-full border border-violet-300 bg-white px-3 py-1.5 text-xs font-semibold text-violet-700 transition hover:bg-violet-50 disabled:opacity-50"
        >
          {aiLoading ? "Generating…" : "Generate with AI"}
        </button>
      </div>
      {loading && !summary ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : error ? (
        <p className="text-xs text-rose-600">{error}</p>
      ) : summary ? (
        <>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
            <p className="font-semibold text-slate-800">
              {summary.title}
              {aiGenerated ? (
                <span className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                  Story (AI)
                </span>
              ) : null}
            </p>
            <pre className="mt-2 max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words font-sans text-slate-700">
              {summary.content || "No events in the selected window."}
            </pre>
            <p className="mt-2 text-slate-500">
              {summary.eventCount} event(s) in window · {summary.canPost ? "Ready to post" : "Next post in 30 min"}
            </p>
          </div>
          {summary.canPost ? (
            <button
              type="button"
              onClick={handlePostNow}
              disabled={loading || !postingEnabled}
              title={!postingEnabled ? postingConfigMessage : undefined}
              className="rounded-full border border-teal-300 bg-white px-4 py-2 text-xs font-semibold text-teal-700 transition hover:bg-teal-50 disabled:opacity-50"
            >
              {loading ? "Posting…" : "Post now to Molt"}
            </button>
          ) : null}
          {summary.content?.trim() ? (
            <button
              type="button"
              onClick={handlePostThisStory}
              disabled={!postingEnabled || postingThis}
              title={!postingEnabled ? postingConfigMessage : undefined}
              className="rounded-full border border-violet-300 bg-white px-4 py-2 text-xs font-semibold text-violet-700 transition hover:bg-violet-50 disabled:opacity-50"
            >
              {postingThis ? "Posting…" : "Post this story to Molt"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => fetchSummary()}
            disabled={loading}
            className="block text-xs text-slate-500 hover:text-slate-700"
          >
            Refresh script
          </button>
        </>
      ) : null}
    </div>
  );
}

/** Manual "narrator" post to Molt — same REST API as automated posts; you write title + content as the agent. */
function ManualMoltPostCard({ cardClass }: { cardClass: string }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const handlePost = async () => {
    if (!title.trim() || !content.trim()) {
      setStatus("Enter a title and content.");
      return;
    }
    setStatus(null);
    setPosting(true);
    try {
      const res = await fetch("/api/molt-post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), content: content.trim() }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setStatus(data.error ?? "Post failed.");
        return;
      }
      setStatus("Posted to Molt.");
      setTitle("");
      setContent("");
    } catch {
      setStatus("Post failed.");
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className={`${cardClass} space-y-3`}>
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
        Post to Molt (as narrator)
      </h3>
      <p className="text-xs text-slate-600">
        Posts appear as the Lobster Observatory narrator (same identity as the automated 30‑min
        summaries). Write custom updates; no AI required.
      </p>
      <input
        type="text"
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
      />
      <textarea
        placeholder="Content (narrator voice, tank updates, etc.)"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={3}
        className="w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
      />
      <button
        type="button"
        onClick={handlePost}
        disabled={posting}
        className="rounded-full border border-teal-300 bg-white px-4 py-2 text-xs font-semibold text-teal-700 transition hover:bg-teal-50 disabled:opacity-50"
      >
        {posting ? "Posting…" : "Post as narrator"}
      </button>
      {status ? (
        <p className="text-xs text-slate-600">{status}</p>
      ) : null}
      {publicEnv.NEXT_PUBLIC_MOLTBOOK_OBSERVATORY_URL ? (
        <a
          href={publicEnv.NEXT_PUBLIC_MOLTBOOK_OBSERVATORY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-teal-600 hover:underline"
        >
          View Lobster Observatory on Moltbook →
        </a>
      ) : null}
    </div>
  );
}

export const RightPanel = ({
  viewLabel,
  lowPower,
  onToggleLowPower,
  aquariumId,
  layout = "sidebar",
  selectedLobsterId,
  onRequestFirstPerson,
  onClearSelection,
  myLobsterId,
  myLobsterColors,
  onSetMyLobster,
  onMyLobsterColorsChange,
  onRefetchMyLobster,
  aggressiveMode = false,
  onAggressiveChange,
  betrayMode = false,
  onBetrayChange,
}: RightPanelProps) => {
  const [balance, setBalance] = useState<number | null>(null);
  const [feedAmount, setFeedAmount] = useState("100");
  const [feedTxHash, setFeedTxHash] = useState("");
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [myLobster, setMyLobster] = useState<LobsterProfile | null>(null);
  const [eligibilityInfo, setEligibilityInfo] = useState<EligibilityInfo | null>(null);
  const [walletOverride, setWalletOverride] = useState("");
  const [connectPassword, setConnectPassword] = useState("");
  const [connectLoading, setConnectLoading] = useState(false);
  const [connectSuccess, setConnectSuccess] = useState(false);
  const [connectBalance, setConnectBalance] = useState<number | null>(null);
  const [nameColorForm, setNameColorForm] = useState({ displayName: "", bodyColor: "#c85c42", clawColor: "#8b4513" });
  const [nameColorLoading, setNameColorLoading] = useState(false);
  const [claimModalOpen, setClaimModalOpen] = useState(false);
  const [claimForm, setClaimForm] = useState({ displayName: "", bodyColor: "#c85c42", clawColor: "#8b4513" });
  const [claimLoading, setClaimLoading] = useState(false);
  const [respawnTick, setRespawnTick] = useState(0);
  const [instantRespawnTxHash, setInstantRespawnTxHash] = useState("");
  const [instantRespawnSubmitting, setInstantRespawnSubmitting] = useState(false);
  const [instantRespawnError, setInstantRespawnError] = useState<string | null>(null);
  const [feedFilters, setFeedFilters] = useState<FeedFilterState>(() => ({ ...DEFAULT_FEED_FILTERS }));
  const toggleFeedFilter = useCallback((key: FeedFilterKey) => {
    setFeedFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const tankEvents = useSyncExternalStore(
    subscribeTankEvents,
    getTankEvents,
    () => serverTankEvents,
  );
  const focusLobsterSim = useSyncExternalStore(
    subscribeFocusLobster,
    getFocusLobsterSnapshot,
    () => null as Lobster | null,
  );
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
  const tankRelationships = useSyncExternalStore(
    subscribeTankLobsters,
    getTankRelationships,
    getServerSnapshotRelationships,
  );
  const [leaderboardRows, setLeaderboardRows] = useState<LeaderboardRow[]>([]);
  const [leaderboardRefresh, setLeaderboardRefresh] = useState(0);
  const selectedLobsterFromTank =
    selectedLobsterId != null
      ? tankLobsters.find((l) => l.id === selectedLobsterId)
      : null;
  const myLobsterFromTank = myLobsterId != null ? tankLobsters.find((l) => l.id === myLobsterId) : null;
  const lostShrimpToWinner = getTankLostShrimpToWinner();
  const myLobsterAggressionTargets = useMemo(() => {
    if (!myLobsterId || Object.keys(lostShrimpToWinner).length === 0) return [];
    return Object.entries(lostShrimpToWinner)
      .filter(([key]) => key.startsWith(`${myLobsterId}-`))
      .map(([key, count]) => {
        const winnerId = key.slice(myLobsterId!.length + 1);
        const winner = tankLobsters.find((l) => l.id === winnerId);
        return { name: winner?.displayName ?? winnerId, count };
      })
      .filter((t) => t.count > 0);
  }, [myLobsterId, lostShrimpToWinner, tankLobsters]);
  const damageRange = selectedLobsterFromTank ? getDamageRange(selectedLobsterFromTank) : null;
  const myLobsterDamageRange = myLobsterFromTank ? getDamageRange(myLobsterFromTank) : null;
  const boostEndByLobsterId = getPetBoostEndByLobsterId();
  const now = Date.now();
  const myLobsterBoosted = !!(
    myLobsterId &&
    (boostEndByLobsterId[myLobsterId] ?? 0) > now
  );
  const selectedLobsterBoosted = !!(
    selectedLobsterFromTank &&
    (boostEndByLobsterId[selectedLobsterFromTank.id] ?? 0) > now
  );
  const tokenMint = publicEnv.NEXT_PUBLIC_TOKEN_MINT;
  const tankBankAddress = publicEnv.NEXT_PUBLIC_TANK_BANK_ADDRESS ?? "";
  const tier = useMemo(() => {
    if (balance === null) return "viewer";
    return getEligibilityTier({ amount: balance, decimals: 0 });
  }, [balance]);
  const effectiveWallet = (walletOverride.trim() || (publicKey ? publicKey.toBase58() : "")) || null;
  const headers = useMemo(
    () => walletHeaders(publicKey, walletOverride),
    [publicKey, walletOverride],
  );
  const myLobsterDead =
    myLobsterFromTank &&
    (myLobsterFromTank.health ?? 100) <= 0 &&
    myLobsterFromTank.respawnAt != null &&
    Date.now() < myLobsterFromTank.respawnAt;
  const myLobsterWaitingRespawn =
    myLobsterFromTank &&
    (myLobsterFromTank.health ?? 100) <= 0 &&
    myLobsterFromTank.respawnAt != null;
  useEffect(() => {
    if (!myLobsterWaitingRespawn) return;
    let last = Date.now();
    let raf = 0;
    const tick = () => {
      const now = Date.now();
      if (now - last >= 1000) {
        last = now;
        setRespawnTick((t) => t + 1);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [myLobsterWaitingRespawn]);

  useEffect(() => {
    if (!effectiveWallet) return;
    const loadEvents = async () => {
      try {
        const response = await fetch("/api/me", {
          headers: { "Content-Type": "application/json", "x-wallet-address": effectiveWallet },
        });
        const data = await response.json();
        if (response.ok) {
          if (data.lobster) {
            setMyLobster(data.lobster);
            setPetBoostFromMe(data.lobster.id ?? null, data.lobster.petBoostUntil ?? null);
            // Sync to shell so main page "Your lobster" hero and tank view show this lobster
            onSetMyLobster?.(data.lobster.id, {
              bodyColor: data.lobster.bodyColor ?? "#c85c42",
              clawColor: data.lobster.clawColor ?? "#8b4513",
              bandanaColor: (data.lobster as { bandanaColor?: string | null }).bandanaColor ?? "#94a3b8",
            });
          } else {
            setPetBoostFromMe(null, null);
          }
          if (data.eligibility) {
            setEligibilityInfo(data.eligibility);
          }
        }
        if (response.ok && Array.isArray(data.events)) {
          const events = data.events.map((event: any) => ({
            id: event.id,
            type: event.type,
            createdAt: new Date(event.createdAt).getTime(),
            payload: event.payload,
          }));
          if (events.length > 0) {
            events.sort((a: any, b: any) => b.createdAt - a.createdAt);
            hydrateTankEvents(events);
          }
        }
      } catch {
        // ignore hydration errors
      }
    };
    void loadEvents();
  }, [effectiveWallet, onSetMyLobster]);

  useEffect(() => {
    if (!connected || !publicKey || !tokenMint) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    const loadBalance = async () => {
      try {
        const result = await getSolanaTokenBalance(connection, publicKey, tokenMint);
        if (!cancelled) {
          setBalance(result.amount);
        }
      } catch {
        if (!cancelled) {
          setBalance(0);
        }
      }
    };
    loadBalance();
    return () => {
      cancelled = true;
    };
  }, [connected, connection, publicKey, tokenMint]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(
          `/api/leaderboards?aquarium=${aquariumId ?? "global"}`,
        );
        const data = await response.json();
        if (!cancelled && response.ok && Array.isArray(data.lobsters)) {
          setLeaderboardRows(data.lobsters.slice(0, 5));
        }
      } catch {
        if (!cancelled) setLeaderboardRows([]);
      }
    };
    void load();
    const interval =
      aquariumId === "global"
        ? setInterval(load, 15_000)
        : undefined;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [aquariumId, leaderboardRefresh]);

  const loadMe = useCallback(async () => {
    if (!effectiveWallet) return;
    try {
      const response = await fetch("/api/me", {
        headers: { "Content-Type": "application/json", "x-wallet-address": effectiveWallet },
      });
      const data = await response.json();
      if (response.ok) {
        if (data.lobster) {
          setMyLobster(data.lobster);
          setNameColorForm({
            displayName: data.lobster.displayName ?? "",
            bodyColor: data.lobster.bodyColor ?? "#c85c42",
            clawColor: data.lobster.clawColor ?? "#8b4513",
          });
          setPetBoostFromMe(data.lobster.id ?? null, data.lobster.petBoostUntil ?? null);
          // Propagate \"my lobster\" up so MainPage and TankScene know which sim lobster is yours,
          // even when you connect via pasted wallet address instead of the Solana adapter.
          onSetMyLobster?.(data.lobster.id, {
            bodyColor: data.lobster.bodyColor ?? "#c85c42",
            clawColor: data.lobster.clawColor ?? "#8b4513",
            bandanaColor:
              (data.lobster as { bandanaColor?: string | null }).bandanaColor ?? "#94a3b8",
          });
        } else {
          setMyLobster(null);
          setPetBoostFromMe(null, null);
        }
        if (data.eligibility) setEligibilityInfo(data.eligibility);
      }
    } catch {
      // ignore
    }
  }, [effectiveWallet]);

  const handleConnect = async () => {
    setActionStatus(null);
    if (!effectiveWallet) {
      setActionStatus("Paste a wallet address or connect a wallet first.");
      return;
    }
    if (!connectPassword.trim() || connectPassword.length < 6) {
      setActionStatus("Enter a password (min 6 characters) to connect.");
      return;
    }
    setConnectLoading(true);
    setActionStatus(null);
    try {
      const res = await fetch("/api/auth/set-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wallet-address": effectiveWallet },
        body: JSON.stringify({ password: connectPassword.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (res.status === 409) {
        const verifyRes = await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-wallet-address": effectiveWallet },
          body: JSON.stringify({ password: connectPassword.trim() }),
        });
        const verifyData = (await verifyRes.json()) as { ok?: boolean; error?: string };
        if (!verifyRes.ok || !verifyData.ok) {
          setActionStatus(verifyData.error ?? "Wrong password.");
          setConnectLoading(false);
          return;
        }
      } else if (!res.ok) {
        setActionStatus(data.error ?? "Failed to set password.");
        setConnectLoading(false);
        return;
      }
      const balanceRes = await fetch(`/api/wallet/balance?address=${encodeURIComponent(effectiveWallet)}`);
      const balanceData = (await balanceRes.json()) as { balance?: number; error?: string };
      if (!balanceRes.ok || balanceData.error) {
        const msg = balanceData.error ?? "Could not load token balance.";
        const hint = msg.includes("403") || msg.toLowerCase().includes("blocked")
          ? " Use a different RPC in .env (e.g. https://api.mainnet-beta.solana.com or https://api.devnet.solana.com) or a provider that doesn’t block your IP."
          : " Ensure HELIUS_API_KEY is set in .env and TOKEN_MINT is the correct contract address.";
        setActionStatus(`${msg}${hint}`);
        setConnectLoading(false);
        return;
      }
      const bal = balanceData.balance ?? 0;
      setConnectBalance(bal);
      if (bal >= 10000) {
        setConnectSuccess(true);
        setActionStatus("You're the proud owner of this lobster. Name and customize below.");
      } else {
        setActionStatus(bal >= 100 ? "Caretaker tier. Hold 10,000 tokens to be an owner and claim a lobster." : "Hold at least 10,000 tokens to be an owner.");
      }
      await loadMe();
    } catch (err) {
      setActionStatus("Connect failed. Check your connection and try again.");
    } finally {
      setConnectLoading(false);
    }
  };

  const handleNameColorSubmit = async () => {
    if (!effectiveWallet) return;
    setNameColorLoading(true);
    setActionStatus(null);
    try {
      let lobsterId = myLobster?.id;
      if (!lobsterId) {
        const claimRes = await fetch("/api/lobsters/claim", {
          method: "POST",
          headers,
          body: JSON.stringify({ tier: "owner", aquariumId }),
        });
        const claimData = await claimRes.json();
        if (!claimRes.ok) {
          setActionStatus(claimData.error ?? "Claim failed.");
          setNameColorLoading(false);
          return;
        }
        lobsterId = claimData.lobsterId;
      }
      const patchRes = await fetch(`/api/lobsters/${lobsterId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-wallet-address": effectiveWallet },
        body: JSON.stringify({
          displayName: nameColorForm.displayName.trim() || null,
          bodyColor: nameColorForm.bodyColor || null,
          clawColor: nameColorForm.clawColor || null,
        }),
      });
      if (!patchRes.ok) {
        const err = await patchRes.json();
        setActionStatus(err.error ?? "Update failed.");
        setNameColorLoading(false);
        return;
      }
      setActionStatus("Lobster saved.");
      setNameColorForm((f) => ({ ...f, displayName: "" }));
      setConnectSuccess(false);
      await loadMe();
    } catch {
      setActionStatus("Save failed.");
    } finally {
      setNameColorLoading(false);
    }
  };

  const handleClaimModalSubmit = async () => {
    if (!effectiveWallet) return;
    setClaimLoading(true);
    setActionStatus(null);
    try {
      const res = await fetch("/api/lobsters/claim", {
        method: "POST",
        headers,
        body: JSON.stringify({
          tier: "owner",
          aquariumId,
          displayName: claimForm.displayName.trim() || null,
          bodyColor: claimForm.bodyColor || null,
          clawColor: claimForm.clawColor || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionStatus(data.error ?? "Claim failed.");
        setClaimLoading(false);
        return;
      }
      setActionStatus(`Claimed ${data.lobsterId}.`);
      setClaimModalOpen(false);
      onSetMyLobster?.(data.lobsterId, {
        bodyColor: claimForm.bodyColor || "#c85c42",
        clawColor: claimForm.clawColor || "#8b4513",
        bandanaColor: "#94a3b8",
      });
      setClaimForm({ displayName: "", bodyColor: "#c85c42", clawColor: "#8b4513" });
      setLeaderboardRefresh((r) => r + 1);
      await loadMe();
      onRefetchMyLobster?.();
    } catch {
      setActionStatus("Claim failed.");
    } finally {
      setClaimLoading(false);
    }
  };

  const handleClaim = async () => {
    setActionStatus(null);
    if (!effectiveWallet) {
      setActionStatus("Paste a wallet address or connect a wallet first.");
      return;
    }
    try {
      const response = await fetch("/api/lobsters/claim", {
        method: "POST",
        headers,
        body: JSON.stringify({ tier, aquariumId }),
      });
      const data = await response.json();
      if (!response.ok) {
        setActionStatus(data.error ?? "Unable to claim.");
        return;
      }
      setActionStatus(`Claimed ${data.lobsterId}.`);
    } catch {
      setActionStatus("Claim failed.");
    }
  };

  const handlePet = async () => {
    setActionStatus(null);
    if (!effectiveWallet) {
      setActionStatus("Paste a wallet address or connect a wallet first.");
      return;
    }
    try {
      const response = await fetch("/api/pet", {
        method: "POST",
        headers,
      });
      const data = await response.json();
      if (!response.ok) {
        setActionStatus(data.error ?? "Pet failed.");
        return;
      }
      setActionStatus("Pet successful.");
    } catch {
      setActionStatus("Pet failed.");
    }
  };

  const handleFeed = async () => {
    setActionStatus(null);
    if (!effectiveWallet) {
      setActionStatus("Paste a wallet address or connect a wallet first.");
      return;
    }
    const txHash = feedTxHash.trim();
    if (txHash && (!feedAmount || Number(feedAmount) <= 0)) {
      setActionStatus("Enter a valid amount when providing a transaction hash.");
      return;
    }
    try {
      const response = await fetch("/api/feed/verify", {
        method: "POST",
        headers: {
          ...headers,
          "x-wallet-address": effectiveWallet,
        },
        body: JSON.stringify({
          ...(txHash ? { txHash, registeredWallet: effectiveWallet } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        const msg = data.error ?? "Feed failed.";
        const detail = data.detail ? ` ${data.detail}` : "";
        const expected = data.expectedWallet ? ` Use this wallet in "Wallet address" above: ${data.expectedWallet}` : "";
        setActionStatus(msg + detail + expected);
        return;
      }
      const amount = typeof data.amount === "number" ? data.amount : (feedAmount ? Number(feedAmount) : 0);
      const credits = typeof data.feedCredits === "number" ? data.feedCredits : (myLobster?.feedCredits ?? 0);
      setActionStatus(
        credits >= 0
          ? `Verified successfully. ${amount > 0 ? `${amount} tokens added; ` : ""}${credits} feed${credits === 1 ? "" : "s"} remaining. Combat boost active.`
          : amount > 0
            ? `Thank you for feeding your lobster. ${amount} tokens applied; combat boost active.`
            : "Thank you for feeding your lobster.",
      );
      setFeedTxHash("");
      setMyLobster((prev) => (prev ? { ...prev, feedCredits: credits } : null));
      const lobsterName = myLobsterFromTank?.displayName ?? data.lobsterId ?? "A lobster";
      addTankEvents([
        {
          id: `feed-${data.lobsterId}-${Date.now()}`,
          type: "feed",
          createdAt: Date.now(),
          payload: {
            lobsterId: data.lobsterId,
            message: `${lobsterName} has been fed! Temporary combat boost active.`,
          },
        },
      ]);
      setPetBoostFromMe(data.lobsterId ?? null, data.petBoostUntil ?? null);
      if (effectiveWallet) {
        try {
          const meRes = await fetch("/api/me", {
            headers: { "Content-Type": "application/json", "x-wallet-address": effectiveWallet },
          });
          const meData = await meRes.json();
          if (meRes.ok && meData.lobster) {
            setMyLobster((prev) => (prev && meData.lobster ? { ...prev, ...meData.lobster, feedCredits: meData.lobster.feedCredits ?? prev.feedCredits } : prev));
            setPetBoostFromMe(meData.lobster.id ?? null, meData.lobster.petBoostUntil ?? null);
            if (onRefetchMyLobster) await onRefetchMyLobster();
          }
          fetchLastTransfers();
        } catch {
          // ignore refetch errors
        }
      }
    } catch {
      setActionStatus("Feed failed.");
    }
  };

  const feedCredits = myLobster?.feedCredits ?? 0;
  const [feedUseLoading, setFeedUseLoading] = useState(false);
  const [lastTransfers, setLastTransfers] = useState<{ amount: number; time: number }[]>([]);
  const [lastTransfersLoading, setLastTransfersLoading] = useState(false);
  const fetchLastTransfers = useCallback(async () => {
    if (!effectiveWallet) return;
    setLastTransfersLoading(true);
    try {
      const res = await fetch(`/api/wallet/transactions?address=${encodeURIComponent(effectiveWallet)}`);
      const data = (await res.json()) as { transfers?: { amount: number; time: number }[] };
      if (res.ok && Array.isArray(data.transfers)) setLastTransfers(data.transfers);
    } catch {
      setLastTransfers([]);
    } finally {
      setLastTransfersLoading(false);
    }
  }, [effectiveWallet]);
  useEffect(() => {
    if (effectiveWallet) fetchLastTransfers();
  }, [effectiveWallet, fetchLastTransfers]);
  const lastTransfer = lastTransfers[0];

  const handleUseFeed = async () => {
    setActionStatus(null);
    if (!effectiveWallet) {
      setActionStatus("Connect or paste your wallet first.");
      return;
    }
    if (feedCredits < 1) {
      setActionStatus("No feeds remaining. Verify a token transfer to add feeds.");
      return;
    }
    setFeedUseLoading(true);
    try {
      const response = await fetch("/api/feed/use", {
        method: "POST",
        headers: { ...headers, "x-wallet-address": effectiveWallet },
      });
      const data = await response.json();
      if (!response.ok) {
        setActionStatus(data.error ?? "Use feed failed.");
        return;
      }
      const remaining = typeof data.feedCredits === "number" ? data.feedCredits : feedCredits - 1;
      setMyLobster((prev) => (prev ? { ...prev, feedCredits: remaining } : null));
      setActionStatus(`Fed! ${remaining} feed${remaining === 1 ? "" : "s"} remaining. Combat boost active.`);
      setPetBoostFromMe(data.lobsterId ?? null, data.petBoostUntil ?? null);
      addTankEvents([
        {
          id: `feed-use-${data.lobsterId}-${Date.now()}`,
          type: "feed",
          createdAt: Date.now(),
          payload: {
            lobsterId: data.lobsterId,
            message: `${myLobsterFromTank?.displayName ?? "Your lobster"} has been fed!`,
          },
        },
      ]);
      if (onRefetchMyLobster) await onRefetchMyLobster();
    } catch {
      setActionStatus("Use feed failed.");
    } finally {
      setFeedUseLoading(false);
    }
  };

  const handleOpenFeedSendInPhantom = () => {
    setActionStatus(null);
    if (!tankBankAddress) {
      setActionStatus("Tank bank address is not configured. Ask the owner to set NEXT_PUBLIC_TANK_BANK_ADDRESS in .env.");
      return;
    }
    // Use extension wallet for reference if connected; otherwise effectiveWallet so Phantom pay URL still works
    const walletForRef = (publicKey?.toBase58() ?? effectiveWallet) ?? "";
    const amount = Number(feedAmount) > 0 ? feedAmount : "100";
    try {
      const url = new URL("https://phantom.app/ul/v1/pay");
      url.searchParams.set("recipient", tankBankAddress);
      url.searchParams.set("amount", amount);
      if (walletForRef) url.searchParams.set("reference", walletForRef);
      url.searchParams.set("label", "Lobster Tank Feed");
      url.searchParams.set("message", "Feed your lobster in the Lobster Tank.");
      window.open(url.toString(), "_blank", "noopener,noreferrer");
      setActionStatus("Phantom send opened. After you confirm the transfer, paste the transaction hash below and click Verify feed.");
    } catch {
      setActionStatus("Could not open Phantom send link. Send tokens manually to the tank bank address and paste the tx hash below.");
    }
  };
  const wrapperClass =
    layout === "toolbar"
      ? "mt-6 flex flex-col w-full"
      : "flex h-full flex-col gap-6 rounded-2xl border border-slate-200 bg-slate-50/80 p-6 text-slate-900 shadow-sm";
  const tabRowClass =
    layout === "toolbar"
      ? "flex flex-nowrap gap-1 overflow-x-auto border-b border-slate-200 pb-2 min-h-[40px] items-center"
      : "mb-4 flex flex-wrap gap-1 border-b border-slate-200 pb-2";
  const cardClass =
    layout === "toolbar"
      ? "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
      : "";

  const defaultEditColors: MyLobsterColors = useMemo(
    () => ({
      bodyColor: myLobsterColors?.bodyColor ?? "#c85c42",
      clawColor: myLobsterColors?.clawColor ?? "#8b4513",
      bandanaColor: myLobsterColors?.bandanaColor ?? "#94a3b8",
    }),
    [myLobsterColors?.bodyColor, myLobsterColors?.clawColor, myLobsterColors?.bandanaColor],
  );
  const [currentViewEditColors, setCurrentViewEditColors] = useState<MyLobsterColors>(defaultEditColors);
  useEffect(() => {
    if (myLobsterId && myLobsterColors) setCurrentViewEditColors(myLobsterColors);
  }, [myLobsterId, myLobsterColors?.bodyColor, myLobsterColors?.clawColor, myLobsterColors?.bandanaColor]);

  const handleCurrentViewColorChange = useCallback(
    (field: keyof MyLobsterColors, value: string) => {
      const next = { ...currentViewEditColors, [field]: value };
      setCurrentViewEditColors(next);
      onMyLobsterColorsChange?.(next);
    },
    [currentViewEditColors, onMyLobsterColorsChange],
  );

  type ControlTab = "your-lobster" | "selected" | "all-lobsters" | "actions";
  const [controlTab, setControlTab] = useState<ControlTab>("your-lobster");
  const tabLabels: Record<ControlTab, string> = {
    "your-lobster": "Your lobster",
    "selected": "Selected",
    "all-lobsters": "All lobsters",
    "actions": "Actions",
  };

  useEffect(() => {
    if (selectedLobsterId != null) setControlTab("selected");
  }, [selectedLobsterId]);

  // When the user clicks the "Your lobster" tab and we know which lobster is theirs,
  // automatically switch the tank camera into first-person POV from that lobster.
  return (
    <aside className={wrapperClass}>
      <div className={tabRowClass}>
        {(Object.keys(tabLabels) as ControlTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setControlTab(tab)}
            className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
              controlTab === tab
                ? "bg-teal-100 text-teal-800"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {tabLabels[tab]}
          </button>
        ))}
      </div>
      {controlTab === "your-lobster" ? (
      <div className={`${cardClass} space-y-2`}>
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-500">
          Current View
        </p>
        {myLobsterId ? (
          <>
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">Your lobster</h2>
            {myLobsterFromTank ? (
              <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/50 p-3">
                {/* HP bar */}
                <div className="flex items-center gap-3">
                  <span className="text-xs font-medium text-slate-500 w-6">HP</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-teal-500 transition-all"
                      style={{ width: `${Math.max(0, Math.min(100, myLobsterFromTank.health ?? 100))}%` }}
                    />
                  </div>
                  <span className="text-xs tabular-nums text-slate-600">{Math.round(myLobsterFromTank.health ?? 100)}/100</span>
                </div>
                {/* XP bar */}
                {(() => {
                  const xp = myLobsterFromTank.xp ?? 0;
                  const xpForNext = myLobsterFromTank.level * 100;
                  const xpInLevel = xp % xpForNext;
                  const pct = Math.min(100, Math.round((xpInLevel / xpForNext) * 100));
                  return (
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-medium text-slate-500 w-6">XP</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
                        <div className="h-full rounded-full bg-indigo-400 transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs tabular-nums text-slate-600">{xpInLevel}/{xpForNext}</span>
                    </div>
                  );
                })()}
                {/* Boost status */}
                {(() => {
                  const boostEnd = getPetBoostEndByLobsterId()[myLobsterId!];
                  const remaining = boostEnd ? Math.max(0, boostEnd - Date.now()) : 0;
                  if (remaining <= 0) return null;
                  const mins = Math.floor(remaining / 60000);
                  const secs = Math.floor((remaining % 60000) / 1000);
                  return (
                    <div className="flex items-center gap-2 rounded-lg border-2 border-amber-400 bg-gradient-to-r from-amber-50 to-yellow-50 px-3 py-1.5 shadow-sm" title="3× speed & damage in tank">
                      <span className="text-xs font-bold text-amber-800">Golden boosted</span>
                      <span className="text-xs tabular-nums font-medium text-amber-700">{mins}:{String(secs).padStart(2, "0")} remaining</span>
                    </div>
                  );
                })()}
                {(myLobsterFromTank as { _lastBehavior?: string })._lastBehavior != null ? (
                  <p className="text-xs text-slate-500">
                    Behavior: <span className="font-medium text-slate-700">{(myLobsterFromTank as { _lastBehavior?: string })._lastBehavior}</span>
                  </p>
                ) : null}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                  <span className="text-slate-500">Level</span>
                  <span className="font-medium text-slate-900">{myLobsterFromTank.level}</span>
                  <span className="text-slate-500">Shrimp</span>
                  <span className="font-medium text-slate-900">{myLobsterFromTank.shrimpEaten ?? Math.floor((myLobsterFromTank.xp ?? 0) / 10)}</span>
                  <span className="text-slate-500">Kills</span>
                  <span className="font-medium text-slate-900">{myLobsterFromTank.lobsterKills ?? 0}</span>
                  <span className="text-slate-500">Deaths</span>
                  <span className="font-medium text-slate-900">{myLobsterFromTank.losses ?? 0}</span>
                  <span className="text-slate-500">Community</span>
                  <span className="font-medium text-slate-900">{tankCommunities.find((c) => c.id === myLobsterFromTank.communityId)?.name ?? "—"}</span>
                </div>
                {!myLobsterFromTank.communityId ? (
                  <JoinCommunityInline
                    onJoined={() => { /* refetch handled by parent or sim sync */ }}
                  />
                ) : null}
                {myLobsterAggressionTargets.length > 0 ? (
                  <p className="mt-2 text-xs text-slate-500">
                    Aggression building towards: {myLobsterAggressionTargets.map((t) => `${t.name} (${t.count} shrimp lost)`).join(", ")} — may fight when it reaches 4.
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setControlTab("actions")}
                className="rounded-full bg-teal-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-600"
              >
                Feed
              </button>
              <button
                type="button"
                onClick={handlePet}
                disabled={!effectiveWallet || !myLobsterId}
                className="rounded-full border border-teal-300 bg-white px-3 py-1.5 text-xs font-semibold text-teal-700 hover:bg-teal-50 disabled:opacity-50"
              >
                Pet
              </button>
              <Link
                href="/me"
                className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Claim / Me
              </Link>
              {onRequestFirstPerson && myLobsterId ? (
                <button
                  type="button"
                  onClick={() => onRequestFirstPerson(myLobsterId)}
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  1st person view
                </button>
              ) : null}
            </div>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Customization</h3>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="h-[260px] w-[320px] max-w-full shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-100 pointer-events-auto">
                <Canvas camera={{ position: [0, 0, 4], fov: 45 }} style={{ width: "100%", height: "100%" }}>
                  <ambientLight intensity={0.9} />
                  <directionalLight position={[2, 2, 2]} intensity={0.8} />
                  <OrbitControls enableZoom={false} enablePan={false} />
                  <CurrentViewLobsterPreview
                    bodyColor={currentViewEditColors.bodyColor}
                    clawColor={currentViewEditColors.clawColor}
                    bandanaColor={currentViewEditColors.bandanaColor}
                  />
                </Canvas>
              </div>
              <div className="flex flex-col gap-2 min-w-0">
                <label className="flex items-center gap-2 text-xs text-slate-600">
                  <span className="w-14 shrink-0">Body</span>
                  <input
                    type="color"
                    value={currentViewEditColors.bodyColor}
                    onChange={(e) => handleCurrentViewColorChange("bodyColor", e.target.value)}
                    className="h-9 w-20 cursor-pointer rounded border border-slate-300"
                  />
                </label>
                <label className="flex items-center gap-2 text-xs text-slate-600">
                  <span className="w-14 shrink-0">Claw</span>
                  <input
                    type="color"
                    value={currentViewEditColors.clawColor}
                    onChange={(e) => handleCurrentViewColorChange("clawColor", e.target.value)}
                    className="h-9 w-20 cursor-pointer rounded border border-slate-300"
                  />
                </label>
                <label className="flex items-center gap-2 text-xs text-slate-600">
                  <span className="w-14 shrink-0">Bandana</span>
                  <input
                    type="color"
                    value={currentViewEditColors.bandanaColor}
                    onChange={(e) => handleCurrentViewColorChange("bandanaColor", e.target.value)}
                    className="h-9 w-20 cursor-pointer rounded border border-slate-300"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    handleCurrentViewColorChange("bodyColor", "#c85c42");
                    handleCurrentViewColorChange("clawColor", "#8b4513");
                    handleCurrentViewColorChange("bandanaColor", "#94a3b8");
                  }}
                  className="mt-1 text-xs font-medium text-slate-500 hover:text-slate-700 underline"
                >
                  Reset colors
                </button>
              </div>
            </div>
            {myLobsterFromTank ? (
              <>
                {myLobsterDead ? (
                  <div className="border-t border-slate-200 pt-3 mt-2 space-y-2">
                    <p className="text-sm font-medium text-rose-700">Your lobster has fallen.</p>
                    <p className="text-xs text-slate-600">
                      Respawn in{" "}
                      <span className="font-medium text-slate-900">
                        {Math.max(0, Math.ceil((myLobsterFromTank.respawnAt! - Date.now()) / 1000))}s
                      </span>{" "}
                      or pay 20 tokens to respawn now.
                    </p>
                    {publicEnv.NEXT_PUBLIC_TANK_BANK_ADDRESS ? (
                      <p className="text-[10px] text-slate-500 break-all">
                        Send 20 tokens to: {publicEnv.NEXT_PUBLIC_TANK_BANK_ADDRESS}
                      </p>
                    ) : null}
                    <input
                      type="text"
                      placeholder="Transaction hash"
                      value={instantRespawnTxHash}
                      onChange={(e) => {
                        setInstantRespawnTxHash(e.target.value);
                        setInstantRespawnError(null);
                      }}
                      className="w-full rounded border border-slate-200 px-2 py-1 text-xs"
                    />
                    {instantRespawnError ? (
                      <p className="text-xs text-rose-600">{instantRespawnError}</p>
                    ) : null}
                    <button
                      type="button"
                      disabled={instantRespawnSubmitting || !instantRespawnTxHash.trim() || !publicKey}
                      onClick={async () => {
                        if (!myLobsterFromTank || !publicKey) return;
                        setInstantRespawnError(null);
                        setInstantRespawnSubmitting(true);
                        try {
                          const res = await fetch("/api/lobsters/instant-respawn", {
                            method: "POST",
                            headers: { "Content-Type": "application/json", "x-wallet-address": publicKey.toBase58() },
                            body: JSON.stringify({
                              lobsterId: myLobsterFromTank.id,
                              txHash: instantRespawnTxHash.trim(),
                              registeredWallet: publicKey.toBase58(),
                            }),
                          });
                          const data = await res.json().catch(() => ({}));
                          if (res.ok && data.ok) {
                            setPendingInstantRespawnLobsterId(myLobsterFromTank.id);
                            setInstantRespawnTxHash("");
                          } else {
                            setInstantRespawnError(data.error ?? "Respawn failed");
                          }
                        } catch {
                          setInstantRespawnError("Request failed");
                        } finally {
                          setInstantRespawnSubmitting(false);
                        }
                      }}
                      className="w-full rounded bg-teal-600 px-2 py-1.5 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-50"
                    >
                      {instantRespawnSubmitting ? "Respawn…" : "Respawn now (20 tokens)"}
                    </button>
                  </div>
                ) : null}
              <div className="grid grid-cols-2 gap-2 text-xs text-slate-700 border-t border-slate-200 pt-3 mt-2">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Level</p>
                  <p className="font-semibold">{myLobsterFromTank.level}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Health</p>
                  <p className="font-semibold">{Math.round(myLobsterFromTank.health ?? 100)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Kills</p>
                  <p className="font-semibold">{myLobsterFromTank.lobsterKills ?? 0}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Deaths</p>
                  <p className="font-semibold">{myLobsterFromTank.losses ?? 0}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400" title="Chance to become friends (next encounter)">Friendship chance</p>
                  <p className="font-semibold">
                    {(() => {
                      const others = tankLobsters.filter((l) => l.id !== myLobsterFromTank.id);
                      if (others.length === 0) return "—";
                      const avg = others.reduce((s, l) => s + getFriendshipChance(tankRelationships ?? {}, myLobsterFromTank.id, l.id), 0) / others.length;
                      return `${Math.min(100, Math.round(avg * 100))}% (avg)`;
                    })()}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400" title="Chance to attack when competing for shrimp">Attack chance</p>
                  <p className="font-semibold">
                    {(() => {
                      const others = tankLobsters.filter((l) => l.id !== myLobsterFromTank.id);
                      if (others.length === 0) return "—";
                      const avg = others.reduce((s, l) => s + getAttackChance(tankRelationships ?? {}, myLobsterFromTank.id, l.id), 0) / others.length;
                      return `${Math.min(100, Math.round(avg * 100))}% (avg)`;
                    })()}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Damage</p>
                  <p className="font-semibold">
                    {myLobsterDamageRange
                      ? myLobsterBoosted
                        ? `${myLobsterDamageRange.minDamage * BOOST_MULT}-${myLobsterDamageRange.maxDamage * BOOST_MULT}`
                        : `${myLobsterDamageRange.minDamage}-${myLobsterDamageRange.maxDamage}`
                      : "—"}
                    {myLobsterBoosted ? (
                      <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800" title="Combat boost active">Boosted</span>
                    ) : null}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Speed</p>
                  <p className="font-semibold">
                    {myLobsterFromTank
                      ? (myLobsterBoosted ? getSpeed(myLobsterFromTank) * BOOST_MULT : getSpeed(myLobsterFromTank)).toFixed(1)
                      : "—"}
                    {myLobsterBoosted ? (
                      <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800" title="Combat boost active">Boosted</span>
                    ) : null}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Community</p>
                  <p className="font-semibold">{myLobsterFromTank.communityId ?? "—"}</p>
                </div>
              </div>
              {myLobsterFromTank && (aggressiveMode !== undefined || betrayMode !== undefined) ? (
                <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-3 mt-2">
                  {aggressiveMode !== undefined && onAggressiveChange ? (
                    <button
                      type="button"
                      onClick={() => onAggressiveChange(!aggressiveMode)}
                      className={`rounded px-2 py-1 text-xs font-medium ${aggressiveMode ? "bg-rose-100 text-rose-800" : "bg-slate-100 text-slate-600"}`}
                    >
                      {aggressiveMode ? "Aggressive ON" : "Aggressive"}
                    </button>
                  ) : null}
                  {betrayMode !== undefined && onBetrayChange ? (
                    <button
                      type="button"
                      onClick={() => onBetrayChange(!betrayMode)}
                      className={`rounded px-2 py-1 text-xs font-medium ${betrayMode ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"}`}
                    >
                      {betrayMode ? "Betray ON" : "Betray"}
                    </button>
                  ) : null}
                </div>
              ) : null}
              </>
            ) : null}
            {publicKey && myLobsterId && onRefetchMyLobster ? (
              <SaveMyLobsterColorsButton
                lobsterId={myLobsterId}
                colors={currentViewEditColors}
                walletAddress={publicKey.toBase58()}
                onSaved={onRefetchMyLobster}
              />
            ) : null}
            {myLobsterId && tankEvents.length > 0 ? (
              <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/50 p-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Recent events for your lobster</h3>
                <div className="max-h-[120px] space-y-1 overflow-y-auto text-xs">
                  {tankEvents
                    .filter((e) => {
                      const p = e.payload as Record<string, unknown>;
                      return p?.winnerId === myLobsterId || p?.loserId === myLobsterId || p?.lobsterId === myLobsterId || (Array.isArray(p?.lobsterIds) && (p.lobsterIds as string[]).includes(myLobsterId));
                    })
                    .slice(0, 8)
                    .map((event) => (
                      <div key={event.id} className="rounded border border-slate-100 bg-white px-2 py-1">
                        {renderNarration(event)}
                      </div>
                    ))}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900">{viewLabel}</h2>
            <p className="text-sm text-slate-600">
              Select a lobster in the tank and click &quot;Set as my lobster&quot; to preview and customize colours. Connect your wallet to unlock caretaker and owner actions.
            </p>
          </>
        )}
      </div>
      ) : null}

      {controlTab === "selected" ? (
        selectedLobsterFromTank ? (
        <div className={`${cardClass} space-y-3`}>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
            Selected lobster
          </h3>
          <div className="pointer-events-auto h-[260px] w-full max-w-[320px] shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
            <Canvas camera={{ position: [0, 0, 4], fov: 45 }} style={{ width: "100%", height: "100%" }}>
              <ambientLight intensity={0.9} />
              <directionalLight position={[2, 2, 2]} intensity={0.8} />
              <OrbitControls enableZoom={false} enablePan={false} />
              <CurrentViewLobsterPreview
                bodyColor={selectedLobsterFromTank.bodyColor ?? "#c85c42"}
                clawColor={selectedLobsterFromTank.clawColor ?? "#8b4513"}
                bandanaColor={
                  (selectedLobsterFromTank as { bandanaColor?: string | null }).bandanaColor
                  ?? tankCommunities.find((c) => c.id === selectedLobsterFromTank.communityId)?.color
                  ?? "#94a3b8"
                }
              />
            </Canvas>
          </div>
          <h3 className="text-base font-semibold text-slate-900">
            {selectedLobsterFromTank.displayName ?? selectedLobsterFromTank.id}
            <span className="ml-2 rounded-full bg-teal-100 px-2 py-0.5 text-xs font-medium text-teal-800">
              Lv.{selectedLobsterFromTank.level}
            </span>
          </h3>
          <div className="grid grid-cols-2 gap-2 text-xs text-slate-700">
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">ID</p>
              <p className="font-semibold">{selectedLobsterFromTank.id}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Level</p>
              <p className="font-semibold">{selectedLobsterFromTank.level}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Health</p>
              <p className="font-semibold">{Math.round(selectedLobsterFromTank.health ?? 100)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Shrimp eaten</p>
              <p className="font-semibold">{selectedLobsterFromTank.shrimpEaten ?? 0}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Size</p>
              <p className="font-semibold">{(selectedLobsterFromTank.size ?? 1).toFixed(2)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Status</p>
              <p className="font-semibold">{selectedLobsterFromTank.status ?? "Neutral"}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Lobster kills</p>
              <p className="font-semibold">{selectedLobsterFromTank.lobsterKills ?? 0}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Deaths</p>
              <p className="font-semibold">{selectedLobsterFromTank.losses ?? 0}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Deaths (lobsters)</p>
              <p className="font-semibold">{selectedLobsterFromTank.deathsFromLobsters ?? "—"}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Deaths (octopus)</p>
              <p className="font-semibold">{selectedLobsterFromTank.deathsFromOctopuses ?? "—"}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Community</p>
              <p className="font-semibold">{tankCommunities.find((c) => c.id === selectedLobsterFromTank.communityId)?.name ?? selectedLobsterFromTank.communityId ?? "—"}</p>
            </div>
            {(selectedLobsterFromTank as { _lastBehavior?: string })._lastBehavior != null ? (
              <div className="col-span-2">
                <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Behavior (sim)</p>
                <p className="font-semibold">{(selectedLobsterFromTank as { _lastBehavior?: string })._lastBehavior}</p>
              </div>
            ) : null}
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Damage</p>
              <p className="font-semibold">
                {damageRange
                  ? selectedLobsterBoosted
                    ? `${damageRange.minDamage * BOOST_MULT}-${damageRange.maxDamage * BOOST_MULT}`
                    : `${damageRange.minDamage}-${damageRange.maxDamage}`
                  : "—"}
                {selectedLobsterBoosted ? (
                  <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800" title="Combat boost active">Boosted</span>
                ) : null}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Speed</p>
              <p className="font-semibold">
                {selectedLobsterFromTank
                  ? (selectedLobsterBoosted ? getSpeed(selectedLobsterFromTank) * BOOST_MULT : getSpeed(selectedLobsterFromTank)).toFixed(1)
                  : "—"}
                {selectedLobsterBoosted ? (
                  <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800" title="Combat boost active">Boosted</span>
                ) : null}
              </p>
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">HP</p>
              <span className="text-xs text-slate-600">
                {Math.round(selectedLobsterFromTank.health ?? 100)} / 100
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-teal-500 transition-all"
                style={{
                  width: `${Math.max(0, Math.min(100, selectedLobsterFromTank.health ?? 100))}%`,
                }}
              />
            </div>
            {(() => {
              const sid = selectedLobsterFromTank.id;
              const rels = tankRelationships ?? {};
              const others = tankLobsters.filter((l) => l.id !== sid);
              const friendshipChances = others.map((l) => getFriendshipChance(rels, sid, l.id));
              const attackChances = others.map((l) => getAttackChance(rels, sid, l.id));
              const avgFriendship = others.length > 0
                ? friendshipChances.reduce((a, b) => a + b, 0) / others.length
                : 0;
              const avgAttack = others.length > 0
                ? attackChances.reduce((a, b) => a + b, 0) / others.length
                : 0;
              const friendshipPct = Math.min(100, Math.round(avgFriendship * 100));
              const attackPctSel = Math.min(100, Math.round(avgAttack * 100));
              return (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400" title="Chance to become friends (next encounter)">
                      Friendship chance
                    </p>
                    <span className="text-xs text-slate-600">{friendshipPct}%</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-amber-400/80"
                      style={{ width: `${friendshipPct}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400" title="Chance to attack when competing for shrimp">
                      Attack chance
                    </p>
                    <span className="text-xs text-slate-600">{attackPctSel}%</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-rose-500/80"
                      style={{ width: `${attackPctSel}%` }}
                    />
                  </div>
                </>
              );
            })()}
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Eat vs same level</p>
              <span className="text-xs text-slate-600">
                {Math.min(100, Math.round(((selectedLobsterFromTank.size ?? 1) / 2) * 100))}%
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-emerald-500/80"
                style={{
                  width: `${Math.max(0, Math.min(100, ((selectedLobsterFromTank.size ?? 1) / 2) * 100))}%`,
                }}
              />
            </div>
          </div>
          {(() => {
            const sid = selectedLobsterFromTank.id;
            const pairs = Object.entries(tankRelationships ?? {}).filter(
              ([key]) => key.startsWith(sid + "-") || key.endsWith("-" + sid),
            );
            const friendEntries = pairs
              .filter(([, r]) => r.likes >= 2)
              .map(([key, r]) => ({
                id: key.startsWith(sid + "-") ? key.slice(sid.length + 1) : key.slice(0, -sid.length - 1),
                likes: r.likes,
              }));
            const angerEntries = pairs
              .filter(([, r]) => r.conflicts > 0)
              .map(([key, r]) => ({
                id: key.startsWith(sid + "-") ? key.slice(sid.length + 1) : key.slice(0, -sid.length - 1),
                conflicts: r.conflicts,
              }));
            const name = (id: string) => tankLobsters.find((l) => l.id === id)?.displayName ?? id;
            const communityAggression = angerEntries.reduce<Record<string, number>>((acc, entry) => {
              const other = tankLobsters.find((l) => l.id === entry.id);
              if (other?.communityId) {
                acc[other.communityId] = (acc[other.communityId] ?? 0) + entry.conflicts;
              }
              return acc;
            }, {});
            const communityRows = Object.entries(communityAggression).map(([id, count]) => ({
              id,
              count,
              name: tankCommunities.find((c) => c.id === id)?.name ?? id,
            }));
            if (friendEntries.length === 0 && angerEntries.length === 0) return null;
            return (
              <div className="space-y-2">
                <h4 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                  Relationships
                </h4>
                {friendEntries.length > 0 ? (
                  <div>
                    <p className="text-[10px] text-slate-400">Friendships</p>
                    <ul className="mt-0.5 list-inside list-disc text-xs text-slate-700">
                      {friendEntries.map((entry) => (
                        <li key={entry.id}>{name(entry.id)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {angerEntries.length > 0 ? (
                  <div>
                    <p className="text-[10px] text-slate-400">Angers / rivalries</p>
                    <ul className="mt-0.5 list-inside list-disc text-xs text-slate-700">
                      {angerEntries.map((entry) => (
                        <li key={entry.id}>
                          {name(entry.id)} ({entry.conflicts})
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {communityRows.length > 0 ? (
                  <div>
                    <p className="text-[10px] text-slate-400">Community tensions</p>
                    <ul className="mt-0.5 list-inside list-disc text-xs text-slate-700">
                      {communityRows.map((entry) => (
                        <li key={entry.id}>
                          {entry.name} ({entry.count})
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            );
          })()}
          <div className="flex flex-wrap gap-2">
            {onRequestFirstPerson ? (
              <button
                type="button"
                onClick={() => onRequestFirstPerson(selectedLobsterFromTank.id)}
                className="rounded-full bg-teal-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-teal-600"
              >
                View in 1st person
              </button>
            ) : null}
            {onSetMyLobster && selectedLobsterFromTank ? (
              <button
                type="button"
                onClick={() => onSetMyLobster(selectedLobsterFromTank.id)}
                className="rounded-full border border-teal-400 bg-teal-50 px-3 py-1.5 text-xs font-semibold text-teal-700 hover:bg-teal-100"
              >
                Set as my lobster
              </button>
            ) : null}
            {onClearSelection ? (
              <button
                type="button"
                onClick={onClearSelection}
                className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Clear selection
              </button>
            ) : null}
          </div>
          <p className="text-[10px] text-slate-400">Click a lobster in the tank to select. Set as my lobster to customize; view in 1st person to see from its eyes (lobster keeps moving on its own).</p>
        </div>
        ) : (
        <div className={`${cardClass} space-y-3`}>
          <p className="text-sm font-medium text-slate-700">No lobster selected</p>
          <p className="text-sm text-slate-600">
            Click a lobster in the 3D tank to select it. Then use &quot;Set as my lobster&quot; to claim and edit name and colors.
          </p>
        </div>
        )
      ) : null}

      {controlTab === "all-lobsters" ? (
      <div className={`${cardClass} space-y-3`}>
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
          All lobsters in tank
        </h3>
        <div className="max-h-[240px] space-y-1 overflow-y-auto text-xs">
          {tankLobsters.length === 0 ? (
            <p className="text-slate-500">No lobsters in sim yet.</p>
          ) : (
            tankLobsters.map((lobster, index) => {
              const shrimp = lobster.shrimpEaten ?? 0;
              const nearLevelUp = shrimp > 0 && shrimp % 10 >= 8;
              const couragePct = Math.round((lobster.courage ?? 0.5) * 100);
              const community = lobster.communityId
                ? tankCommunities.find((c) => c.id === lobster.communityId)
                : null;
              const rowClass = index % 2 === 1 ? "bg-slate-50/70" : "bg-white";
              return (
                <div
                  key={lobster.id}
                  className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-lg border border-slate-100 px-2 py-1.5 ${rowClass}`}
                >
                  <span className="flex items-center gap-2 font-medium text-slate-900">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: community?.color ?? "#e2e8f0" }}
                    />
                    {lobster.displayName ?? lobster.id}
                    {nearLevelUp ? (
                      <span className="ml-1 text-amber-600" title="Near level-up">↑</span>
                    ) : null}
                  </span>
                  <span className="text-slate-500">Lv.{lobster.level}</span>
                  <span className="text-slate-500" title="Size">{(lobster.size ?? 1).toFixed(2)}</span>
                  <span className="text-slate-500">HP {lobster.health ?? 100}</span>
                  <span className="text-slate-500" title="Courage (trait)">{couragePct}%</span>
                  <span className="text-slate-500">{(lobster.shrimpEaten ?? 0)} shrimp</span>
                </div>
              );
            })
          )}
        </div>
        <p className="text-[10px] text-slate-400">Click a lobster in the 3D tank to select and view details.</p>
      </div>
      ) : null}

      {controlTab === "actions" ? (
      <div className={`${cardClass} space-y-3`}>
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
          Actions
        </h3>
        <div className="grid gap-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-3 space-y-3">
            <p className="text-xs text-slate-600">
              Send tokens to the tank bank, then paste the transaction hash below. Feeding costs tokens and immediately improves your lobster&apos;s probabilities and power, and can grant a temporary combat boost.
              {tankBankAddress
                ? ` The current tank bank wallet is ${tankBankAddress}.`
                : ""}
              {" "}The wallet that sent the tokens must be the same as in &quot;Wallet address&quot; below.
            </p>
            <label className="block text-[11px] font-medium uppercase tracking-[0.2em] text-slate-500">
              Transaction hash (signature)
            </label>
            <input
              type="text"
              placeholder="Optional: paste tx hash, or leave blank to use your latest transfer"
              value={feedTxHash}
              onChange={(e) => setFeedTxHash(e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 font-mono"
            />
            <label className="block text-[11px] font-medium uppercase tracking-[0.2em] text-slate-500">
              Feed amount
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                placeholder="100"
                value={feedAmount}
                onChange={(event) => setFeedAmount(event.target.value)}
                className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleOpenFeedSendInPhantom}
                  disabled={!tankBankAddress}
                  className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                >
                  Open in Phantom
                </button>
                <button
                  type="button"
                  onClick={handleFeed}
                  className="rounded-full bg-teal-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-600"
                >
                  Verify feed
                </button>
                {feedCredits > 0 ? (
                  <button
                    type="button"
                    onClick={handleUseFeed}
                    disabled={feedUseLoading}
                    className="rounded-full bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600 disabled:opacity-50"
                  >
                    {feedUseLoading ? "…" : "Use 1 feed"}
                  </button>
                ) : null}
              </div>
            </div>
            <p className="text-[11px] font-medium text-slate-600">
              Feeds remaining: <span className="tabular-nums">{feedCredits}</span>
              {feedCredits > 0 ? " — click “Use 1 feed” to spend one without sending more tokens." : " — verify a token transfer to the tank bank to add feeds (e.g. 100 tokens = 1 feed, 1000 = 10)."}
            </p>
            {lastTransfer != null ? (
              <p className="text-[11px] text-slate-500">
                Last transfer to tank bank: <span className="tabular-nums font-medium">{lastTransfer.amount}</span> tokens
                {lastTransfersLoading ? " (updating…)" : ""}
              </p>
            ) : lastTransfersLoading ? (
              <p className="text-[11px] text-slate-500">Checking recent transfers…</p>
            ) : null}
            <p className="text-[11px] text-slate-500">
              Leave the hash blank to verify using your most recent token transfer to the tank bank (same wallet as below). Or paste a tx hash after sending. If Phantom didn&apos;t open, send from your wallet manually then verify.
            </p>
          </div>
          {actionStatus ? (
            <p className="text-xs text-slate-600">{actionStatus}</p>
          ) : null}
        </div>
      </div>
      ) : null}

      <div className={`${cardClass} space-y-4`}>
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
          Wallet for ownership &amp; rewards
        </h3>
        <p className="text-xs text-slate-600">
          Enter the wallet address that holds your tokens (this wallet will receive rewards after the competition ends). Set a password for this login—you’ll use it to sign in later. You need 10,000+ tokens to claim a lobster. When you click Claim, a window opens to name your lobster and choose body and claw colours (head/bandana is set by your community and cannot be changed).
        </p>
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div>
            <label className="block text-[10px] font-medium uppercase tracking-[0.2em] text-slate-400">
              Wallet address
            </label>
            <input
              type="text"
              placeholder="Paste wallet address"
              value={walletOverride}
              onChange={(e) => {
                setWalletOverride(e.target.value);
                setConnectSuccess(false);
                setConnectBalance(null);
              }}
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
            />
          </div>
          <div>
            <label className="block text-[10px] font-medium uppercase tracking-[0.2em] text-slate-400">
              Password
            </label>
            <input
              type="password"
              placeholder="Set or enter password (min 6 characters)"
              value={connectPassword}
              onChange={(e) => setConnectPassword(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
              autoComplete="current-password"
            />
          </div>
          {myLobster && effectiveWallet ? (
            <p className="rounded-full border border-teal-200 bg-teal-50 px-4 py-2.5 text-sm font-medium text-teal-800" role="status">
              Logged in as <strong>{myLobster.displayName ?? "Owner"}</strong>{" "}
              <span className="font-mono text-slate-600">
                ({effectiveWallet.slice(0, 4)}…{effectiveWallet.slice(-4)})
              </span>
            </p>
          ) : null}
          <button
            type="button"
            onClick={handleConnect}
            disabled={connectLoading || !effectiveWallet || connectPassword.trim().length < 6}
            className="w-full rounded-full bg-teal-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-600 disabled:opacity-50"
          >
            {connectLoading ? "Connecting…" : myLobster && effectiveWallet ? "Sign in again" : "Connect wallet"}
          </button>
          {actionStatus ? (
            <p className={`text-xs ${actionStatus.startsWith("Hold") || actionStatus.startsWith("Caretaker") || actionStatus.startsWith("Connect") || actionStatus.startsWith("Failed") || actionStatus.startsWith("Wrong") ? "text-amber-700" : "text-teal-700"}`} role="alert">
              {actionStatus}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-xs">
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Token balance</p>
              <p className="font-semibold text-slate-900">
                {connectBalance !== null ? connectBalance : (eligibilityInfo?.balance ?? balance ?? 0)}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">Tier</p>
              <p className="font-semibold capitalize text-slate-900">
                {connectBalance !== null
                  ? (connectBalance >= 10000 ? "owner" : connectBalance >= 100 ? "caretaker" : "viewer")
                  : (eligibilityInfo?.tier ?? tier)}
              </p>
            </div>
          </div>
          {connectSuccess && (connectBalance ?? 0) >= 10000 ? (
            <div className="space-y-3 border-t border-slate-100 pt-3">
              {myLobster ? (
                <>
                  <p className="text-sm font-semibold text-teal-700">Your lobster</p>
                  <div className="space-y-2">
                    <label className="block text-[10px] font-medium uppercase tracking-[0.2em] text-slate-400">Name</label>
                    <input
                      type="text"
                      placeholder="Display name"
                      value={nameColorForm.displayName}
                      onChange={(e) => setNameColorForm((f) => ({ ...f, displayName: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
                    />
                    <div className="flex flex-wrap items-center gap-3">
                      <div>
                        <label className="block text-[10px] text-slate-400">Body</label>
                        <input
                          type="color"
                          value={nameColorForm.bodyColor}
                          onChange={(e) => setNameColorForm((f) => ({ ...f, bodyColor: e.target.value }))}
                          className="h-8 w-12 cursor-pointer rounded border border-slate-200"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] text-slate-400">Claws</label>
                        <input
                          type="color"
                          value={nameColorForm.clawColor}
                          onChange={(e) => setNameColorForm((f) => ({ ...f, clawColor: e.target.value }))}
                          className="h-8 w-12 cursor-pointer rounded border border-slate-200"
                        />
                      </div>
                    </div>
                    <p className="text-[10px] text-slate-500">Head (bandana) is set by your community.</p>
                    <button
                      type="button"
                      onClick={handleNameColorSubmit}
                      disabled={nameColorLoading}
                      className="rounded-full bg-teal-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-600 disabled:opacity-50"
                    >
                      {nameColorLoading ? "Saving…" : "Save name & colors"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-teal-700">Eligible to claim. Name your lobster and pick colors.</p>
                  <button
                    type="button"
                    onClick={() => setClaimModalOpen(true)}
                    className="w-full rounded-full bg-teal-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-600"
                  >
                    Claim lobster
                  </button>
                </>
              )}
            </div>
          ) : null}
          {claimModalOpen ? (
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="claim-modal-title">
              <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
                <h2 id="claim-modal-title" className="text-lg font-semibold text-slate-900">Name your lobster</h2>
                <p className="mt-1 text-xs text-slate-500">Choose a name and colors. Head (bandana) is set by your community and cannot be changed.</p>
                <div className="mt-4 space-y-3">
                  <div>
                    <label className="block text-[10px] font-medium uppercase tracking-[0.2em] text-slate-400">Name</label>
                    <input
                      type="text"
                      placeholder="Lobster name"
                      value={claimForm.displayName}
                      onChange={(e) => setClaimForm((f) => ({ ...f, displayName: e.target.value }))}
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900"
                    />
                  </div>
                  <div className="flex items-center gap-4">
                    <div>
                      <label className="block text-[10px] text-slate-400">Body</label>
                      <input
                        type="color"
                        value={claimForm.bodyColor}
                        onChange={(e) => setClaimForm((f) => ({ ...f, bodyColor: e.target.value }))}
                        className="h-9 w-14 cursor-pointer rounded border border-slate-200"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-400">Claws</label>
                      <input
                        type="color"
                        value={claimForm.clawColor}
                        onChange={(e) => setClaimForm((f) => ({ ...f, clawColor: e.target.value }))}
                        className="h-9 w-14 cursor-pointer rounded border border-slate-200"
                      />
                    </div>
                  </div>
                </div>
                <div className="mt-5 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setClaimModalOpen(false)}
                    className="flex-1 rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleClaimModalSubmit}
                    disabled={claimLoading}
                    className="flex-1 rounded-full bg-teal-500 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-600 disabled:opacity-50"
                  >
                    {claimLoading ? "Claiming…" : "Claim"}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
        <div className="text-[10px] text-slate-500">
          Or select wallet: <span className="inline-flex"><WalletMultiButton className="!inline-flex !h-8 !rounded-full !bg-slate-100 !px-3 !text-xs !text-slate-700 hover:!bg-slate-200" /></span>
        </div>
        <div className="space-y-2">
          <label className="flex cursor-pointer items-center justify-between rounded-lg border border-slate-100 bg-white px-3 py-2 text-xs text-slate-600">
            Low-power mode
            <input
              type="checkbox"
              checked={lowPower}
              onChange={onToggleLowPower}
              className="h-4 w-4 accent-teal-500"
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between rounded-lg border border-slate-100 bg-white px-3 py-2 text-xs text-slate-600">
            Reduced motion
            <input
              type="checkbox"
              checked={lowPower}
              onChange={onToggleLowPower}
              className="h-4 w-4 accent-teal-500"
            />
          </label>
        </div>
      </div>
    </aside>
  );
};

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
