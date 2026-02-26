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
const SEAWEED_HEIGHT = 56;
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
  const { camera, gl } = useThree();

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
      <JaggedFloorScatter />
      <MergedStaticDecorations />
      <CavesAndTunnels />
      <CaveDomes />
      <BarnacleRocks />
      <CoralFans />
      <SeaGrassBeds />
      <TreasureChests />
      <SunkenAnchor />
      <Starfish />
      <SeaUrchins />
      <Jellyfish />
      <MarimoMossBalls />
      <BrainCoral />
      <MushroomCoral />
      <SunkenRuins />
      <ClamWithPearl />
      <CrystalFormations />
      <SandRipples />
      <TubeWormClusters />
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

const SEAWEED_SWAY = 0.07;
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
        const height = Math.min(SEAWEED_HEIGHT - 2 + (i % 6) * 3, TANK_BOX[1] * 0.68);
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

function SeaweedLeaf({ position, rotation, scale, color }: { position: [number, number, number]; rotation: [number, number, number]; scale: number; color: string }) {
  const geo = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.quadraticCurveTo(0.55 * scale, 0.7 * scale, 0.25 * scale, 1.8 * scale);
    shape.quadraticCurveTo(0, 2.1 * scale, -0.25 * scale, 1.8 * scale);
    shape.quadraticCurveTo(-0.55 * scale, 0.7 * scale, 0, 0);
    const g = new THREE.ShapeGeometry(shape, 6);
    g.computeVertexNormals();
    return g;
  }, [scale]);
  return (
    <mesh position={position} rotation={rotation}>
      <primitive object={geo} attach="geometry" />
      <meshStandardMaterial color={color} roughness={0.75} metalness={0} side={THREE.DoubleSide} />
    </mesh>
  );
}

function SeaweedStrand({ variantIndex, height, seed }: { variantIndex: number; height: number; seed: number }) {
  const variant = SEAWEED_VARIANTS[variantIndex % SEAWEED_VARIANTS.length];
  const mainColor = variant.colors[variantIndex % variant.colors.length];

  const mainCurve = useMemo(() => {
    const points: THREE.Vector3[] = [];
    const steps = 28;
    const amp1 = 1.6 + Math.sin(seed) * 0.4;
    const amp2 = 1.0 + Math.cos(seed * 1.3) * 0.3;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const y = t * height;
      const blend = 0.1 + t * 0.9;
      const phase1 = t * Math.PI * 0.8 + seed;
      const phase2 = t * Math.PI * 1.5 + seed * 0.7;
      const swayX = (Math.sin(phase1) * amp1 + Math.sin(phase2) * amp2 * 0.5) * blend;
      const swayZ = (Math.cos(phase1 * 0.9 + 0.7) * amp1 * 0.75 + Math.cos(phase2 * 0.85 + 0.3) * amp2 * 0.4) * blend;
      points.push(new THREE.Vector3(swayX, y, swayZ));
    }
    return new THREE.CatmullRomCurve3(points);
  }, [height, seed]);

  const sideCurves = useMemo(() => {
    const out: { curve: THREE.CatmullRomCurve3; color: string }[] = [];
    [0.35, 0.6, 0.82].forEach((bt, bi) => {
      const base = mainCurve.getPointAt(bt);
      const dir = bi % 2 === 0 ? 1 : -1;
      const len = height * 0.15;
      out.push({
        curve: new THREE.CatmullRomCurve3([
          base.clone(),
          new THREE.Vector3(base.x + 0.6 * dir, base.y + len * 0.5, base.z + 0.3 * dir),
          new THREE.Vector3(base.x + 1.0 * dir, base.y + len, base.z + 0.5 * dir),
        ]),
        color: variant.colors[(bi + 1) % variant.colors.length],
      });
    });
    return out;
  }, [mainCurve, height, variant.colors]);

  const leaves = useMemo(() => {
    const out: { pos: [number, number, number]; rot: [number, number, number]; sc: number; col: string }[] = [];
    const leafCount = 6;
    for (let li = 0; li < leafCount; li++) {
      const t = 0.2 + (li / leafCount) * 0.7;
      const pt = mainCurve.getPointAt(t);
      const side = li % 2 === 0 ? 1 : -1;
      out.push({
        pos: [pt.x + side * 0.35, pt.y, pt.z + side * 0.25],
        rot: [0.15 * side, seed + li * 0.6, 0.4 * side],
        sc: 0.9 + (li % 3) * 0.2,
        col: variant.colors[li % variant.colors.length],
      });
    }
    return out;
  }, [mainCurve, seed, variant.colors]);

  return (
    <group>
      <mesh>
        <tubeGeometry args={[mainCurve, 28, 0.22, 6, false]} />
        <meshStandardMaterial color={mainColor} roughness={0.85} metalness={0} />
      </mesh>
      {sideCurves.map((b, bi) => (
        <mesh key={bi}>
          <tubeGeometry args={[b.curve, 12, 0.1, 4, false]} />
          <meshStandardMaterial color={b.color} roughness={0.88} metalness={0} />
        </mesh>
      ))}
      {leaves.map((lf, li) => (
        <SeaweedLeaf key={li} position={lf.pos} rotation={lf.rot} scale={lf.sc} color={lf.col} />
      ))}
      <mesh position={[0, 0.08, 0]}>
        <sphereGeometry args={[0.32, 6, 5]} />
        <meshStandardMaterial color="#2a5a42" roughness={0.95} metalness={0} />
      </mesh>
    </group>
  );
}

const ROCKS: Array<[number, number, number]> = [
  [-24, -20, 0.85],
  [-24, -6, 0.7],
  [-24, 10, 0.75],
  [-24, 22, 0.8],
  [24, -22, 0.75],
  [24, -8, 0.7],
  [24, 6, 0.8],
  [24, 20, 0.7],
  [-12, -26, 0.9],
  [0, -26, 0.65],
  [14, -26, 0.75],
  [-16, 26, 0.7],
  [4, 26, 0.8],
  [20, 26, 0.65],
  [-18, -8, 1.0],
  [16, 10, 0.75],
  [-6, 14, 1.1],
  [10, -12, 0.85],
  [-20, 4, 1.05],
  [4, -10, 0.7],
  [20, -4, 0.9],
  [-14, 12, 0.8],
  [22, 14, 0.65],
  [-22, -12, 0.75],
  [-10, -18, 0.9],
  [6, 18, 0.75],
  [0, 6, 1.0],
  [12, 2, 0.7],
  [-6, 2, 0.65],
  [18, -14, 0.85],
  [-18, 16, 0.8],
  [24, 6, 0.75],
  [-8, -14, 0.6],
  [8, 16, 0.6],
  [-14, 0, 0.7],
  [14, -6, 0.65],
  [2, -20, 0.8],
  [-4, 20, 0.7],
  [18, 0, 0.6],
  [-20, -16, 0.75],
  [22, -18, 0.7],
];

const ROCK_COLORS = ["#8f7b66", "#7a6b5a", "#9c8974", "#6e6052", "#a5957f"];

function IrregularRockGeometry({ scale, seed }: { scale: number; seed: number }) {
  const geometry = useMemo(() => {
    const geo = new THREE.IcosahedronGeometry(scale, 2);
    const pos = geo.attributes.position;
    geo.computeVertexNormals();
    const norm = geo.attributes.normal;
    const colors: number[] = [];
    const baseColor = new THREE.Color(ROCK_COLORS[Math.floor(seed) % ROCK_COLORS.length]);
    const mossColor = new THREE.Color("#4a6b4a");
    const lichColor = new THREE.Color("#8a9a78");
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i);
      let y = pos.getY(i);
      let z = pos.getZ(i);
      const nx = norm.getX(i);
      const ny = norm.getY(i);
      const nz = norm.getZ(i);
      const n1 = Math.sin(x * seed * 2.3 + y * 1.7) * Math.cos(z * seed * 1.1 + 0.5);
      const n2 = Math.sin(x * 4.1 + z * 3.7 + seed) * 0.5;
      const n3 = Math.cos(y * 5.3 + x * 2.1 + seed * 0.7) * 0.3;
      const distort = 0.2 + (n1 + n2 + n3) * 0.22;
      const flattenY = y < 0 ? 0.5 : 1.0;
      const crackX = Math.sin(x * 10 + seed * 3) * 0.08;
      const crackZ = Math.cos(z * 9 + seed * 2.5) * 0.08;
      const spike = (Math.sin(i * 1.7 + seed * 5) * 0.5 + 0.5) * scale * 0.35;
      x = x * (1 + distort * 0.5) + crackX + nx * spike;
      y = y * flattenY * (1 + distort * 0.3) + ny * spike * 0.8;
      z = z * (1 + distort * 0.5) + crackZ + nz * spike;
      const faceted = Math.sin(x * 6 + seed) * 0.04 + Math.cos(z * 6 + seed * 2) * 0.04;
      x += faceted; z += faceted;
      pos.setXYZ(i, x, y, z);

      const heightBlend = (y / scale + 1) * 0.5;
      const noiseBlend = (n1 + 1) * 0.5;
      const c = baseColor.clone();
      if (heightBlend > 0.6 && noiseBlend > 0.4) {
        c.lerp(mossColor, (heightBlend - 0.6) * 2 * noiseBlend);
      }
      if (noiseBlend > 0.65) {
        c.lerp(lichColor, (noiseBlend - 0.65) * 1.5);
      }
      c.multiplyScalar(0.85 + n2 * 0.3);
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }, [scale, seed]);
  return <primitive object={geometry} attach="geometry" />;
}

function RockMossClump({ x, y, z, seed }: { x: number; y: number; z: number; seed: number }) {
  const count = 3 + Math.floor(seed % 4);
  return (
    <group position={[x, y, z]}>
      {Array.from({ length: count }).map((_, i) => {
        const angle = (i / count) * Math.PI * 2 + seed;
        const r = 0.2 + (i % 3) * 0.1;
        return (
          <mesh key={i} position={[Math.cos(angle) * r, 0.05, Math.sin(angle) * r]}>
            <sphereGeometry args={[0.12 + (i % 3) * 0.04, 6, 4]} />
            <meshStandardMaterial color={i % 2 === 0 ? "#3d5c3d" : "#4a6a3e"} roughness={0.95} metalness={0} />
          </mesh>
        );
      })}
    </group>
  );
}

function Rocks() {
  return (
    <group>
      {ROCKS.map(([x, z, scale], i) => {
        const yBase = sandHeightAt(x, z);
        return (
          <group key={i}>
            <mesh
              position={[x, yBase + scale * 0.35, z]}
              rotation={[Math.sin(i * 0.5) * 0.2, i * 0.6, Math.cos(i * 0.3) * 0.15]}
            >
              <IrregularRockGeometry scale={scale} seed={i * 1.3 + 0.5} />
              <meshStandardMaterial roughness={0.92} metalness={0.02} flatShading vertexColors />
            </mesh>
            {i % 2 === 0 && (
              <RockMossClump x={x} y={yBase + scale * 0.6} z={z} seed={i * 2.1} />
            )}
            {i % 3 === 0 && (
              <mesh position={[x + 0.3, yBase + scale * 0.15, z + 0.2]} rotation={[0.1, i, 0.05]}>
                <dodecahedronGeometry args={[scale * 0.35, 1]} />
                <meshStandardMaterial color="#6e6052" roughness={0.95} metalness={0} flatShading />
              </mesh>
            )}
          </group>
        );
      })}
    </group>
  );
}

function JaggedFloorScatter() {
  const JAG_COLORS = ["#7a6b5a", "#6e6052", "#8a7a68", "#5a4e42", "#9c8a76", "#7e6e5e"];
  const positions = useMemo(() => {
    const out: Array<[number, number, number, number, number]> = [];
    const halfX = TANK_BOX[0] / 2 - 5;
    const halfZ = TANK_BOX[2] / 2 - 5;
    const minDist = 2.2;
    const placed: Array<{ x: number; z: number }> = [];
    const seed = 12.9898;
    const rand = (i: number, j: number) => {
      const x = Math.sin(i * seed + j * 78.233) * 43758.5453;
      return x - Math.floor(x);
    };
    let id = 0;
    for (let pass = 0; pass < 3; pass++) {
      const step = pass === 0 ? 4.5 : pass === 1 ? 3.2 : 2.8;
      const scaleMin = pass === 0 ? 0.38 : pass === 1 ? 0.32 : 0.28;
      const scaleRange = pass === 0 ? 0.42 : pass === 1 ? 0.28 : 0.22;
      for (let xi = -halfX; xi <= halfX; xi += step) {
        for (let zi = -halfZ; zi <= halfZ; zi += step) {
          const jx = (rand(id, 1) * 2 - 1) * step * 0.85;
          const jz = (rand(id, 2) * 2 - 1) * step * 0.85;
          const px = xi + jx;
          const pz = zi + jz;
          const tooClose = placed.some((p) => (p.x - px) ** 2 + (p.z - pz) ** 2 < minDist ** 2);
          if (tooClose && pass > 0) continue;
          placed.push({ x: px, z: pz });
          const scale = scaleMin + rand(id, 3) * scaleRange;
          const rotY = (xi + zi + id) * 0.4;
          const heightOff = 0.25 + rand(id, 4) * 0.55;
          out.push([px, pz, scale, rotY, heightOff]);
          id++;
        }
      }
    }
    return out;
  }, []);

  return (
    <group>
      {positions.map(([x, z, scale, rotY, heightOff], i) => {
        const yBase = sandHeightAt(x, z);
        const shape = i % 3;
        const color = JAG_COLORS[i % JAG_COLORS.length];
        const rotX = Math.sin(i * 0.7) * 0.25;
        const rotZ = Math.cos(i * 0.9) * 0.2;
        const y = yBase + scale * heightOff;
        return (
          <mesh key={i} position={[x, y, z]} rotation={[rotX, rotY, rotZ]}>
            {shape === 0 && <tetrahedronGeometry args={[scale, 0]} />}
            {shape === 1 && <octahedronGeometry args={[scale, 0]} />}
            {shape === 2 && <dodecahedronGeometry args={[scale * 0.9, 0]} />}
            <meshStandardMaterial color={color} roughness={0.95} metalness={0.02} flatShading />
          </mesh>
        );
      })}
    </group>
  );
}

const PEBBLES: Array<[number, number, number]> = [
  [-14, -4, 0.15], [-6, 6, 0.18], [6, 12, 0.12], [14, -10, 0.2],
  [-20, 10, 0.16], [22, 4, 0.14], [2, -14, 0.1], [-8, 14, 0.12],
  [0, 0, 0.14], [-18, -12, 0.16], [18, 14, 0.13], [-4, -8, 0.11],
  [8, -16, 0.15], [-16, 16, 0.12], [12, -4, 0.17], [-10, 2, 0.13],
];

function Pebbles() {
  const PEB_COLORS = ["#9c876d", "#8a7560", "#a89878", "#907a68", "#b0a088"];
  return (
    <group>
      {PEBBLES.map(([x, z, scale], i) => (
        <mesh key={i} position={[x, sandHeightAt(x, z) + scale * 0.3, z]} rotation={[i * 0.3, i * 0.5, i * 0.2]} scale={[1, 0.6 + (i % 3) * 0.15, 1]}>
          <dodecahedronGeometry args={[scale, 1]} />
          <meshStandardMaterial color={PEB_COLORS[i % PEB_COLORS.length]} roughness={0.98} metalness={0} flatShading />
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
  const BARK_COLORS = ["#8b6b4a", "#7a5c3e", "#9a7b5a", "#6e5036"];
  return (
    <group>
      {DRIFTWOOD.map(([x, z, length, radius], i) => {
        const yBase = sandHeightAt(x, z);
        return (
          <group key={i} position={[x, yBase + radius * 0.6, z]} rotation={[0.2, i * 0.6, 0.1]}>
            <mesh>
              <cylinderGeometry args={[radius * 0.85, radius * 1.1, length, 8]} />
              <meshStandardMaterial color={BARK_COLORS[i % BARK_COLORS.length]} roughness={0.92} metalness={0} />
            </mesh>
            <mesh rotation={[0, 0.3, 0]}>
              <cylinderGeometry args={[radius * 1.05, radius * 1.25, length * 0.95, 8]} />
              <meshStandardMaterial color={BARK_COLORS[(i + 1) % BARK_COLORS.length]} roughness={0.95} metalness={0} transparent opacity={0.6} />
            </mesh>
            {Array.from({ length: 3 }).map((_, ki) => {
              const ky = -length * 0.3 + ki * length * 0.3;
              return (
                <mesh key={`k-${ki}`} position={[radius * 0.8, ky, 0]} rotation={[0, ki * 1.2, 0]}>
                  <sphereGeometry args={[radius * 0.35, 5, 4]} />
                  <meshStandardMaterial color="#6e5036" roughness={0.95} metalness={0} />
                </mesh>
              );
            })}
            <mesh position={[0, length * 0.52, 0]} rotation={[0.3, 0, 0.5]}>
              <cylinderGeometry args={[radius * 0.3, radius * 0.5, length * 0.3, 5]} />
              <meshStandardMaterial color="#7a5c3e" roughness={0.92} metalness={0} />
            </mesh>
            <mesh position={[0, -length * 0.48, 0]} rotation={[-0.2, 0.5, -0.3]}>
              <cylinderGeometry args={[radius * 0.25, radius * 0.4, length * 0.25, 5]} />
              <meshStandardMaterial color="#7a5c3e" roughness={0.92} metalness={0} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

const POTTERY_SHARDS: Array<[number, number, number]> = [
  [-2, -12, 0.35],
  [6, -14, 0.28],
  [0, -10, 0.22],
];

function PotteryShards() {
  const SHARD_COLORS = ["#c26d4f", "#b05d42", "#d47d5f", "#a85038"];
  return (
    <group>
      {POTTERY_SHARDS.map(([x, z, scale], i) => {
        const yBase = sandHeightAt(x, z);
        return (
          <group key={i} position={[x, yBase, z]}>
            <mesh position={[0, scale * 0.2, 0]} rotation={[0.2, i * 0.5, 0.1]}>
              <tetrahedronGeometry args={[scale, 1]} />
              <meshStandardMaterial color={SHARD_COLORS[i % SHARD_COLORS.length]} roughness={0.75} metalness={0.08} flatShading />
            </mesh>
            {Array.from({ length: 3 }).map((_, si) => (
              <mesh key={`s-${si}`} position={[Math.sin(si + i) * 0.2, scale * 0.1, Math.cos(si + i) * 0.15]} rotation={[si * 0.3, si * 0.7, 0.4]}>
                <tetrahedronGeometry args={[scale * 0.4, 0]} />
                <meshStandardMaterial color={SHARD_COLORS[(si + i) % SHARD_COLORS.length]} roughness={0.78} metalness={0.06} flatShading />
              </mesh>
            ))}
          </group>
        );
      })}
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
  const SHELL_COLORS = ["#e6d3b8", "#d8c5aa", "#f0e0c8", "#c8b898"];
  return (
    <group>
      {SHELLS.map(([x, z, scale], i) => {
        const yBase = sandHeightAt(x, z);
        return (
          <group key={i} position={[x, yBase, z]} rotation={[0, i * 0.7, 0]}>
            <mesh position={[0, scale * 0.15, 0]} scale={[1, 0.5, 1]}>
              <sphereGeometry args={[scale, 8, 6]} />
              <meshStandardMaterial color={SHELL_COLORS[i % SHELL_COLORS.length]} roughness={0.6} metalness={0.08} />
            </mesh>
            {Array.from({ length: 8 }).map((_, ri) => {
              const angle = (ri / 8) * Math.PI;
              return (
                <mesh key={`r-${ri}`} position={[0, scale * 0.15, 0]} rotation={[0, 0, angle]}>
                  <boxGeometry args={[scale * 2, 0.01, 0.02]} />
                  <meshStandardMaterial color="#d0b898" roughness={0.7} metalness={0.05} />
                </mesh>
              );
            })}
            <mesh position={[0, scale * 0.25, 0]}>
              <sphereGeometry args={[scale * 0.3, 6, 5]} />
              <meshStandardMaterial color="#f8e8d0" roughness={0.5} metalness={0.1} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

const CORAL_MOUNDS: Array<[number, number, number]> = [
  [-6, -2, 0.6],
  [12, 2, 0.5],
  [4, 8, 0.55],
  [-14, -10, 0.5],
  [20, 14, 0.45],
  [0, -16, 0.55],
  [-20, 8, 0.5],
];

function CoralMounds() {
  const CORAL_COLORS = ["#d97c6b", "#e08a76", "#c96858", "#e8a090", "#d45a4a", "#cc7766"];
  return (
    <group>
      {CORAL_MOUNDS.map(([x, z, scale], i) => {
        const yBase = sandHeightAt(x, z);
        return (
          <group key={i} position={[x, yBase, z]}>
            {Array.from({ length: 5 + (i % 3) }).map((_, bi) => {
              const angle = (bi / (5 + (i % 3))) * Math.PI * 2 + i * 0.8;
              const r = scale * (0.2 + (bi % 3) * 0.15);
              const h = scale * (0.8 + (bi % 4) * 0.3);
              const w = scale * (0.25 + (bi % 2) * 0.12);
              return (
                <mesh key={`br-${bi}`} position={[Math.cos(angle) * r, h * 0.5, Math.sin(angle) * r]} rotation={[Math.sin(bi + i) * 0.2, angle, Math.cos(bi) * 0.15]}>
                  <coneGeometry args={[w, h, 6]} />
                  <meshStandardMaterial color={CORAL_COLORS[(bi + i) % CORAL_COLORS.length]} roughness={0.82} metalness={0} />
                </mesh>
              );
            })}
            <mesh position={[0, scale * 0.2, 0]}>
              <sphereGeometry args={[scale * 0.5, 8, 6]} />
              <meshStandardMaterial color="#c06050" roughness={0.9} metalness={0} />
            </mesh>
            {Array.from({ length: 8 }).map((_, ti) => {
              const angle = (ti / 8) * Math.PI * 2 + i * 1.3;
              const r = scale * 0.3;
              return (
                <mesh key={`tip-${ti}`} position={[Math.cos(angle) * r, scale * 0.9 + (ti % 3) * 0.15, Math.sin(angle) * r]}>
                  <sphereGeometry args={[0.08 + (ti % 3) * 0.03, 5, 4]} />
                  <meshStandardMaterial color="#f0a0a0" roughness={0.6} metalness={0} />
                </mesh>
              );
            })}
          </group>
        );
      })}
    </group>
  );
}

const SPONGES: Array<[number, number, number]> = [
  [8, -6, 0.5],
  [-14, 8, 0.45],
];

function SpongePillars() {
  const SPONGE_COLORS = ["#e5b84f", "#d4a83e", "#c89830", "#edc55a"];
  return (
    <group>
      {SPONGES.map(([x, z, scale], i) => {
        const yBase = sandHeightAt(x, z);
        return (
          <group key={i} position={[x, yBase, z]}>
            <mesh position={[0, scale * 0.6, 0]} rotation={[0, i * 0.4, 0]}>
              <cylinderGeometry args={[scale * 0.4, scale * 0.55, scale * 1.4, 8]} />
              <meshStandardMaterial color={SPONGE_COLORS[i % SPONGE_COLORS.length]} roughness={0.85} metalness={0.03} />
            </mesh>
            {Array.from({ length: 10 }).map((_, pi) => {
              const angle = (pi / 10) * Math.PI * 2;
              const r = scale * 0.42;
              const h = scale * (0.3 + (pi % 4) * 0.25);
              return (
                <mesh key={`p-${pi}`} position={[Math.cos(angle) * r, h, Math.sin(angle) * r]}>
                  <sphereGeometry args={[0.06 + (pi % 3) * 0.02, 5, 4]} />
                  <meshStandardMaterial color="#c89830" roughness={0.9} metalness={0} />
                </mesh>
              );
            })}
            <mesh position={[0, scale * 1.25, 0]}>
              <torusGeometry args={[scale * 0.35, scale * 0.1, 6, 12]} />
              <meshStandardMaterial color={SPONGE_COLORS[(i + 1) % SPONGE_COLORS.length]} roughness={0.8} metalness={0.03} />
            </mesh>
            {i % 2 === 0 && (
              <mesh position={[scale * 0.4, scale * 0.3, 0]} rotation={[0, i * 1.2, 0.3]}>
                <cylinderGeometry args={[scale * 0.2, scale * 0.3, scale * 0.7, 7]} />
                <meshStandardMaterial color="#d4a83e" roughness={0.88} metalness={0.02} />
              </mesh>
            )}
          </group>
        );
      })}
    </group>
  );
}

const ANEMONES: Array<[number, number]> = [
  [2, 12],
  [-4, 10],
  [14, -8],
  [-16, 6],
  [8, 16],
  [-10, -14],
];

function AnemoneTufts() {
  const TENTACLE_COLORS = ["#f08fa4", "#e87898", "#d4688a", "#f5a0b8", "#e06080"];
  return (
    <group>
      {ANEMONES.map(([x, z], i) => {
        const yBase = sandHeightAt(x, z);
        const tentacleCount = 14 + (i % 4) * 2;
        return (
          <group key={i} position={[x, yBase, z]}>
            <mesh position={[0, 0.15, 0]}>
              <cylinderGeometry args={[0.4, 0.5, 0.3, 8]} />
              <meshStandardMaterial color="#a0506e" roughness={0.9} metalness={0} />
            </mesh>
            <mesh position={[0, 0.32, 0]}>
              <cylinderGeometry args={[0.45, 0.38, 0.15, 8]} />
              <meshStandardMaterial color="#b06070" roughness={0.85} metalness={0} />
            </mesh>
            {Array.from({ length: tentacleCount }).map((_, ti) => {
              const angle = (ti / tentacleCount) * Math.PI * 2;
              const ring = ti < tentacleCount / 2 ? 0.25 : 0.15;
              const h = 0.6 + (ti % 4) * 0.15;
              const tilt = 0.3 + (ti % 3) * 0.1;
              return (
                <mesh key={`t-${ti}`} position={[Math.cos(angle) * ring, 0.4 + h * 0.5, Math.sin(angle) * ring]} rotation={[Math.cos(angle) * tilt, 0, Math.sin(angle) * tilt]}>
                  <cylinderGeometry args={[0.025, 0.045, h, 4]} />
                  <meshStandardMaterial color={TENTACLE_COLORS[ti % TENTACLE_COLORS.length]} roughness={0.75} metalness={0} />
                </mesh>
              );
            })}
            {Array.from({ length: tentacleCount }).map((_, ti) => {
              const angle = (ti / tentacleCount) * Math.PI * 2;
              const ring = ti < tentacleCount / 2 ? 0.25 : 0.15;
              const h = 0.6 + (ti % 4) * 0.15;
              return (
                <mesh key={`tip-${ti}`} position={[Math.cos(angle) * ring, 0.4 + h, Math.sin(angle) * ring]}>
                  <sphereGeometry args={[0.04, 5, 4]} />
                  <meshStandardMaterial color="#f8c0d0" roughness={0.6} metalness={0.05} emissive="#f8c0d0" emissiveIntensity={0.15} />
                </mesh>
              );
            })}
          </group>
        );
      })}
    </group>
  );
}

const KELP_CLUSTERS: Array<[number, number]> = [
  [18, 6],
  [-18, -2],
  [22, -10],
  [-22, 12],
  [6, -18],
  [-8, 18],
];

function KelpClusters() {
  const KELP_COLORS = ["#2f7a55", "#2d6a4f", "#347f59", "#287045", "#3c8f66"];
  return (
    <group>
      {KELP_CLUSTERS.map(([x, z], i) => {
        const yBase = sandHeightAt(x, z);
        const bladeCount = 5 + (i % 3) * 2;
        return (
          <group key={i} position={[x, yBase, z]} rotation={[0, i * 0.4, 0]}>
            <mesh position={[0, 0.1, 0]}>
              <sphereGeometry args={[0.4, 6, 5]} />
              <meshStandardMaterial color="#2a5a42" roughness={0.95} metalness={0} />
            </mesh>
            {Array.from({ length: bladeCount }).map((_, bi) => {
              const angle = (bi / bladeCount) * Math.PI * 2;
              const offsetX = Math.cos(angle) * 0.3;
              const offsetZ = Math.sin(angle) * 0.3;
              const h = 3.0 + (bi % 4) * 0.8;
              const curve = new THREE.CatmullRomCurve3([
                new THREE.Vector3(offsetX, 0, offsetZ),
                new THREE.Vector3(offsetX + Math.sin(bi + i) * 0.6, h * 0.3, offsetZ + Math.cos(bi) * 0.4),
                new THREE.Vector3(offsetX + Math.sin(bi * 0.7 + i) * 1.0, h * 0.6, offsetZ + Math.cos(bi * 1.2) * 0.6),
                new THREE.Vector3(offsetX + Math.sin(bi * 1.3 + i * 0.5) * 1.2, h * 0.85, offsetZ + Math.cos(bi * 0.8 + i) * 0.7),
                new THREE.Vector3(offsetX + Math.sin(bi * 0.9 + i * 1.1) * 0.8, h, offsetZ + Math.cos(bi * 1.5) * 0.5),
              ]);
              return (
                <group key={`blade-${bi}`}>
                  <mesh>
                    <tubeGeometry args={[curve, 18, 0.08 + (bi % 3) * 0.02, 5, false]} />
                    <meshStandardMaterial color={KELP_COLORS[bi % KELP_COLORS.length]} roughness={0.85} metalness={0} />
                  </mesh>
                  {Array.from({ length: 4 }).map((_, li) => {
                    const t = 0.2 + (li / 4) * 0.6;
                    const pt = curve.getPointAt(t);
                    const side = li % 2 === 0 ? 1 : -1;
                    return (
                      <mesh key={`kl-${li}`} position={[pt.x + side * 0.15, pt.y, pt.z]} rotation={[0.2 * side, bi + li * 0.5, 0.4 * side]}>
                        <planeGeometry args={[0.5 + (li % 3) * 0.15, 0.25]} />
                        <meshStandardMaterial color={KELP_COLORS[(bi + li) % KELP_COLORS.length]} roughness={0.8} metalness={0} side={THREE.DoubleSide} />
                      </mesh>
                    );
                  })}
                  {bi % 2 === 0 && (
                    <mesh position={[curve.getPointAt(0.95).x, curve.getPointAt(0.95).y, curve.getPointAt(0.95).z]}>
                      <sphereGeometry args={[0.12, 6, 5]} />
                      <meshStandardMaterial color="#4a9a6a" roughness={0.7} metalness={0} />
                    </mesh>
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

const PEBBLE_PILES: Array<[number, number]> = [
  [14, 14],
  [-6, -14],
];

function PebblePiles() {
  const PEBBLE_COLORS = ["#a08e75", "#8e7c65", "#b09e85", "#968470", "#a89878"];
  return (
    <group>
      {PEBBLE_PILES.map(([x, z], i) => (
        <group key={i} position={[x, sandHeightAt(x, z) + 0.1, z]}>
          {Array.from({ length: 12 }).map((_, idx) => {
            const angle = (idx / 12) * Math.PI * 2 + i;
            const dist = 0.2 + (idx % 3) * 0.15;
            const sz = 0.1 + (idx % 4) * 0.05;
            return (
              <mesh key={idx} position={[Math.cos(angle) * dist, sz * 0.3 + (idx % 2) * 0.05, Math.sin(angle) * dist]} rotation={[idx * 0.3, idx * 0.5, idx * 0.2]}>
                <dodecahedronGeometry args={[sz, 1]} />
                <meshStandardMaterial color={PEBBLE_COLORS[idx % PEBBLE_COLORS.length]} roughness={0.98} metalness={0} flatShading />
              </mesh>
            );
          })}
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
      {REEF_ARCHES.map(([x, z], i) => {
        const yBase = sandHeightAt(x, z);
        const pillarStones = 6;
        return (
          <group key={i} position={[x, yBase, z]} rotation={[0, i * 0.8, 0]}>
            {Array.from({ length: pillarStones }).map((_, pi) => (
              <mesh key={`l-${pi}`} position={[-0.5 + Math.sin(pi + i) * 0.08, pi * 0.22 + 0.12, Math.cos(pi * 0.7) * 0.06]} rotation={[pi * 0.1, pi * 0.3, 0]}>
                <dodecahedronGeometry args={[0.28 + (pi % 2) * 0.05, 1]} />
                <meshStandardMaterial color={pi % 2 === 0 ? "#6a5a45" : "#7a6b58"} roughness={0.92} metalness={0.02} flatShading />
              </mesh>
            ))}
            {Array.from({ length: pillarStones }).map((_, pi) => (
              <mesh key={`r-${pi}`} position={[0.5 + Math.sin(pi + i * 2) * 0.08, pi * 0.22 + 0.12, Math.cos(pi * 0.9) * 0.06]} rotation={[pi * 0.15, pi * 0.2, 0]}>
                <dodecahedronGeometry args={[0.28 + (pi % 3) * 0.04, 1]} />
                <meshStandardMaterial color={pi % 2 === 0 ? "#7a6b58" : "#6a5a45"} roughness={0.92} metalness={0.02} flatShading />
              </mesh>
            ))}
            {Array.from({ length: 5 }).map((_, ai) => {
              const t = ai / 4;
              const angle = Math.PI * t;
              return (
                <mesh key={`a-${ai}`} position={[Math.cos(angle) * 0.5, pillarStones * 0.22 + Math.sin(angle) * 0.3, 0]} rotation={[0, 0, angle - Math.PI / 2]}>
                  <dodecahedronGeometry args={[0.25 + (ai % 2) * 0.05, 1]} />
                  <meshStandardMaterial color="#7a6a55" roughness={0.9} metalness={0.03} flatShading />
                </mesh>
              );
            })}
            <mesh position={[-0.6, 0.05, 0]}>
              <sphereGeometry args={[0.15, 5, 4]} />
              <meshStandardMaterial color="#3d5c3d" roughness={0.95} metalness={0} />
            </mesh>
            <mesh position={[0.55, 0.05, 0.1]}>
              <sphereGeometry args={[0.12, 5, 4]} />
              <meshStandardMaterial color="#4a6a3e" roughness={0.95} metalness={0} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

const CORAL_FAN_POSITIONS: Array<[number, number]> = [
  [-12, 6], [10, -10], [18, 12], [-20, -8], [0, 14], [-8, -18],
];

function CoralFans() {
  const FAN_COLORS = ["#e06858", "#d45a4a", "#c94838", "#e87868", "#b03828"];
  return (
    <group>
      {CORAL_FAN_POSITIONS.map(([x, z], i) => {
        const yBase = sandHeightAt(x, z);
        const fanHeight = 1.8 + (i % 3) * 0.4;
        const ribCount = 7 + (i % 4);
        return (
          <group key={i} position={[x, yBase, z]} rotation={[0, i * 1.2, 0]}>
            <mesh position={[0, 0.2, 0]}>
              <cylinderGeometry args={[0.12, 0.2, 0.4, 6]} />
              <meshStandardMaterial color="#8a6050" roughness={0.9} metalness={0} />
            </mesh>
            {Array.from({ length: ribCount }).map((_, ri) => {
              const angle = -0.6 + (ri / (ribCount - 1)) * 1.2;
              const h = fanHeight * (0.7 + (ri % 3) * 0.15);
              const curve = new THREE.CatmullRomCurve3([
                new THREE.Vector3(0, 0.35, 0),
                new THREE.Vector3(Math.sin(angle) * h * 0.3, 0.35 + h * 0.4, 0.1),
                new THREE.Vector3(Math.sin(angle) * h * 0.5, 0.35 + h * 0.75, 0.15),
                new THREE.Vector3(Math.sin(angle) * h * 0.55, 0.35 + h, 0.08),
              ]);
              return (
                <mesh key={`rib-${ri}`}>
                  <tubeGeometry args={[curve, 12, 0.03 + (ri % 2) * 0.01, 4, false]} />
                  <meshStandardMaterial color={FAN_COLORS[ri % FAN_COLORS.length]} roughness={0.75} metalness={0} />
                </mesh>
              );
            })}
            {Array.from({ length: ribCount - 1 }).map((_, mi) => {
              const a1 = -0.6 + (mi / (ribCount - 1)) * 1.2;
              const a2 = -0.6 + ((mi + 1) / (ribCount - 1)) * 1.2;
              const h = fanHeight * 0.6;
              const cx = (Math.sin(a1) + Math.sin(a2)) * h * 0.25;
              const cy = 0.35 + h * 0.5;
              return (
                <mesh key={`mem-${mi}`} position={[cx, cy, 0.1]} rotation={[0, 0, (a1 + a2) / 2]}>
                  <planeGeometry args={[0.25, h * 0.6]} />
                  <meshStandardMaterial color={FAN_COLORS[(mi + i) % FAN_COLORS.length]} roughness={0.8} metalness={0} side={THREE.DoubleSide} transparent opacity={0.85} />
                </mesh>
              );
            })}
          </group>
        );
      })}
    </group>
  );
}

const SEA_GRASS_POSITIONS: Array<[number, number]> = [
  [-16, -14], [14, 16], [-22, 0], [20, -6], [0, -20], [-4, 20], [10, 10], [-12, -6],
];

function SeaGrassBeds() {
  const GRASS_COLORS = ["#3a7a4a", "#2d6a3f", "#4a8a5a", "#358a48", "#2a6035"];
  return (
    <group>
      {SEA_GRASS_POSITIONS.map(([x, z], i) => {
        const yBase = sandHeightAt(x, z);
        const bladeCount = 10 + (i % 5) * 3;
        return (
          <group key={i} position={[x, yBase, z]}>
            {Array.from({ length: bladeCount }).map((_, bi) => {
              const angle = (bi / bladeCount) * Math.PI * 2 + i;
              const dist = 0.3 + (bi % 4) * 0.15;
              const bx = Math.cos(angle) * dist;
              const bz = Math.sin(angle) * dist;
              const h = 0.8 + (bi % 5) * 0.25;
              const lean = 0.15 + (bi % 3) * 0.08;
              return (
                <mesh key={`gb-${bi}`} position={[bx, h * 0.5, bz]} rotation={[Math.cos(angle) * lean, 0, Math.sin(angle) * lean]}>
                  <planeGeometry args={[0.08, h]} />
                  <meshStandardMaterial color={GRASS_COLORS[bi % GRASS_COLORS.length]} roughness={0.85} metalness={0} side={THREE.DoubleSide} />
                </mesh>
              );
            })}
          </group>
        );
      })}
    </group>
  );
}

function IrregularRockCluster({ seed, scale }: { seed: number; scale: number }) {
  const CLUSTER_COLORS = ["#5a4a35", "#6a5a45", "#7a6b58", "#8a7b68", "#5e5040"];
  const rocks = useMemo(() => {
    const result: Array<{ pos: [number, number, number]; size: number; rot: [number, number, number]; sub: number }> = [];
    const count = 7 + Math.floor(seed * 3) % 5;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + seed * 0.5;
      const dist = scale * 0.25 + (Math.sin(seed * 10 + i * 2.3) * 0.5 + 0.5) * scale * 0.45;
      const height = scale * 0.25 + (Math.cos(seed * 7 + i * 1.7) * 0.5 + 0.5) * scale * 0.55;
      result.push({
        pos: [Math.cos(angle) * dist, height, Math.sin(angle) * dist],
        size: scale * 0.2 + (Math.sin(seed * 5 + i) * 0.5 + 0.5) * scale * 0.3,
        rot: [seed + i * 0.3, i * 0.7, seed * 0.5 + i * 0.2],
        sub: i % 3 === 0 ? 2 : 1,
      });
    }
    return result;
  }, [seed, scale]);

  return (
    <group>
      {rocks.map((rock, i) => (
        <group key={i}>
          <mesh position={rock.pos} rotation={rock.rot}>
            <dodecahedronGeometry args={[rock.size, rock.sub]} />
            <meshStandardMaterial color={CLUSTER_COLORS[i % CLUSTER_COLORS.length]} roughness={0.95} flatShading />
          </mesh>
          {i % 3 === 0 && (
            <mesh position={[rock.pos[0], rock.pos[1] + rock.size * 0.7, rock.pos[2]]}>
              <sphereGeometry args={[0.12, 5, 4]} />
              <meshStandardMaterial color="#3d5c3d" roughness={0.95} metalness={0} />
            </mesh>
          )}
        </group>
      ))}
    </group>
  );
}

function CaveArch({ scale, seed }: { scale: number; seed: number }) {
  const ARCH_COLORS = ["#5a4a35", "#6a5a45", "#7a6b58", "#4e4030", "#685848"];
  const rocks = useMemo(() => {
    const result: Array<{ pos: [number, number, number]; size: number; rot: number; sub: number }> = [];
    const leftPillar = 10 + Math.floor(seed * 2) % 4;
    for (let i = 0; i < leftPillar; i++) {
      const t = i / leftPillar;
      const x = -scale * 0.5 + Math.sin(seed * 3 + i) * scale * 0.12;
      const y = t * scale * 1.3;
      const z = Math.cos(seed * 5 + i * 0.8) * scale * 0.08;
      result.push({
        pos: [x, y, z],
        size: scale * 0.22 + Math.sin(seed + i) * scale * 0.08,
        rot: seed + i * 0.4,
        sub: i % 4 === 0 ? 2 : 1,
      });
    }
    const rightPillar = 10 + Math.floor(seed * 3) % 4;
    for (let i = 0; i < rightPillar; i++) {
      const t = i / rightPillar;
      const x = scale * 0.5 + Math.sin(seed * 4 + i) * scale * 0.12;
      const y = t * scale * 1.3;
      const z = Math.cos(seed * 6 + i * 0.9) * scale * 0.08;
      result.push({
        pos: [x, y, z],
        size: scale * 0.22 + Math.cos(seed + i) * scale * 0.08,
        rot: seed * 2 + i * 0.3,
        sub: i % 3 === 0 ? 2 : 1,
      });
    }
    const archTop = 8 + Math.floor(seed * 2) % 3;
    for (let i = 0; i < archTop; i++) {
      const t = i / (archTop - 1);
      const angle = Math.PI * t;
      const x = Math.cos(angle) * scale * 0.5;
      const y = scale * 1.2 + Math.sin(angle) * scale * 0.35;
      result.push({
        pos: [x, y, Math.sin(seed * 2 + i) * scale * 0.08],
        size: scale * 0.28 + Math.sin(seed * 3 + i) * scale * 0.08,
        rot: seed + i,
        sub: 1,
      });
    }
    return result;
  }, [scale, seed]);

  const stalactites = useMemo(() => {
    const out: Array<{ pos: [number, number, number]; h: number }> = [];
    const count = 4 + Math.floor(seed * 2) % 3;
    for (let i = 0; i < count; i++) {
      const t = 0.2 + (i / count) * 0.6;
      const angle = Math.PI * t;
      out.push({
        pos: [Math.cos(angle) * scale * 0.4, scale * 1.15 + Math.sin(angle) * scale * 0.25, Math.sin(seed + i) * scale * 0.05],
        h: 0.3 + (i % 3) * 0.15,
      });
    }
    return out;
  }, [scale, seed]);

  return (
    <group>
      {rocks.map((rock, i) => (
        <mesh key={`r-${i}`} position={rock.pos} rotation={[rock.rot * 0.3, rock.rot, rock.rot * 0.2]}>
          <dodecahedronGeometry args={[rock.size, rock.sub]} />
          <meshStandardMaterial color={ARCH_COLORS[i % ARCH_COLORS.length]} roughness={0.95} flatShading />
        </mesh>
      ))}
      {stalactites.map((st, si) => (
        <mesh key={`st-${si}`} position={st.pos} rotation={[Math.PI, 0, 0]}>
          <coneGeometry args={[0.1, st.h, 5]} />
          <meshStandardMaterial color="#8a7b6a" roughness={0.9} metalness={0.02} />
        </mesh>
      ))}
      <mesh position={[-scale * 0.5, scale * 0.1, 0]}>
        <sphereGeometry args={[scale * 0.12, 5, 4]} />
        <meshStandardMaterial color="#3d5c3d" roughness={0.95} metalness={0} />
      </mesh>
      <mesh position={[scale * 0.5, scale * 0.08, 0]}>
        <sphereGeometry args={[scale * 0.1, 5, 4]} />
        <meshStandardMaterial color="#4a6a3e" roughness={0.95} metalness={0} />
      </mesh>
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
      {CAVE_DOMES.map(([x, z, radius], i) => {
        const yBase = sandHeightAt(x, z);
        return (
          <group key={i} position={[x, yBase, z]}>
            <mesh position={[0, radius * 0.35, 0]} rotation={[0, i * 0.4, 0]}>
              <icosahedronGeometry args={[radius, 2]} />
              <meshStandardMaterial color="#6a5b4a" roughness={0.92} metalness={0.03} flatShading />
            </mesh>
            <mesh position={[0, radius * 0.6, 0]} rotation={[0, i * 0.7, 0]} scale={[1.1, 0.5, 1.1]}>
              <icosahedronGeometry args={[radius * 0.85, 1]} />
              <meshStandardMaterial color="#5a4d3e" roughness={0.95} metalness={0} flatShading transparent opacity={0.9} />
            </mesh>
            {Array.from({ length: 5 }).map((_, si) => {
              const angle = (si / 5) * Math.PI * 2 + i * 0.5;
              const stalH = 0.8 + (si % 3) * 0.4;
              return (
                <mesh key={`stal-${si}`} position={[Math.cos(angle) * radius * 0.5, radius * 0.55 + stalH * 0.3, Math.sin(angle) * radius * 0.5]} rotation={[0.1 * Math.sin(si), 0, 0.1 * Math.cos(si)]}>
                  <coneGeometry args={[0.15 + (si % 2) * 0.08, stalH, 5]} />
                  <meshStandardMaterial color="#8a7b6a" roughness={0.9} metalness={0.02} />
                </mesh>
              );
            })}
            {Array.from({ length: 12 }).map((_, idx) => {
              const angle = idx * 0.52 + i;
              const dist = radius * (0.75 + (idx % 3) * 0.12);
              const boulderScale = 0.5 + (idx % 4) * 0.2;
              return (
                <mesh key={`rub-${idx}`} position={[Math.cos(angle) * dist, boulderScale * 0.25, Math.sin(angle) * dist]} rotation={[idx * 0.3, idx * 0.5, idx * 0.2]}>
                  <dodecahedronGeometry args={[boulderScale, 1]} />
                  <meshStandardMaterial color={idx % 2 === 0 ? "#7a6b5a" : "#8f7b66"} roughness={0.93} metalness={0.02} flatShading />
                </mesh>
              );
            })}
            {Array.from({ length: 6 }).map((_, mi) => {
              const angle = mi * 1.05 + i * 0.3;
              const r = radius * 0.6;
              return (
                <mesh key={`moss-${mi}`} position={[Math.cos(angle) * r, radius * 0.5 + mi * 0.1, Math.sin(angle) * r]} rotation={[0.3 * mi, angle, 0]}>
                  <sphereGeometry args={[0.25 + (mi % 3) * 0.1, 6, 4]} />
                  <meshStandardMaterial color={mi % 2 === 0 ? "#3d5c3d" : "#4a6a3e"} roughness={0.95} metalness={0} />
                </mesh>
              );
            })}
          </group>
        );
      })}
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
      {BARNACLE_ROCKS.map(([x, z, scale], i) => {
        const yBase = sandHeightAt(x, z);
        return (
          <group key={i} position={[x, yBase + scale * 0.4, z]}>
            <mesh rotation={[0.1 * i, i * 0.7, 0]}>
              <icosahedronGeometry args={[scale, 2]} />
              <meshStandardMaterial color="#6e5e4a" roughness={0.95} metalness={0} flatShading />
            </mesh>
            <mesh rotation={[0, i * 0.3, 0]} scale={[1, 0.6, 1]}>
              <dodecahedronGeometry args={[scale * 1.1, 1]} />
              <meshStandardMaterial color="#7e6a56" roughness={0.93} metalness={0.01} flatShading />
            </mesh>
            {Array.from({ length: 8 }).map((_, idx) => {
              const angle = (idx / 8) * Math.PI * 2 + i;
              const r = scale * 0.6;
              const bSize = 0.08 + (idx % 3) * 0.04;
              return (
                <mesh key={`b-${idx}`} position={[Math.cos(angle) * r, scale * 0.3 + (idx % 3) * 0.08, Math.sin(angle) * r]}>
                  <coneGeometry args={[bSize, bSize * 2.5, 5]} />
                  <meshStandardMaterial color={idx % 2 === 0 ? "#d9c9b0" : "#c4b89a"} roughness={0.85} metalness={0.05} />
                </mesh>
              );
            })}
            {i % 2 === 0 && Array.from({ length: 6 }).map((_, ti) => {
              const angle = (ti / 6) * Math.PI * 2 + i * 1.5;
              const r = scale * 0.35;
              return (
                <mesh key={`ten-${ti}`} position={[Math.cos(angle) * r, scale * 0.5, Math.sin(angle) * r]} rotation={[Math.sin(ti) * 0.4, 0, Math.cos(ti) * 0.4]}>
                  <cylinderGeometry args={[0.03, 0.02, 0.5 + (ti % 3) * 0.15, 4]} />
                  <meshStandardMaterial color={ti % 2 === 0 ? "#e06050" : "#d04838"} roughness={0.7} metalness={0} />
                </mesh>
              );
            })}
            {Array.from({ length: 3 }).map((_, tw) => {
              const angle = tw * 2.1 + i * 0.8;
              return (
                <mesh key={`tw-${tw}`} position={[Math.cos(angle) * scale * 0.5, scale * 0.35, Math.sin(angle) * scale * 0.5]} rotation={[0.2, angle, 0.1]}>
                  <cylinderGeometry args={[0.04, 0.06, 0.6 + tw * 0.15, 5]} />
                  <meshStandardMaterial color="#a08060" roughness={0.9} metalness={0.02} />
                </mesh>
              );
            })}
          </group>
        );
      })}
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

function VineStrand({
  index,
  x,
  z,
  baseY,
  fullHeight,
}: {
  index: number;
  x: number;
  z: number;
  baseY: number;
  fullHeight: number;
}) {
  const vineColor = VINE_COLORS[index % VINE_COLORS.length];
  const leafColor = LEAF_COLORS[index % LEAF_COLORS.length];
  const heightScale = 0.58 + (index % 6) * 0.06;
  const vineHeight = fullHeight * heightScale;
  const curveAmp = 0.8 + Math.sin(index * 1.7) * 0.5 + (index % 3) * 0.25;
  const radiusBase = 0.28 + (index % 4) * 0.08;
  const radiusTip = 0.12 + (index % 3) * 0.04;
  const seed = index * 2.1 + 0.7;
  const leafScale = 0.9 + (index % 4) * 0.2;

  const curve = useMemo(() => {
    const points: THREE.Vector3[] = [];
    const steps = 24;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const y = t * vineHeight;
      const phase1 = t * Math.PI * 1.2 + seed;
      const phase2 = t * Math.PI * 2.1 + seed * 0.8;
      const bendX = (Math.sin(phase1) * curveAmp + Math.sin(phase2) * curveAmp * 0.4) * (0.1 + t * 0.9);
      const bendZ = (Math.cos(phase1 * 0.9 + 0.5) * curveAmp * 0.85 + Math.cos(phase2 * 0.7) * curveAmp * 0.35) * (0.1 + t * 0.9);
      points.push(new THREE.Vector3(bendX, y, bendZ));
    }
    return new THREE.CatmullRomCurve3(points);
  }, [vineHeight, curveAmp, seed]);

  const tubeGeo = useMemo(() => {
    const r0 = radiusBase * 0.95;
    const r1 = radiusTip * 0.95;
    return new THREE.TubeGeometry(curve, 32, (r0 + r1) / 2, 8, false);
  }, [curve, radiusBase, radiusTip]);

  const leafTs = [0.15, 0.28, 0.42, 0.55, 0.68, 0.82, 0.92];

  return (
    <group position={[x, baseY, z]}>
      <mesh>
        <primitive object={tubeGeo} attach="geometry" />
        <meshStandardMaterial color={vineColor} roughness={0.85} metalness={0} />
      </mesh>
      {leafTs.map((t, li) => {
        const pt = curve.getPointAt(t);
        const side = li % 2 === 0 ? 1 : -1;
        const lw = (1.2 + (li % 3) * 0.25) * leafScale;
        const lh = (0.5 + (li % 2) * 0.15) * leafScale;
        return (
          <group key={li}>
            <mesh position={[pt.x + side * 0.5, pt.y, pt.z]} rotation={[0.2 * side, index * 0.5 + li, 0.5 * side]}>
              <planeGeometry args={[lw, lh]} />
              <meshStandardMaterial color={leafColor} roughness={0.78} metalness={0} side={THREE.DoubleSide} />
            </mesh>
            {(li % 2 === 0 || li === 3) && (
              <mesh position={[pt.x - side * 0.4, pt.y + 0.3, pt.z + 0.15]} rotation={[-0.2 * side, li * 0.7, -0.4 * side]}>
                <planeGeometry args={[lw * 0.85, lh * 0.9]} />
                <meshStandardMaterial color={LEAF_COLORS[(index + li) % LEAF_COLORS.length]} roughness={0.78} metalness={0} side={THREE.DoubleSide} />
              </mesh>
            )}
          </group>
        );
      })}
      <mesh position={[0, vineHeight * 0.98, 0]}>
        <sphereGeometry args={[radiusTip * 2.5, 6, 5]} />
        <meshStandardMaterial color="#3a5a3a" roughness={0.95} metalness={0} />
      </mesh>
    </group>
  );
}

function WallVines() {
  const hw = TANK_BOX[0] / 2 - 0.5;
  const hh = TANK_BOX[1] / 2;
  const hd = TANK_BOX[2] / 2 - 0.5;
  const floorY = -hh;
  const fullHeight = (hh * 2 - 2) * 0.88;

  const vines = [
    { x: -hw, z: -20 }, { x: -hw, z: -12 }, { x: -hw, z: -4 }, { x: -hw, z: 4 }, { x: -hw, z: 12 }, { x: -hw, z: 20 },
    { x: hw, z: -18 }, { x: hw, z: -8 }, { x: hw, z: 2 }, { x: hw, z: 10 }, { x: hw, z: 18 },
    { x: -22, z: -hd }, { x: -14, z: -hd }, { x: -6, z: -hd }, { x: 2, z: -hd }, { x: 10, z: -hd }, { x: 18, z: -hd },
    { x: -18, z: hd }, { x: -8, z: hd }, { x: 0, z: hd }, { x: 10, z: hd }, { x: 20, z: hd },
    { x: -hw, z: -16 }, { x: -hw, z: 8 }, { x: hw, z: -14 }, { x: hw, z: 6 },
  ];

  return (
    <group>
      {vines.map((vine, i) => (
        <VineStrand
          key={i}
          index={i}
          x={vine.x}
          z={vine.z}
          baseY={floorY + 0.5 + (i % 4) * 0.25}
          fullHeight={fullHeight}
        />
      ))}
    </group>
  );
}

/* ── Treasure Chest ── */
const TREASURE_POSITIONS: Array<[number, number, number]> = [
  [-16, 12, 0.4],
  [18, -14, -0.3],
];

function TreasureChests() {
  return (
    <group>
      {TREASURE_POSITIONS.map(([x, z, rot], i) => {
        const yBase = sandHeightAt(x, z);
        return (
          <group key={i} position={[x, yBase, z]} rotation={[0, rot + i * 1.2, 0]}>
            <mesh position={[0, 0.45, 0]}>
              <boxGeometry args={[1.4, 0.8, 0.9]} />
              <meshStandardMaterial color="#6b4226" roughness={0.85} metalness={0.05} />
            </mesh>
            <mesh position={[0, 0.45, 0.46]}>
              <boxGeometry args={[1.42, 0.82, 0.02]} />
              <meshStandardMaterial color="#5a3820" roughness={0.9} metalness={0.02} />
            </mesh>
            <mesh position={[0, 0.45, -0.46]}>
              <boxGeometry args={[1.42, 0.82, 0.02]} />
              <meshStandardMaterial color="#5a3820" roughness={0.9} metalness={0.02} />
            </mesh>
            {[-0.5, 0, 0.5].map((bx, bi) => (
              <mesh key={`band-${bi}`} position={[bx, 0.45, 0]}>
                <boxGeometry args={[0.08, 0.84, 0.94]} />
                <meshStandardMaterial color="#c9a84c" roughness={0.4} metalness={0.6} />
              </mesh>
            ))}
            <mesh position={[0, 0.88, 0]} rotation={[-0.5 - i * 0.2, 0, 0]} scale={[1.0, 0.15, 0.9]}>
              <boxGeometry args={[1.4, 1, 0.9]} />
              <meshStandardMaterial color="#7a5230" roughness={0.85} metalness={0.05} />
            </mesh>
            <mesh position={[0, 0.92, 0]}>
              <boxGeometry args={[0.2, 0.12, 0.15]} />
              <meshStandardMaterial color="#d4b04f" roughness={0.3} metalness={0.7} />
            </mesh>
            {Array.from({ length: 8 }).map((_, ci) => {
              const cx = (ci - 3.5) * 0.16;
              const cz = Math.sin(ci + i) * 0.25;
              return (
                <mesh key={`coin-${ci}`} position={[cx, 0.85 + ci * 0.03, cz]} rotation={[Math.PI / 2 + ci * 0.15, 0, ci * 0.3]}>
                  <cylinderGeometry args={[0.1, 0.1, 0.03, 8]} />
                  <meshStandardMaterial color="#e8c84f" roughness={0.3} metalness={0.7} />
                </mesh>
              );
            })}
            {Array.from({ length: 5 }).map((_, gi) => (
              <mesh key={`gem-${gi}`} position={[Math.sin(gi * 1.3) * 0.4, 0.9 + gi * 0.02, Math.cos(gi * 0.9) * 0.2]}>
                <octahedronGeometry args={[0.08 + (gi % 3) * 0.03, 0]} />
                <meshStandardMaterial color={gi % 3 === 0 ? "#e04040" : gi % 3 === 1 ? "#40e040" : "#4060e0"} roughness={0.2} metalness={0.3} emissive={gi % 3 === 0 ? "#e04040" : gi % 3 === 1 ? "#40e040" : "#4060e0"} emissiveIntensity={0.3} />
              </mesh>
            ))}
          </group>
        );
      })}
    </group>
  );
}

/* ── Sunken Anchor ── */
function SunkenAnchor() {
  const x = 8, z = 18;
  const yBase = sandHeightAt(x, z);
  return (
    <group position={[x, yBase, z]} rotation={[0.15, 0.8, 0.1]}>
      <mesh position={[0, 1.5, 0]}>
        <cylinderGeometry args={[0.1, 0.1, 3.0, 8]} />
        <meshStandardMaterial color="#4a4a4a" roughness={0.7} metalness={0.5} />
      </mesh>
      <mesh position={[0, 2.9, 0]}>
        <torusGeometry args={[0.3, 0.08, 8, 16]} />
        <meshStandardMaterial color="#4a4a4a" roughness={0.7} metalness={0.5} />
      </mesh>
      <mesh position={[0, 0.15, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.08, 0.08, 2.0, 8]} />
        <meshStandardMaterial color="#4a4a4a" roughness={0.7} metalness={0.5} />
      </mesh>
      {[-1, 1].map((dir) => (
        <group key={dir}>
          <mesh position={[dir * 0.9, 0.15, 0]} rotation={[0, 0, dir * 0.6]}>
            <cylinderGeometry args={[0.07, 0.07, 0.8, 6]} />
            <meshStandardMaterial color="#4a4a4a" roughness={0.7} metalness={0.5} />
          </mesh>
          <mesh position={[dir * 1.15, -0.15, 0]}>
            <coneGeometry args={[0.14, 0.3, 5]} />
            <meshStandardMaterial color="#4a4a4a" roughness={0.7} metalness={0.5} />
          </mesh>
        </group>
      ))}
      {Array.from({ length: 6 }).map((_, ci) => (
        <mesh key={`ch-${ci}`} position={[Math.sin(ci * 0.8) * 0.15, 3.1 + ci * 0.3, Math.cos(ci * 0.6) * 0.15]} rotation={[ci * 0.4, 0, ci * 0.3]}>
          <torusGeometry args={[0.12, 0.04, 6, 8]} />
          <meshStandardMaterial color="#5a5a5a" roughness={0.6} metalness={0.5} />
        </mesh>
      ))}
      {Array.from({ length: 4 }).map((_, ri) => (
        <mesh key={`rust-${ri}`} position={[Math.sin(ri * 1.5) * 0.12, 0.5 + ri * 0.6, 0.1]}>
          <sphereGeometry args={[0.06 + ri * 0.02, 5, 4]} />
          <meshStandardMaterial color="#8a4a20" roughness={0.95} metalness={0.1} />
        </mesh>
      ))}
    </group>
  );
}

/* ── Starfish ── */
const STARFISH_POSITIONS: Array<[number, number, number]> = [
  [-10, -8, 0.3], [6, 14, 1.2], [-20, 2, 0.7], [14, -6, 2.1], [0, -18, 0.5],
  [20, 10, 1.8], [-8, 16, 0.1], [-18, -14, 1.5],
];

function StarfishArm({ angle, length }: { angle: number; length: number }) {
  return (
    <group rotation={[0, 0, angle]}>
      <mesh position={[length * 0.5, 0, 0]} scale={[1, 0.3, 1]}>
        <coneGeometry args={[0.12, length, 4]} />
        <meshStandardMaterial color="#d06030" roughness={0.75} metalness={0.05} />
      </mesh>
      {Array.from({ length: 3 }).map((_, ti) => (
        <mesh key={ti} position={[length * (0.2 + ti * 0.25), 0.03, 0]}>
          <sphereGeometry args={[0.04, 4, 3]} />
          <meshStandardMaterial color="#f0a080" roughness={0.6} metalness={0} />
        </mesh>
      ))}
    </group>
  );
}

function Starfish() {
  return (
    <group>
      {STARFISH_POSITIONS.map(([x, z, rot], i) => {
        const yBase = sandHeightAt(x, z);
        const armLen = 0.35 + (i % 3) * 0.08;
        return (
          <group key={i} position={[x, yBase + 0.05, z]} rotation={[-Math.PI / 2, 0, rot]}>
            <mesh>
              <sphereGeometry args={[0.15, 6, 5]} />
              <meshStandardMaterial color="#c85828" roughness={0.75} metalness={0.05} />
            </mesh>
            {Array.from({ length: 5 }).map((_, ai) => (
              <StarfishArm key={ai} angle={(ai / 5) * Math.PI * 2} length={armLen} />
            ))}
          </group>
        );
      })}
    </group>
  );
}

/* ── Sea Urchins ── */
const URCHIN_POSITIONS: Array<[number, number]> = [
  [-4, -12], [10, 6], [-14, -2], [20, -10], [2, 16], [-20, 14],
];

function SeaUrchins() {
  const URCHIN_COLORS = ["#2a1a3a", "#1a2a1a", "#3a1a2a", "#1a1a2a"];
  return (
    <group>
      {URCHIN_POSITIONS.map(([x, z], i) => {
        const yBase = sandHeightAt(x, z);
        const radius = 0.25 + (i % 3) * 0.08;
        const spineCount = 20 + (i % 5) * 4;
        return (
          <group key={i} position={[x, yBase + radius, z]}>
            <mesh>
              <sphereGeometry args={[radius, 10, 8]} />
              <meshStandardMaterial color={URCHIN_COLORS[i % URCHIN_COLORS.length]} roughness={0.85} metalness={0.05} />
            </mesh>
            {Array.from({ length: spineCount }).map((_, si) => {
              const phi = Math.acos(1 - 2 * (si + 0.5) / spineCount);
              const theta = Math.PI * (1 + Math.sqrt(5)) * si;
              const nx = Math.sin(phi) * Math.cos(theta);
              const ny = Math.sin(phi) * Math.sin(theta);
              const nz = Math.cos(phi);
              const spineLen = radius * (1.2 + (si % 4) * 0.3);
              return (
                <mesh key={si} position={[nx * radius, nz * radius, ny * radius]} rotation={[Math.atan2(Math.sqrt(nx * nx + ny * ny), nz), 0, Math.atan2(ny, nx)]}>
                  <cylinderGeometry args={[0.008, 0.02, spineLen, 3]} />
                  <meshStandardMaterial color={si % 2 === 0 ? "#1a0a2a" : "#2a1a3a"} roughness={0.8} metalness={0.1} />
                </mesh>
              );
            })}
          </group>
        );
      })}
    </group>
  );
}

/* ── Animated Jellyfish ── */
const JELLYFISH_POSITIONS: Array<[number, number, number]> = [
  [-12, 4, 6], [14, -8, 8], [0, 12, 5], [-18, -6, 7], [20, 6, 9],
];

function Jellyfish() {
  const jellyRefs = useRef<THREE.Group[]>([]);
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    jellyRefs.current.forEach((group, idx) => {
      if (!group) return;
      const base = JELLYFISH_POSITIONS[idx];
      group.position.y = base[2] + Math.sin(t * 0.4 + idx * 1.5) * 1.5;
      group.position.x = base[0] + Math.sin(t * 0.2 + idx * 2.3) * 0.8;
      group.position.z = base[1] + Math.cos(t * 0.25 + idx * 1.8) * 0.6;
      group.rotation.y = Math.sin(t * 0.15 + idx) * 0.3;
      const pulse = 1 + Math.sin(t * 2 + idx * 1.2) * 0.08;
      group.scale.set(pulse, 1 / pulse, pulse);
    });
  });

  const JELLY_COLORS = ["#e8a0d8", "#a0d8e8", "#d8e8a0", "#a0e8c0", "#d8a0e8"];
  return (
    <group>
      {JELLYFISH_POSITIONS.map((pos, i) => {
        const bellR = 0.6 + (i % 3) * 0.15;
        const tentCount = 8 + (i % 4) * 2;
        const color = JELLY_COLORS[i % JELLY_COLORS.length];
        return (
          <group key={i} ref={(el) => { if (el) jellyRefs.current[i] = el; }} position={[pos[0], pos[2], pos[1]]}>
            <mesh scale={[1, 0.55, 1]}>
              <sphereGeometry args={[bellR, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
              <meshStandardMaterial color={color} roughness={0.3} metalness={0} transparent opacity={0.65} side={THREE.DoubleSide} />
            </mesh>
            <mesh scale={[0.85, 0.45, 0.85]}>
              <sphereGeometry args={[bellR, 12, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
              <meshStandardMaterial color={color} roughness={0.4} metalness={0} transparent opacity={0.4} side={THREE.DoubleSide} />
            </mesh>
            {Array.from({ length: 8 }).map((_, ri) => {
              const angle = (ri / 8) * Math.PI * 2;
              return (
                <mesh key={`r-${ri}`} position={[Math.cos(angle) * bellR * 0.8, -0.05, Math.sin(angle) * bellR * 0.8]}>
                  <sphereGeometry args={[0.06, 5, 4]} />
                  <meshStandardMaterial color={color} roughness={0.3} metalness={0} emissive={color} emissiveIntensity={0.4} transparent opacity={0.8} />
                </mesh>
              );
            })}
            {Array.from({ length: tentCount }).map((_, ti) => {
              const angle = (ti / tentCount) * Math.PI * 2;
              const r = bellR * (0.5 + (ti % 3) * 0.15);
              const tentLen = 1.5 + (ti % 4) * 0.5;
              return (
                <mesh key={`t-${ti}`} position={[Math.cos(angle) * r, -tentLen * 0.5, Math.sin(angle) * r]}>
                  <cylinderGeometry args={[0.015, 0.03, tentLen, 4]} />
                  <meshStandardMaterial color={color} roughness={0.4} metalness={0} transparent opacity={0.5} />
                </mesh>
              );
            })}
            <pointLight color={color} intensity={0.3} distance={3} decay={2} position={[0, -0.1, 0]} />
          </group>
        );
      })}
    </group>
  );
}

/* ── Marimo Moss Balls ── */
const MARIMO_POSITIONS: Array<[number, number, number]> = [
  [-6, 4, 0.5], [8, -10, 0.45], [-14, -8, 0.55], [16, 12, 0.4], [0, -6, 0.48],
  [-20, 0, 0.42], [22, -2, 0.52], [-10, 14, 0.38],
];

function MarimoMossBalls() {
  return (
    <group>
      {MARIMO_POSITIONS.map(([x, z, radius], i) => {
        const yBase = sandHeightAt(x, z);
        return (
          <group key={i} position={[x, yBase + radius, z]}>
            <mesh>
              <sphereGeometry args={[radius, 12, 10]} />
              <meshStandardMaterial color="#3a6a3a" roughness={0.95} metalness={0} />
            </mesh>
            {Array.from({ length: 30 }).map((_, fi) => {
              const phi = Math.acos(1 - 2 * (fi + 0.5) / 30);
              const theta = Math.PI * (1 + Math.sqrt(5)) * fi;
              const nx = Math.sin(phi) * Math.cos(theta) * radius;
              const ny = Math.cos(phi) * radius;
              const nz = Math.sin(phi) * Math.sin(theta) * radius;
              return (
                <mesh key={fi} position={[nx, ny, nz]} rotation={[phi, theta, 0]}>
                  <planeGeometry args={[0.08, 0.14 + (fi % 4) * 0.03]} />
                  <meshStandardMaterial color={fi % 3 === 0 ? "#2a5a2a" : fi % 3 === 1 ? "#4a7a4a" : "#3a6a3a"} roughness={0.9} metalness={0} side={THREE.DoubleSide} />
                </mesh>
              );
            })}
          </group>
        );
      })}
    </group>
  );
}

/* ── Brain Coral & Mushroom Coral ── */
const BRAIN_CORAL_POSITIONS: Array<[number, number, number]> = [
  [-8, 8, 0.7], [12, -4, 0.6], [2, 14, 0.55], [-18, -12, 0.65],
];
const MUSHROOM_CORAL_POSITIONS: Array<[number, number, number]> = [
  [6, -16, 0.5], [-12, 10, 0.55], [18, 8, 0.45], [-4, -14, 0.5],
];

function BrainCoral() {
  return (
    <group>
      {BRAIN_CORAL_POSITIONS.map(([x, z, radius], i) => {
        const yBase = sandHeightAt(x, z);
        const grooveCount = 12 + (i % 4) * 2;
        return (
          <group key={i} position={[x, yBase + radius * 0.6, z]}>
            <mesh scale={[1, 0.65, 1]}>
              <sphereGeometry args={[radius, 16, 12]} />
              <meshStandardMaterial color="#c8988a" roughness={0.8} metalness={0.03} />
            </mesh>
            {Array.from({ length: grooveCount }).map((_, gi) => {
              const angle = (gi / grooveCount) * Math.PI * 2;
              const r = radius * (0.3 + (gi % 3) * 0.2);
              const arcLen = radius * 0.8;
              const curve = new THREE.CatmullRomCurve3([
                new THREE.Vector3(Math.cos(angle) * r, radius * 0.2, Math.sin(angle) * r),
                new THREE.Vector3(Math.cos(angle + 0.3) * r * 1.1, radius * 0.35, Math.sin(angle + 0.3) * r * 1.1),
                new THREE.Vector3(Math.cos(angle + 0.6) * r * 0.9, radius * 0.15, Math.sin(angle + 0.6) * r * 0.9),
              ]);
              return (
                <mesh key={gi}>
                  <tubeGeometry args={[curve, 8, 0.03, 4, false]} />
                  <meshStandardMaterial color="#a07060" roughness={0.85} metalness={0} />
                </mesh>
              );
            })}
          </group>
        );
      })}
    </group>
  );
}

function MushroomCoral() {
  return (
    <group>
      {MUSHROOM_CORAL_POSITIONS.map(([x, z, radius], i) => {
        const yBase = sandHeightAt(x, z);
        return (
          <group key={i} position={[x, yBase, z]}>
            <mesh position={[0, 0.3, 0]}>
              <cylinderGeometry args={[0.12, 0.18, 0.6, 6]} />
              <meshStandardMaterial color="#8a7a68" roughness={0.9} metalness={0} />
            </mesh>
            <mesh position={[0, 0.65, 0]} scale={[1, 0.3, 1]}>
              <sphereGeometry args={[radius, 14, 10]} />
              <meshStandardMaterial color={i % 2 === 0 ? "#d07868" : "#c89080"} roughness={0.75} metalness={0.02} />
            </mesh>
            {Array.from({ length: 12 }).map((_, ri) => {
              const angle = (ri / 12) * Math.PI * 2;
              return (
                <mesh key={ri} position={[Math.cos(angle) * radius * 0.7, 0.65, Math.sin(angle) * radius * 0.7]} rotation={[0, 0, angle]}>
                  <boxGeometry args={[0.04, 0.01, radius * 0.8]} />
                  <meshStandardMaterial color="#b08878" roughness={0.8} metalness={0} />
                </mesh>
              );
            })}
            {Array.from({ length: 6 }).map((_, di) => {
              const angle = (di / 6) * Math.PI * 2 + i;
              const r = radius * 0.4;
              return (
                <mesh key={`d-${di}`} position={[Math.cos(angle) * r, 0.68, Math.sin(angle) * r]}>
                  <sphereGeometry args={[0.04, 5, 4]} />
                  <meshStandardMaterial color="#f0c0b0" roughness={0.5} metalness={0} />
                </mesh>
              );
            })}
          </group>
        );
      })}
    </group>
  );
}

/* ── Sunken Ruins ── */
function SunkenRuins() {
  const ruins: Array<{ x: number; z: number; type: string; rot: number }> = [
    { x: -22, z: -16, type: "column", rot: 0.2 },
    { x: -20, z: -18, type: "block", rot: 0.5 },
    { x: 22, z: 16, type: "column", rot: -0.3 },
    { x: 20, z: 14, type: "block", rot: 0.8 },
    { x: 0, z: 20, type: "column", rot: 0.1 },
  ];
  return (
    <group>
      {ruins.map((r, i) => {
        const yBase = sandHeightAt(r.x, r.z);
        if (r.type === "column") {
          const colH = 2.5 + (i % 3) * 0.8;
          const tilt = 0.15 + (i % 2) * 0.1;
          return (
            <group key={i} position={[r.x, yBase, r.z]} rotation={[tilt, r.rot, tilt * 0.5]}>
              <mesh position={[0, colH / 2, 0]}>
                <cylinderGeometry args={[0.35, 0.4, colH, 8]} />
                <meshStandardMaterial color="#b0a898" roughness={0.85} metalness={0.02} />
              </mesh>
              {Array.from({ length: 6 }).map((_, fi) => (
                <mesh key={fi} position={[0, fi * (colH / 6), 0]} rotation={[0, fi * 0.5, 0]}>
                  <torusGeometry args={[0.38, 0.04, 6, 12]} />
                  <meshStandardMaterial color="#a09888" roughness={0.88} metalness={0.02} />
                </mesh>
              ))}
              <mesh position={[0, colH + 0.1, 0]}>
                <boxGeometry args={[0.9, 0.15, 0.9]} />
                <meshStandardMaterial color="#c0b8a8" roughness={0.85} metalness={0.02} />
              </mesh>
              <mesh position={[0, 0.08, 0]}>
                <boxGeometry args={[0.9, 0.15, 0.9]} />
                <meshStandardMaterial color="#c0b8a8" roughness={0.85} metalness={0.02} />
              </mesh>
              {Array.from({ length: 3 }).map((_, mi) => (
                <mesh key={`m-${mi}`} position={[Math.sin(mi + i) * 0.25, colH * (0.3 + mi * 0.2), 0.3]}>
                  <sphereGeometry args={[0.08, 5, 4]} />
                  <meshStandardMaterial color="#4a6a4a" roughness={0.95} metalness={0} />
                </mesh>
              ))}
            </group>
          );
        }
        return (
          <group key={i} position={[r.x, yBase, r.z]} rotation={[0.05, r.rot, 0.08]}>
            <mesh position={[0, 0.35, 0]}>
              <boxGeometry args={[1.2, 0.7, 0.8]} />
              <meshStandardMaterial color="#a09888" roughness={0.88} metalness={0.02} flatShading />
            </mesh>
            <mesh position={[0.15, 0.75, 0.1]} rotation={[0.1, 0.3, 0.15]}>
              <boxGeometry args={[0.8, 0.4, 0.6]} />
              <meshStandardMaterial color="#b0a898" roughness={0.88} metalness={0.02} flatShading />
            </mesh>
            {Array.from({ length: 4 }).map((_, ci) => (
              <mesh key={ci} position={[Math.sin(ci * 1.5 + i) * 0.5, 0.08, Math.cos(ci + i) * 0.3]}>
                <dodecahedronGeometry args={[0.15 + ci * 0.03, 0]} />
                <meshStandardMaterial color="#b0a898" roughness={0.92} metalness={0.02} flatShading />
              </mesh>
            ))}
          </group>
        );
      })}
    </group>
  );
}

/* ── Clam With Pearl ── */
const CLAM_POSITIONS: Array<[number, number, number]> = [
  [-2, -10, 0.6], [16, 6, 1.4], [-16, -4, 2.2],
];

function ClamWithPearl() {
  return (
    <group>
      {CLAM_POSITIONS.map(([x, z, rot], i) => {
        const yBase = sandHeightAt(x, z);
        const clamSize = 0.5 + (i % 3) * 0.1;
        return (
          <group key={i} position={[x, yBase + 0.05, z]} rotation={[0, rot, 0]}>
            <mesh position={[0, 0, 0]} rotation={[0.1, 0, 0]} scale={[1, 0.25, 1]}>
              <sphereGeometry args={[clamSize, 12, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2]} />
              <meshStandardMaterial color="#c8b8a0" roughness={0.7} metalness={0.08} />
            </mesh>
            <mesh position={[0, 0.08, 0]} rotation={[-0.6 - (i % 2) * 0.3, 0, 0]} scale={[1, 0.25, 1]}>
              <sphereGeometry args={[clamSize, 12, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2]} />
              <meshStandardMaterial color="#d0c0a8" roughness={0.7} metalness={0.08} />
            </mesh>
            {Array.from({ length: 8 }).map((_, ri) => {
              const angle = (ri / 8) * Math.PI;
              return (
                <mesh key={ri} position={[0, 0.04, 0]} rotation={[0, angle, 0]}>
                  <boxGeometry args={[clamSize * 2, 0.01, 0.015]} />
                  <meshStandardMaterial color="#b8a890" roughness={0.75} metalness={0.05} />
                </mesh>
              );
            })}
            <mesh position={[0, 0.12, 0]}>
              <sphereGeometry args={[clamSize * 0.22, 10, 8]} />
              <meshStandardMaterial color="#f0e8e0" roughness={0.2} metalness={0.3} emissive="#f0e8e0" emissiveIntensity={0.25} />
            </mesh>
            <pointLight color="#f8f0e8" intensity={0.15} distance={2} decay={2} position={[0, 0.15, 0]} />
          </group>
        );
      })}
    </group>
  );
}

/* ── Crystal Formations ── */
const CRYSTAL_POSITIONS: Array<[number, number, number]> = [
  [-18, 8, 0.8], [14, -16, 1.2], [4, -4, 0.4], [-10, 16, 1.6],
];

function CrystalFormations() {
  const CRYSTAL_COLORS = ["#60a0e0", "#80c0f0", "#a0d8f8", "#5088c8", "#70b0e8"];
  return (
    <group>
      {CRYSTAL_POSITIONS.map(([x, z, rot], i) => {
        const yBase = sandHeightAt(x, z);
        const crystalCount = 4 + (i % 3) * 2;
        return (
          <group key={i} position={[x, yBase, z]} rotation={[0, rot, 0]}>
            <mesh position={[0, 0.15, 0]}>
              <dodecahedronGeometry args={[0.4, 1]} />
              <meshStandardMaterial color="#5a5a6a" roughness={0.9} metalness={0.05} flatShading />
            </mesh>
            {Array.from({ length: crystalCount }).map((_, ci) => {
              const angle = (ci / crystalCount) * Math.PI * 2 + i * 0.5;
              const dist = 0.15 + (ci % 3) * 0.1;
              const h = 0.6 + (ci % 4) * 0.3;
              const w = 0.08 + (ci % 3) * 0.03;
              const tilt = 0.15 + (ci % 2) * 0.1;
              const color = CRYSTAL_COLORS[ci % CRYSTAL_COLORS.length];
              return (
                <group key={`c-${ci}`}>
                  <mesh position={[Math.cos(angle) * dist, h * 0.5 + 0.1, Math.sin(angle) * dist]} rotation={[Math.cos(angle) * tilt, 0, Math.sin(angle) * tilt]}>
                    <octahedronGeometry args={[w, 0]} />
                    <meshStandardMaterial color={color} roughness={0.15} metalness={0.2} transparent opacity={0.8} />
                  </mesh>
                  <mesh position={[Math.cos(angle) * dist, h * 0.5 + 0.1, Math.sin(angle) * dist]} rotation={[Math.cos(angle) * tilt, 0, Math.sin(angle) * tilt]} scale={[0.7, h / (w * 2), 0.7]}>
                    <octahedronGeometry args={[w, 0]} />
                    <meshStandardMaterial color={color} roughness={0.1} metalness={0.15} transparent opacity={0.6} emissive={color} emissiveIntensity={0.35} />
                  </mesh>
                </group>
              );
            })}
            <pointLight color="#80c0f0" intensity={0.25} distance={3} decay={2} position={[0, 0.5, 0]} />
          </group>
        );
      })}
    </group>
  );
}

/* ── Sand Ripples (floor detail) ── */
function SandRipples() {
  const rippleCount = 20;
  return (
    <group>
      {Array.from({ length: rippleCount }).map((_, i) => {
        const x = -20 + (i % 5) * 10 + Math.sin(i * 2.3) * 3;
        const z = -18 + Math.floor(i / 5) * 9 + Math.cos(i * 1.7) * 3;
        const yBase = sandHeightAt(x, z);
        const len = 2 + (i % 4) * 0.8;
        return (
          <mesh key={i} position={[x, yBase + 0.01, z]} rotation={[-Math.PI / 2, 0, i * 0.7]}>
            <planeGeometry args={[len, 0.08]} />
            <meshStandardMaterial color="#c8b898" roughness={0.95} metalness={0} transparent opacity={0.4} />
          </mesh>
        );
      })}
    </group>
  );
}

/* ── Tube Worm Clusters ── */
const TUBE_WORM_POSITIONS: Array<[number, number]> = [
  [-6, -6], [10, 10], [-16, 14], [18, -12],
];

function TubeWormClusters() {
  const WORM_COLORS = ["#e04040", "#e06040", "#d03030", "#f05050", "#c82828"];
  return (
    <group>
      {TUBE_WORM_POSITIONS.map(([x, z], i) => {
        const yBase = sandHeightAt(x, z);
        const tubeCount = 6 + (i % 4) * 2;
        return (
          <group key={i} position={[x, yBase, z]}>
            {Array.from({ length: tubeCount }).map((_, ti) => {
              const angle = (ti / tubeCount) * Math.PI * 2 + i;
              const dist = 0.15 + (ti % 3) * 0.08;
              const h = 0.5 + (ti % 4) * 0.2;
              return (
                <group key={ti} position={[Math.cos(angle) * dist, 0, Math.sin(angle) * dist]}>
                  <mesh position={[0, h / 2, 0]}>
                    <cylinderGeometry args={[0.04, 0.06, h, 5]} />
                    <meshStandardMaterial color="#a09080" roughness={0.9} metalness={0.02} />
                  </mesh>
                  {Array.from({ length: 5 }).map((_, fi) => {
                    const fAngle = (fi / 5) * Math.PI * 2;
                    return (
                      <mesh key={fi} position={[Math.cos(fAngle) * 0.06, h, Math.sin(fAngle) * 0.06]} rotation={[Math.cos(fAngle) * 0.5, 0, Math.sin(fAngle) * 0.5]}>
                        <cylinderGeometry args={[0.005, 0.015, 0.15, 3]} />
                        <meshStandardMaterial color={WORM_COLORS[(ti + fi) % WORM_COLORS.length]} roughness={0.6} metalness={0} />
                      </mesh>
                    );
                  })}
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

