export type EligibilityTier = "viewer" | "caretaker" | "owner";

export type UserProfile = {
  id: string;
  handle: string;
  avatarUrl?: string;
  walletAddress?: string;
  tier: EligibilityTier;
  lobsterId?: string;
};
