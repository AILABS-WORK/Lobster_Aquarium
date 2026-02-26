/**
 * Web Worker for running tickTank off the main thread.
 * Receives state + params, runs sim, posts back { state, events }.
 */
import { defaultConfig, tickTank } from "./engine";
import type { EngineConfig } from "./engine";
import type { TankState } from "./types";
import type { TankEvent } from "./events";

const STEP_MS = 50;
const MAX_CATCH_UP_MS = 500;

export type SimWorkerMessage = {
  type: "tick";
  state: TankState;
  totalDeltaMs: number;
  now: number;
  config: EngineConfig;
};

export type SimWorkerResponse = {
  type: "tick";
  state: TankState;
  events: TankEvent[];
};

function random(): number {
  return Math.random();
}

self.onmessage = (e: MessageEvent<SimWorkerMessage>) => {
  if (e.data.type !== "tick") return;
  const { state, totalDeltaMs, now, config } = e.data;
  const toSimulate = Math.min(totalDeltaMs, MAX_CATCH_UP_MS);
  let currentState = state;
  const allEvents: TankEvent[] = [];
  let remaining = toSimulate;
  while (remaining >= STEP_MS) {
    const result = tickTank(currentState, STEP_MS, random, now, config);
    currentState = result.state;
    allEvents.push(...result.events);
    remaining -= STEP_MS;
  }
  if (remaining > 0) {
    const result = tickTank(currentState, remaining, random, now, config);
    currentState = result.state;
    allEvents.push(...result.events);
  }
  const response: SimWorkerResponse = {
    type: "tick",
    state: currentState,
    events: allEvents,
  };
  self.postMessage(response);
};
