import { TankEvent } from "@/sim/events";

const PERSIST_DEBOUNCE_MS = 2500;
const PERSIST_BATCH_MIN = 8;
let persistBuffer: TankEvent[] = [];
let persistScheduled: ReturnType<typeof setTimeout> | null = null;

const flushPersist = async () => {
  persistScheduled = null;
  const toSend = persistBuffer.slice();
  persistBuffer = [];
  if (toSend.length === 0) return;
  try {
    await fetch("/api/tank-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: toSend }),
    });
  } catch {
    // re-queue on failure so we don't lose events (optional: could drop)
    persistBuffer = [...toSend, ...persistBuffer].slice(0, 100);
  }
};

const schedulePersist = (batch: TankEvent[]) => {
  const existingIds = new Set(persistBuffer.map((e) => e.id));
  const toAdd = batch.filter((e) => !existingIds.has(e.id));
  if (toAdd.length === 0) return;
  toAdd.forEach((e) => persistBuffer.push(e));
  if (persistBuffer.length > 150) persistBuffer = persistBuffer.slice(-100);
  if (persistScheduled != null) return;
  if (persistBuffer.length >= PERSIST_BATCH_MIN) {
    void flushPersist();
    return;
  }
  persistScheduled = setTimeout(() => {
    persistScheduled = null;
    if (persistBuffer.length > 0) void flushPersist();
  }, PERSIST_DEBOUNCE_MS);
};

type Listener = () => void;

let events: TankEvent[] = [];
const listeners = new Set<Listener>();

export const addTankEvents = (newEvents: TankEvent[]) => {
  if (newEvents.length === 0) return;
  const existingIds = new Set(events.map((e) => e.id));
  const toAdd = newEvents.filter((e) => !existingIds.has(e.id));
  if (toAdd.length === 0) return;
  events = [...toAdd, ...events].slice(0, 200);
  listeners.forEach((listener) => listener());
  schedulePersist(toAdd);
};

export const getTankEvents = () => events;

export const hydrateTankEvents = (hydrated: TankEvent[]) => {
  if (hydrated.length === 0) return;
  const existingIds = new Set(events.map((e) => e.id));
  const toAdd = hydrated.filter((e) => !existingIds.has(e.id));
  if (toAdd.length === 0) return;
  events = [...toAdd, ...events].slice(0, 150);
  listeners.forEach((listener) => listener());
};

export const subscribeTankEvents = (listener: Listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const clearTankEvents = () => {
  events = [];
  listeners.forEach((listener) => listener());
};
