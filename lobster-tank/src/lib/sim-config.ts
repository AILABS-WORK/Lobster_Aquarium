/**
 * Shared sim dimensions and creature counts. Use a scale factor (e.g. 1 or 4)
 * to run a larger tank with proportionally more lobsters and predators.
 * Server reads TANK_SCALE from env; client can use NEXT_PUBLIC_TANK_SCALE or rely on server state.
 */
const BASE_WIDTH = 800;
const BASE_HEIGHT = 600;
const BASE_LOBSTER_COUNT = 48;
const BASE_PREDATOR_COUNT = 3;

export function getSimDimensions(scale: number): {
  width: number;
  height: number;
  lobsterCount: number;
  predatorCount: number;
} {
  const s = Math.max(0.25, Math.min(10, Number(scale) || 1));
  return {
    width: Math.round(BASE_WIDTH * s),
    height: Math.round(BASE_HEIGHT * s),
    lobsterCount: Math.round(BASE_LOBSTER_COUNT * s),
    predatorCount: Math.max(1, Math.round(BASE_PREDATOR_COUNT * s)),
  };
}
