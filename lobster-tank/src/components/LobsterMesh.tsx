"use client";

import { lobsterGeometries } from "@/lib/shared-geometries";

const BODY_COLOR = "#c85c42";
const CLAW_COLOR = "#a04030";
const TAIL_COLOR = "#b05038";
const LEG_COLOR = "#8b3a2a";
const EYE_COLOR = "#1a1a1a";

const g = lobsterGeometries;

export type LobsterMeshProps = {
  bodyColor?: string;
  clawColor?: string;
  bandanaColor?: string | null;
  /** When true, show a subtle golden/boost aura (e.g. after being fed). */
  boosted?: boolean;
  /** When true, lobster is dead -- grey out */
  dead?: boolean;
};

export function LobsterMesh({
  bodyColor = BODY_COLOR,
  clawColor = CLAW_COLOR,
  bandanaColor = null,
  boosted = false,
  dead = false,
}: LobsterMeshProps) {
  const effectiveBodyColor = dead ? "#6b7280" : bodyColor;
  const effectiveClawColor = dead ? "#4b5563" : clawColor;
  const bodyMat = dead
    ? { color: effectiveBodyColor, roughness: 0.9, metalness: 0, transparent: false }
    : boosted
      ? { color: effectiveBodyColor, roughness: 0.5, metalness: 0.15, emissive: "#eab308", emissiveIntensity: 0.5, transparent: false }
      : { color: effectiveBodyColor, roughness: 0.65, metalness: 0.08, transparent: false };
  return (
    <group name="lobster">
      {boosted && !dead ? (
        <>
          <pointLight position={[0, 0.5, 0]} intensity={1} distance={6} color="#fbbf24" castShadow={false} />
          <pointLight position={[0, 0, 0.3]} intensity={0.6} distance={4} color="#fde047" castShadow={false} />
          {/* Golden boosted aura ring visible in aquarium */}
          <mesh position={[0, -0.12, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.75, 0.06, 12, 32]} />
            <meshBasicMaterial color="#eab308" transparent opacity={0.85} />
          </mesh>
        </>
      ) : null}
      {/* Head / cephalothorax */}
      <mesh position={[-0.46, 0.04, 0]} name="body">
        <primitive object={g.box(0.44, 0.24, 0.32)} attach="geometry" />
        <meshStandardMaterial {...bodyMat} />
      </mesh>
      <mesh position={[-0.64, 0.08, 0]}>
        <primitive object={g.box(0.2, 0.18, 0.26)} attach="geometry" />
        <meshStandardMaterial {...bodyMat} />
      </mesh>
      {/* Bandana: strip on head for community; visible from front and side */}
      {bandanaColor ? (
        <group position={[-0.52, 0.24, 0]} rotation={[0.14, 0, 0]}>
          <mesh>
            <primitive object={g.box(0.58, 0.1, 0.28)} attach="geometry" />
            <meshStandardMaterial color={bandanaColor} roughness={0.55} metalness={0.06} transparent={false} />
          </mesh>
        </group>
      ) : null}
      {/* Segmented abdomen (4 segments, tapering) */}
      <mesh position={[-0.1, 0.02, 0]}>
        <primitive object={g.box(0.26, 0.2, 0.24)} attach="geometry" />
        <meshStandardMaterial {...bodyMat} />
      </mesh>
      <mesh position={[0.16, 0.02, 0]}>
        <primitive object={g.box(0.22, 0.18, 0.22)} attach="geometry" />
        <meshStandardMaterial {...bodyMat} />
      </mesh>
      <mesh position={[0.42, 0.02, 0]}>
        <primitive object={g.box(0.2, 0.16, 0.2)} attach="geometry" />
        <meshStandardMaterial {...bodyMat} />
      </mesh>
      <mesh position={[0.68, 0.02, 0]}>
        <primitive object={g.box(0.18, 0.14, 0.18)} attach="geometry" />
        <meshStandardMaterial {...bodyMat} />
      </mesh>
      {/* Tail fan (5 segments, fanned) */}
      <mesh position={[0.92, 0.02, 0.1]} rotation={[0, 0, 0.2]}>
        <primitive object={g.box(0.18, 0.07, 0.3)} attach="geometry" />
        <meshStandardMaterial color={TAIL_COLOR} roughness={0.7} metalness={0.05} />
      </mesh>
      <mesh position={[0.92, 0.02, -0.1]} rotation={[0, 0, -0.2]}>
        <primitive object={g.box(0.18, 0.07, 0.3)} attach="geometry" />
        <meshStandardMaterial color={TAIL_COLOR} roughness={0.7} metalness={0.05} />
      </mesh>
      <mesh position={[1.02, 0.02, 0]} rotation={[0, 0, 0.08]} name="tail">
        <primitive object={g.box(0.16, 0.06, 0.26)} attach="geometry" />
        <meshStandardMaterial color={TAIL_COLOR} roughness={0.7} metalness={0.05} />
      </mesh>
      <mesh position={[1.16, 0.02, 0.08]} rotation={[0, 0, 0.16]}>
        <primitive object={g.box(0.14, 0.05, 0.22)} attach="geometry" />
        <meshStandardMaterial color={TAIL_COLOR} roughness={0.7} metalness={0.05} />
      </mesh>
      <mesh position={[1.16, 0.02, -0.08]} rotation={[0, 0, -0.16]}>
        <primitive object={g.box(0.14, 0.05, 0.22)} attach="geometry" />
        <meshStandardMaterial color={TAIL_COLOR} roughness={0.7} metalness={0.05} />
      </mesh>
      {/* Crusher claw (larger) */}
      <mesh position={[-0.76, 0.1, 0.3]} rotation={[0.14, 0, 0.06]}>
        <primitive object={g.box(0.3, 0.18, 0.52)} attach="geometry" />
        <meshStandardMaterial color={effectiveClawColor} roughness={0.75} metalness={0.05} transparent={false} />
      </mesh>
      <mesh position={[-0.9, 0.08, 0.4]} rotation={[0.06, 0.1, 0.08]}>
        <primitive object={g.box(0.22, 0.1, 0.3)} attach="geometry" />
        <meshStandardMaterial color={effectiveClawColor} roughness={0.8} metalness={0.04} transparent={false} />
      </mesh>
      {/* Pincer claw (smaller) */}
      <mesh position={[-0.72, 0.08, -0.3]} rotation={[0.08, 0, -0.06]}>
        <primitive object={g.box(0.24, 0.14, 0.4)} attach="geometry" />
        <meshStandardMaterial color={effectiveClawColor} roughness={0.75} metalness={0.05} transparent={false} />
      </mesh>
      <mesh position={[-0.86, 0.06, -0.38]} rotation={[0.05, -0.08, -0.05]}>
        <primitive object={g.box(0.2, 0.08, 0.24)} attach="geometry" />
        <meshStandardMaterial color={effectiveClawColor} roughness={0.8} metalness={0.04} transparent={false} />
      </mesh>
      {/* Legs (pairs underneath) */}
      {[-0.32, -0.1, 0.12, 0.34, 0.56].map((x, i) => (
        <group key={i}>
          <mesh name={`leg-${i}-l`} position={[x, -0.08, 0.16]} rotation={[0.35, 0, 0]}>
            <primitive object={g.cylinder(0.035, 0.035, 0.16, 5)} attach="geometry" />
            <meshStandardMaterial color={LEG_COLOR} roughness={0.8} metalness={0} />
          </mesh>
          <mesh name={`leg-${i}-r`} position={[x, -0.08, -0.16]} rotation={[0.35, 0, 0]}>
            <primitive object={g.cylinder(0.035, 0.035, 0.16, 5)} attach="geometry" />
            <meshStandardMaterial color={LEG_COLOR} roughness={0.8} metalness={0} />
          </mesh>
        </group>
      ))}
      {/* Eyes on stalks */}
      <mesh position={[-0.54, 0.16, 0.12]}>
        <primitive object={g.sphere(0.04, 6, 6)} attach="geometry" />
        <meshStandardMaterial color={EYE_COLOR} roughness={0.3} metalness={0.2} />
      </mesh>
      <mesh position={[-0.54, 0.16, -0.12]}>
        <primitive object={g.sphere(0.04, 6, 6)} attach="geometry" />
        <meshStandardMaterial color={EYE_COLOR} roughness={0.3} metalness={0.2} />
      </mesh>
      {/* Antennae (thin, forward) */}
      <mesh position={[-0.7, 0.12, 0.2]} rotation={[0.25, 0, 0]}>
        <primitive object={g.cylinder(0.012, 0.012, 0.5, 5)} attach="geometry" />
        <meshStandardMaterial color={LEG_COLOR} roughness={0.85} metalness={0} />
      </mesh>
      <mesh position={[-0.7, 0.12, -0.2]} rotation={[0.25, 0, 0]}>
        <primitive object={g.cylinder(0.012, 0.012, 0.5, 5)} attach="geometry" />
        <meshStandardMaterial color={LEG_COLOR} roughness={0.85} metalness={0} />
      </mesh>
    </group>
  );
}
