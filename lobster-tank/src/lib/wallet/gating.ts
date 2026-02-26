import { env } from "@/lib/env";
import { EligibilityTier } from "@/types/profile";
import { TokenBalance } from "./types";

const defaultCare = 100; // 1000 for production; lowered for testing
const defaultOwner = 10000;

export const getCaretakerMin = (): number => {
  const v = env.TOKEN_CARETAKER_MIN;
  if (v == null || v === "") return defaultCare;
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultCare;
};

export const getOwnerMin = (): number => {
  const v = env.TOKEN_OWNER_MIN;
  if (v == null || v === "") return defaultOwner;
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultOwner;
};

export const CARETAKER_MIN = defaultCare;
export const OWNER_MIN = defaultOwner;

export const getEligibilityTier = (balance: TokenBalance): EligibilityTier => {
  const ownerMin = getOwnerMin();
  const caretakerMin = getCaretakerMin();
  if (balance.amount >= ownerMin) return "owner";
  if (balance.amount >= caretakerMin) return "caretaker";
  return "viewer";
};
