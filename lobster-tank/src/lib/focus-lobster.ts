import type { Lobster } from "@/sim/types";

type Listener = () => void;
let snapshot: Lobster | null = null;
const listeners = new Set<Listener>();

export const setFocusLobsterSnapshot = (lobster: Lobster | null) => {
  snapshot = lobster;
  listeners.forEach((l) => l());
};

export const getFocusLobsterSnapshot = () => snapshot;

export const subscribeFocusLobster = (listener: Listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
