// Vite SSR로만 불러오는 production 지붕 통합 probe.
// app의 단일 three 인스턴스로 실제 BufferGeometry를 만든 뒤 직렬화 가능한 좌표만 반환한다.
import * as THREE from 'three';
import { buildSkeletonRoof } from '../../src/layout/roof-skeleton.js';
import { computeSkeleton } from '../../src/layout/skeleton.js';
import { PRESETS, giwaFootprintPolygon } from '../../src/params.js';

const U_SEGMENTS = 14;
const V_SEGMENTS = 8;
const FACE_VERTEX_COUNT = (U_SEGMENTS + 1) * (V_SEGMENTS + 1);
const FACE_INDEX_COUNT = U_SEGMENTS * V_SEGMENTS * 6;

const subtract = (a, b) => ({ x: a.x - b.x, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.z * b.z;

function upperChains(footprint) {
  const skeleton = computeSkeleton(footprint);
  return skeleton.faces.flatMap((face) => {
    const edgeStart = skeleton.poly[face.edgeIndex];
    const edgeEnd = skeleton.poly[(face.edgeIndex + 1) % skeleton.poly.length];
    const edge = subtract(edgeEnd, edgeStart);
    const edgeLength = Math.hypot(edge.x, edge.z) || 1;
    const direction = { x: edge.x / edgeLength, z: edge.z / edgeLength };
    const upper = face.polygon
      .filter((point) => point.h > 1e-4)
      .map((point) => ({ ...point, t: dot(subtract(point, edgeStart), direction) }))
      .sort((a, b) => a.t - b.t);
    if (upper.length === 0) return [];
    return [upper.length === 1 ? [upper[0], upper[0]] : upper];
  });
}

function makeProbeMaterials() {
  const tileTex = new THREE.Texture();
  const material = () => new THREE.MeshStandardMaterial();
  return {
    tileTex,
    eaveBand: material(),
    tileRidge: material(),
    wood: material(),
    jeoksae: material(),
    wadang: material(),
    waguto: material(),
  };
}

function disposeRoof(roof, borrowed) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  roof.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of objectMaterials) {
      if (!material || borrowed.has(material)) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
}

export function inspectProductionRoofSeams() {
  const dimensions = {
    mainHalfW: [2.8, PRESETS.giwa.mainHalfW, 5.2],
    mainHalfD: [1.8, PRESETS.giwa.mainHalfD, 2.8],
    wingLen: [2.8, PRESETS.giwa.wingLen, 4.6],
    wingW: [1.8, PRESETS.giwa.wingW, 3.0],
    riseScale: [0.6, PRESETS.giwa.riseScale, 1.2],
  };
  const mats = makeProbeMaterials();
  const borrowed = new Set(Object.values(mats));
  const cases = [];
  const faces = [];
  const eaveY = 0.37;

  try {
    for (const mainHalfW of dimensions.mainHalfW) {
      for (const mainHalfD of dimensions.mainHalfD) {
        for (const wingLen of dimensions.wingLen) {
          for (const wingW of dimensions.wingW) {
            for (const riseScale of dimensions.riseScale) {
              const P = { ...PRESETS.giwa, mainHalfW, mainHalfD, wingLen, wingW, riseScale };
              const footprint = giwaFootprintPolygon(P);
              const chains = upperChains(footprint);
              const roof = buildSkeletonRoof(footprint, { eaveY, riseScale, mats });
              const surfaceMeshes = roof.children.filter((object) => (
                object.isMesh
                && object.geometry?.getAttribute('position')?.count === FACE_VERTEX_COUNT
                && object.geometry?.index?.count === FACE_INDEX_COUNT
              ));
              const label = `${mainHalfW}/${mainHalfD}/${wingLen}/${wingW}/${riseScale}`;
              cases.push({ label, expectedFaces: chains.length, actualFaces: surfaceMeshes.length });

              for (let faceIndex = 0; faceIndex < Math.min(chains.length, surfaceMeshes.length); faceIndex++) {
                const position = surfaceMeshes[faceIndex].geometry.getAttribute('position');
                const samples = [];
                for (let iu = 0; iu <= U_SEGMENTS; iu++) {
                  const vertex = iu * (V_SEGMENTS + 1) + V_SEGMENTS;
                  samples.push({
                    x: position.getX(vertex),
                    z: position.getZ(vertex),
                    h: (position.getY(vertex) - eaveY) / riseScale,
                  });
                }
                faces.push({ label, chain: chains[faceIndex], samples });
              }
              disposeRoof(roof, borrowed);
            }
          }
        }
      }
    }
  } finally {
    mats.tileTex.dispose();
    for (const value of Object.values(mats)) if (value?.isMaterial) value.dispose();
  }

  return {
    cases,
    faces,
    uVertices: U_SEGMENTS + 1,
    faceVertexCount: FACE_VERTEX_COUNT,
    faceIndexCount: FACE_INDEX_COUNT,
  };
}
