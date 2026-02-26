"use client";

import { octopusGeometries } from "@/lib/shared-geometries";
import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";

const g = octopusGeometries;
const BODY_COLOR = "#1e3a8a"; // deep blue mantle
const TENTACLE_COLOR = "#1d4ed8"; // brighter blue arms
const SUCKER_COLOR = "#bfdbfe"; // light bluish suckers
const EYE_COLOR = "#0b1120";

export type OctopusMeshProps = {
  bodyColor?: string;
  tentacleColor?: string;
  suckerColor?: string;
  eyeColor?: string;
  scale?: number;

  // style knobs
  headSize?: number; // bigger mantle/head
  tentacleLength?: number; // longer arms
  tentacleThickness?: number;
  curl?: number; // how much tentacles curl inward
  bandanaColor?: string | null; // optional cosmetic like lobster
};

export function OctopusMesh({
  bodyColor = BODY_COLOR,
  tentacleColor = TENTACLE_COLOR,
  suckerColor = SUCKER_COLOR,
  eyeColor = EYE_COLOR,
  scale = 1,

  headSize = 1.15,
  tentacleLength = 1.0,
  tentacleThickness = 1.0,
  curl = 1.0,
  bandanaColor = null,
}: OctopusMeshProps) {
  // 8 tentacle anchor angles
  const tentacles = Array.from({ length: 8 }, (_, i) => i);
  const tentacleRefs = useRef<Group[]>([]);

  // Add a gentle idle sway so the arms feel alive.
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    tentacleRefs.current.forEach((g, i) => {
      if (!g) return;
      const phase = i * 0.6;
      const sway = Math.sin(t * 1.6 + phase) * 0.18;
      const lift = Math.sin(t * 1.1 + phase) * 0.06;
      g.rotation.z = sway;
      g.rotation.x = -0.1 + lift * 0.2;
    });
  });

  return (
    <group name="octopus" scale={[scale, scale, scale]}>
      {/* Mantle / head: rounded box stack to feel more octopus-like */}
      <group name="mantle" position={[0, 0.28 * headSize, 0]}>
        {/* main bulb */}
        <mesh>
          <boxGeometry args={[0.7 * headSize, 0.55 * headSize, 0.6 * headSize]} />
          <meshStandardMaterial color={bodyColor} roughness={0.6} metalness={0.08} />
        </mesh>

        {/* rounded crown */}
        <mesh position={[0.05 * headSize, 0.22 * headSize, 0]}>
          <primitive object={g.box(0.55 * headSize, 0.35 * headSize, 0.5 * headSize)} attach="geometry" />
          <meshStandardMaterial color={bodyColor} roughness={0.6} metalness={0.08} />
        </mesh>

        {/* front “face” block so eyes sit proud */}
        <mesh position={[-0.24 * headSize, 0.02 * headSize, 0]} rotation={[0, 0, 0.04]}>
          <primitive object={g.box(0.3 * headSize, 0.3 * headSize, 0.4 * headSize)} attach="geometry" />
          <meshStandardMaterial color={bodyColor} roughness={0.6} metalness={0.08} />
        </mesh>

        {/* Optional bandana (same concept as lobster) */}
        {bandanaColor ? (
          <mesh position={[-0.02 * headSize, 0.14 * headSize, 0]} rotation={[0.12, 0, 0]}>
            <primitive object={g.box(0.72 * headSize, 0.1 * headSize, 0.54 * headSize)} attach="geometry" />
            <meshStandardMaterial color={bandanaColor} roughness={0.55} metalness={0.06} />
          </mesh>
        ) : null}

        {/* Eyes – larger and pushed forward so they read clearly */}
        <mesh position={[-0.34 * headSize, 0.08 * headSize, 0.2 * headSize]}>
          <primitive object={g.sphere(0.06 * headSize, 6, 6)} attach="geometry" />
          <meshStandardMaterial color={EYE_COLOR} roughness={0.25} metalness={0.25} />
        </mesh>
        <mesh position={[-0.34 * headSize, 0.08 * headSize, -0.2 * headSize]}>
          <primitive object={g.sphere(0.06 * headSize, 6, 6)} attach="geometry" />
          <meshStandardMaterial color={EYE_COLOR} roughness={0.25} metalness={0.25} />
        </mesh>
      </group>

      {/* Tentacles (segmented, with slight curl and suckers) */}
      <group name="tentacles" position={[0, 0.02, 0]}>
        {tentacles.map((i) => {
          const angle = (i / 8) * Math.PI * 2;

          // anchor ring around the mantle bottom
          const anchorR = 0.32 * headSize;
          const ax = Math.cos(angle) * anchorR;
          const az = Math.sin(angle) * anchorR;

          // each tentacle has a slight unique yaw so they don't look cloned
          const yaw = angle + (i % 2 === 0 ? 0.22 : -0.22);

          const segments = 4;

          return (
            <group
              key={i}
              name={`tentacle-${i}`}
              ref={(el) => {
                if (el) tentacleRefs.current[i] = el;
              }}
              position={[ax, 0.04, az]}
              rotation={[0, yaw, 0]}
            >
              {Array.from({ length: segments }, (_, s) => {
                const t = s / (segments - 1);

                // segment size tapers
                const w = (0.22 - t * 0.09) * tentacleThickness;
                const h = (0.14 - t * 0.07) * tentacleThickness;
                const d = (0.18 - t * 0.07) * tentacleThickness;

                // forward offset along local X
                const x = 0.16 + t * (0.75 * tentacleLength);

                // droop and curl
                const y = -t * (0.26 * tentacleLength) - Math.sin(t * Math.PI) * 0.06 * curl;
                const z = Math.sin(t * Math.PI * 0.9) * 0.1 * curl;

                const rx = -t * 0.65 * curl;
                const rz = (i % 2 === 0 ? 1 : -1) * t * 0.26;

                return (
                  <group key={s} position={[x, y, z]} rotation={[rx, 0, rz]}>
                    <mesh>
                      <primitive object={g.box(w, h, d)} attach="geometry" />
                      <meshStandardMaterial color={tentacleColor} roughness={0.75} metalness={0.05} />
                    </mesh>
                  </group>
                );
              })}
            </group>
          );
        })}
      </group>
    </group>
  );
}
