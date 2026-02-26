"use client";

import { useEffect, useMemo, useRef } from "react";
import { createInitialTankState } from "@/sim/factory";
import { tickTankV2 } from "@/sim/engine-v2";
import { addTankEvents } from "@/lib/tank-events";
import { Lobster, TankState, Vector2 } from "@/sim/types";

type CameraMode = "global" | "focusLobster" | "focusCommunity";

type TankCanvasProps = {
  mode?: CameraMode;
  focusLobsterId?: string;
  focusCommunityId?: string;
  lobsterCount?: number;
  lowPower?: boolean;
};

const createRng = (seed: number) => {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

const defaultTankSize = { width: 900, height: 540 };

export const TankCanvas = ({
  mode = "global",
  focusLobsterId,
  focusCommunityId,
  lobsterCount = 55,
  lowPower = false,
}: TankCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<TankState | null>(null);
  const rngRef = useRef<() => number>(() => 0.5);
  const lastTimeRef = useRef<number>(0);

  const seed = useMemo(() => Math.floor(Date.now() / 1000), []);

  useEffect(() => {
    rngRef.current = createRng(seed);
  }, [seed]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(width));
      canvas.height = Math.max(1, Math.floor(height));
      if (!stateRef.current) {
        stateRef.current = createInitialTankState(
          lobsterCount,
          width || defaultTankSize.width,
          height || defaultTankSize.height,
          rngRef.current,
        );
      } else {
        stateRef.current = {
          ...stateRef.current,
          width: width || defaultTankSize.width,
          height: height || defaultTankSize.height,
        };
      }
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    return () => observer.disconnect();
  }, [lobsterCount]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationId = 0;
    const frame = (time: number) => {
      const last = lastTimeRef.current || time;
      const delta = time - last;
      if (lowPower && delta < 50) {
        animationId = requestAnimationFrame(frame);
        return;
      }
      lastTimeRef.current = time;

      if (!stateRef.current) {
        stateRef.current = createInitialTankState(
          lobsterCount,
          defaultTankSize.width,
          defaultTankSize.height,
          rngRef.current,
        );
      }

      const now = Date.now();
      const { state, events } = tickTankV2(
        stateRef.current,
        delta,
        rngRef.current,
        now,
      );
      stateRef.current = state;
      addTankEvents(events);

      drawTank(ctx, canvas, state, mode, focusLobsterId, focusCommunityId);
      animationId = requestAnimationFrame(frame);
    };

    animationId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animationId);
  }, [lobsterCount, mode, focusLobsterId, focusCommunityId, lowPower]);

  return (
    <div ref={containerRef} className="h-full w-full">
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
};

const drawTank = (
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  state: TankState,
  mode: CameraMode,
  focusLobsterId?: string,
  focusCommunityId?: string,
) => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, "#082434");
  gradient.addColorStop(1, "#0a3d4f");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const camera = getCameraOffset(state, canvas, mode, focusLobsterId, focusCommunityId);
  drawLobsters(ctx, state, camera);

  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 3;
  ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
};

const drawLobsters = (
  ctx: CanvasRenderingContext2D,
  state: TankState,
  camera: Vector2,
) => {
  const communityColors = new Map(
    state.communities.map((community) => [community.id, community.color]),
  );

  for (const lobster of state.lobsters) {
    const x = lobster.position.x + camera.x;
    const y = lobster.position.y + camera.y;
    const size = 10 + lobster.size * 6;

    ctx.fillStyle = "rgba(243, 94, 80, 0.9)";
    ctx.beginPath();
    ctx.ellipse(x, y, size * 1.4, size, 0, 0, Math.PI * 2);
    ctx.fill();

    if (lobster.communityId) {
      ctx.fillStyle = communityColors.get(lobster.communityId) ?? "#7dd3fc";
      ctx.beginPath();
      ctx.arc(x + size * 0.9, y - size * 0.7, size * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
};

const getCameraOffset = (
  state: TankState,
  canvas: HTMLCanvasElement,
  mode: CameraMode,
  focusLobsterId?: string,
  focusCommunityId?: string,
): Vector2 => {
  if (mode === "global") return { x: 0, y: 0 };

  let target: Lobster | undefined;
  if (mode === "focusLobster" && focusLobsterId) {
    target = state.lobsters.find((lobster) => lobster.id === focusLobsterId);
  }
  if (mode === "focusCommunity" && focusCommunityId) {
    target = state.lobsters.find(
      (lobster) => lobster.communityId === focusCommunityId,
    );
  }

  if (!target) return { x: 0, y: 0 };
  const offsetX = canvas.width / 2 - target.position.x;
  const offsetY = canvas.height / 2 - target.position.y;

  const clampedX = Math.min(0, Math.max(offsetX, canvas.width - state.width));
  const clampedY = Math.min(0, Math.max(offsetY, canvas.height - state.height));
  return { x: clampedX, y: clampedY };
};
