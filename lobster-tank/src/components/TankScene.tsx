"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { AdaptiveDpr, Html, OrbitControls } from "@react-three/drei";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as THREE from "three";
import { createInitialTankState, createInitialTankStateFromLobsters, createPredators, TANK_WALL_MARGIN, MAX_SPAWN_ELEVATION } from "@/sim/factory";
import { getSimDimensions } from "@/lib/sim-config";
import type { ApiLobster } from "@/sim/factory";
import { SEAWEED_SIM_POSITIONS } from "@/sim/obstacles";
import { shrimpToReachLevel, tickTankV2 } from "@/sim/engine-v2";
import { addTankEvents, clearTankEvents, hydrateTankEvents } from "@/lib/tank-events";
import { setFocusLobsterSnapshot } from "@/lib/focus-lobster";
import { setNearbyLobster } from "@/lib/nearby-lobster";
import { clearTankState, getTankState, setTankState as persistTankState } from "@/lib/tank-state";
import { getPetBoostEndByLobsterId } from "@/lib/pet-boost";
import { getPendingInstantRespawnLobsterId, setPendingInstantRespawnLobsterId } from "@/lib/instant-respawn";
import { sandBump, sandHeightAt } from "@/lib/sand-height";
import {
  getServerSnapshotCommunities,
  getServerSnapshotLobsters,
  getServerSnapshotPositions,
  getTankCommunities,
  getTankLobsterPositions3D,
  getTankLobsters,
  setTankLobsters,
  subscribeTankLobsters,
} from "@/lib/tank-lobsters";
import type { Community, Food, Lobster, Predator, RelationshipCounts, TankState } from "@/sim/types";
import type { MyLobsterColors } from "@/components/TankShell";
import { InstancedShrimpFood, type FoodInstanceData } from "@/components/InstancedShrimpFood";
import { LobsterMesh } from "@/components/LobsterMesh";
import { MergedStaticDecorations } from "@/components/MergedStaticDecorations";
import { OctopusMesh } from "@/components/OctopusMesh";
import { publicEnv } from "@/lib/public-env";

const FEED_THROTTLE_MS = 200;
const PERSIST_THROTTLE_MS = 2500;
/** Max sim time per frame so one slow frame doesn't jump too far. */
const MAX_CATCH_UP_MS = 100;

/** Event types to exclude from feed (e.g. wall/collision - user doesn't care about glass hits). */
const FEED_EXCLUDE_TYPES = new Set<string>([
  "system",
]);

/** Emit all events to feed except excluded types. No limit - show everything happening. */
const filterFeedEvents = <T extends { type: string }>(events: T[]): T[] =>
  events.filter((e) => !FEED_EXCLUDE_TYPES.has(e.type));
/** Throttle for writing focus/nearby to refs only; UI sync is separate and slower to avoid frame hitches. */
const FOCUS_NEARBY_THROTTLE_MS = 400;
/** How often we push first-person focus/nearby from refs to React stores (avoids re-renders every frame). */
const FIRST_PERSON_UI_SYNC_MS = 1800;
const scheduleIdle =
  typeof requestIdleCallback !== "undefined"
    ? requestIdleCallback
    : (cb: () => void) => setTimeout(cb, 0);
// Match server coordinate space (scale 1 = 800x600) so foods/lobsters render spaced out, not in one corner
const DEFAULT_TANK_SCALE = 1;
const { width: SIM_WIDTH, height: SIM_HEIGHT } = getSimDimensions(DEFAULT_TANK_SCALE);

/** Enforce state dimensions to match sim and clamp all positions (fix 11). */
function enforceStateDimensions(state: TankState, width: number, height: number) {
  const margin = TANK_WALL_MARGIN;
  state.width = width;
  state.height = height;
  const maxX = width - margin;
  const maxY = height - margin;
  for (const l of state.lobsters) {
    l.position.x = Math.max(margin, Math.min(maxX, l.position.x));
    l.position.y = Math.max(margin, Math.min(maxY, l.position.y));
  }
  for (const p of state.predators ?? []) {
    p.position.x = Math.max(margin, Math.min(maxX, p.position.x));
    p.position.y = Math.max(margin, Math.min(maxY, p.position.y));
  }
}

const TANK_BOX = [120, 80, 90] as const;
const INNER_MARGIN_3D = 1;
const LOBSTER_SCALE = 0.98;
const SEAWEED_HEIGHT = 32;
const SAND_BASE = "#e8d9bc";
const WATER_COLOR = "#6ec9c2";
const WATER_SURFACE = "#8de4dd";
const WATER_GLASS = "#c7f2ef";
const BASE_LOBSTER_HEIGHT = 0.7;
const PARTICLE_COUNT = 100;
const FOOD_RENDER_MAX = 64;
const INTERACT_RADIUS_SQ = 18 * 18;

const _quatA = new THREE.Quaternion();
const _quatB = new THREE.Quaternion();
const _quatC = new THREE.Quaternion();
const _targetQ = new THREE.Quaternion();
const _xAxis = new THREE.Vector3(1, 0, 0);
const _yAxis = new THREE.Vector3(0, 1, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);

/** Ensure color is opaque hex (no rgba/transparency) for lobster materials. */
function toOpaqueHex(c: string, fallback = "#c85c42"): string {
  const hex = /^#?([a-fA-F0-9]{2})([a-fA-F0-9]{2})([a-fA-F0-9]{2})$/.exec(c);
  if (hex) return `#${hex[1]}${hex[2]}${hex[3]}`.toLowerCase();
  const rgba = /rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(c);
  if (rgba) {
    const r = Math.min(255, parseInt(rgba[1], 10)).toString(16).padStart(2, "0");
    const g = Math.min(255, parseInt(rgba[2], 10)).toString(16).padStart(2, "0");
    const b = Math.min(255, parseInt(rgba[3], 10)).toString(16).padStart(2, "0");
    return `#${r}${g}${b}`;
  }
  return fallback;
}

/** Return span of food positions so we can skip merging server foods if they're all in a corner. */
function foodSpread(foods: Food[]): { spanX: number; spanY: number } {
  if (foods.length === 0) return { spanX: 0, spanY: 0 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const f of foods) {
    const x = f.position?.x ?? 0, y = f.position?.y ?? 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return {
    spanX: Number.isFinite(minX) && Number.isFinite(maxX) ? maxX - minX : 0,
    spanY: Number.isFinite(minY) && Number.isFinite(maxY) ? maxY - minY : 0,
  };
}

/** After reset, ensure lobsters and foods use full tank volume (elevation spread), not all at bottom. */
function ensureElevationSpread(state: TankState): void {
  const maxElev = MAX_SPAWN_ELEVATION;
  state.lobsters.forEach((l, i) => {
    const e = l.elevation ?? 0;
    if (e <= 0 || !Number.isFinite(e)) {
      l.elevation = (i * 1.31) % (maxElev + 1) + Math.random() * 8;
      if (l.elevation > maxElev) l.elevation = maxElev;
    }
  });
  state.foods.forEach((f, i) => {
    const e = f.elevation ?? 0;
    if (e <= 0 || !Number.isFinite(e)) {
      const layer = i % 3;
      f.elevation = (layer + 0.5) * (maxElev / 3) + (Math.random() - 0.5) * 40;
      f.elevation = Math.max(0, Math.min(maxElev, f.elevation));
    }
  });
}

/** Darken very light colors so lobsters stay visible against the water. */
function ensureVisibleColor(hex: string, fallback = "#c85c42"): string {
  const opaque = toOpaqueHex(hex, fallback);
  const m = /^#?([a-fA-F0-9]{2})([a-fA-F0-9]{2})([a-fA-F0-9]{2})$/.exec(opaque);
  if (!m) return fallback;
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  if (luminance <= 0.75) return opaque;
  const dark = { r: 0.78, g: 0.36, b: 0.26 };
  const blend = (luminance - 0.75) / 0.25;
  const R = Math.round((r * (1 - blend) + dark.r * blend) * 255);
  const G = Math.round((g * (1 - blend) + dark.g * blend) * 255);
  const B = Math.round((b * (1 - blend) + dark.b * blend) * 255);
  return `#${R.toString(16).padStart(2, "0")}${G.toString(16).padStart(2, "0")}${B.toString(16).padStart(2, "0")}`;
}

type TankSceneProps = {
  viewMode: "outside" | "firstPerson";
  focusLobsterId?: string;
  lobsterCount?: number;
  /** When set, sim is hydrated from these DB lobsters (claimed only); lobsterCount is ignored. */
  initialLobstersFromApi?: ApiLobster[] | null;
  aquariumId?: string;
  selectedLobsterId?: string | null;
  hoveredLobsterId?: string | null;
  onSelectLobster?: (id: string) => void;
  onHoverLobster?: (id: string | null) => void;
  lowPower?: boolean;
  myLobsterId?: string | null;
  myLobsterColors?: MyLobsterColors | null;
  /** When true, first-person look up/down is inverted (finger up = look up). */
  firstPersonInvertY?: boolean;
  aggressiveMode?: boolean;
  betrayMode?: boolean;
};

export const TankScene = ({
  viewMode,
  focusLobsterId,
  lobsterCount = 0,
  initialLobstersFromApi,
  aquariumId,
  selectedLobsterId,
  hoveredLobsterId,
  onSelectLobster,
  onHoverLobster,
  lowPower = false,
  myLobsterId,
  myLobsterColors,
  firstPersonInvertY = false,
  aggressiveMode = false,
  betrayMode = false,
}: TankSceneProps) => {
  const effectiveCount =
    Array.isArray(initialLobstersFromApi)
      ? initialLobstersFromApi.length
      : (lobsterCount ?? 0);
  return (
    <Canvas
      camera={{ position: [0, 28, 140], fov: 45, near: 0.1, far: 900 }}
      dpr={[1, 1.5]}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      shadows={false}
    >
      <AdaptiveDpr pixelated />
      <color attach="background" args={["#ffffff"]} />
      <ambientLight intensity={0.85} />
      <directionalLight position={[10, 20, 10]} intensity={0.9} />
      <directionalLight position={[-18, 26, -14]} intensity={0.45} />
      <TankContents
        viewMode={viewMode}
        focusLobsterId={focusLobsterId}
        lobsterCount={effectiveCount}
        initialLobstersFromApi={initialLobstersFromApi}
        aquariumId={aquariumId}
        selectedLobsterId={selectedLobsterId}
        hoveredLobsterId={hoveredLobsterId}
        onSelectLobster={onSelectLobster}
        onHoverLobster={onHoverLobster}
        lowPower={lowPower}
        myLobsterId={myLobsterId}
        myLobsterColors={myLobsterColors}
        firstPersonInvertY={firstPersonInvertY}
        aggressiveMode={aggressiveMode}
        betrayMode={betrayMode}
      />
    </Canvas>
  );
};

const TankContents = ({
  viewMode,
  focusLobsterId,
  lobsterCount = 0,
  initialLobstersFromApi,
  aquariumId,
  selectedLobsterId,
  hoveredLobsterId,
  onSelectLobster,
  onHoverLobster,
  lowPower = false,
  myLobsterId,
  myLobsterColors,
  firstPersonInvertY = false,
  aggressiveMode = false,
  betrayMode = false,
}: TankSceneProps) => {
  const aqId = aquariumId ?? "global";
  const saved = getTankState(aqId);
  const fromApi = Array.isArray(initialLobstersFromApi);
  const rawInitial =
    saved?.lobsterCount === lobsterCount && saved.state.lobsters.length === lobsterCount
      ? saved.state
      : fromApi
        ? createInitialTankStateFromLobsters(initialLobstersFromApi ?? [], SIM_WIDTH, SIM_HEIGHT, Math.random)
        : createInitialTankState(lobsterCount, SIM_WIDTH, SIM_HEIGHT, Math.random);
  const hasPredators = Array.isArray(rawInitial.predators) && rawInitial.predators.length >= 3;
  const initialState: TankState = hasPredators
    ? rawInitial
    : { ...rawInitial, predators: createPredators(SIM_WIDTH, SIM_HEIGHT, Math.random) };
  const stateRef = useRef<TankState>(initialState);
  const lobsterRefs = useRef<THREE.Group[]>([]);
  const predatorRefs = useRef<THREE.Group[]>([]);
  const foodIndexById = useRef<Map<string, number>>(new Map());
  const foodIdByIndex = useRef<(string | undefined)[]>([]);
  const foodInstanceDataRef = useRef<FoodInstanceData[]>(
    Array.from({ length: FOOD_RENDER_MAX }, () => ({ x: 0, y: 0, z: 0, rotY: 0, scale: 1, visible: false }))
  );
  const foodPosByIndexRef = useRef<{ x: number; y: number; z: number }[]>(
    Array.from({ length: FOOD_RENDER_MAX }, () => ({ x: 0, y: 0, z: 0 }))
  );
  const lastFeedEmitRef = useRef<number>(0);
  const lastPersistRef = useRef<number>(0);
  const lastFocusNearbyRef = useRef<number>(0);
  const lastLobsterListSigRef = useRef<string>("");
  const lastServerEventTimeRef = useRef<number>(0);
  const lastResetAtRef = useRef<number>(0);
  const controlsRef = useRef<any>(null);
  const ctrlRef = useRef(false);
  const movementRef = useRef({ forward: false, back: false, left: false, right: false, up: false, down: false, eat: false });
  const mouseRef = useRef({ x: 0, y: 0, pitch: 0 });
  const firstPersonSmoothedRef = useRef<{
    simX: number;
    simY: number;
    simElevation: number;
    heading: number;
    pitch: number;
    focusId: string | null;
  }>({ simX: 0, simY: 0, simElevation: 0, heading: 0, pitch: 0, focusId: null });
  /** Refs for 1st POV UI: written in useFrame, synced to stores on a slow interval to avoid frame hitches. */
  const firstPersonFocusSnapshotRef = useRef<Lobster | null>(null);
  const firstPersonNearbyRef = useRef<Lobster | null>(null);
  const [contextLost, setContextLost] = useState(false);
  const [resetting, setResetting] = useState(false);
  const { camera, gl } = useThree();

  const handleResetTank = useCallback(async (emptyTank = false) => {
    if (resetting) return;
    setResetting(true);
    try {
      const q = new URLSearchParams({ aquarium: aqId });
      if (emptyTank) q.set("empty", "1");
      const res = await fetch(`/api/tank-reset?${q.toString()}`, { method: "POST" });
      if (!res.ok) throw new Error("Reset failed");
      lastResetAtRef.current = Date.now();
      clearTankState(aqId);
      clearTankEvents();
      lastServerEventTimeRef.current = Date.now();
      const stateRes = await fetch(`/api/tank-state?aquarium=${encodeURIComponent(aqId)}`, { cache: "no-store" });
      if (!stateRes.ok) throw new Error("Fetch state failed");
      const data = await stateRes.json();
      if (data.lobsters && Array.isArray(data.lobsters)) {
        const dims = getSimDimensions(1);
        const width = data.width ?? stateRef.current.width ?? dims.width;
        const height = data.height ?? stateRef.current.height ?? dims.height;
        let foods = Array.isArray(data.foods) ? data.foods : stateRef.current.foods ?? [];
        // Fallback: if server returned no shrimp after reset, seed foods so lobsters have something to seek
        if (foods.length === 0) {
          const fallback = createInitialTankState(data.lobsters.length, width, height, Math.random);
          foods = fallback.foods;
        }
        const fresh: TankState = {
          width,
          height,
          time: data.time ?? 0,
          lobsters: data.lobsters,
          predators: data.predators ?? stateRef.current.predators,
          foods,
          lastFoodSpawn: data.time ?? Date.now(),
          communities: Array.isArray(data.communities) ? data.communities : [],
          relationships: data.relationships ?? {},
          communityEncounters: {},
          communityJoinAffinity: {},
          rivalEncounters: {},
          friendlyEncounterCount: {},
          lastFriendlyEncounterTime: {},
          lostShrimpToWinner: {},
          sameShrimpContests: {},
          _lastShrimpContestTime: {},
        };
        // Ensure full 3D volume: no one stuck at bottom (elevation 0) after reset
        ensureElevationSpread(fresh);
        stateRef.current = fresh;
        setTankLobsters(fresh.lobsters, undefined, fresh.communities, fresh.relationships);
        persistTankState(fresh, fresh.lobsters.length, aqId);
      }
    } catch {
      // ignore
    } finally {
      setResetting(false);
    }
  }, [aqId, resetting]);

  useEffect(() => {
    const canvas = gl.domElement;
    const onContextLost = (e: Event) => {
      e.preventDefault();
      setContextLost(true);
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    return () => canvas.removeEventListener("webglcontextlost", onContextLost);
  }, [gl]);

  const lobsterIds = useMemo(
    () =>
      fromApi && initialLobstersFromApi
        ? initialLobstersFromApi.map((l) => l.id)
        : Array.from({ length: lobsterCount }, (_, index) =>
            `LOB-${String(index + 1).padStart(3, "0")}`,
          ),
    [lobsterCount, aquariumId, fromApi, initialLobstersFromApi],
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

  useEffect(() => {
    const current = getTankState(aqId);
    if (current?.state.lobsters.length === 0) return; // keep intentionally empty tank (e.g. after "Empty tank")
    if (current?.lobsterCount === lobsterCount && current.state.lobsters.length === lobsterCount) return;
    stateRef.current = fromApi
      ? createInitialTankStateFromLobsters(initialLobstersFromApi ?? [], SIM_WIDTH, SIM_HEIGHT, Math.random)
      : createInitialTankState(lobsterCount, SIM_WIDTH, SIM_HEIGHT, Math.random);
  }, [aqId, lobsterCount, fromApi, initialLobstersFromApi]);

  useEffect(() => {
    setTankLobsters(
      stateRef.current.lobsters,
      undefined,
      stateRef.current.communities,
      stateRef.current.relationships,
      stateRef.current.lostShrimpToWinner,
    );

    let cancelled = false;
    const applyServerState = (data: {
      lobsters?: Lobster[];
      predators?: Predator[];
      foods?: Food[];
      communities?: Community[];
      relationships?: Record<string, RelationshipCounts>;
      lostShrimpToWinner?: Record<string, number>;
      time?: number;
      width?: number;
      height?: number;
    }) => {
      if (!data.lobsters || !Array.isArray(data.lobsters) || data.lobsters.length === 0) return;
      const current = stateRef.current;
      const isInitialLoad = current.lobsters.length === 0;

      if (isInitialLoad) {
        const dims = getSimDimensions(1);
        const loaded: TankState = {
          ...current,
          lobsters: data.lobsters,
          predators: data.predators ?? current.predators,
          foods: (data.foods && data.foods.length > 0) ? data.foods : (current.foods ?? []),
          communities: data.communities ?? current.communities,
          relationships: data.relationships ?? current.relationships,
          lostShrimpToWinner: data.lostShrimpToWinner ?? current.lostShrimpToWinner ?? {},
          time: data.time ?? current.time,
          width: data.width ?? current.width ?? dims.width,
          height: data.height ?? current.height ?? dims.height,
        };
        ensureElevationSpread(loaded);
        enforceStateDimensions(loaded, SIM_WIDTH, SIM_HEIGHT);
        stateRef.current = loaded;
        setTankLobsters(
        stateRef.current.lobsters,
        undefined,
        stateRef.current.communities,
        stateRef.current.relationships,
        stateRef.current.lostShrimpToWinner,
        );
        persistTankState(stateRef.current, stateRef.current.lobsters.length, aqId);
        return;
      }

      if (data.foods && data.foods.length > 0) {
        data.foods.forEach((f: Food, i: number) => {
          const e = f.elevation ?? 0;
          if (e <= 0 || !Number.isFinite(e)) {
            f.elevation = ((i % 3) + 0.5) * (MAX_SPAWN_ELEVATION / 3) + (Math.random() - 0.5) * 40;
            f.elevation = Math.max(0, Math.min(MAX_SPAWN_ELEVATION, f.elevation));
          }
        });
      }

      const localLobMap = new Map(current.lobsters.map(l => [l.id, l]));
      for (const sLob of data.lobsters) {
        const loc = localLobMap.get(sLob.id);
        if (loc) {
          loc.health = sLob.health;
          loc.maxHp = sLob.maxHp;
          loc.level = sLob.level;
          loc.xp = sLob.xp;
          loc.shrimpEaten = sLob.shrimpEaten;
          loc.lobsterKills = sLob.lobsterKills;
          loc.losses = sLob.losses;
          loc.deathsFromLobsters = sLob.deathsFromLobsters;
          loc.deathsFromOctopuses = sLob.deathsFromOctopuses;
          loc.communityId = sLob.communityId;
          // Stats only; let local engine drive behavior/targets for smooth sim.
          // loc.behaviorState = sLob.behaviorState;
          // loc.hostileTargetId = sLob.hostileTargetId;
          // loc.attackTargetId = sLob.attackTargetId;
          // loc.lastAttackedById = sLob.lastAttackedById;
          // loc.lastAttackedAt = sLob.lastAttackedAt;
          // loc.fleeFromId = sLob.fleeFromId;
          // loc.targetFoodId = sLob.targetFoodId;
          loc.respawnAt = sLob.respawnAt;
          loc.displayName = sLob.displayName;
          loc.bodyColor = sLob.bodyColor;
          loc.clawColor = sLob.clawColor;
        } else {
          current.lobsters.push(sLob);
        }
      }
      const serverIds = new Set(data.lobsters.map(l => l.id));
      current.lobsters = current.lobsters.filter(l => serverIds.has(l.id));

      if (data.predators && data.predators.length > 0) {
        const serverPredIds = new Set(data.predators.map((p: Predator) => p.id));
        current.predators = current.predators.filter(p => serverPredIds.has(p.id));

        const localPredMap = new Map(current.predators.map(p => [p.id, p]));
        for (const sPred of data.predators) {
          const loc = localPredMap.get(sPred.id);
          if (loc) {
            loc.health = sPred.health;
            loc.targetLobsterId = sPred.targetLobsterId;
            loc.attackCooldownUntil = sPred.attackCooldownUntil;
          } else {
            current.predators.push(sPred);
          }
        }
      }

      if (data.foods && data.foods.length > 0) {
        const spread = foodSpread(data.foods);
        if (spread.spanX >= 150 && spread.spanY >= 150) {
          const localFoodIds = new Set(current.foods.map(f => f.id));
          const serverFoodIds = new Set(data.foods.map(f => f.id));
          current.foods = current.foods.filter(f => serverFoodIds.has(f.id));
          for (const sFood of data.foods) {
            if (!localFoodIds.has(sFood.id)) current.foods.push(sFood);
          }
        }
      }
      current.communities = data.communities ?? current.communities;
      current.relationships = data.relationships ?? current.relationships;
      if (data.lostShrimpToWinner !== undefined) current.lostShrimpToWinner = data.lostShrimpToWinner;
      current.time = data.time ?? current.time;
      // Only accept server dimensions in the same scale as client (800×600); reject 4x smaller or 4x larger so creatures aren't flung to a corner
      const w = data.width ?? current.width;
      const h = data.height ?? current.height;
      if (w != null && w >= SIM_WIDTH * 0.5 && w <= SIM_WIDTH * 1.5) current.width = w;
      if (h != null && h >= SIM_HEIGHT * 0.5 && h <= SIM_HEIGHT * 1.5) current.height = h;
      enforceStateDimensions(current, SIM_WIDTH, SIM_HEIGHT);

      stateRef.current = current;
      setTankLobsters(
        current.lobsters,
        undefined,
        current.communities,
        current.relationships,
        current.lostShrimpToWinner,
      );
      persistTankState(current, current.lobsters.length, aqId);
    };

    const hydrateFromServer = async () => {
      try {
        const res = await fetch(`/api/tank-state?aquarium=${encodeURIComponent(aqId)}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        applyServerState(data);
      } catch {
        // server state not available, continue with local sim
      }
    };
    void hydrateFromServer();

    // Event fetcher for selected aquarium so feed shows friendship, food, predator, combat, etc.
    const fetchEvents = () => {
      if (cancelled) return;
      const since = lastServerEventTimeRef.current;
      fetch(`/api/tank-events/recent?since=${since}&aquarium=${encodeURIComponent(aqId)}`)
        .then((eventsRes) => (eventsRes.ok ? eventsRes.json() : { events: [] }))
        .then(({ events: newEvents }) => {
          if (cancelled) return;
          if (Array.isArray(newEvents) && newEvents.length > 0) {
            hydrateTankEvents(newEvents);
            const maxCreated = Math.max(...newEvents.map((e: { createdAt?: number }) => e.createdAt ?? 0));
            if (maxCreated > since) lastServerEventTimeRef.current = maxCreated;
          }
        })
        .catch(() => {});
    };

    const initialEventTimer = setTimeout(fetchEvents, 600);
    const eventPollInterval = setInterval(fetchEvents, 1500);

    const pollIntervalMs = 4000;
    const pollInterval = setInterval(async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/tank-state?aquarium=${encodeURIComponent(aqId)}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        const msSinceReset = lastResetAtRef.current ? Date.now() - lastResetAtRef.current : Infinity;
        const skipPollOverwrite = msSinceReset < 8000;
        if (!skipPollOverwrite && data.lobsters && Array.isArray(data.lobsters) && data.lobsters.length > 0) {
          applyServerState(data);
        }
        fetchEvents();
      } catch {
        // ignore
      }
    }, pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
      if (initialEventTimer != null) clearTimeout(initialEventTimer);
      if (eventPollInterval != null) clearInterval(eventPollInterval);
    };
  }, [aqId]);

  useEffect(() => {
    if (viewMode === "outside" && controlsRef.current) {
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.update();
    }
  }, [viewMode]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent, pressed: boolean) => {
      if (event.key === "w" || event.key === "W") movementRef.current.back = pressed;
      if (event.key === "s" || event.key === "S") movementRef.current.forward = pressed;
      if (event.key === "a" || event.key === "A") movementRef.current.right = pressed;
      if (event.key === "d" || event.key === "D") movementRef.current.left = pressed;
      if (event.key === " ") {
        if (pressed) event.preventDefault();
      }
      if (event.key === "Shift") movementRef.current.down = pressed;
      if (event.key === "e" || event.key === "E") movementRef.current.eat = pressed;
      if (event.key === "Control") ctrlRef.current = pressed;
    };
    const down = (event: KeyboardEvent) => handleKey(event, true);
    const up = (event: KeyboardEvent) => handleKey(event, false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useEffect(() => {
    if (!controlsRef.current) return;
    controlsRef.current.target.set(0, 0, 0);
    controlsRef.current.update();
    camera.position.set(0, 28, 140);
    camera.lookAt(0, 0, 0);
  }, [camera]);

  // Sync first-person focus/nearby from refs to React stores on a slow interval so useFrame never triggers re-renders.
  useEffect(() => {
    if (viewMode !== "firstPerson") return;
    const sync = () => {
      setFocusLobsterSnapshot(firstPersonFocusSnapshotRef.current);
      setNearbyLobster(firstPersonNearbyRef.current);
    };
    const initial = setTimeout(sync, 120);
    const id = setInterval(sync, FIRST_PERSON_UI_SYNC_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [viewMode]);

  useFrame((_, deltaSeconds) => {
    const now = Date.now();
    let state = stateRef.current;
    if (focusLobsterId && focusLobsterId === myLobsterId) {
      const focusLob = getFocusLobster(state, focusLobsterId);
      if (focusLob) {
        focusLob.aggressiveMode = aggressiveMode;
        focusLob.betrayMode = betrayMode;
      }
    }
    const totalDeltaMs = Math.min(deltaSeconds * 1000, MAX_CATCH_UP_MS);

    const result = tickTankV2(stateRef.current, totalDeltaMs, Math.random, now);
    state = result.state;
    stateRef.current = state;
    const allEvents = result.events;
    if (now - lastPersistRef.current >= PERSIST_THROTTLE_MS) {
      lastPersistRef.current = now;
      const stateToPersist = state;
      const schedulePersist = typeof requestIdleCallback !== "undefined" ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 0);
      schedulePersist(() => persistTankState(stateToPersist, lobsterCount, aqId));
    }
    const pendingRespawnId = getPendingInstantRespawnLobsterId();
    if (pendingRespawnId) {
      const lob = state.lobsters.find((l) => l.id === pendingRespawnId);
      if (lob) {
        lob.health = lob.maxHp ?? 100;
        lob.respawnAt = undefined;
        lob.velocity.x = 0;
        lob.velocity.y = 0;
        lob.elevation = 0;
        lob.pitch = 0;
      }
      setPendingInstantRespawnLobsterId(null);
    }
    if (allEvents.length > 0 && now - lastFeedEmitRef.current >= FEED_THROTTLE_MS) {
      lastFeedEmitRef.current = now;
      const eventsToEmit = filterFeedEvents(allEvents);
      if (eventsToEmit.length > 0) {
        const scheduleEmit = typeof requestIdleCallback !== "undefined" ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 0);
        scheduleEmit(() => addTankEvents(eventsToEmit));
      }
    }

    const w = state.width ?? SIM_WIDTH;
    const h = state.height ?? SIM_HEIGHT;
    const margin = TANK_WALL_MARGIN;
    const innerW = Math.max(1, w - margin * 2);
    const innerH = Math.max(1, h - margin * 2);
    // Sim bounds (margin..w-margin, margin..h-margin) map to 3D tank; innerW/innerH match engine (fix 18).
    const halfX = TANK_BOX[0] / 2 - INNER_MARGIN_3D;
    const halfY = TANK_BOX[1] / 2 - INNER_MARGIN_3D;
    const halfZ = TANK_BOX[2] / 2 - INNER_MARGIN_3D;
    const positions3D: { x: number; y: number; z: number }[] = [];

    const elevScale = (halfX * 2) / innerW;

    state.lobsters.forEach((lobster, index) => {
      const group = lobsterRefs.current[index];
      if (!group) return;

      const posX = lobster.position.x;
      const posY = lobster.position.y;
      const elev = lobster.elevation ?? 0;

      const nx = (posX - margin) / innerW;
      const ny = (posY - margin) / innerH;
      const targetX = nx * halfX * 2 - halfX;
      const targetZ = ny * halfZ * 2 - halfZ;
      const groundY = sandHeightAt(targetX, targetZ);
      const isCrawling = lobster.motionMode === "crawl";
      const isDead = (lobster.health ?? 100) <= 0;
      const elevation = isDead ? 0 : Math.max(0, elev) * elevScale;
      const targetY = isDead
        ? groundY + BASE_LOBSTER_HEIGHT * LOBSTER_SCALE * 0.3
        : groundY + BASE_LOBSTER_HEIGHT * LOBSTER_SCALE + elevation;

      const nearWall = posX < margin + 80 || posX > w - margin - 80 || posY < margin + 80 || posY > h - margin - 80;
      const fast = Math.hypot(lobster.velocity.x, lobster.velocity.y) > 15;
      const posSmooth = nearWall || fast ? 0.92 : 0.78;
      group.position.x += (targetX - group.position.x) * posSmooth;
      group.position.y += (targetY - group.position.y) * posSmooth;
      group.position.z += (targetZ - group.position.z) * posSmooth;
      positions3D.push({ x: group.position.x, y: group.position.y, z: group.position.z });

      const pitch = lobster.pitch ?? 0;
      const hSpeed = Math.hypot(lobster.velocity.x, lobster.velocity.y);
      const cosPitch = Math.cos(pitch);
      const simSpeed = cosPitch > 0.1 ? hSpeed / cosPitch : hSpeed + Math.abs(Math.sin(pitch)) * (lobster.speedMult ?? 1) * 18;

      const speedMul = lobster.speedMult ?? 1;
      const phaseBase = index * 3.7;

      const tail = group.getObjectByName("tail");
      if (tail) {
        if (isCrawling) {
          const tailFreq = 500 + (index % 7) * 30;
          const tailAmp = 0.06 + simSpeed * 0.12;
          const targetTailRot = Math.sin(now / tailFreq + phaseBase) * tailAmp;
          tail.rotation.y += (targetTailRot - tail.rotation.y) * 0.10;
        } else {
          const tailFreq = 80 + (index % 5) * 15;
          const tailAmp = 0.3 + Math.min(simSpeed * 0.15, 0.5);
          const targetTailRot = Math.sin(now / tailFreq + phaseBase) * tailAmp;
          tail.rotation.x += (targetTailRot - tail.rotation.x) * 0.18;
        }
      }

      const targetAngle = lobster.heading ?? 0;
      const targetRotY = Math.PI - targetAngle;

      const { pitch: terrainPitch, roll: terrainRoll } = sandSlopeAt(targetX, targetZ);
      const lobsterPitch = pitch;
      const isSwimming = !isCrawling || elevation > 0.3 || Math.abs(lobsterPitch) > 0.05;

      const _hQ = _quatA.setFromAxisAngle(_yAxis, targetRotY);
      if (isSwimming) {
        const swimSway = Math.sin(now / (600 + (index % 6) * 70) + phaseBase * 0.7) * 0.06;
        const bodyUndulate = Math.sin(now / (400 + (index % 5) * 50) + phaseBase) * 0.04;
        _quatB.setFromAxisAngle(_zAxis, -lobsterPitch + bodyUndulate);
        _quatC.setFromAxisAngle(_xAxis, swimSway);
        _targetQ.copy(_hQ).multiply(_quatB).multiply(_quatC);
      } else {
        _quatB.setFromAxisAngle(_zAxis, terrainPitch * 0.6);
        _quatC.setFromAxisAngle(_xAxis, terrainRoll * 0.6);
        _targetQ.copy(_hQ).multiply(_quatB).multiply(_quatC);
      }
      const turnSmooth = isSwimming ? 0.12 : 0.06;
      group.quaternion.slerp(_targetQ, turnSmooth);

      const isMoving = simSpeed > 0.3;
      const baseAnimSpeed = 160 + (index % 8) * 20;
      const legAnimSpeed = isCrawling
        ? (isMoving ? Math.max(80, 300 - simSpeed * 100) : 1200)
        : baseAnimSpeed / Math.max(0.5, speedMul);
      const legSwing = isCrawling
        ? (isMoving ? Math.min(0.4, simSpeed * 0.35) : 0)
        : Math.min(0.35, 0.15 + simSpeed * 0.04);
      
      const phase = now / legAnimSpeed + phaseBase;
      for (let legIndex = 0; legIndex < 5; legIndex += 1) {
        const left = group.getObjectByName(`leg-${legIndex}-l`);
        const right = group.getObjectByName(`leg-${legIndex}-r`);
        const offset = legIndex * 0.6;
        const targetSwing = Math.sin(phase + offset) * legSwing;
        if (left) left.rotation.z += (targetSwing - left.rotation.z) * 0.12;
        if (right) right.rotation.z += (-targetSwing - right.rotation.z) * 0.12;
      }
    });
    const listSig = state.lobsters.length + "-" + state.lobsters.map((l) => l.id).join(",");
    if (listSig !== lastLobsterListSigRef.current) {
      lastLobsterListSigRef.current = listSig;
      const lobs = state.lobsters;
      const pos = [...positions3D];
      const comms = state.communities;
      const rels = state.relationships;
      scheduleIdle(() => setTankLobsters(lobs, pos, comms, rels, state.lostShrimpToWinner));
    }

    const preds = state.predators ?? [];
    preds.forEach((predator, index) => {
      const group = predatorRefs.current[index];
      if (!group) return;
      const px = predator.position.x;
      const py = predator.position.y;
      const pelev = predator.elevation ?? 0;
      const nx = (px - margin) / innerW;
      const ny = (py - margin) / innerH;
      const targetX = nx * halfX * 2 - halfX;
      const targetZ = ny * halfZ * 2 - halfZ;
      const groundY = sandHeightAt(targetX, targetZ);
      const elevation = Math.max(0, pelev) * elevScale;
      const targetY = groundY + BASE_LOBSTER_HEIGHT * 1.35 + elevation;

      const posSmooth = 0.78;
      group.position.x += (targetX - group.position.x) * posSmooth;
      group.position.y += (targetY - group.position.y) * posSmooth;
      group.position.z += (targetZ - group.position.z) * posSmooth;

      const targetAngle = predator.heading ?? 0;
      const targetRotY = Math.PI - targetAngle;
      let rotDiff = targetRotY - group.rotation.y;
      while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
      while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
      group.rotation.y += rotDiff * 0.88;
      const targetPitch = predator.pitch ?? 0;
      group.rotation.x += (targetPitch - group.rotation.x) * 0.88;
    });

    const currentFoodIds = new Set(state.foods.map((food) => food.id));
    const idByIndex = foodIdByIndex.current;
    const indexById = foodIndexById.current;
    for (const [id, index] of indexById) {
      if (!currentFoodIds.has(id)) {
        indexById.delete(id);
        idByIndex[index] = undefined;
      }
    }

    const visibleFoodIndices = new Set<number>();
    state.foods.forEach((food) => {
      let index = indexById.get(food.id);
      let isNewAssignment = false;
      if (index === undefined) {
        for (let i = 0; i < FOOD_RENDER_MAX; i += 1) {
          if (!idByIndex[i]) {
            index = i;
            idByIndex[i] = food.id;
            indexById.set(food.id, i);
            isNewAssignment = true;
            break;
          }
        }
      }
      if (index === undefined) return;
      visibleFoodIndices.add(index);

      const nx = (food.position.x - margin) / innerW;
      const ny = (food.position.y - margin) / innerH;
      const targetX = nx * halfX * 2 - halfX;
      const targetZ = ny * halfZ * 2 - halfZ;
      const groundY = sandHeightAt(targetX, targetZ);
      const targetY = groundY + 0.4 + (food.elevation ?? 0) * elevScale;

      const posRef = foodPosByIndexRef.current[index];
      const smoothFactor = 0.72;
      if (isNewAssignment) {
        posRef.x = targetX;
        posRef.y = targetY;
        posRef.z = targetZ;
      }
      posRef.x += (targetX - posRef.x) * smoothFactor;
      posRef.y += (targetY - posRef.y) * smoothFactor;
      posRef.z += (targetZ - posRef.z) * smoothFactor;

      const data = foodInstanceDataRef.current[index];
      const scale = 0.55 + (index % 4) * 0.12;
      data.x = posRef.x;
      data.y = posRef.y;
      data.z = posRef.z;
      data.rotY = Math.PI - (food.heading ?? 0);
      data.scale = scale;
      data.visible = true;
    });
    for (let i = 0; i < FOOD_RENDER_MAX; i += 1) {
      const data = foodInstanceDataRef.current[i];
      if (!visibleFoodIndices.has(i)) data.visible = false;
    }

    if (viewMode === "firstPerson") {
      const target = getFocusLobster(state, focusLobsterId);
      if (!target) {
        setFocusLobsterSnapshot(null);
      }
      if (target) {
        // First-person is view-only: camera follows lobster; engine drives all movement.
        const sm = firstPersonSmoothedRef.current;
        if (sm.focusId !== target.id) {
          sm.simX = target.position.x;
          sm.simY = target.position.y;
          sm.simElevation = target.elevation ?? 0;
          sm.heading = target.heading ?? 0;
          sm.pitch = target.pitch ?? 0;
          sm.focusId = target.id;
        }
        const posRate = 8;
        const rotRate = 5;
        const posT = 1 - Math.exp(-posRate * deltaSeconds);
        const rotT = 1 - Math.exp(-rotRate * deltaSeconds);
        sm.simX += (target.position.x - sm.simX) * posT;
        sm.simY += (target.position.y - sm.simY) * posT;
        sm.simElevation += ((target.elevation ?? 0) - sm.simElevation) * posT;
        let dh = (target.heading ?? 0) - sm.heading;
        while (dh > Math.PI) dh -= 2 * Math.PI;
        while (dh < -Math.PI) dh += 2 * Math.PI;
        sm.heading += dh * rotT;
        const dp = (target.pitch ?? 0) - sm.pitch;
        sm.pitch += dp * rotT;
        const heading = sm.heading;
        const pitch = sm.pitch;

        if (now - lastFocusNearbyRef.current >= FOCUS_NEARBY_THROTTLE_MS) {
          lastFocusNearbyRef.current = now;
          const snapshot = {
            ...target,
            position: { ...target.position },
            velocity: { ...target.velocity },
          };
          let closestOther: (typeof state.lobsters)[0] | null = null;
          let closestDistSq = INTERACT_RADIUS_SQ;
          for (const other of state.lobsters) {
            if (other.id === target.id) continue;
            const dx = other.position.x - target.position.x;
            const dy = other.position.y - target.position.y;
            const dz = (other.elevation ?? 0) - (target.elevation ?? 0);
            const dSq = dx * dx + dy * dy + dz * dz * 0.25;
            if (dSq < closestDistSq) {
              closestDistSq = dSq;
              closestOther = other;
            }
          }
          firstPersonFocusSnapshotRef.current = snapshot;
          firstPersonNearbyRef.current = closestOther;
        }

        const camSimX = firstPersonSmoothedRef.current.simX;
        const camSimY = firstPersonSmoothedRef.current.simY;
        const camSimElev = firstPersonSmoothedRef.current.simElevation;
        const ntx = (camSimX - margin) / innerW;
        const nty = (camSimY - margin) / innerH;
        const lobX = ntx * halfX * 2 - halfX;
        const lobZ = nty * halfZ * 2 - halfZ;
        const groundY = sandHeightAt(lobX, lobZ);
        const lobY = groundY + BASE_LOBSTER_HEIGHT * LOBSTER_SCALE + camSimElev * elevScale + 1.2;

        const cosP = Math.cos(pitch);
        const sinP = Math.sin(pitch);
        const cosH = Math.cos(heading);
        const sinH = Math.sin(heading);
        const forwardX = cosH * cosP;
        const forwardY = sinP;
        const forwardZ = sinH * cosP;
        const eyeOffset = 1.6;
        const lookAhead = 28;

        const targetCamX = lobX + forwardX * eyeOffset;
        const targetCamY = lobY + 0.5 + forwardY * eyeOffset;
        const targetCamZ = lobZ + forwardZ * eyeOffset;
        const camRate = 7;
        const camT = 1 - Math.exp(-camRate * deltaSeconds);
        camera.position.x += (targetCamX - camera.position.x) * camT;
        camera.position.y += (targetCamY - camera.position.y) * camT;
        camera.position.z += (targetCamZ - camera.position.z) * camT;
        const lookX = camera.position.x + forwardX * lookAhead;
        const lookY = camera.position.y + forwardY * lookAhead;
        const lookZ = camera.position.z + forwardZ * lookAhead;
        camera.lookAt(lookX, lookY, lookZ);

        if (controlsRef.current) {
          controlsRef.current.enabled = false;
        }
      }
    } else {
      firstPersonSmoothedRef.current.focusId = null;
      firstPersonFocusSnapshotRef.current = null;
      firstPersonNearbyRef.current = null;
      setFocusLobsterSnapshot(null);
      setNearbyLobster(null);
      mouseRef.current.pitch = 0;
      if (controlsRef.current) {
        controlsRef.current.enabled = true;
      }
    }
  });

  return (
    <>
      {contextLost && (
        <Html
          position={[0, 0, 0]}
          center
          style={{
            position: "fixed",
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.8)",
            color: "#fff",
            fontSize: "1.1rem",
            zIndex: 10000,
            pointerEvents: "auto",
          }}
        >
          Display was reset. Refresh the page to restore the tank.
        </Html>
      )}
      {aqId === "global" && !contextLost && publicEnv.NEXT_PUBLIC_SHOW_RESET_TANK === "true" && (
        <Html
          position={[0, 0, 0]}
          center
          transform={false}
          style={{
            position: "fixed",
            top: 12,
            right: 12,
            left: "auto",
            bottom: "auto",
            width: "auto",
            height: "auto",
            pointerEvents: "auto",
            zIndex: 100,
            display: "flex",
            gap: "6px",
          }}
        >
          <button
            type="button"
            onClick={() => handleResetTank(false)}
            disabled={resetting}
            className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 shadow-sm transition hover:bg-amber-100 disabled:opacity-60"
          >
            {resetting ? "Resetting…" : "Reset tank (testing)"}
          </button>
          <button
            type="button"
            onClick={() => handleResetTank(true)}
            disabled={resetting}
            className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-800 shadow-sm transition hover:bg-red-100 disabled:opacity-60"
          >
            {resetting ? "…" : "Empty tank (testing)"}
          </button>
        </Html>
      )}
      <OrbitControls
        ref={controlsRef}
        enablePan
        enableRotate
        enableZoom
        minDistance={15}
        maxDistance={350}
        minPolarAngle={0.15}
        maxPolarAngle={1.6}
        enableDamping
        dampingFactor={0.08}
        rotateSpeed={1}
        panSpeed={1}
        zoomSpeed={0.8}
      />
      <AmbientParticles lowPower={lowPower} />
      <mesh>
        <boxGeometry args={[TANK_BOX[0], TANK_BOX[1], TANK_BOX[2]]} />
        <meshStandardMaterial
          color={WATER_COLOR}
          transparent
          opacity={0.35}
          roughness={0.15}
          metalness={0.02}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[0, TANK_BOX[1] / 2 - 0.5, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[TANK_BOX[0] - 2, TANK_BOX[2] - 2]} />
        <meshStandardMaterial color={WATER_SURFACE} transparent opacity={0.7} />
      </mesh>
      <mesh>
        <boxGeometry args={[TANK_BOX[0] + 1.2, TANK_BOX[1] + 1.2, TANK_BOX[2] + 1.2]} />
        <meshStandardMaterial
          color={WATER_GLASS}
          transparent
          opacity={0.08}
          roughness={0.18}
          metalness={0.05}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <EdgeFrame />
      <WallVines />
      <SandFloor />
      <MossyEdges />
      <BottomBorder />
      <Seaweed lowPower={lowPower} />
      <Rocks />
      <MergedStaticDecorations />
      <CavesAndTunnels />
      <CaveDomes />
      <BarnacleRocks />
      <BubbleVents />
      {tankLobsters.map((lobster, index) => {
        const id = lobster.id;
        const communityColor =
          lobster.communityId != null
            ? tankCommunities.find((c) => c.id === lobster.communityId)?.color
            : undefined;
        const isMyLobster = id === myLobsterId && myLobsterColors;
        const rawBody = isMyLobster
          ? myLobsterColors!.bodyColor
          : (lobster.bodyColor ?? communityColor ?? "#c85c42");
        const rawClaw = isMyLobster ? myLobsterColors!.clawColor : (lobster.clawColor ?? "#8b4513");
        const bodyColor = ensureVisibleColor(rawBody);
        const clawColor = ensureVisibleColor(rawClaw, "#8b4513");
        const bandanaColor = communityColor ?? (isMyLobster ? myLobsterColors!.bandanaColor : null);
        const petBoostEnd = getPetBoostEndByLobsterId()[id];
        const boosted = typeof petBoostEnd === "number" && petBoostEnd > Date.now();
        return (
        <group
          key={id}
          ref={(el) => {
            if (el) lobsterRefs.current[index] = el;
          }}
          scale={[LOBSTER_SCALE, LOBSTER_SCALE, LOBSTER_SCALE]}
        >
          <LobsterMesh bodyColor={bodyColor} clawColor={clawColor} bandanaColor={bandanaColor} boosted={boosted} dead={(lobster.health ?? 100) <= 0} />
          {onSelectLobster && viewMode === "outside" ? (
            <mesh
              position={[0, 0.3, 0]}
              visible={false}
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelectLobster(id);
              }}
              onPointerEnter={() => onHoverLobster?.(id)}
              onPointerLeave={() => onHoverLobster?.(null)}
              userData={{ lobsterId: id }}
            >
              <boxGeometry args={[2, 1.2, 1.5]} />
            </mesh>
          ) : null}
        </group>
        );
      })}
      {(stateRef.current?.predators ?? []).map((predator, index) => (
        <group
          key={predator.id}
          ref={(el) => {
            if (el) predatorRefs.current[index] = el;
          }}
          scale={[1.45, 1.45, 1.45]}
        >
          <OctopusMesh bodyColor="#7c2d12" tentacleColor="#9a3412" scale={1} />
        </group>
      ))}
      <LobsterLabels
        hoveredLobsterId={hoveredLobsterId}
        selectedLobsterId={selectedLobsterId}
      />
      <InstancedShrimpFood instanceDataRef={foodInstanceDataRef} />
    </>
  );
};

const getFocusLobster = (state: TankState, focusLobsterId?: string) => {
  if (focusLobsterId) {
    return state.lobsters.find((lobster) => lobster.id === focusLobsterId);
  }
  return state.lobsters[0];
};

function LobsterLabels({
  hoveredLobsterId,
  selectedLobsterId,
}: {
  hoveredLobsterId?: string | null;
  selectedLobsterId?: string | null;
}) {
  const lobsters = useSyncExternalStore(
    subscribeTankLobsters,
    getTankLobsters,
    getServerSnapshotLobsters,
  );
  const positions = useSyncExternalStore(
    subscribeTankLobsters,
    getTankLobsterPositions3D,
    getServerSnapshotPositions,
  );
  if (lobsters.length === 0 || positions.length !== lobsters.length) return null;
  const labelLobsterId = hoveredLobsterId ?? selectedLobsterId ?? null;
  if (!labelLobsterId) return null;
  const index = lobsters.findIndex((l) => l.id === labelLobsterId);
  if (index < 0) return null;
  const lobster = lobsters[index];
  const pos = positions[index];
  if (!pos) return null;
  return (
    <Html
      key={lobster.id}
      position={[pos.x, pos.y + 0.6, pos.z]}
      center
      style={{
        pointerEvents: "none",
        userSelect: "none",
        whiteSpace: "nowrap",
        fontSize: "10px",
        color: "#1e293b",
        textShadow: "0 0 2px #fff, 0 0 4px #fff",
        fontWeight: 600,
      }}
    >
      {lobster.displayName ?? lobster.id}
    </Html>
  );
}

const SHRIMP_BODY = "#f5a89a";
const SHRIMP_STRIPE = "#e07060";
const SHRIMP_TAIL = "#e88a7a";
const SHRIMP_EYE = "#111";

function ShrimpFood({ seed }: { seed: number }) {
  const scale = 0.55 + (seed % 4) * 0.12;
  const curve = 0.12;
  return (
    <group scale={[scale, scale, scale]} rotation={[0, seed * 0.9, 0]}>
      {/* Body segments - curved shrimp shape */}
      {[0, 1, 2, 3, 4].map((i) => {
        const segX = -0.08 + i * 0.09;
        const segY = Math.sin(i * 0.5) * curve;
        const segScale = 1 - i * 0.08;
        const isStripe = i % 2 === 1;
        return (
          <mesh key={i} position={[segX, segY, 0]}>
            <sphereGeometry args={[0.065 * segScale, 6, 6]} />
            <meshStandardMaterial
              color={isStripe ? SHRIMP_STRIPE : SHRIMP_BODY}
              roughness={0.55}
              metalness={0.1}
            />
          </mesh>
        );
      })}
      {/* Tail fan - multiple segments */}
      <mesh position={[0.32, 0.02, 0]} rotation={[0, 0, -0.2]}>
        <coneGeometry args={[0.08, 0.14, 5]} />
        <meshStandardMaterial color={SHRIMP_TAIL} roughness={0.65} metalness={0} />
      </mesh>
      <mesh position={[0.38, 0.04, 0.04]} rotation={[0.4, 0, -0.3]}>
        <boxGeometry args={[0.08, 0.02, 0.06]} />
        <meshStandardMaterial color={SHRIMP_TAIL} roughness={0.7} metalness={0} />
      </mesh>
      <mesh position={[0.38, 0.04, -0.04]} rotation={[-0.4, 0, -0.3]}>
        <boxGeometry args={[0.08, 0.02, 0.06]} />
        <meshStandardMaterial color={SHRIMP_TAIL} roughness={0.7} metalness={0} />
      </mesh>
      {/* Head/rostrum */}
      <mesh position={[-0.18, 0.01, 0]}>
        <sphereGeometry args={[0.07, 6, 6]} />
        <meshStandardMaterial color={SHRIMP_BODY} roughness={0.5} metalness={0.1} />
      </mesh>
      <mesh position={[-0.28, 0.02, 0]} rotation={[0, 0, 0.1]}>
        <coneGeometry args={[0.025, 0.12, 4]} />
        <meshStandardMaterial color={SHRIMP_BODY} roughness={0.6} metalness={0} />
      </mesh>
      {/* Eyes on stalks */}
      <mesh position={[-0.2, 0.06, 0.045]}>
        <sphereGeometry args={[0.022, 5, 5]} />
        <meshStandardMaterial color={SHRIMP_EYE} roughness={0.2} metalness={0.4} />
      </mesh>
      <mesh position={[-0.2, 0.06, -0.045]}>
        <sphereGeometry args={[0.022, 5, 5]} />
        <meshStandardMaterial color={SHRIMP_EYE} roughness={0.2} metalness={0.4} />
      </mesh>
      {/* Antennae - longer and curved */}
      {[1, -1].map((side) => (
        <group key={side}>
          <mesh position={[-0.24, 0.04, side * 0.05]} rotation={[side * 0.4, 0, -0.5]}>
            <cylinderGeometry args={[0.006, 0.004, 0.18, 4]} />
            <meshStandardMaterial color={SHRIMP_STRIPE} roughness={0.8} metalness={0} />
          </mesh>
          <mesh position={[-0.22, 0.03, side * 0.06]} rotation={[side * 0.3, 0, -0.7]}>
            <cylinderGeometry args={[0.005, 0.003, 0.22, 4]} />
            <meshStandardMaterial color={SHRIMP_STRIPE} roughness={0.8} metalness={0} />
          </mesh>
        </group>
      ))}
      {/* Walking legs */}
      {[-0.12, -0.04, 0.04, 0.12].map((x, i) => (
        <mesh key={i} position={[x, -0.05, 0]} rotation={[0, 0, 0.15 + i * 0.05]}>
          <cylinderGeometry args={[0.008, 0.006, 0.08, 3]} />
          <meshStandardMaterial color={SHRIMP_TAIL} roughness={0.75} metalness={0} />
        </mesh>
      ))}
      {/* Swimmerets under body */}
      {[0, 1, 2].map((i) => (
        <mesh key={`sw-${i}`} position={[i * 0.08, -0.04, 0]} rotation={[0, 0, 0.1]}>
          <boxGeometry args={[0.04, 0.015, 0.05]} />
          <meshStandardMaterial color={SHRIMP_BODY} roughness={0.7} metalness={0} transparent opacity={0.8} />
        </mesh>
      ))}
    </group>
  );
}

function sandSlopeAt(x: number, z: number) {
  const eps = 1.0;
  const hL = sandBump(x - eps, z);
  const hR = sandBump(x + eps, z);
  const hD = sandBump(x, z - eps);
  const hU = sandBump(x, z + eps);
  const dxSlope = (hR - hL) / (2 * eps);
  const dzSlope = (hU - hD) / (2 * eps);
  const pitch = Math.atan(dzSlope);
  const roll = Math.atan(-dxSlope);
  return { pitch, roll };
}

const randomBetween = (min: number, max: number) =>
  min + (max - min) * Math.random();

const TERRAIN_DEPTH = 2;

const SAND_LIGHT = "#e8d5a8";
const SAND_MID = "#c9b896";
const SAND_DARK = "#b5a080";
const GRAVEL_DARK = "#9a8b78";
const GRAVEL_LIGHT = "#b0a090";

function SandFloor() {
  const w = TANK_BOX[0];
  const d = TANK_BOX[2];
  const floorY = -TANK_BOX[1] / 2;
  const resX = 30;
  const resZ = 30;

  const geometry = useMemo(() => {
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];

    const getHeight = (xi: number, zi: number) => {
      const x = (xi / resX - 0.5) * w;
      const z = (zi / resZ - 0.5) * d;
      return sandBump(x, z);
    };

    const getTerrainColor = (x: number, z: number, height: number) => {
      const n1 = Math.sin(x * 0.08 + 1.5) * Math.cos(z * 0.07 + 0.8);
      const n2 = Math.sin(x * 0.15 + z * 0.12 + 2.3) * 0.5;
      const blend = (n1 + n2 + 2) * 0.25;
      
      const heightFactor = Math.min(1, height / 2.5);
      const brightness = 0.9 + heightFactor * 0.1;
      
      let r, g, b;
      if (blend < 0.35) {
        const c = new THREE.Color(GRAVEL_DARK);
        r = c.r; g = c.g; b = c.b;
      } else if (blend < 0.5) {
        const t = (blend - 0.35) / 0.15;
        const c1 = new THREE.Color(GRAVEL_DARK);
        const c2 = new THREE.Color(GRAVEL_LIGHT);
        r = c1.r + (c2.r - c1.r) * t;
        g = c1.g + (c2.g - c1.g) * t;
        b = c1.b + (c2.b - c1.b) * t;
      } else if (blend < 0.65) {
        const t = (blend - 0.5) / 0.15;
        const c1 = new THREE.Color(GRAVEL_LIGHT);
        const c2 = new THREE.Color(SAND_DARK);
        r = c1.r + (c2.r - c1.r) * t;
        g = c1.g + (c2.g - c1.g) * t;
        b = c1.b + (c2.b - c1.b) * t;
      } else if (blend < 0.8) {
        const t = (blend - 0.65) / 0.15;
        const c1 = new THREE.Color(SAND_DARK);
        const c2 = new THREE.Color(SAND_MID);
        r = c1.r + (c2.r - c1.r) * t;
        g = c1.g + (c2.g - c1.g) * t;
        b = c1.b + (c2.b - c1.b) * t;
      } else {
        const t = (blend - 0.8) / 0.2;
        const c1 = new THREE.Color(SAND_MID);
        const c2 = new THREE.Color(SAND_LIGHT);
        r = c1.r + (c2.r - c1.r) * t;
        g = c1.g + (c2.g - c1.g) * t;
        b = c1.b + (c2.b - c1.b) * t;
      }
      
      return { r: r * brightness, g: g * brightness, b: b * brightness };
    };

    for (let zi = 0; zi <= resZ; zi++) {
      for (let xi = 0; xi <= resX; xi++) {
        const x = (xi / resX - 0.5) * w;
        const z = (zi / resZ - 0.5) * d;
        const h = getHeight(xi, zi);
        positions.push(x, h, z);

        const color = getTerrainColor(x, z, h);
        colors.push(color.r, color.g, color.b);

        const eps = w / resX;
        const hL = xi > 0 ? getHeight(xi - 1, zi) : h;
        const hR = xi < resX ? getHeight(xi + 1, zi) : h;
        const hD = zi > 0 ? getHeight(xi, zi - 1) : h;
        const hU = zi < resZ ? getHeight(xi, zi + 1) : h;
        const nx = (hL - hR) / (2 * eps);
        const nz = (hD - hU) / (2 * eps);
        const len = Math.sqrt(nx * nx + 1 + nz * nz);
        normals.push(nx / len, 1 / len, nz / len);
      }
    }

    for (let zi = 0; zi < resZ; zi++) {
      for (let xi = 0; xi < resX; xi++) {
        const tl = zi * (resX + 1) + xi;
        const tr = tl + 1;
        const bl = tl + resX + 1;
        const br = bl + 1;
        indices.push(tl, bl, tr, tr, bl, br);
      }
    }

    const baseStart = positions.length / 3;
    for (let zi = 0; zi <= resZ; zi++) {
      for (let xi = 0; xi <= resX; xi++) {
        const x = (xi / resX - 0.5) * w;
        const z = (zi / resZ - 0.5) * d;
        positions.push(x, -TERRAIN_DEPTH, z);
        const color = new THREE.Color(GRAVEL_DARK).multiplyScalar(0.6);
        colors.push(color.r, color.g, color.b);
        normals.push(0, -1, 0);
      }
    }

    for (let zi = 0; zi < resZ; zi++) {
      for (let xi = 0; xi < resX; xi++) {
        const tl = baseStart + zi * (resX + 1) + xi;
        const tr = tl + 1;
        const bl = tl + resX + 1;
        const br = bl + 1;
        indices.push(tl, tr, bl, tr, br, bl);
      }
    }

    const addSide = (x1: number, z1: number, x2: number, z2: number, nx: number, nz: number) => {
      const steps = 30;
      const sideStart = positions.length / 3;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = x1 + (x2 - x1) * t;
        const z = z1 + (z2 - z1) * t;
        const h = sandBump(x, z);
        positions.push(x, h, z);
        positions.push(x, -TERRAIN_DEPTH, z);
        
        const topColor = getTerrainColor(x, z, h);
        const botColor = new THREE.Color(GRAVEL_DARK).multiplyScalar(0.5);
        colors.push(topColor.r * 0.9, topColor.g * 0.9, topColor.b * 0.9);
        colors.push(botColor.r, botColor.g, botColor.b);
        normals.push(nx, 0, nz);
        normals.push(nx, 0, nz);
      }
      for (let i = 0; i < steps; i++) {
        const t = sideStart + i * 2;
        indices.push(t, t + 1, t + 2, t + 1, t + 3, t + 2);
      }
    };

    addSide(-w / 2, -d / 2, -w / 2, d / 2, -1, 0);
    addSide(w / 2, -d / 2, w / 2, d / 2, 1, 0);
    addSide(-w / 2, -d / 2, w / 2, -d / 2, 0, -1);
    addSide(-w / 2, d / 2, w / 2, d / 2, 0, 1);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geo.setIndex(indices);
    return geo;
  }, [w, d]);

  return (
    <mesh position={[0, floorY, 0]}>
      <primitive object={geometry} attach="geometry" />
      <meshStandardMaterial
        roughness={0.92}
        metalness={0}
        vertexColors
        flatShading
      />
    </mesh>
  );
}

const MOSSY_COLOR = "#3d4f3d";
const MOSSY_STRIP_WIDTH = 4.2;

function MossyEdges() {
  const w = TANK_BOX[0];
  const d = TANK_BOX[2];
  const floorY = -TANK_BOX[1] / 2;
  const h = 0.08;
  return (
    <group position={[0, floorY + h / 2, 0]}>
      <mesh position={[0, 0, d / 2 - MOSSY_STRIP_WIDTH / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w + 0.4, MOSSY_STRIP_WIDTH]} />
        <meshStandardMaterial color={MOSSY_COLOR} roughness={0.9} metalness={0} />
      </mesh>
      <mesh position={[0, 0, -d / 2 + MOSSY_STRIP_WIDTH / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w + 0.4, MOSSY_STRIP_WIDTH]} />
        <meshStandardMaterial color={MOSSY_COLOR} roughness={0.9} metalness={0} />
      </mesh>
      <mesh position={[w / 2 - MOSSY_STRIP_WIDTH / 2, 0, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[MOSSY_STRIP_WIDTH, d + 0.4]} />
        <meshStandardMaterial color={MOSSY_COLOR} roughness={0.9} metalness={0} />
      </mesh>
      <mesh position={[-w / 2 + MOSSY_STRIP_WIDTH / 2, 0, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[MOSSY_STRIP_WIDTH, d + 0.4]} />
        <meshStandardMaterial color={MOSSY_COLOR} roughness={0.9} metalness={0} />
      </mesh>
    </group>
  );
}

function BottomBorder() {
  const w = TANK_BOX[0];
  const d = TANK_BOX[2];
  const floorY = -TANK_BOX[1] / 2;
  const thickness = 0.6;
  const height = 0.8;
  const inset = 0.4;
  const color = "#6b6458";
  return (
    <group>
      <mesh position={[0, floorY - height / 2 + 0.05, d / 2 - inset]}>
        <boxGeometry args={[w - inset * 2, height, thickness]} />
        <meshStandardMaterial color={color} roughness={0.8} metalness={0.1} />
      </mesh>
      <mesh position={[0, floorY - height / 2 + 0.05, -d / 2 + inset]}>
        <boxGeometry args={[w - inset * 2, height, thickness]} />
        <meshStandardMaterial color={color} roughness={0.8} metalness={0.1} />
      </mesh>
      <mesh position={[w / 2 - inset, floorY - height / 2 + 0.05, 0]}>
        <boxGeometry args={[thickness, height, d - inset * 2]} />
        <meshStandardMaterial color={color} roughness={0.8} metalness={0.1} />
      </mesh>
      <mesh position={[-w / 2 + inset, floorY - height / 2 + 0.05, 0]}>
        <boxGeometry args={[thickness, height, d - inset * 2]} />
        <meshStandardMaterial color={color} roughness={0.8} metalness={0.1} />
      </mesh>
    </group>
  );
}

const SEAWEED_SWAY = 0.28;
const SEAWEED_VARIANTS = [
  {
    colors: ["#2d6a4f", "#2f7a55", "#338b60"],
    segments: [
      { h: 2.4, r1: 0.18, r2: 0.3, rot: 0.08, y: -1.2 },
      { h: 2.1, r1: 0.16, r2: 0.24, rot: -0.12, y: 0.2 },
      { h: 1.7, r1: 0.1, r2: 0.2, rot: 0.18, y: 1.4 },
    ],
  },
  {
    colors: ["#2c6f4c", "#347f59", "#3c8f66"],
    segments: [
      { h: 1.6, r1: 0.16, r2: 0.26, rot: -0.1, y: -0.7 },
      { h: 1.4, r1: 0.12, r2: 0.2, rot: 0.2, y: 0.6 },
    ],
    cluster: true,
  },
  {
    colors: ["#2b5f49", "#2f6f52", "#387f5e"],
    segments: [
      { h: 2.8, r1: 0.14, r2: 0.22, rot: 0.12, y: -1.4 },
      { h: 2.2, r1: 0.12, r2: 0.2, rot: -0.18, y: 0.4 },
      { h: 1.8, r1: 0.1, r2: 0.16, rot: 0.25, y: 1.7 },
    ],
  },
];

function Seaweed({ lowPower = false }: { lowPower?: boolean }) {
  const seaweedRefs = useRef<THREE.Group[]>([]);
  const positions = lowPower ? SEAWEED_SIM_POSITIONS.slice(0, 8) : SEAWEED_SIM_POSITIONS;

  const simToTankXZ = useCallback((simX: number, simY: number) => {
    const margin = TANK_WALL_MARGIN;
    const innerW = SIM_WIDTH - margin * 2;
    const innerH = SIM_HEIGHT - margin * 2;
    const halfX = TANK_BOX[0] / 2 - INNER_MARGIN_3D;
    const halfZ = TANK_BOX[2] / 2 - INNER_MARGIN_3D;
    const nx = (simX - margin) / innerW;
    const nz = (simY - margin) / innerH;
    return {
      x: nx * halfX * 2 - halfX,
      z: nz * halfZ * 2 - halfZ,
    };
  }, []);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    seaweedRefs.current.forEach((group, index) => {
      if (!group) return;
      group.rotation.z = Math.sin(t * 0.8 + index) * SEAWEED_SWAY;
    });
  });

  return (
    <group>
      {positions.map((pos, i) => {
        const { x, z } = simToTankXZ(pos.x, pos.y);
        const height = SEAWEED_HEIGHT - 6 + (i % 5) * 2.5;
        return (
          <group
            key={i}
            ref={(el) => {
              if (el) seaweedRefs.current[i] = el;
            }}
            position={[x, sandHeightAt(x, z), z]}
            rotation={[0, (i % 4) * 0.25, 0]}
          >
            <SeaweedStrand variantIndex={i} height={height} seed={i * 0.7 + 1} />
          </group>
        );
      })}
    </group>
  );
}

function SeaweedStrand({ variantIndex, height, seed }: { variantIndex: number; height: number; seed: number }) {
  const variant = SEAWEED_VARIANTS[variantIndex % SEAWEED_VARIANTS.length];
  const mainCurve = useMemo(() => {
    const points: THREE.Vector3[] = [];
    const steps = 12;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const y = t * height;
      const phase = t * Math.PI * 0.6 + seed;
      const swayAmp = 1.0 + 0.4 * Math.sin(seed * 0.7);
      const swayX = Math.sin(phase) * swayAmp;
      const swayZ = Math.cos(phase * 0.9 + 0.5) * swayAmp * 0.85;
      points.push(new THREE.Vector3(swayX, y, swayZ));
    }
    return new THREE.CatmullRomCurve3(points);
  }, [height, seed]);

  const branchCurves = useMemo(() => {
    const branches: THREE.CatmullRomCurve3[] = [];
    const branchHeights = [0.4, 0.6, 0.82];
    branchHeights.forEach((t, idx) => {
      const baseY = height * t;
      const dir = idx % 2 === 0 ? 1 : -1;
      const len = height * (0.18 + (idx % 3) * 0.06);
      const points = [
        new THREE.Vector3(0, baseY, 0),
        new THREE.Vector3(1.2 * dir, baseY + len * 0.5, 0.6 * dir),
        new THREE.Vector3(2.0 * dir, baseY + len * 1.0, 1.0 * dir),
        new THREE.Vector3(2.2 * dir, baseY + len * 1.35, 1.2 * dir),
      ];
      branches.push(new THREE.CatmullRomCurve3(points));
    });
    return branches;
  }, [height]);

  const mainColor = variant.colors[variantIndex % variant.colors.length];
  return (
    <group>
      <mesh>
        <tubeGeometry args={[mainCurve, 28, 0.42, 7, false]} />
        <meshStandardMaterial color={mainColor} roughness={0.9} metalness={0} />
      </mesh>
      {branchCurves.map((curve, idx) => (
        <mesh key={idx}>
          <tubeGeometry args={[curve, 20, 0.24, 6, false]} />
          <meshStandardMaterial color={variant.colors[(idx + 1) % variant.colors.length]} roughness={0.9} metalness={0} />
        </mesh>
      ))}
    </group>
  );
}

const ROCKS: Array<[number, number, number]> = [
  [-18, -8, 0.9],
  [16, 10, 0.7],
  [-6, 14, 1.1],
  [10, -12, 0.8],
  [-20, 4, 1.0],
  [4, -10, 0.65],
  [20, -4, 0.85],
  [-14, 12, 0.75],
  [22, 14, 0.6],
  [-22, -12, 0.7],
  [-10, -18, 0.85],
  [6, 18, 0.7],
  [0, 6, 0.95],
  [12, 2, 0.65],
  [-6, 2, 0.6],
  [18, -14, 0.8],
  [-18, 16, 0.75],
  [24, 6, 0.7],
];

const ROCK_COLORS = ["#8f7b66", "#7a6b5a", "#9c8974", "#6e6052", "#a5957f"];

function IrregularRockGeometry({ scale, seed }: { scale: number; seed: number }) {
  const geometry = useMemo(() => {
    const geo = new THREE.IcosahedronGeometry(scale, 1);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const distort = 0.2 + Math.sin(x * seed + y * seed * 0.7 + z * seed * 0.5) * 0.3;
      const flattenY = y < 0 ? 0.6 : 1.0;
      pos.setX(i, x * (1 + distort * 0.4));
      pos.setY(i, y * flattenY * (1 + distort * 0.2));
      pos.setZ(i, z * (1 + distort * 0.35));
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }, [scale, seed]);
  return <primitive object={geometry} attach="geometry" />;
}

function Rocks() {
  return (
    <group>
      {ROCKS.map(([x, z, scale], i) => (
        <mesh
          key={i}
          position={[x, sandHeightAt(x, z) + scale * 0.35, z]}
          rotation={[Math.sin(i * 0.5) * 0.2, i * 0.6, Math.cos(i * 0.3) * 0.15]}
        >
          <IrregularRockGeometry scale={scale} seed={i * 1.3 + 0.5} />
          <meshStandardMaterial
            color={ROCK_COLORS[i % ROCK_COLORS.length]}
            roughness={0.92}
            metalness={0.02}
            flatShading
          />
        </mesh>
      ))}
    </group>
  );
}

const PEBBLES: Array<[number, number, number]> = [
  [-14, -4, 0.15],
  [-6, 6, 0.18],
  [6, 12, 0.12],
  [14, -10, 0.2],
  [-20, 10, 0.16],
  [22, 4, 0.14],
  [2, -14, 0.1],
  [-8, 14, 0.12],
];

function Pebbles() {
  return (
    <group>
      {PEBBLES.map(([x, z, scale], i) => (
        <mesh
          key={i}
          position={[x, sandHeightAt(x, z) + scale * 0.4, z]}
          rotation={[0, i * 0.5, 0]}
        >
          <icosahedronGeometry args={[scale, 0]} />
          <meshStandardMaterial color="#9c876d" roughness={0.98} metalness={0} flatShading />
        </mesh>
      ))}
    </group>
  );
}

const DRIFTWOOD: Array<[number, number, number, number]> = [
  [-8, -6, 4.5, 0.25],
  [12, 8, 5.2, 0.22],
];

function Driftwood() {
  return (
    <group>
      {DRIFTWOOD.map(([x, z, length, radius], i) => (
        <mesh
          key={i}
          position={[x, sandHeightAt(x, z) + radius * 0.6, z]}
          rotation={[0.2, i * 0.6, 0.1]}
        >
          <cylinderGeometry args={[radius, radius * 1.2, length, 6]} />
          <meshStandardMaterial color="#8b6b4a" roughness={0.9} metalness={0} />
        </mesh>
      ))}
    </group>
  );
}

const POTTERY_SHARDS: Array<[number, number, number]> = [
  [-2, -12, 0.35],
  [6, -14, 0.28],
  [0, -10, 0.22],
];

function PotteryShards() {
  return (
    <group>
      {POTTERY_SHARDS.map(([x, z, scale], i) => (
        <mesh
          key={i}
          position={[x, sandHeightAt(x, z) + scale * 0.3, z]}
          rotation={[0.2, i * 0.5, 0.1]}
        >
          <tetrahedronGeometry args={[scale, 0]} />
          <meshStandardMaterial color="#c26d4f" roughness={0.8} metalness={0.05} />
        </mesh>
      ))}
    </group>
  );
}

const SHELLS: Array<[number, number, number]> = [
  [-12, 4, 0.2],
  [-10, 6, 0.18],
  [-8, 3, 0.22],
  [10, -4, 0.2],
];

function ShellClusters() {
  return (
    <group>
      {SHELLS.map(([x, z, scale], i) => (
        <mesh
          key={i}
          position={[x, sandHeightAt(x, z) + scale * 0.25, z]}
          rotation={[0, i * 0.7, 0]}
        >
          <sphereGeometry args={[scale, 6, 6]} />
          <meshStandardMaterial color="#e6d3b8" roughness={0.7} metalness={0.05} />
        </mesh>
      ))}
    </group>
  );
}

const CORAL_MOUNDS: Array<[number, number, number]> = [
  [-6, -2, 0.6],
  [12, 2, 0.5],
  [4, 8, 0.55],
];

function CoralMounds() {
  return (
    <group>
      {CORAL_MOUNDS.map(([x, z, scale], i) => (
        <group key={i} position={[x, sandHeightAt(x, z) + scale * 0.4, z]}>
          <mesh rotation={[0, i * 0.5, 0]}>
            <coneGeometry args={[scale * 0.6, scale * 1.4, 6]} />
            <meshStandardMaterial color="#d97c6b" roughness={0.85} metalness={0} />
          </mesh>
          <mesh position={[scale * 0.4, scale * 0.2, 0]}>
            <coneGeometry args={[scale * 0.4, scale * 1.1, 6]} />
            <meshStandardMaterial color="#e08a76" roughness={0.85} metalness={0} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

const SPONGES: Array<[number, number, number]> = [
  [8, -6, 0.5],
  [-14, 8, 0.45],
];

function SpongePillars() {
  return (
    <group>
      {SPONGES.map(([x, z, scale], i) => (
        <mesh
          key={i}
          position={[x, sandHeightAt(x, z) + scale * 0.6, z]}
          rotation={[0, i * 0.4, 0]}
        >
          <boxGeometry args={[scale * 0.9, scale * 1.4, scale * 0.9]} />
          <meshStandardMaterial color="#e5b84f" roughness={0.8} metalness={0.05} />
        </mesh>
      ))}
    </group>
  );
}

const ANEMONES: Array<[number, number]> = [
  [2, 12],
  [-4, 10],
];

function AnemoneTufts() {
  return (
    <group>
      {ANEMONES.map(([x, z], i) => (
        <group key={i} position={[x, sandHeightAt(x, z) + 0.3, z]}>
          {Array.from({ length: 6 }).map((_, idx) => (
            <mesh key={idx} rotation={[0, (idx / 6) * Math.PI * 2, 0]}>
              <cylinderGeometry args={[0.04, 0.08, 0.8, 5]} />
              <meshStandardMaterial color="#f08fa4" roughness={0.9} metalness={0} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

const KELP_CLUSTERS: Array<[number, number]> = [
  [18, 6],
  [-18, -2],
];

function KelpClusters() {
  return (
    <group>
      {KELP_CLUSTERS.map(([x, z], i) => (
        <group
          key={i}
          position={[x, sandHeightAt(x, z), z]}
          rotation={[0, i * 0.4, 0]}
        >
          {Array.from({ length: 3 }).map((_, idx) => (
            <mesh key={idx} position={[idx * 0.2 - 0.2, 1.5, 0]} rotation={[0, 0, 0.2]}>
              <cylinderGeometry args={[0.08, 0.14, 3.2, 6]} />
              <meshStandardMaterial color="#2f7a55" roughness={0.9} metalness={0} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

const PEBBLE_PILES: Array<[number, number]> = [
  [14, 14],
  [-6, -14],
];

function PebblePiles() {
  return (
    <group>
      {PEBBLE_PILES.map(([x, z], i) => (
        <group key={i} position={[x, sandHeightAt(x, z) + 0.2, z]}>
          {Array.from({ length: 6 }).map((_, idx) => (
            <mesh key={idx} position={[Math.sin(idx) * 0.4, 0, Math.cos(idx) * 0.4]}>
              <icosahedronGeometry args={[0.16, 0]} />
              <meshStandardMaterial color="#a08e75" roughness={0.98} metalness={0} flatShading />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

const REEF_ARCHES: Array<[number, number]> = [
  [-2, 2],
  [6, -2],
];

function ReefArches() {
  return (
    <group>
      {REEF_ARCHES.map(([x, z], i) => (
        <group key={i} position={[x, sandHeightAt(x, z) + 0.6, z]}>
          <mesh position={[-0.5, 0, 0]}>
            <boxGeometry args={[0.5, 1.2, 0.5]} />
            <meshStandardMaterial color="#7a6a55" roughness={0.9} metalness={0.05} />
          </mesh>
          <mesh position={[0.5, 0, 0]}>
            <boxGeometry args={[0.5, 1.2, 0.5]} />
            <meshStandardMaterial color="#7a6a55" roughness={0.9} metalness={0.05} />
          </mesh>
          <mesh position={[0, 0.6, 0]}>
            <boxGeometry args={[1.4, 0.4, 0.6]} />
            <meshStandardMaterial color="#7a6a55" roughness={0.9} metalness={0.05} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function IrregularRockCluster({ seed, scale }: { seed: number; scale: number }) {
  const rocks = useMemo(() => {
    const result: Array<{ pos: [number, number, number]; size: number; rot: [number, number, number] }> = [];
    const count = 5 + Math.floor(seed * 3) % 4;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + seed * 0.5;
      const dist = scale * 0.3 + (Math.sin(seed * 10 + i * 2.3) * 0.5 + 0.5) * scale * 0.4;
      const height = scale * 0.3 + (Math.cos(seed * 7 + i * 1.7) * 0.5 + 0.5) * scale * 0.6;
      result.push({
        pos: [Math.cos(angle) * dist, height, Math.sin(angle) * dist],
        size: scale * 0.25 + (Math.sin(seed * 5 + i) * 0.5 + 0.5) * scale * 0.35,
        rot: [seed + i * 0.3, i * 0.7, seed * 0.5 + i * 0.2],
      });
    }
    return result;
  }, [seed, scale]);

  return (
    <group>
      {rocks.map((rock, i) => (
        <mesh key={i} position={rock.pos} rotation={rock.rot}>
          <dodecahedronGeometry args={[rock.size, 0]} />
          <meshStandardMaterial 
            color={i % 2 === 0 ? "#6a5a45" : "#7a6b58"} 
            roughness={0.95} 
            flatShading 
          />
        </mesh>
      ))}
    </group>
  );
}

function CaveArch({ scale, seed }: { scale: number; seed: number }) {
  const rocks = useMemo(() => {
    const result: Array<{ pos: [number, number, number]; size: number; rot: number }> = [];
    const leftPillar = 8 + Math.floor(seed * 2) % 3;
    for (let i = 0; i < leftPillar; i++) {
      const t = i / leftPillar;
      const x = -scale * 0.5 + Math.sin(seed * 3 + i) * scale * 0.15;
      const y = t * scale * 1.2;
      const z = Math.cos(seed * 5 + i * 0.8) * scale * 0.1;
      result.push({
        pos: [x, y, z],
        size: scale * 0.25 + Math.sin(seed + i) * scale * 0.1,
        rot: seed + i * 0.4,
      });
    }
    const rightPillar = 8 + Math.floor(seed * 3) % 3;
    for (let i = 0; i < rightPillar; i++) {
      const t = i / rightPillar;
      const x = scale * 0.5 + Math.sin(seed * 4 + i) * scale * 0.15;
      const y = t * scale * 1.2;
      const z = Math.cos(seed * 6 + i * 0.9) * scale * 0.1;
      result.push({
        pos: [x, y, z],
        size: scale * 0.25 + Math.cos(seed + i) * scale * 0.1,
        rot: seed * 2 + i * 0.3,
      });
    }
    const archTop = 6 + Math.floor(seed * 2) % 3;
    for (let i = 0; i < archTop; i++) {
      const t = i / (archTop - 1);
      const angle = Math.PI * t;
      const x = Math.cos(angle) * scale * 0.5;
      const y = scale * 1.1 + Math.sin(angle) * scale * 0.3;
      result.push({
        pos: [x, y, Math.sin(seed * 2 + i) * scale * 0.1],
        size: scale * 0.3 + Math.sin(seed * 3 + i) * scale * 0.1,
        rot: seed + i,
      });
    }
    return result;
  }, [scale, seed]);

  return (
    <group>
      {rocks.map((rock, i) => (
        <mesh key={i} position={rock.pos} rotation={[rock.rot * 0.3, rock.rot, rock.rot * 0.2]}>
          <dodecahedronGeometry args={[rock.size, 0]} />
          <meshStandardMaterial 
            color={i % 3 === 0 ? "#5a4a35" : i % 3 === 1 ? "#6a5a45" : "#7a6b58"} 
            roughness={0.95} 
            flatShading 
          />
        </mesh>
      ))}
    </group>
  );
}

const CAVE_POSITIONS: Array<[number, number, number, number]> = [
  [-14, -10, 3, 0],
  [12, 8, 3.5, 0.7],
  [-8, 14, 2.8, -0.4],
  [10, -14, 3.2, 1.2],
  [0, -8, 4, 0.3],
];

function CavesAndTunnels() {
  return (
    <group>
      {CAVE_POSITIONS.map(([x, z, scale, rot], i) => (
        <group key={i} position={[x, sandHeightAt(x, z), z]} rotation={[0, rot, 0]}>
          <CaveArch scale={scale} seed={i * 1.7 + 0.5} />
        </group>
      ))}
      
      <group position={[-18, sandHeightAt(-18, 2), 2]} rotation={[0, 0.5, 0]}>
        <IrregularRockCluster seed={1.3} scale={4} />
      </group>
      
      <group position={[16, sandHeightAt(16, -6), -6]} rotation={[0, -0.3, 0]}>
        <IrregularRockCluster seed={2.7} scale={3.5} />
      </group>
      
      <group position={[0, sandHeightAt(0, 16), 16]} rotation={[0, 0.8, 0]}>
        <IrregularRockCluster seed={4.1} scale={4.5} />
      </group>
    </group>
  );
}

const CAVE_DOMES: Array<[number, number, number]> = [
  [-8, 6, 6.5],
  [14, -2, 5.5],
];

function CaveDomes() {
  return (
    <group>
      {CAVE_DOMES.map(([x, z, radius], i) => (
        <group key={i} position={[x, sandHeightAt(x, z) + radius * 0.35, z]}>
          <mesh rotation={[0, i * 0.4, 0]}>
            <icosahedronGeometry args={[radius, 1]} />
            <meshStandardMaterial color="#7a6b5a" roughness={0.9} metalness={0.05} />
          </mesh>
          {Array.from({ length: 8 }).map((_, idx) => (
            <mesh
              key={idx}
              position={[
                Math.cos(idx * 0.8 + i) * radius * 0.9,
                (idx % 3) * 0.4,
                Math.sin(idx * 0.8 + i) * radius * 0.9,
              ]}
              rotation={[0, idx * 0.6, 0]}
            >
              <dodecahedronGeometry args={[0.7 + (idx % 3) * 0.15, 0]} />
              <meshStandardMaterial color="#8f7b66" roughness={0.9} metalness={0.05} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

const STARFISH: Array<[number, number]> = [
  [4, -6],
  [-16, 6],
];

function StarfishPatches() {
  return (
    <group>
      {STARFISH.map(([x, z], i) => (
        <group key={i} position={[x, sandHeightAt(x, z) + 0.08, z]}>
          {Array.from({ length: 5 }).map((_, idx) => (
            <mesh key={idx} rotation={[0, (idx / 5) * Math.PI * 2, 0]}>
              <coneGeometry args={[0.14, 0.6, 4]} />
              <meshStandardMaterial color="#e08a6a" roughness={0.8} metalness={0} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

const BARNACLE_ROCKS: Array<[number, number, number]> = [
  [-10, -6, 0.6],
  [16, -12, 0.5],
  [6, 12, 0.55],
  [-18, 8, 0.5],
];

function BarnacleRocks() {
  return (
    <group>
      {BARNACLE_ROCKS.map(([x, z, scale], i) => (
        <group key={i} position={[x, sandHeightAt(x, z) + scale * 0.4, z]}>
          <mesh>
            <dodecahedronGeometry args={[scale, 0]} />
            <meshStandardMaterial color="#7e6a56" roughness={0.95} metalness={0} flatShading />
          </mesh>
          {Array.from({ length: 4 }).map((_, idx) => (
            <mesh key={idx} position={[Math.sin(idx) * 0.4, scale * 0.2, Math.cos(idx) * 0.4]}>
              <coneGeometry args={[0.12, 0.3, 5]} />
              <meshStandardMaterial color="#d9c9b0" roughness={0.85} metalness={0.05} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

const SAND_RIDGES: Array<[number, number]> = [
  [6, 14],
  [-18, 10],
];

function SandRidges() {
  return (
    <group>
      {SAND_RIDGES.map(([x, z], i) => (
        <mesh
          key={i}
          position={[x, sandHeightAt(x, z) + 0.1, z]}
          rotation={[0, i * 0.4, 0]}
        >
          <boxGeometry args={[3, 0.25, 1.2]} />
          <meshStandardMaterial color="#d9c6a1" roughness={0.95} metalness={0} />
        </mesh>
      ))}
    </group>
  );
}

const ROCK_SLABS: Array<[number, number]> = [
  [10, 12],
  [-12, -10],
];

function RockSlabs() {
  return (
    <group>
      {ROCK_SLABS.map(([x, z], i) => (
        <mesh
          key={i}
          position={[x, sandHeightAt(x, z) + 0.2, z]}
          rotation={[0.05, i * 0.6, 0.02]}
        >
          <boxGeometry args={[2.4, 0.4, 1.6]} />
          <meshStandardMaterial color="#7f6e5a" roughness={0.95} metalness={0} />
        </mesh>
      ))}
    </group>
  );
}

const BUBBLE_VENTS: Array<[number, number]> = [
  [0, 6],
  [-6, -4],
  [12, -10],
];

const BUBBLE_RADIUS = 0.16;
const TANK_TOP_Y = TANK_BOX[1] / 2;

function BubbleVents() {
  const bubbleRefs = useRef<THREE.Mesh[]>([]);
  const bubbleData = useMemo(() => {
    const bubbles: Array<{ ventIndex: number; offset: number; drift: number }> = [];
    BUBBLE_VENTS.forEach((_, ventIndex) => {
      for (let i = 0; i < 18; i += 1) {
        bubbles.push({
          ventIndex,
          offset: i * 0.85,
          drift: 0.35 + (i % 3) * 0.15,
        });
      }
    });
    return bubbles;
  }, []);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    bubbleRefs.current.forEach((mesh, i) => {
      if (!mesh) return;
      const data = bubbleData[i];
      const [vx, vz] = BUBBLE_VENTS[data.ventIndex];
      const baseY = sandHeightAt(vx, vz) + 0.2;
      const riseHeight = TANK_TOP_Y - baseY;
      const rise = (t * 1.2 + data.offset) % Math.max(riseHeight, 1);
      mesh.position.x = vx + Math.sin(t * 0.7 + data.offset) * data.drift;
      mesh.position.y = baseY + rise;
      mesh.position.z = vz + Math.cos(t * 0.6 + data.offset) * data.drift;
    });
  });

  return (
    <group>
      {BUBBLE_VENTS.map(([x, z], i) => (
        <group key={i} position={[x, sandHeightAt(x, z) + 0.1, z]}>
          <mesh>
            <coneGeometry args={[0.3, 0.6, 6]} />
            <meshStandardMaterial color="#6f8f9c" roughness={0.6} metalness={0.2} />
          </mesh>
        </group>
      ))}
      {bubbleData.map((_, i) => (
        <mesh
          key={i}
          ref={(el) => {
            if (el) bubbleRefs.current[i] = el;
          }}
        >
          <sphereGeometry args={[BUBBLE_RADIUS, 10, 10]} />
          <meshStandardMaterial color="#d4f8f6" roughness={0.1} metalness={0} transparent opacity={0.98} />
        </mesh>
      ))}
    </group>
  );
}

const ALGAE_PATCHES: Array<[number, number]> = [
  [14, -2],
  [-4, 6],
  [-12, -4],
  [8, 14],
];

function AlgaePatches() {
  return (
    <group>
      {ALGAE_PATCHES.map(([x, z], i) => (
        <mesh
          key={i}
          position={[x, sandHeightAt(x, z) + 0.02, z]}
          rotation={[-Math.PI / 2, 0, i * 0.4]}
        >
          <circleGeometry args={[1.4, 8]} />
          <meshStandardMaterial color="#3f8b5e" roughness={0.95} metalness={0} />
        </mesh>
      ))}
    </group>
  );
}

const COIN_PILES: Array<[number, number]> = [
  [-2, -2],
  [16, 4],
  [-14, 10],
];

function CoinPiles() {
  return (
    <group>
      {COIN_PILES.map(([x, z], i) => (
        <group key={i} position={[x, sandHeightAt(x, z) + 0.08, z]}>
          {Array.from({ length: 5 }).map((_, idx) => (
            <mesh key={idx} position={[0, idx * 0.06, 0]}>
              <cylinderGeometry args={[0.2, 0.2, 0.04, 8]} />
              <meshStandardMaterial color="#d4b04f" roughness={0.4} metalness={0.6} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

function EdgeFrame() {
  const hw = TANK_BOX[0] / 2;
  const hh = TANK_BOX[1] / 2;
  const hd = TANK_BOX[2] / 2;
  const thickness = 0.6;
  const beams: Array<[number, number, number, number, number, number]> = [
    [hw, hh, 0, thickness, thickness, TANK_BOX[2]],
    [-hw, hh, 0, thickness, thickness, TANK_BOX[2]],
    [hw, -hh, 0, thickness, thickness, TANK_BOX[2]],
    [-hw, -hh, 0, thickness, thickness, TANK_BOX[2]],
    [0, hh, hd, TANK_BOX[0], thickness, thickness],
    [0, hh, -hd, TANK_BOX[0], thickness, thickness],
    [0, -hh, hd, TANK_BOX[0], thickness, thickness],
    [0, -hh, -hd, TANK_BOX[0], thickness, thickness],
    [hw, 0, hd, thickness, TANK_BOX[1], thickness],
    [-hw, 0, hd, thickness, TANK_BOX[1], thickness],
    [hw, 0, -hd, thickness, TANK_BOX[1], thickness],
    [-hw, 0, -hd, thickness, TANK_BOX[1], thickness],
  ];
  return (
    <group>
      {beams.map(([x, y, z, sx, sy, sz], i) => (
        <mesh key={i} position={[x, y, z]}>
          <boxGeometry args={[sx, sy, sz]} />
          <meshStandardMaterial color="#5a6a6e" roughness={0.25} metalness={0.85} />
        </mesh>
      ))}
    </group>
  );
}

const VINE_COLORS = ["#2d5a45", "#326b50", "#3a7a5a", "#28503d"];
const LEAF_COLORS = ["#3d8a5f", "#459968", "#4da872", "#55b87c"];

function WallVines() {
  const hw = TANK_BOX[0] / 2 - 0.5;
  const hh = TANK_BOX[1] / 2;
  const hd = TANK_BOX[2] / 2 - 0.5;
  const floorY = -hh;

  const vines = [
    { x: -hw, z: -12, segments: 6, baseY: floorY + 1 },
    { x: -hw, z: 8, segments: 7, baseY: floorY + 0.5 },
    { x: -hw, z: 18, segments: 5, baseY: floorY + 1.5 },
    { x: hw, z: -8, segments: 6, baseY: floorY + 1 },
    { x: hw, z: 14, segments: 7, baseY: floorY + 0.8 },
    { x: 8, z: -hd, segments: 5, baseY: floorY + 1.2 },
    { x: -10, z: -hd, segments: 6, baseY: floorY + 0.6 },
    { x: -18, z: -hd, segments: 4, baseY: floorY + 1 },
    { x: 0, z: hd, segments: 5, baseY: floorY + 1.4 },
    { x: 16, z: hd, segments: 6, baseY: floorY + 0.9 },
    { x: -hw, z: -20, segments: 7, baseY: floorY + 0.7 },
    { x: -hw, z: 0, segments: 6, baseY: floorY + 1.1 },
    { x: hw, z: -18, segments: 7, baseY: floorY + 0.6 },
    { x: hw, z: 2, segments: 6, baseY: floorY + 1.3 },
    { x: -6, z: hd, segments: 6, baseY: floorY + 1.2 },
    { x: 22, z: hd, segments: 5, baseY: floorY + 0.7 },
    { x: 12, z: -hd, segments: 6, baseY: floorY + 1.0 },
    { x: -22, z: -hd, segments: 6, baseY: floorY + 0.8 },
  ];

  return (
    <group>
      {vines.map((vine, i) => {
        const segmentHeight = 4.5;
        const vineColor = VINE_COLORS[i % VINE_COLORS.length];
        const leafColor = LEAF_COLORS[i % LEAF_COLORS.length];
        
        return (
          <group key={i} position={[vine.x, vine.baseY, vine.z]}>
            {Array.from({ length: vine.segments }).map((_, j) => {
              const y = j * segmentHeight;
              const wobbleX = Math.sin(i + j * 0.8) * 0.15;
              const wobbleZ = Math.cos(i + j * 0.6) * 0.12;
              const thickness = 0.25 - j * 0.025;
              
              return (
                <group key={j}>
                  {/* Vine stem segment */}
                  <mesh
                    position={[wobbleX, y + segmentHeight / 2, wobbleZ]}
                    rotation={[wobbleZ * 0.3, 0, wobbleX * 0.2]}
                  >
                    <cylinderGeometry args={[thickness * 0.7, thickness, segmentHeight, 6]} />
                    <meshStandardMaterial color={vineColor} roughness={0.85} metalness={0} />
                  </mesh>
                  
                  {/* Leaves along the vine */}
                  {j > 0 && j < vine.segments - 1 && (
                    <>
                      <mesh
                        position={[wobbleX + 0.4, y + 1, wobbleZ]}
                        rotation={[0.2, i * 0.5 + j, 0.6]}
                      >
                        <planeGeometry args={[1.2, 0.5]} />
                        <meshStandardMaterial
                          color={leafColor}
                          roughness={0.8}
                          metalness={0}
                          side={THREE.DoubleSide}
                        />
                      </mesh>
                      <mesh
                        position={[wobbleX - 0.3, y + 2.5, wobbleZ + 0.2]}
                        rotation={[-0.15, i * 0.3 + j * 0.7, -0.5]}
                      >
                        <planeGeometry args={[1.0, 0.45]} />
                        <meshStandardMaterial
                          color={leafColor}
                          roughness={0.8}
                          metalness={0}
                          side={THREE.DoubleSide}
                        />
                      </mesh>
                    </>
                  )}
                </group>
              );
            })}
          </group>
        );
      })}
    </group>
  );
}

function AmbientParticles({ lowPower = false }: { lowPower?: boolean }) {
  const count = lowPower ? 30 : PARTICLE_COUNT;
  const geometry = useMemo(() => {
    const positions: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const x = randomBetween(-TANK_BOX[0] / 2 + 2, TANK_BOX[0] / 2 - 2);
      const y = randomBetween(-TANK_BOX[1] / 2 + 2, TANK_BOX[1] / 2 - 4);
      const z = randomBetween(-TANK_BOX[2] / 2 + 2, TANK_BOX[2] / 2 - 2);
      positions.push(x, y, z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }, [count]);

  return (
    <points>
      <primitive object={geometry} attach="geometry" />
      <pointsMaterial
        color="#bfe9e6"
        size={0.18}
        sizeAttenuation
        transparent
        opacity={0.35}
      />
    </points>
  );
}

