/**
 * Client for the sim Web Worker. Runs tickTank off the main thread.
 * Falls back to sync tickTank when worker is unavailable.
 */
import type { EngineConfig } from "@/sim/engine";
import type { TankState } from "@/sim/types";
import type { TankEvent } from "@/sim/events";
import type { SimWorkerResponse } from "@/sim/sim-worker";

let worker: Worker | null = null;
let workerFailed = false;

function getWorker(): Worker | null {
  if (typeof window === "undefined" || workerFailed) return null;
  if (worker) return worker;
  try {
    worker = new Worker(
      new URL("../sim/sim-worker.ts", import.meta.url),
      { type: "module" }
    );
    return worker;
  } catch {
    workerFailed = true;
    return null;
  }
}

export type TickResult = { state: TankState; events: TankEvent[] };

/** Max sim time to run per frame (catch-up when lagging). */
const MAX_CATCH_UP_MS = 500;

export function tickSimAsync(
  state: TankState,
  totalDeltaMs: number,
  now: number,
  config: EngineConfig
): Promise<TickResult> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error("Worker not available"));

  return new Promise((resolve, reject) => {
    const handler = (e: MessageEvent<SimWorkerResponse>) => {
      if (e.data.type !== "tick") return;
      w.removeEventListener("message", handler);
      resolve({ state: e.data.state, events: e.data.events });
    };
    w.addEventListener("message", handler);
    w.postMessage({
      type: "tick",
      state,
      totalDeltaMs: Math.min(totalDeltaMs, MAX_CATCH_UP_MS),
      now,
      config,
    });
  });
}

export function isWorkerAvailable(): boolean {
  return !workerFailed && worker !== null;
}
