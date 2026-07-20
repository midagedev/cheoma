import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../rng.js';
import { injectCloudShadow } from '../builder/palette.js';
import { crunchForest, makeEcotoneField, GRANITE } from './forest-crunch.js';

// 한국 산 v2(#122·#121·#115) — 사용자 원지시 복원: "빽빽한 진짜 나무가 주인공".
//   #123 워커 오프로드: 배치 "수치 크런치"(그루/암괴 좌표·계절색)는 forest-crunch.js 로 분리해
//   워커(populate.worker.js)·메인이 공유하고, 이 파일은 그 버퍼로 InstancedMesh "조립"만 한다.
//   결과 룩·드로우콜·결정론은 불변(크런치는 수학만 이설, 조립 코드는 원본 그대로).
//
// 구성: 소나무 수관 InstancedMesh(1) + 활엽 수관 InstancedMesh(1) + 화강암 InstancedMesh(1) = 3 드로우콜.
//   전용 rng(plan.seed 파생, 공유 시퀀스 불침해 → determinism). 지형 규약 공유 warp + 격자 onMesh(#86).
//   #127 terrainR(TR) 클램프 로직(나무 반경 제한)은 크런치 모듈(makeTerrainSampler·target 식)에 그대로 보존.

// 하위호환 재-export(populate.js 가 forest.js 에서 import) — 크런치 모듈이 실소유.
export { makeEcotoneField, GRANITE };

// ───────────────────────── 초저폴리 나무 프로토(수관만) ─────────────────────────
function makeConiferProto() {
  const a = new THREE.ConeGeometry(1.55, 3.6, 6); a.translate(0, 1.8, 0);
  const b = new THREE.ConeGeometry(1.02, 2.5, 6); b.translate(0, 3.5, 0);
  const g = mergeGeometries([a, b], false);
  g.deleteAttribute('uv'); g.computeVertexNormals();
  return g;
}
function makeBroadleafProto() {
  const g = new THREE.IcosahedronGeometry(1.85, 0); g.scale(1.06, 0.92, 1.06); g.translate(0, 2.0, 0);
  g.deleteAttribute('uv'); g.computeVertexNormals();
  return g;
}
// #137 원경 LOD 캐노피 블롭 — 클러스터(여러 그루) 1인스턴스. 단위 크기(반경~1·높이~1.2, 밑면 y≈0)로
//   author 하고 크런치가 매트릭스 스케일(spread, blobH, spread)로 클러스터 footprint·매스에 맞춘다.
//   저폴리 이중 돔(40 삼각) → 정점수·인스턴스수 대폭↓, 살짝 lumpy 해 부감에서 캐노피 결로 읽힌다.
function makeCanopyBlobProto() {
  const a = new THREE.IcosahedronGeometry(1, 0); a.scale(1.15, 0.62, 1.15); a.translate(0, 0.58, 0);
  const b = new THREE.IcosahedronGeometry(0.72, 0); b.scale(1.2, 0.66, 1.2); b.translate(0.48, 0.9, -0.34);
  const g = mergeGeometries([a, b], false);
  g.deleteAttribute('uv'); g.computeVertexNormals();
  return g;
}

// ───────────────────────── 화강암 암릉·암괴 프로토(#121) ─────────────────────────
function makeCragProto(seed) {
  const rng = makeRng(seed);
  const parts = [];
  const n = 2 + ((rng() * 2) | 0);
  for (let k = 0; k < n; k++) {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const sx = rng.range(0.85, 1.25), sy = rng.range(0.8, 1.15), sz = rng.range(0.85, 1.25);
    g.scale(sx, sy, sz);
    const p = g.attributes.position;
    for (let v = 0; v < p.count; v++) {
      p.setXYZ(v, p.getX(v) * (0.9 + 0.2 * rng()), p.getY(v) * (0.9 + 0.2 * rng()), p.getZ(v) * (0.9 + 0.2 * rng()));
    }
    g.translate((rng() - 0.5) * 0.8, sy * 0.25, (rng() - 0.5) * 0.8);
    g.deleteAttribute('uv');
    parts.push(g);
  }
  const m = mergeGeometries(parts, false);
  m.computeBoundingBox(); m.translate(0, -m.boundingBox.min.y, 0);
  m.computeVertexNormals(); m.computeBoundingBox();
  return m;
}

// ───────────────────────── 조립(크런치 버퍼 → InstancedMesh) ─────────────────────────
// 나무: 소나무·활엽 InstancedMesh(공유 재질) + 계절색 setSeason. treeC = 크런치 산출(메인 또는 워커).
function assembleTrees(treeC, cloudU) {
  const group = new THREE.Group(); group.name = 'forest-trees';
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.94, metalness: 0, flatShading: true });
  injectCloudShadow(mat, cloudU);
  const insts = [];
  const build = (proto, matBuf, colBuf, name) => {
    const count = matBuf.length / 16;
    if (!count) return;
    const inst = new THREE.InstancedMesh(proto, mat, count);
    inst.instanceMatrix = new THREE.InstancedBufferAttribute(matBuf, 16);
    inst.instanceMatrix.needsUpdate = true;
    inst.instanceColor = new THREE.InstancedBufferAttribute(colBuf.summer.slice(), 3);
    inst.name = name; inst.castShadow = true; inst.receiveShadow = true; inst.frustumCulled = false;
    group.add(inst); insts.push({ inst, colBuf });
  };
  build(makeConiferProto(), treeC.pineMat, treeC.pineCol, 'forest-pine');
  build(makeBroadleafProto(), treeC.broadMat, treeC.broadCol, 'forest-broad');
  // #137 원경 LOD: nearR 밖 산나무 클러스터 블롭(단일 병합 FAR 메시 = 소나무·활엽 통합, +1 드로우콜).
  //   계절색은 클러스터 평균이 perInstance 4버퍼로 실려 setSeason 이 다른 메시들과 동일하게 스왑.
  if (treeC.farMat && treeC.farMat.length) build(makeCanopyBlobProto(), treeC.farMat, treeC.farCol, 'forest-far');
  const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
  const setSeason = (name) => {
    const se = SEASONS.includes(name) ? name : 'summer';
    for (const it of insts) {
      it.inst.instanceColor.array.set(it.colBuf[se]);
      it.inst.instanceColor.needsUpdate = true;
    }
  };
  return { group, setSeason, count: treeC.pineCount + treeC.broadCount, pineCount: treeC.pineCount, broadCount: treeC.broadCount, farCount: treeC.farCount || 0, ridgePine: treeC.ridgePine, triCount: treeC.triCount };
}
// 화강암: 단일 InstancedMesh(perInstance 색). rockC = 크런치 산출. proto 는 메인에서 결정론 생성.
function assembleGranite(rockC, cloudU, protoSeed) {
  if (!rockC || !rockC.count) return null;
  const proto = makeCragProto((protoSeed ^ 0x5a17c0) >>> 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, flatShading: true });
  injectCloudShadow(mat, cloudU);
  const inst = new THREE.InstancedMesh(proto, mat, rockC.count);
  inst.instanceMatrix = new THREE.InstancedBufferAttribute(rockC.mat, 16);
  inst.instanceMatrix.needsUpdate = true;
  inst.instanceColor = new THREE.InstancedBufferAttribute(rockC.col, 3);
  inst.instanceColor.needsUpdate = true;
  inst.name = 'forest-rocks';
  inst.castShadow = true; inst.receiveShadow = true; inst.frustumCulled = false;
  return { mesh: inst, anchors: rockC.anchors, count: rockC.count, ridgeCount: rockC.ridgeCount };
}

// ───────────────────────── 최상위 ─────────────────────────
// buildForest(plan, site, warp, mask, cloudU, clearDist, precomputed)
//   precomputed(#123): 워커가 계산한 { trees, rocks } 버퍼. 있으면 크런치 생략(메인 스레드 조립만).
//   없으면 메인에서 crunchForest 실행(?worker=0·동기 createVillage·shoot 도구 경로 — 결정론 동일).
export function buildForest(plan, site, warp, mask, cloudU, clearDist, precomputed) {
  const group = new THREE.Group(); group.name = 'village-forest';
  const seed = ((plan.seed || 0) ^ 0x0f03e5) >>> 0;

  const crunch = precomputed || crunchForest(plan, site, { warp, mask, clearDist });
  const trees = assembleTrees(crunch.trees, cloudU);
  if (trees) group.add(trees.group);
  // 화강암 proto 시드는 원본과 동일하게 granite 시드((forestSeed^0xb2))에서 파생해야 한다(byte-identical).
  const rocks = assembleGranite(crunch.rocks, cloudU, (seed ^ 0xb2) >>> 0);
  if (rocks) group.add(rocks.mesh);

  let drawCalls = 0;
  if (trees) drawCalls += trees.group.children.length;
  if (rocks) drawCalls++;

  const setSeason = (name) => { trees?.setSeason(name); };
  const setHaze = (_c) => { /* v2: 나무는 씬 fog 로 원경 페이드 */ };
  setSeason('summer');

  group.userData = {
    drawCalls,
    treeCount: trees ? trees.count : 0,
    pineCount: trees ? trees.pineCount : 0,
    broadCount: trees ? trees.broadCount : 0,
    farCount: trees ? trees.farCount : 0,
    treeTris: trees ? trees.triCount : 0,
    shellVertexCount: 0, shellFaceCount: 0,
    rockCount: rocks ? rocks.count : 0,
    ridgeRockCount: rocks ? rocks.ridgeCount : 0,
    rockAnchors: rocks ? rocks.anchors : [],
    setSeason, setHaze,
  };
  return {
    group, setSeason, setHaze, drawCalls,
    treeCount: trees ? trees.count : 0,
    treeTris: trees ? trees.triCount : 0,
    shellVertexCount: 0, shellFaceCount: 0,
    rockCount: rocks ? rocks.count : 0,
    ridgeRockCount: rocks ? rocks.ridgeCount : 0,
    rockAnchors: rocks ? rocks.anchors : [],
  };
}
