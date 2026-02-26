"use client";

import { sandHeightAt } from "@/lib/sand-height";
import { useMemo } from "react";
import * as THREE from "three";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";

function addVertexColors(geo: THREE.BufferGeometry, color: string): void {
  const c = new THREE.Color(color);
  const pos = geo.attributes.position;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

function createTransformedGeo(
  type: "box" | "sphere" | "cylinder" | "cone" | "icosahedron" | "tetrahedron" | "dodecahedron" | "plane" | "circle",
  args: number[],
  position: [number, number, number],
  rotation: [number, number, number],
  color: string
): THREE.BufferGeometry {
  let geo: THREE.BufferGeometry;
  if (type === "box") {
    geo = new THREE.BoxGeometry(args[0], args[1], args[2]);
  } else if (type === "sphere") {
    geo = new THREE.SphereGeometry(args[0], args[1] ?? 6, args[2] ?? 6);
  } else if (type === "cylinder") {
    geo = new THREE.CylinderGeometry(args[0], args[1] ?? args[0], args[2], args[3] ?? 6);
  } else if (type === "cone") {
    geo = new THREE.ConeGeometry(args[0], args[1], args[2] ?? 6);
  } else if (type === "icosahedron") {
    geo = new THREE.IcosahedronGeometry(args[0], args[1] ?? 0);
  } else if (type === "tetrahedron") {
    geo = new THREE.TetrahedronGeometry(args[0], args[1] ?? 0);
  } else if (type === "dodecahedron") {
    geo = new THREE.DodecahedronGeometry(args[0], args[1] ?? 0);
  } else if (type === "plane") {
    geo = new THREE.PlaneGeometry(args[0], args[1]);
  } else if (type === "circle") {
    geo = new THREE.CircleGeometry(args[0], args[1] ?? 8);
  } else {
    geo = new THREE.BoxGeometry(1, 1, 1);
  }
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(position[0], position[1], position[2]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2])),
    new THREE.Vector3(1, 1, 1)
  );
  geo.applyMatrix4(m);
  addVertexColors(geo, color);
  return geo;
}

/** Merges static decoration meshes into 1-3 draw calls for performance. */
export function MergedStaticDecorations() {
  const { group1, group2, group3 } = useMemo(() => {
    const geos1: THREE.BufferGeometry[] = [];
    const geos2: THREE.BufferGeometry[] = [];
    const geos3: THREE.BufferGeometry[] = [];

    const PEBBLES: Array<[number, number, number]> = [
      [-14, -4, 0.15], [-6, 6, 0.18], [6, 12, 0.12], [14, -10, 0.2],
      [-20, 10, 0.16], [22, 4, 0.14], [2, -14, 0.1], [-8, 14, 0.12],
    ];
    for (let i = 0; i < PEBBLES.length; i++) {
      const [x, z, scale] = PEBBLES[i];
      const y = sandHeightAt(x, z) + scale * 0.4;
      geos1.push(createTransformedGeo("icosahedron", [scale, 0], [x, y, z], [0, i * 0.5, 0], "#9c876d"));
    }

    const DRIFTWOOD: Array<[number, number, number, number]> = [[-8, -6, 4.5, 0.25], [12, 8, 5.2, 0.22]];
    for (let i = 0; i < DRIFTWOOD.length; i++) {
      const [x, z, length, radius] = DRIFTWOOD[i];
      const y = sandHeightAt(x, z) + radius * 0.6;
      geos1.push(createTransformedGeo("cylinder", [radius, radius * 1.2, length, 6], [x, y, z], [0.2, i * 0.6, 0.1], "#8b6b4a"));
    }

    const POTTERY_SHARDS: Array<[number, number, number]> = [[-2, -12, 0.35], [6, -14, 0.28], [0, -10, 0.22]];
    for (let i = 0; i < POTTERY_SHARDS.length; i++) {
      const [x, z, scale] = POTTERY_SHARDS[i];
      const y = sandHeightAt(x, z) + scale * 0.3;
      geos1.push(createTransformedGeo("tetrahedron", [scale, 0], [x, y, z], [0.2, i * 0.5, 0.1], "#c26d4f"));
    }

    const SHELLS: Array<[number, number, number]> = [[-12, 4, 0.2], [-10, 6, 0.18], [-8, 3, 0.22], [10, -4, 0.2]];
    for (let i = 0; i < SHELLS.length; i++) {
      const [x, z, scale] = SHELLS[i];
      const y = sandHeightAt(x, z) + scale * 0.25;
      geos1.push(createTransformedGeo("sphere", [scale, 6, 6], [x, y, z], [0, i * 0.7, 0], "#e6d3b8"));
    }

    const SAND_RIDGES: Array<[number, number]> = [[6, 14], [-18, 10]];
    for (let i = 0; i < SAND_RIDGES.length; i++) {
      const [x, z] = SAND_RIDGES[i];
      const y = sandHeightAt(x, z) + 0.1;
      geos1.push(createTransformedGeo("box", [3, 0.25, 1.2], [x, y, z], [0, i * 0.4, 0], "#d9c6a1"));
    }

    const ROCK_SLABS: Array<[number, number]> = [[10, 12], [-12, -10]];
    for (let i = 0; i < ROCK_SLABS.length; i++) {
      const [x, z] = ROCK_SLABS[i];
      const y = sandHeightAt(x, z) + 0.2;
      geos1.push(createTransformedGeo("box", [2.4, 0.4, 1.6], [x, y, z], [0.05, i * 0.6, 0.02], "#7f6e5a"));
    }

    const REEF_ARCHES: Array<[number, number]> = [[-2, 2], [6, -2]];
    for (let i = 0; i < REEF_ARCHES.length; i++) {
      const [x, z] = REEF_ARCHES[i];
      const by = sandHeightAt(x, z) + 0.6;
      geos1.push(createTransformedGeo("box", [0.5, 1.2, 0.5], [x - 0.5, by, z], [0, 0, 0], "#7a6a55"));
      geos1.push(createTransformedGeo("box", [0.5, 1.2, 0.5], [x + 0.5, by, z], [0, 0, 0], "#7a6a55"));
      geos1.push(createTransformedGeo("box", [1.4, 0.4, 0.6], [x, by + 0.6, z], [0, 0, 0], "#7a6a55"));
    }

    const CORAL_MOUNDS: Array<[number, number, number]> = [[-6, -2, 0.6], [12, 2, 0.5], [4, 8, 0.55]];
    for (let i = 0; i < CORAL_MOUNDS.length; i++) {
      const [x, z, scale] = CORAL_MOUNDS[i];
      const by = sandHeightAt(x, z) + scale * 0.4;
      geos2.push(createTransformedGeo("cone", [scale * 0.6, scale * 1.4, 6], [x, by, z], [0, i * 0.5, 0], "#d97c6b"));
      geos2.push(createTransformedGeo("cone", [scale * 0.4, scale * 1.1, 6], [x + scale * 0.4, by + scale * 0.2, z], [0, 0, 0], "#e08a76"));
    }

    const SPONGES: Array<[number, number, number]> = [[8, -6, 0.5], [-14, 8, 0.45]];
    for (let i = 0; i < SPONGES.length; i++) {
      const [x, z, scale] = SPONGES[i];
      const y = sandHeightAt(x, z) + scale * 0.6;
      geos2.push(createTransformedGeo("box", [scale * 0.9, scale * 1.4, scale * 0.9], [x, y, z], [0, i * 0.4, 0], "#e5b84f"));
    }

    const STARFISH: Array<[number, number]> = [[4, -6], [-16, 6]];
    for (let i = 0; i < STARFISH.length; i++) {
      const [x, z] = STARFISH[i];
      const by = sandHeightAt(x, z) + 0.08;
      for (let idx = 0; idx < 5; idx++) {
        geos2.push(createTransformedGeo("cone", [0.14, 0.6, 4], [x, by, z], [0, (idx / 5) * Math.PI * 2, 0], "#e08a6a"));
      }
    }

    const ANEMONES: Array<[number, number]> = [[2, 12], [-4, 10]];
    for (let i = 0; i < ANEMONES.length; i++) {
      const [x, z] = ANEMONES[i];
      const by = sandHeightAt(x, z) + 0.3;
      for (let idx = 0; idx < 6; idx++) {
        geos2.push(createTransformedGeo("cylinder", [0.04, 0.08, 0.8, 5], [x, by, z], [0, (idx / 6) * Math.PI * 2, 0], "#f08fa4"));
      }
    }

    const ALGAE_PATCHES: Array<[number, number]> = [[14, -2], [-4, 6], [-12, -4], [8, 14]];
    for (let i = 0; i < ALGAE_PATCHES.length; i++) {
      const [x, z] = ALGAE_PATCHES[i];
      const y = sandHeightAt(x, z) + 0.02;
      geos3.push(createTransformedGeo("circle", [1.4, 8], [x, y, z], [-Math.PI / 2, 0, i * 0.4], "#3f8b5e"));
    }

    const COIN_PILES: Array<[number, number]> = [[-2, -2], [16, 4], [-14, 10]];
    for (let i = 0; i < COIN_PILES.length; i++) {
      const [x, z] = COIN_PILES[i];
      const by = sandHeightAt(x, z) + 0.08;
      for (let idx = 0; idx < 5; idx++) {
        geos3.push(createTransformedGeo("cylinder", [0.2, 0.2, 0.04, 8], [x, by + idx * 0.06, z], [0, 0, 0], "#d4b04f"));
      }
    }

    const PEBBLE_PILES: Array<[number, number]> = [[14, 14], [-6, -14]];
    for (let i = 0; i < PEBBLE_PILES.length; i++) {
      const [x, z] = PEBBLE_PILES[i];
      const by = sandHeightAt(x, z) + 0.2;
      for (let idx = 0; idx < 6; idx++) {
        geos1.push(createTransformedGeo("icosahedron", [0.16, 0], [x + Math.sin(idx) * 0.4, by, z + Math.cos(idx) * 0.4], [0, 0, 0], "#a08e75"));
      }
    }

    const KELP_CLUSTERS: Array<[number, number]> = [[18, 6], [-18, -2]];
    for (let i = 0; i < KELP_CLUSTERS.length; i++) {
      const [x, z] = KELP_CLUSTERS[i];
      const by = sandHeightAt(x, z);
      for (let idx = 0; idx < 3; idx++) {
        geos3.push(createTransformedGeo("cylinder", [0.08, 0.14, 3.2, 6], [x + idx * 0.2 - 0.2, by + 1.5, z], [0, 0, 0.2], "#2f7a55"));
      }
    }

    const ensureNonIndexed = (g: THREE.BufferGeometry) =>
      g.index ? g.toNonIndexed() : g;
    const norm1 = geos1.map(ensureNonIndexed);
    const norm2 = geos2.map(ensureNonIndexed);
    const norm3 = geos3.map(ensureNonIndexed);
    const merged1 = norm1.length > 0 ? BufferGeometryUtils.mergeGeometries(norm1) : null;
    const merged2 = norm2.length > 0 ? BufferGeometryUtils.mergeGeometries(norm2) : null;
    const merged3 = norm3.length > 0 ? BufferGeometryUtils.mergeGeometries(norm3) : null;

    geos1.filter((g) => g.index).forEach((g) => g.dispose());
    geos2.filter((g) => g.index).forEach((g) => g.dispose());
    geos3.filter((g) => g.index).forEach((g) => g.dispose());
    norm1.forEach((g) => g.dispose());
    norm2.forEach((g) => g.dispose());
    norm3.forEach((g) => g.dispose());

    return { group1: merged1, group2: merged2, group3: merged3 };
  }, []);

  return (
    <group>
      {group1 && (
        <mesh geometry={group1}>
          <meshStandardMaterial vertexColors roughness={0.9} metalness={0.05} flatShading={false} />
        </mesh>
      )}
      {group2 && (
        <mesh geometry={group2}>
          <meshStandardMaterial vertexColors roughness={0.85} metalness={0.02} flatShading={false} />
        </mesh>
      )}
      {group3 && (
        <mesh geometry={group3}>
          <meshStandardMaterial vertexColors roughness={0.9} metalness={0.1} flatShading={false} />
        </mesh>
      )}
    </group>
  );
}
