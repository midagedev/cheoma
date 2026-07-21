import * as THREE from 'three';
import * as G from '../../core/math/geom2.js';
import { markSharedResource } from '../../core/three-resources.js';
import { parcelWorldPoint } from '../../village/parcel-contract.js';
import {
  TEMPLE_PAD_LIFT,
  templeCompoundSize,
  templeFootprint,
} from '../../village/temple-plan.js';

const PAD_LIFT = 0.06;
const PAD_MARGIN = 0.6;
const PAD_STEP_MIN = 0.1;
const PAD_SINK = 0.06;

// 필지·랜드마크 패드는 같은 두 재질을 공유해 draw call과 material 수를 고정한다.
const padTopMaterial = markSharedResource(
  new THREE.MeshStandardMaterial({ color: 0x8a7f66, roughness: 1, metalness: 0 }),
);
const padStoneMaterial = markSharedResource(
  new THREE.MeshStandardMaterial({ color: 0x8d857a, roughness: 1, metalness: 0 }),
);

export function featurePadMaterials() {
  return { top: padTopMaterial, stone: padStoneMaterial };
}

// footprint 전체가 지형에 파묻히지 않도록 코너·변중점·내부 grid의 최고점을 사용한다.
export function computePadY(parcel, site) {
  const polygon = parcel.poly;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let maxHeight = site.heightAt(parcel.center.x, parcel.center.z);
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x);
    minZ = Math.min(minZ, a.z); maxZ = Math.max(maxZ, a.z);
    maxHeight = Math.max(maxHeight, site.heightAt(a.x, a.z));
    maxHeight = Math.max(maxHeight, site.heightAt((a.x + b.x) / 2, (a.z + b.z) / 2));
  }
  const divisions = 5;
  for (let i = 0; i <= divisions; i++) for (let j = 0; j <= divisions; j++) {
    const x = minX + (maxX - minX) * i / divisions;
    const z = minZ + (maxZ - minZ) * j / divisions;
    if (G.pointInPoly({ x, z }, polygon)) maxHeight = Math.max(maxHeight, site.heightAt(x, z));
  }
  return maxHeight + PAD_LIFT;
}

function makeBufferMesh(positions, indices, material, name) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function emitPad(polygon, padY, site, topPositions, topIndices, skirtPositions, skirtIndices) {
  const pad = G.offsetPoly(G.ensureCCW(polygon), PAD_MARGIN);
  const topBase = topPositions.length / 3;
  for (const corner of pad) topPositions.push(corner.x, padY, corner.z);
  for (let i = 1; i < pad.length - 1; i++) topIndices.push(topBase, topBase + i + 1, topBase + i);

  for (let i = 0; i < pad.length; i++) {
    const a = pad[i], b = pad[(i + 1) % pad.length];
    const segments = 4;
    for (let segment = 0; segment < segments; segment++) {
      const t0 = segment / segments, t1 = (segment + 1) / segments;
      const p0 = { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 };
      const p1 = { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 };
      const ground0 = site.heightAt(p0.x, p0.z), ground1 = site.heightAt(p1.x, p1.z);
      if (padY - ground0 < PAD_STEP_MIN && padY - ground1 < PAD_STEP_MIN) continue;
      const bottom0 = Math.min(ground0, padY) - PAD_SINK;
      const bottom1 = Math.min(ground1, padY) - PAD_SINK;
      const base = skirtPositions.length / 3;
      skirtPositions.push(
        p0.x, padY, p0.z,
        p0.x, bottom0, p0.z,
        p1.x, padY, p1.z,
        p1.x, bottom1, p1.z,
      );
      skirtIndices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }
  }
}

export function buildParcelPads(parcels, site) {
  const group = new THREE.Group();
  group.name = 'village-pads';
  const topPositions = [], topIndices = [], skirtPositions = [], skirtIndices = [];
  for (const parcel of parcels) {
    if (!parcel.poly) continue;
    emitPad(
      parcel.poly,
      parcel.baseY ?? computePadY(parcel, site),
      site,
      topPositions,
      topIndices,
      skirtPositions,
      skirtIndices,
    );
  }
  if (topIndices.length) group.add(makeBufferMesh(topPositions, topIndices, padTopMaterial, 'pad-top'));
  if (skirtIndices.length) group.add(makeBufferMesh(skirtPositions, skirtIndices, padStoneMaterial, 'pad-skirt'));
  return group;
}

// poly가 없는 절·궁 feature를 회전 사각 footprint의 석축 terrace에 앉힌다.
export function buildFeaturePad(site, centerX, centerZ, width, depth, rotationY = 0, heightCap = 3.2) {
  const halfWidth = width / 2, halfDepth = depth / 2;
  const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
  const polygon = [
    [-halfWidth, -halfDepth], [halfWidth, -halfDepth],
    [halfWidth, halfDepth], [-halfWidth, halfDepth],
  ].map(([x, z]) => ({
    x: centerX + x * cos + z * sin,
    z: centerZ - x * sin + z * cos,
  }));
  let padY = site.heightAt(centerX, centerZ);
  let minimum = padY;
  for (const corner of polygon) {
    const height = site.heightAt(corner.x, corner.z);
    padY = Math.max(padY, height);
    minimum = Math.min(minimum, height);
  }
  padY = Math.min(padY, minimum + heightCap) + PAD_LIFT;

  const group = new THREE.Group();
  group.name = 'feature-pad';
  const topPositions = [], topIndices = [], skirtPositions = [], skirtIndices = [];
  emitPad(polygon, padY, site, topPositions, topIndices, skirtPositions, skirtIndices);
  if (topIndices.length) group.add(makeBufferMesh(topPositions, topIndices, padTopMaterial, 'feat-pad-top'));
  if (skirtIndices.length) group.add(makeBufferMesh(skirtPositions, skirtIndices, padStoneMaterial, 'feat-pad-skirt'));
  return { group, padY };
}

function localRectPolygon(frame, minX, maxX, minZ, maxZ) {
  return [
    { x: maxX, z: maxZ }, { x: minX, z: maxZ },
    { x: minX, z: minZ }, { x: maxX, z: minZ },
  ].map((point) => parcelWorldPoint(frame, point));
}

function samplePolygonRange(site, frame, size, divisions = 4) {
  const half = size * 0.5;
  let min = Infinity, max = -Infinity;
  for (let row = 0; row <= divisions; row++) for (let column = 0; column <= divisions; column++) {
    const point = parcelWorldPoint(frame, {
      x: -half + size * column / divisions,
      z: -half + size * row / divisions,
    });
    const height = site.heightAt(point.x, point.z);
    min = Math.min(min, height);
    max = Math.max(max, height);
  }
  return { min, max, drop: max - min };
}

function polygonMaxHeight(site, polygon) {
  let maximum = -Infinity;
  for (const point of polygon) maximum = Math.max(maximum, site.heightAt(point.x, point.z));
  const center = G.polyCentroid(polygon);
  return Math.max(maximum, site.heightAt(center.x, center.z));
}

// A sloped temple site cannot use the generic capped single shelf: lowering it
// buries the rear hall, while raising it produces one enormous front wall. Keep
// the precinct at the real rotated-footprint maximum and, only when needed, cover
// the downhill face with narrow apron terraces. All tiers share two aggregate
// buffers, so terrain adaptation does not add draw calls.
export function buildTempleFeaturePad(site, temple) {
  const frame = {
    center: { x: temple.x, z: temple.z },
    frontDir: temple.frontDir || { x: 0, z: 1 },
  };
  const size = templeCompoundSize(temple);
  const upper = templeFootprint(temple);
  const relief = samplePolygonRange(site, frame, size);
  const reliefCap = temple.placement?.reliefCap
    || Math.min(8, Math.max(4, (site.Hmax || 68) * 0.08));
  // Above roughly one human storey, split the downhill face so even a compact
  // precinct reads as low retaining terraces rather than a single plinth.
  const terraceRiseCap = Math.min(2.4, reliefCap);
  const tierCount = Math.max(1, Math.min(3, Math.ceil(relief.drop / Math.max(1, terraceRiseCap))));
  const padY = Number.isFinite(temple.baseY) ? temple.baseY : relief.max + TEMPLE_PAD_LIFT;
  const surfaces = [{ polygon: upper, y: padY, role: 'court' }];

  const half = size * 0.5;
  const apronDepth = 5.2;
  const overlap = 0.9;
  for (let tier = 1; tier < tierCount; tier++) {
    const back = half - overlap + (tier - 1) * (apronDepth - overlap);
    const front = back + apronDepth;
    const halfWidth = half + 0.7 - tier * 0.35;
    const polygon = localRectPolygon(frame, -halfWidth, halfWidth, back, front);
    const desired = padY - relief.drop * tier / tierCount;
    const y = Math.max(desired, polygonMaxHeight(site, polygon) + PAD_LIFT);
    surfaces.push({ polygon, y, role: 'apron' });
  }

  const group = new THREE.Group();
  group.name = 'feature-pad';
  const topPositions = [], topIndices = [], skirtPositions = [], skirtIndices = [];
  for (const surface of surfaces) {
    emitPad(
      surface.polygon,
      surface.y,
      site,
      topPositions,
      topIndices,
      skirtPositions,
      skirtIndices,
    );
  }
  if (topIndices.length) group.add(makeBufferMesh(topPositions, topIndices, padTopMaterial, 'feat-pad-top'));
  if (skirtIndices.length) group.add(makeBufferMesh(skirtPositions, skirtIndices, padStoneMaterial, 'feat-pad-skirt'));
  group.userData.terraceCount = tierCount;
  return { group, padY, surfaces, relief, reliefCap, tierCount };
}
