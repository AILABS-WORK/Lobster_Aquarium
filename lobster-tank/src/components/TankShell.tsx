"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { TankProvider } from "@/contexts/TankContext";
import { TankScene } from "@/components/TankScene";
import { RightPanel } from "@/components/RightPanel";
import {
  getNearbyLobster,
  subscribeNearbyLobster,
} from "@/lib/nearby-lobster";
import {
  getFocusLobsterSnapshot,
  subscribeFocusLobster,
} from "@/lib/focus-lobster";
import { setPendingInstantRespawnLobsterId } from "@/lib/instant-respawn";
import { publicEnv } from "@/lib/public-env";

export type MyLobsterColors = {
  bodyColor: string;
  clawColor: string;
  bandanaColor: string;
};

const DEFAULT_MY_LOBSTER_COLORS: MyLobsterColors = {
  bodyColor: "#c85c42",
  clawColor: "#8b4513",
  bandanaColor: "#94a3b8",
};

type TankShellProps = {
  /** Optional; derived from pathname when not provided (for layout usage). */
  title?: string;
  /** Optional; derived from pathname when not provided. */
  viewLabel?: string;
  mode?: "global" | "focusLobster" | "focusCommunity";
  focusLobsterId?: string;
  focusCommunityId?: string;
  /** Tab-specific content (Community, Leaderboards, Me). Rendered prominently when present so tabs change the view. */
  children?: React.ReactNode;
};

type ViewOption = "aquarium" | "my-lobster" | "community" | "leaderboards";
type Aquarium = {
  id: string;
  name: string;
  maxLobsters: number;
};

export const TankShell = ({
  title: titleProp,
  viewLabel: viewLabelProp,
  mode: modeProp,
  focusLobsterId,
  focusCommunityId: focusCommunityIdProp,
  children,
}: TankShellProps) => {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [lowPower, setLowPower] = useState(false);
  const [viewDropdownOpen, setViewDropdownOpen] = useState(false);
  const [aquariums, setAquariums] = useState<Aquarium[]>([]);
  const [aquariumsLoaded, setAquariumsLoaded] = useState(false);
  const [selectedLobsterId, setSelectedLobsterId] = useState<string | null>(null);
  const [hoveredLobsterId, setHoveredLobsterId] = useState<string | null>(null);
  const [myLobsterId, setMyLobsterId] = useState<string | null>(null);
  const [myLobsterColors, setMyLobsterColors] = useState<MyLobsterColors | null>(null);
  const { publicKey } = useWallet();
  const nearbyLobster = useSyncExternalStore(
    subscribeNearbyLobster,
    getNearbyLobster,
    () => null,
  );
  const focusLobsterSnapshot = useSyncExternalStore(
    subscribeFocusLobster,
    getFocusLobsterSnapshot,
    () => null,
  );
  const selectedView: ViewOption =
    pathname === "/me"
      ? "my-lobster"
      : pathname === "/community"
        ? "community"
        : pathname === "/leaderboards"
          ? "leaderboards"
          : "aquarium";

  const viewLabelDisplay =
    selectedView === "aquarium"
      ? "Tank"
      : selectedView === "my-lobster"
        ? "Me"
        : selectedView === "community"
          ? "Community"
          : "Leaderboards";

  const title = titleProp ?? (selectedView === "aquarium" ? "Global Aquarium" : selectedView === "leaderboards" ? "Leaderboards" : selectedView === "community" ? "Community Waters" : "Your Lobster");
  const viewLabel = viewLabelProp ?? viewLabelDisplay;
  const mode = modeProp ?? (selectedView === "community" ? "focusCommunity" : "global");
  const focusCommunityId = focusCommunityIdProp ?? (selectedView === "community" ? "community-1" : undefined);

  const selectedAquariumId = searchParams.get("aquarium") ?? "global";
  const selectedAquarium = useMemo(
    () => aquariums.find((aquarium) => aquarium.id === selectedAquariumId),
    [aquariums, selectedAquariumId],
  );
  const [viewFirstPersonLobsterId, setViewFirstPersonLobsterId] = useState<string | null>(null);
  const [respawnTick, setRespawnTick] = useState(0);
  const [instantRespawnTxHash, setInstantRespawnTxHash] = useState("");
  const [instantRespawnSubmitting, setInstantRespawnSubmitting] = useState(false);
  const [instantRespawnError, setInstantRespawnError] = useState<string | null>(null);
  const [tankLobstersFromApi, setTankLobstersFromApi] = useState<{ id: string; displayName?: string | null; level: number; xp: number; size: number; wins: number; losses: number; status: string; traits?: unknown; communityId?: string | null; bodyColor?: string | null; clawColor?: string | null; bandanaColor?: string | null }[] | null>(null);
  const [firstPersonInvertY, setFirstPersonInvertY] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("lobster-firstPersonInvertY") === "1";
  });
  const [aggressiveMode, setAggressiveMode] = useState(false);
  const [betrayMode, setBetrayMode] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const tankSectionRef = useRef<HTMLElement>(null);
  const effectiveFocusLobsterId = focusLobsterId ?? viewFirstPersonLobsterId ?? undefined;
  const effectiveViewMode =
    mode === "focusLobster" && focusLobsterId
      ? "firstPerson"
      : viewFirstPersonLobsterId
        ? "firstPerson"
        : "outside";

  useEffect(() => {
    let cancelled = false;
    const loadAquariums = async () => {
      try {
        const response = await fetch("/api/aquariums");
        const data = await response.json();
        if (!cancelled && response.ok && Array.isArray(data.aquariums)) {
          setAquariums(data.aquariums);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setAquariumsLoaded(true);
      }
    };
    loadAquariums();
    return () => {
      cancelled = true;
    };
  }, []);

  const [pendingLevelUpLevel, setPendingLevelUpLevel] = useState<number | null>(null);
  const [levelUpSubmitting, setLevelUpSubmitting] = useState(false);

  const refetchMyLobster = useCallback(async () => {
    if (!publicKey) return;
    try {
      const res = await fetch("/api/me", {
        headers: { "x-wallet-address": publicKey.toBase58() },
      });
      const data = await res.json();
      if (res.ok && data.lobster) {
        setMyLobsterId(data.lobster.id);
        setMyLobsterColors({
          bodyColor: data.lobster.bodyColor ?? DEFAULT_MY_LOBSTER_COLORS.bodyColor,
          clawColor: data.lobster.clawColor ?? DEFAULT_MY_LOBSTER_COLORS.clawColor,
          bandanaColor: data.lobster.bandanaColor ?? data.lobster.communityColor ?? DEFAULT_MY_LOBSTER_COLORS.bandanaColor,
        });
        setPendingLevelUpLevel(data.lobster.pendingLevelUpLevel ?? null);
      } else {
        setMyLobsterId(null);
        setMyLobsterColors(null);
        setPendingLevelUpLevel(null);
      }
    } catch {
      setMyLobsterId(null);
      setMyLobsterColors(null);
      setPendingLevelUpLevel(null);
    }
  }, [publicKey]);

  useEffect(() => {
    if (!publicKey) {
      setMyLobsterId(null);
      setMyLobsterColors(null);
      return;
    }
    refetchMyLobster();
  }, [publicKey?.toBase58(), refetchMyLobster]);

  const focusLobsterDead =
    focusLobsterSnapshot &&
    (focusLobsterSnapshot.health ?? 100) <= 0 &&
    focusLobsterSnapshot.respawnAt != null &&
    Date.now() < focusLobsterSnapshot.respawnAt;
  const focusLobsterWaitingRespawn =
    focusLobsterSnapshot &&
    (focusLobsterSnapshot.health ?? 100) <= 0 &&
    focusLobsterSnapshot.respawnAt != null;
  useEffect(() => {
    if (!focusLobsterWaitingRespawn) return;
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
  }, [focusLobsterWaitingRespawn]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/lobsters?aquarium=${encodeURIComponent(selectedAquariumId)}`);
        const data = await res.json();
        if (!cancelled && res.ok && Array.isArray(data.lobsters)) {
          setTankLobstersFromApi(data.lobsters);
        } else if (!cancelled) {
          setTankLobstersFromApi([]);
        }
      } catch {
        if (!cancelled) setTankLobstersFromApi([]);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [selectedAquariumId]);

  const handleSetMyLobster = useCallback((id: string, colors?: MyLobsterColors) => {
    setMyLobsterId(id);
    setMyLobsterColors(colors ?? DEFAULT_MY_LOBSTER_COLORS);
  }, []);

  const handleMyLobsterColorsChange = useCallback((colors: MyLobsterColors) => {
    setMyLobsterColors(colors);
  }, []);

  const handleAquariumChange = (nextId: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("aquarium", nextId);
    router.push(`${pathname}?${params.toString()}`);
  };

  const navTabs = [
    { href: "/", label: "Tank", view: "aquarium" as const },
    { href: "/community", label: "Community", view: "community" as const },
    { href: "/leaderboards", label: "Leaderboards", view: "leaderboards" as const },
    { href: "/me", label: "Me", view: "my-lobster" as const },
  ];

  const handleFullscreen = useCallback(() => {
    const el = tankSectionRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
      return;
    }
    el.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {
      setIsFullscreen(false);
    });
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  return (
    <TankProvider value={{ myLobsterId, publicKey: publicKey?.toBase58() ?? null }}>
    <div className="min-h-screen bg-white text-slate-900">
      <header className={`sticky top-0 z-20 border-b border-slate-200/70 bg-white/90 backdrop-blur ${isFullscreen ? "hidden" : ""}`}>
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-1.5 py-1.5 sm:flex-row sm:items-center sm:justify-between">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
              Lobster Tank
            </h1>
            <div className="flex flex-wrap items-center gap-3">
              <nav className="flex rounded-xl border border-slate-200 bg-slate-50/80 p-0.5" aria-label="Main">
                {navTabs.map((tab) => (
                  <Link
                    key={tab.href}
                    href={tab.href}
                    className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                      selectedView === tab.view
                        ? "bg-white text-slate-900 shadow-sm"
                        : "text-slate-600 hover:bg-white/60 hover:text-slate-900"
                    }`}
                  >
                    {tab.label}
                  </Link>
                ))}
              </nav>
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
                <label className="block text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Tank
                </label>
                <select
                  value={selectedAquariumId}
                  onChange={(event) => handleAquariumChange(event.target.value)}
                  className="mt-1 w-40 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700"
                  disabled={!aquariumsLoaded}
                >
                  <option value="global">Global Tank</option>
                  {aquariums
                    .filter((aquarium) => aquarium.id !== "global")
                    .map((aquarium) => (
                      <option key={aquarium.id} value={aquarium.id}>
                        {aquarium.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setViewDropdownOpen((o) => !o)}
                  className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
                  aria-expanded={viewDropdownOpen}
                  aria-haspopup="true"
                >
                  {viewLabelDisplay}
                  <svg
                    className="h-4 w-4 text-slate-500"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </button>
                {viewDropdownOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      aria-hidden="true"
                      onClick={() => setViewDropdownOpen(false)}
                    />
                    <div className="absolute right-0 z-20 mt-1 w-56 rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
                      <Link
                        href="/"
                        onClick={() => setViewDropdownOpen(false)}
                        className="block px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50"
                      >
                        Tank
                      </Link>
                      <Link
                        href="/me"
                        onClick={() => setViewDropdownOpen(false)}
                        className="block px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50"
                      >
                        Me
                      </Link>
                      {myLobsterId ? (
                        <button
                          type="button"
                          onClick={() => {
                            setViewFirstPersonLobsterId(myLobsterId);
                            setViewDropdownOpen(false);
                          }}
                          className="block w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50"
                        >
                          Switch to my lobster view
                        </button>
                      ) : null}
                      <Link
                        href="/community"
                        onClick={() => setViewDropdownOpen(false)}
                        className="block px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50"
                      >
                        Community
                      </Link>
                  <Link
                    href="/leaderboards"
                    onClick={() => setViewDropdownOpen(false)}
                    className="block px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    Leaderboards
                  </Link>
                </div>
              </>
                )}
              </div>
              <Link
                href="/login"
                className="hidden sm:inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                Login
              </Link>
              <button
                type="button"
                onClick={handleFullscreen}
                className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
                title="Aquarium full screen"
              >
                <svg className="h-4 w-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                </svg>
                Full screen
              </button>
            </div>
          </div>
        </div>
      </header>

      <section
        ref={tankSectionRef}
        className="relative flex h-[calc(100vh-52px)] w-full flex-col bg-slate-100"
      >
        <div className="relative flex-1 min-h-0 w-full h-full" style={{ minHeight: 1 }}>
        {isFullscreen ? (
          <button
            type="button"
            onClick={handleFullscreen}
            className="absolute top-3 right-3 z-50 flex items-center gap-2 rounded-lg bg-black/50 px-3 py-2 text-sm font-medium text-white backdrop-blur transition hover:bg-black/70"
            title="Exit full screen"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            Exit full screen
          </button>
        ) : null}
        <TankScene
          viewMode={effectiveViewMode}
          focusLobsterId={effectiveFocusLobsterId}
          lobsterCount={0}
          aquariumId={selectedAquariumId}
          initialLobstersFromApi={tankLobstersFromApi}
          selectedLobsterId={selectedLobsterId}
          hoveredLobsterId={hoveredLobsterId}
          onSelectLobster={(id) => setSelectedLobsterId(id)}
          onHoverLobster={(id) => setHoveredLobsterId(id)}
          lowPower={lowPower}
          myLobsterId={myLobsterId}
          myLobsterColors={myLobsterColors}
          firstPersonInvertY={firstPersonInvertY}
          aggressiveMode={aggressiveMode}
          betrayMode={betrayMode}
        />
        </div>
      </section>

      {effectiveViewMode === "firstPerson" && focusLobsterSnapshot ? (
        <div className="fixed top-20 right-4 z-40 w-56 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur">
          {focusLobsterDead ? (
            <>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Your lobster</p>
              <p className="mt-1 font-semibold text-slate-900">{focusLobsterSnapshot.displayName ?? focusLobsterSnapshot.id}</p>
              <p className="mt-2 text-sm font-medium text-rose-700">Your lobster has fallen.</p>
              <p className="mt-1 text-xs text-slate-600">
                Respawn in{" "}
                <span className="font-medium text-slate-900">
                  {Math.max(0, Math.ceil((focusLobsterSnapshot.respawnAt! - Date.now()) / 1000))}s
                </span>{" "}
                or pay 20 tokens to respawn now.
              </p>
              <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">
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
                    if (!focusLobsterSnapshot || !publicKey) return;
                    setInstantRespawnError(null);
                    setInstantRespawnSubmitting(true);
                    try {
                      const res = await fetch("/api/lobsters/instant-respawn", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "x-wallet-address": publicKey.toBase58() },
                        body: JSON.stringify({
                          lobsterId: focusLobsterSnapshot.id,
                          txHash: instantRespawnTxHash.trim(),
                          registeredWallet: publicKey.toBase58(),
                        }),
                      });
                      const data = await res.json().catch(() => ({}));
                      if (res.ok && data.ok) {
                        setPendingInstantRespawnLobsterId(focusLobsterSnapshot.id);
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
            </>
          ) : (
            <>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Your lobster</p>
              <p className="mt-1 font-semibold text-slate-900">{focusLobsterSnapshot.displayName ?? focusLobsterSnapshot.id}</p>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-600">
                <span>Level</span>
                <span className="font-medium text-slate-900">{focusLobsterSnapshot.level}</span>
                <span>Shrimp eaten</span>
                <span className="font-medium text-slate-900">{focusLobsterSnapshot.shrimpEaten ?? 0}</span>
                <span>Size</span>
                <span className="font-medium text-slate-900">{(focusLobsterSnapshot.size ?? 1).toFixed(2)}</span>
                <span>HP</span>
                <span className="font-medium text-slate-900">{focusLobsterSnapshot.health ?? 100}</span>
                <span>Kills</span>
                <span className="font-medium text-slate-900">{focusLobsterSnapshot.lobsterKills ?? 0}</span>
                <span>Deaths</span>
                <span className="font-medium text-slate-900">{focusLobsterSnapshot.losses ?? 0}</span>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-teal-500 transition-all"
                  style={{ width: `${Math.max(0, Math.min(100, focusLobsterSnapshot.health ?? 100))}%` }}
                />
              </div>
              <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">
                <label className="flex items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={firstPersonInvertY}
                    onChange={(e) => {
                      const v = e.target.checked;
                      setFirstPersonInvertY(v);
                      if (typeof window !== "undefined") window.localStorage.setItem("lobster-firstPersonInvertY", v ? "1" : "0");
                    }}
                    className="rounded border-slate-300"
                  />
                  Invert Y (look)
                </label>
              </div>
            </>
          )}
        </div>
      ) : null}

      {nearbyLobster && effectiveViewMode === "firstPerson" ? (
        <div className="fixed bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-xl border border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
          <p className="text-xs font-medium text-slate-500">Nearby: {(nearbyLobster.displayName ?? nearbyLobster.id)} · Lv.{nearbyLobster.level}</p>
          <p className="mt-1 text-xs text-slate-600">
            [1] Attack · [2] Befriend · [3] Join clan
          </p>
        </div>
      ) : null}

      {pendingLevelUpLevel != null && myLobsterId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="level-up-title">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <h2 id="level-up-title" className="text-lg font-semibold text-slate-900">Level up!</h2>
            <p className="mt-1 text-sm text-slate-600">Choose one stat to improve for level {pendingLevelUpLevel}.</p>
            <div className="mt-4 flex flex-col gap-2">
              {(["hp", "attackDamage", "friendshipChance", "attackHitChance", "critChance"] as const).map((stat) => (
                <button
                  key={stat}
                  type="button"
                  disabled={levelUpSubmitting}
                  onClick={async () => {
                    setLevelUpSubmitting(true);
                    try {
                      const res = await fetch(`/api/lobsters/${encodeURIComponent(myLobsterId)}/level-up`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "x-wallet-address": publicKey?.toBase58() ?? "" },
                        body: JSON.stringify({ stat }),
                      });
                      if (res.ok) {
                        setPendingLevelUpLevel(null);
                        await refetchMyLobster();
                      }
                    } finally {
                      setLevelUpSubmitting(false);
                    }
                  }}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left text-sm font-medium text-slate-800 transition hover:bg-teal-50 hover:border-teal-200 disabled:opacity-50"
                >
                  {stat === "hp" && "HP (max health)"}
                  {stat === "attackDamage" && "Attack damage"}
                  {stat === "friendshipChance" && "Friendship chance"}
                  {stat === "attackHitChance" && "Attack hit chance"}
                  {stat === "critChance" && "Critical hit chance"}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className={`sticky bottom-4 right-4 z-30 flex justify-end pointer-events-none ${isFullscreen ? "hidden" : ""}`}>
        <button
          type="button"
          onClick={() => document.getElementById("controls")?.scrollIntoView({ behavior: "smooth" })}
          className="pointer-events-auto flex flex-col items-center gap-1 rounded-full bg-white/90 px-4 py-2 shadow-lg backdrop-blur transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2"
          aria-label="Scroll to controls and panels below"
        >
          <span className="text-xs font-medium text-slate-600">Scroll for Controls</span>
          <svg className="h-5 w-5 text-slate-500 animate-bounce" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </button>
      </div>

      <main id="controls" className="relative z-10 mx-auto w-full max-w-[1920px] bg-white px-4 pt-10 pb-8 sm:px-6 lg:px-8">
        {children ? (
          pathname === "/" ? (
            <div className="mb-8">{children}</div>
          ) : (
            <div className="mb-8 max-h-[70vh] overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50/50 p-6 shadow-sm">
              {children}
            </div>
          )
        ) : null}
        <RightPanel
          viewLabel={viewLabel}
          lowPower={lowPower}
          onToggleLowPower={() => setLowPower((prev) => !prev)}
          aquariumId={selectedAquariumId}
          layout="toolbar"
          selectedLobsterId={selectedLobsterId}
          onRequestFirstPerson={(id) => setViewFirstPersonLobsterId(id)}
          onClearSelection={() => {
            setSelectedLobsterId(null);
            setViewFirstPersonLobsterId(null);
          }}
          myLobsterId={myLobsterId}
          myLobsterColors={myLobsterColors}
          onSetMyLobster={handleSetMyLobster}
          onMyLobsterColorsChange={handleMyLobsterColorsChange}
          onRefetchMyLobster={refetchMyLobster}
          aggressiveMode={aggressiveMode}
          onAggressiveChange={setAggressiveMode}
          betrayMode={betrayMode}
          onBetrayChange={setBetrayMode}
        />
      </main>
    </div>
    </TankProvider>
  );
};
