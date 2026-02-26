"use client";

import * as THREE from "three";

/** Shared geometries for LobsterMesh - created once, reused across all lobster instances. */
const boxCache = new Map<string, THREE.BoxGeometry>();
const sphereCache = new Map<string, THREE.SphereGeometry>();
const cylinderCache = new Map<string, THREE.CylinderGeometry>();

function getBox(w: number, h: number, d: number): THREE.BoxGeometry {
  const key = `${w},${h},${d}`;
  let g = boxCache.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    boxCache.set(key, g);
  }
  return g;
}

function getSphere(r: number, w: number, h: number): THREE.SphereGeometry {
  const key = `${r},${w},${h}`;
  let g = sphereCache.get(key);
  if (!g) {
    g = new THREE.SphereGeometry(r, w, h);
    sphereCache.set(key, g);
  }
  return g;
}

function getCylinder(r1: number, r2: number, h: number, segments: number): THREE.CylinderGeometry {
  const key = `${r1},${r2},${h},${segments}`;
  let g = cylinderCache.get(key);
  if (!g) {
    g = new THREE.CylinderGeometry(r1, r2, h, segments);
    cylinderCache.set(key, g);
  }
  return g;
}

export const lobsterGeometries = {
  box: getBox,
  sphere: getSphere,
  cylinder: getCylinder,
};

export const octopusGeometries = {
  box: getBox,
  sphere: getSphere,
};
