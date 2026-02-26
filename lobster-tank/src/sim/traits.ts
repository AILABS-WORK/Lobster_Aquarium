export type TraitDelta = {
  xp: number;
  courage: number;
  likeability: number;
  size: number;
};

export const applyFeedEffects = (amount: number): TraitDelta => {
  if (amount >= 5000) {
    return { xp: 80, courage: 0.18, likeability: 0.14, size: 0.05 };
  }
  if (amount >= 1000) {
    return { xp: 40, courage: 0.1, likeability: 0.08, size: 0.03 };
  }
  if (amount >= 500) {
    return { xp: 22, courage: 0.06, likeability: 0.04, size: 0.02 };
  }
  if (amount >= 100) {
    return { xp: 12, courage: 0.02, likeability: 0.02, size: 0.01 };
  }
  return { xp: 4, courage: 0.01, likeability: 0.01, size: 0 };
};

export const applyPetEffects = (): TraitDelta => ({
  xp: 0,
  courage: 0,
  likeability: 0.03,
  size: 0,
});
