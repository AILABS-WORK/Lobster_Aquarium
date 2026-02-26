import type { Lobster } from "@/sim/types";

type Listener = () => void;
let nearby: Lobster | null = null;
const listeners = new Set<Listener>();

export const setNearbyLobster = (lobster: Lobster | null) => {
  nearby = lobster;
  listeners.forEach((l) => l());
};

export const getNearbyLobster = () => nearby;

export const subscribeNearbyLobster = (listener: Listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
