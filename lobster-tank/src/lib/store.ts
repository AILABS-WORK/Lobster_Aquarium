import { UserProfile } from "@/types/profile";
import { Lobster } from "@/sim/types";

const USER_KEY = "lobsterTank:user";
const LOBSTER_KEY = "lobsterTank:lobster";

const safeParse = <T>(value: string | null): T | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

export const loadUserProfile = (): UserProfile | null => {
  if (typeof window === "undefined") return null;
  return safeParse<UserProfile>(window.localStorage.getItem(USER_KEY));
};

export const saveUserProfile = (profile: UserProfile) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(USER_KEY, JSON.stringify(profile));
};

export const loadLobster = (): Lobster | null => {
  if (typeof window === "undefined") return null;
  return safeParse<Lobster>(window.localStorage.getItem(LOBSTER_KEY));
};

export const saveLobster = (lobster: Lobster) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LOBSTER_KEY, JSON.stringify(lobster));
};
