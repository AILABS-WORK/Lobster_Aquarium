import { TANK_WALL_MARGIN } from "./factory";
import { getSimDimensions } from "@/lib/sim-config";

export type Obstacle = {
  x: number;
  y: number;
  radius: number;
};

/** Sim dimensions must match TankScene (800×600 at scale 1) so obstacles use full tank, not a small corner. */
const { width: SIM_WIDTH, height: SIM_HEIGHT } = getSimDimensions(1);
const HALF_X = 120 / 2 - 1; // 59
const HALF_Z = 90 / 2 - 1;  // 44
const INNER_W = SIM_WIDTH - TANK_WALL_MARGIN * 2;
const INNER_H = SIM_HEIGHT - TANK_WALL_MARGIN * 2;
/** Scale factor: 3D radius/scale to sim-space radius (average of x and z axes). */
const SCALE_3D_TO_SIM = (INNER_W / (2 * HALF_X) + INNER_H / (2 * HALF_Z)) / 2;

function from3D(x3d: number, z3d: number, radius3d: number): Obstacle {
  const simX = TANK_WALL_MARGIN + ((x3d + HALF_X) / (2 * HALF_X)) * INNER_W;
  const simY = TANK_WALL_MARGIN + ((z3d + HALF_Z) / (2 * HALF_Z)) * INNER_H;
  const radius = Math.max(2, radius3d * SCALE_3D_TO_SIM);
  return { x: simX, y: simY, radius };
}

/** Seaweed positions in full sim space (800×600). Originally defined in 260×200; scaled so they spread across the whole tank. */
const LEGACY_W = 260;
const LEGACY_H = 200;
const scaleSx = SIM_WIDTH / LEGACY_W;
const scaleSy = SIM_HEIGHT / LEGACY_H;
/** Spaced across full floor: edges, corners, and middle with even distribution (no central cluster). */
const SEAWEED_LEGACY: Array<{ x: number; y: number; radius: number }> = [
  { x: 25, y: 25, radius: 5 },
  { x: 25, y: 55, radius: 5 },
  { x: 25, y: 100, radius: 6 },
  { x: 25, y: 145, radius: 5 },
  { x: 25, y: 175, radius: 5 },
  { x: 235, y: 25, radius: 5 },
  { x: 235, y: 60, radius: 5 },
  { x: 235, y: 100, radius: 6 },
  { x: 235, y: 140, radius: 5 },
  { x: 235, y: 175, radius: 5 },
  { x: 55, y: 18, radius: 5 },
  { x: 100, y: 18, radius: 6 },
  { x: 160, y: 18, radius: 5 },
  { x: 205, y: 18, radius: 5 },
  { x: 55, y: 182, radius: 5 },
  { x: 100, y: 182, radius: 6 },
  { x: 160, y: 182, radius: 5 },
  { x: 205, y: 182, radius: 5 },
  { x: 70, y: 45, radius: 5 },
  { x: 190, y: 45, radius: 5 },
  { x: 70, y: 155, radius: 5 },
  { x: 190, y: 155, radius: 5 },
  { x: 130, y: 70, radius: 6 },
  { x: 130, y: 130, radius: 6 },
  { x: 50, y: 100, radius: 5 },
  { x: 210, y: 100, radius: 5 },
  { x: 100, y: 50, radius: 5 },
  { x: 160, y: 50, radius: 5 },
  { x: 100, y: 150, radius: 5 },
  { x: 160, y: 150, radius: 5 },
  { x: 15, y: 80, radius: 5 },
  { x: 245, y: 80, radius: 5 },
  { x: 130, y: 25, radius: 5 },
  { x: 130, y: 175, radius: 5 },
];
export const SEAWEED_SIM_POSITIONS: Obstacle[] = SEAWEED_LEGACY.map(({ x, y, radius }) => ({
  x: TANK_WALL_MARGIN + (x - TANK_WALL_MARGIN) * scaleSx,
  y: TANK_WALL_MARGIN + (y - TANK_WALL_MARGIN) * scaleSy,
  radius,
}));

/** Rocks: 3D [x, z, scale] from TankScene ROCKS. */
const ROCKS_3D: Array<[number, number, number]> = [
  [-24, -20, 0.85], [-24, -6, 0.7], [-24, 10, 0.75], [-24, 22, 0.8],
  [24, -22, 0.75], [24, -8, 0.7], [24, 6, 0.8], [24, 20, 0.7],
  [-12, -26, 0.9], [0, -26, 0.65], [14, -26, 0.75],
  [-16, 26, 0.7], [4, 26, 0.8], [20, 26, 0.65],
  [-18, -8, 1.0], [16, 10, 0.75], [-6, 14, 1.1], [10, -12, 0.85],
  [-20, 4, 1.05], [4, -10, 0.7], [20, -4, 0.9], [-14, 12, 0.8],
  [22, 14, 0.65], [-22, -12, 0.75], [-10, -18, 0.9], [6, 18, 0.75],
  [0, 6, 1.0], [12, 2, 0.7], [-6, 2, 0.65], [18, -14, 0.85],
  [-18, 16, 0.8], [24, 6, 0.75],
  [-8, -14, 0.6], [8, 16, 0.6], [-14, 0, 0.7], [14, -6, 0.65],
  [2, -20, 0.8], [-4, 20, 0.7], [18, 0, 0.6], [-20, -16, 0.75], [22, -18, 0.7],
];

export const ROCKS_SIM: Obstacle[] = ROCKS_3D.map(([x, z, scale]) => from3D(x, z, scale));

/** Cave domes: 3D [x, z, radius] from TankScene CAVE_DOMES. */
const CAVE_DOMES_3D: Array<[number, number, number]> = [
  [-8, 6, 6.5],
  [14, -2, 5.5],
];

export const CAVE_DOMES_SIM: Obstacle[] = CAVE_DOMES_3D.map(([x, z, r]) => from3D(x, z, r));

/** Barnacle rocks: 3D [x, z, scale] from TankScene BARNACLE_ROCKS. */
const BARNACLE_ROCKS_3D: Array<[number, number, number]> = [
  [-10, -6, 0.6],
  [16, -12, 0.5],
  [6, 12, 0.55],
  [-18, 8, 0.5],
];

export const BARNACLE_ROCKS_SIM: Obstacle[] = BARNACLE_ROCKS_3D.map(([x, z, scale]) => from3D(x, z, scale));

/** All obstacles for engine (seaweed + rocks + domes + barnacles). */
export const ALL_OBSTACLES: Obstacle[] = [
  ...SEAWEED_SIM_POSITIONS,
  ...ROCKS_SIM,
  ...CAVE_DOMES_SIM,
  ...BARNACLE_ROCKS_SIM,
];
