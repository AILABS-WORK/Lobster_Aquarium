"use client";

import { useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import type { Group } from "three";
import { LobsterMesh } from "@/components/LobsterMesh";

export type RotatingLobsterPreviewProps = {
  bodyColor?: string;
  clawColor?: string;
  bandanaColor?: string | null;
  /** Optional fixed size (default 112). */
  size?: number;
  className?: string;
};

function RotatingGroup({
  bodyColor,
  clawColor,
  bandanaColor,
}: {
  bodyColor: string;
  clawColor: string;
  bandanaColor: string | null;
}) {
  const groupRef = useRef<Group>(null);
  useFrame((_, delta) => {
    if (groupRef.current) groupRef.current.rotation.y += delta * 0.2;
  });
  return (
    <group ref={groupRef} scale={1.2}>
      <LobsterMesh
        bodyColor={bodyColor}
        clawColor={clawColor}
        bandanaColor={bandanaColor}
      />
    </group>
  );
}

export function RotatingLobsterPreview({
  bodyColor = "#c85c42",
  clawColor = "#8b4513",
  bandanaColor = null,
  size = 112,
  className = "",
}: RotatingLobsterPreviewProps) {
  return (
    <div
      className={`overflow-hidden rounded-xl border border-slate-200 bg-slate-100 ${className}`}
      style={{ width: size, height: size }}
    >
      <Canvas
        camera={{ position: [0, 0, 4], fov: 45 }}
        style={{ width: size, height: size }}
        gl={{ antialias: true, alpha: false }}
      >
        <ambientLight intensity={0.9} />
        <directionalLight position={[2, 2, 2]} intensity={0.8} />
        <RotatingGroup
          bodyColor={bodyColor}
          clawColor={clawColor}
          bandanaColor={bandanaColor}
        />
      </Canvas>
    </div>
  );
}
