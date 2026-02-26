"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";

const SHRIMP_BODY = "#f5a89a";
const SHRIMP_STRIPE = "#e07060";
const SHRIMP_TAIL = "#e88a7a";
const SHRIMP_EYE = "#111";

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

function transformedGeo(
  geo: THREE.BufferGeometry,
  pos: [number, number, number],
  rot: [number, number, number],
  color: string
): THREE.BufferGeometry {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(pos[0], pos[1], pos[2]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])),
    new THREE.Vector3(1, 1, 1)
  );
  geo = geo.clone();
  geo.applyMatrix4(m);
  addVertexColors(geo, color);
  return geo;
}

export type FoodInstanceData = {
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale: number;
  visible: boolean;
};

const FOOD_RENDER_MAX = 64;

/** Single InstancedMesh for all shrimp - merges 1 shrimp's geometry, draws 64 instances. */
export function InstancedShrimpFood({
  instanceDataRef,
}: {
  instanceDataRef: React.MutableRefObject<FoodInstanceData[]>;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const geometry = useMemo(() => {
    const geos: THREE.BufferGeometry[] = [];
    const curve = 0.12;

    for (let i = 0; i < 5; i++) {
      const segX = -0.08 + i * 0.09;
      const segY = Math.sin(i * 0.5) * curve;
      const segScale = 1 - i * 0.08;
      const color = i % 2 === 1 ? SHRIMP_STRIPE : SHRIMP_BODY;
      const g = new THREE.SphereGeometry(0.065 * segScale, 6, 6);
      geos.push(transformedGeo(g, [segX, segY, 0], [0, 0, 0], color));
      g.dispose();
    }

    const tailCone = new THREE.ConeGeometry(0.08, 0.14, 5);
    geos.push(transformedGeo(tailCone, [0.32, 0.02, 0], [0, 0, -0.2], SHRIMP_TAIL));
    tailCone.dispose();

    const tailBox = new THREE.BoxGeometry(0.08, 0.02, 0.06);
    geos.push(transformedGeo(tailBox, [0.38, 0.04, 0.04], [0.4, 0, -0.3], SHRIMP_TAIL));
    geos.push(transformedGeo(tailBox, [0.38, 0.04, -0.04], [-0.4, 0, -0.3], SHRIMP_TAIL));
    tailBox.dispose();

    geos.push(transformedGeo(new THREE.SphereGeometry(0.07, 6, 6), [-0.18, 0.01, 0], [0, 0, 0], SHRIMP_BODY));
    geos.push(transformedGeo(new THREE.ConeGeometry(0.025, 0.12, 4), [-0.28, 0.02, 0], [0, 0, 0.1], SHRIMP_BODY));

    const eyeGeo = new THREE.SphereGeometry(0.022, 5, 5);
    geos.push(transformedGeo(eyeGeo, [-0.2, 0.06, 0.045], [0, 0, 0], SHRIMP_EYE));
    geos.push(transformedGeo(eyeGeo, [-0.2, 0.06, -0.045], [0, 0, 0], SHRIMP_EYE));
    eyeGeo.dispose();

    const antGeo = new THREE.CylinderGeometry(0.006, 0.004, 0.18, 4);
    geos.push(transformedGeo(antGeo, [-0.24, 0.04, 0.05], [0.4, 0, -0.5], SHRIMP_STRIPE));
    geos.push(transformedGeo(new THREE.CylinderGeometry(0.005, 0.003, 0.22, 4), [-0.22, 0.03, 0.06], [0.3, 0, -0.7], SHRIMP_STRIPE));
    geos.push(transformedGeo(antGeo, [-0.24, 0.04, -0.05], [-0.4, 0, -0.5], SHRIMP_STRIPE));
    geos.push(transformedGeo(new THREE.CylinderGeometry(0.005, 0.003, 0.22, 4), [-0.22, 0.03, -0.06], [-0.3, 0, -0.7], SHRIMP_STRIPE));
    geos.push(transformedGeo(new THREE.CylinderGeometry(0.005, 0.003, 0.22, 4), [-0.22, 0.03, -0.06], [-0.3, 0, -0.7], SHRIMP_STRIPE));
    antGeo.dispose();

    const legPositions = [-0.12, -0.04, 0.04, 0.12];
    for (let i = 0; i < legPositions.length; i++) {
      geos.push(transformedGeo(new THREE.CylinderGeometry(0.008, 0.006, 0.08, 3), [legPositions[i], -0.05, 0], [0, 0, 0.15 + i * 0.05], SHRIMP_TAIL));
    }
    for (let i = 0; i < 3; i++) {
      geos.push(transformedGeo(new THREE.BoxGeometry(0.04, 0.015, 0.05), [i * 0.08, -0.04, 0], [0, 0, 0.1], SHRIMP_BODY));
    }

    const ensureNonIndexed = (g: THREE.BufferGeometry) =>
      g.index ? g.toNonIndexed() : g;
    const normalized = geos.map(ensureNonIndexed);
    const merged = BufferGeometryUtils.mergeGeometries(normalized);
    geos.filter((g) => g.index).forEach((g) => g.dispose());
    normalized.forEach((g) => g.dispose());
    return merged;
  }, []);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const data = instanceDataRef.current;
    for (let i = 0; i < FOOD_RENDER_MAX; i++) {
      const d = data[i];
      if (!d) {
        dummy.scale.setScalar(0);
      } else if (d.visible) {
        dummy.position.set(d.x, d.y, d.z);
        dummy.rotation.set(0, d.rotY, 0);
        dummy.scale.setScalar(d.scale);
      } else {
        dummy.scale.setScalar(0);
      }
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[geometry, undefined, FOOD_RENDER_MAX]} frustumCulled={false}>
      <meshStandardMaterial vertexColors roughness={0.6} metalness={0.1} />
    </instancedMesh>
  );
}
