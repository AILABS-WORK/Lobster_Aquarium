const TANK_BOX = [120, 80, 90] as const;

const smoothNoise = (x: number, z: number, scale: number) => {
  const fx = x * scale;
  const fz = z * scale;
  return (
    Math.sin(fx * 1.0) * Math.cos(fz * 0.9) * 0.5 +
    Math.sin(fx * 2.1 + 1.3) * Math.cos(fz * 1.8 + 0.7) * 0.25 +
    Math.sin(fx * 4.3 + 2.1) * Math.cos(fz * 3.7 + 1.4) * 0.125
  );
};

const sandBump = (x: number, z: number) => {
  const base = smoothNoise(x, z, 0.05) * 2.0;
  const medium = smoothNoise(x + 100, z + 50, 0.1) * 1.2;
  const detail = smoothNoise(x + 200, z + 150, 0.2) * 0.6;
  const fine = smoothNoise(x + 50, z + 80, 0.35) * 0.3;
  const mound1 = Math.exp(-((x + 12) ** 2 + (z - 8) ** 2) * 0.002) * 3;
  const mound2 = Math.exp(-((x - 15) ** 2 + (z + 10) ** 2) * 0.003) * 2.5;
  const mound3 = Math.exp(-((x - 5) ** 2 + (z - 14) ** 2) * 0.004) * 2;
  const mound4 = Math.exp(-((x + 18) ** 2 + (z + 5) ** 2) * 0.002) * 2.8;
  const mound5 = Math.exp(-((x - 8) ** 2 + (z + 16) ** 2) * 0.003) * 2.2;
  const ridge1 = Math.abs(Math.sin(x * 0.15 + z * 0.1)) * 0.8;
  const ridge2 = Math.abs(Math.sin(x * 0.08 - z * 0.12 + 1)) * 0.6;
  const combined =
    base +
    medium +
    detail +
    fine +
    mound1 +
    mound2 +
    mound3 +
    mound4 +
    mound5 +
    ridge1 * 0.4 +
    ridge2 * 0.3;
  return Math.max(0.1, combined * 0.5 + 0.5);
};

export { sandBump };

export const sandHeightAt = (x: number, z: number) => {
  const floorY = -TANK_BOX[1] / 2;
  return floorY + sandBump(x, z);
};
