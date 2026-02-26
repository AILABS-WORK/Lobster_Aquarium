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
const SEAWEED_LEGACY: Array<{ x: number; y: number; radius: number }> = [
  { x: 30, y: 40, radius: 6 },
  { x: 70, y: 150, radius: 6 },
  { x: 110, y: 90, radius: 7 },
  { x: 150, y: 35, radius: 6 },
  { x: 190, y: 130, radius: 7 },
  { x: 225, y: 65, radius: 6 },
  { x: 50, y: 95, radius: 7 },
  { x: 90, y: 35, radius: 6 },
  { x: 135, y: 160, radius: 7 },
  { x: 175, y: 80, radius: 6 },
  { x: 210, y: 170, radius: 7 },
  { x: 20, y: 160, radius: 6 },
  { x: 240, y: 30, radius: 6 },
  { x: 120, y: 20, radius: 6 },
  { x: 120, y: 185, radius: 7 },
  { x: 200, y: 100, radius: 6 },
];
export const SEAWEED_SIM_POSITIONS: Obstacle[] = SEAWEED_LEGACY.map(({ x, y, radius }) => ({
  x: TANK_WALL_MARGIN + (x - TANK_WALL_MARGIN) * scaleSx,
  y: TANK_WALL_MARGIN + (y - TANK_WALL_MARGIN) * scaleSy,
  radius,
}));

/** Rocks: 3D [x, z, scale] from TankScene ROCKS. */
const ROCKS_3D: Array<[number, number, number]> = [
  [-18, -8, 0.9],
  [16, 10, 0.7],
  [-6, 14, 1.1],
  [10, -12, 0.8],
  [-20, 4, 1.0],
  [4, -10, 0.65],
  [20, -4, 0.85],
  [-14, 12, 0.75],
  [22, 14, 0.6],
  [-22, -12, 0.7],
  [-10, -18, 0.85],
  [6, 18, 0.7],
  [0, 6, 0.95],
  [12, 2, 0.65],
  [-6, 2, 0.6],
  [18, -14, 0.8],
  [-18, 16, 0.75],
  [24, 6, 0.7],
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
