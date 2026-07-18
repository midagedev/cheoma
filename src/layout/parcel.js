import * as THREE from 'three';
import { PRESETS } from '../params.js';
import { buildBuilding } from '../builder/index.js';
import { makeMaterials } from '../builder/palette.js';
import { makeRng } from '../rng.js';
import { buildFence } from './fence.js';
import { buildGate } from './gate.js';
import { buildHanok } from './hanok.js';
import { buildCorridor } from './corridor.js';
import { attachOverlayLanterns } from './props.js';

// 담장으로 둘린 대지 + 남측 대문 + 마당 + 북측 중앙 몸채 + 행각/행랑.
// 좌표계: 남쪽 = +z(대문·진입), 북쪽 = -z(몸채·배산). 몸채는 +z(남)을 향해 앉는다.
//
// buildParcel({ seed, style, plotW, plotD, roofOpts, wallH, presetOverrides }) → THREE.Group
//   roofOpts·wallH 는 hanok 분기의 buildHanok 으로 전달 (히어로 필지 편집 반영용)
//   presetOverrides 는 비-hanok 분기(palace/temple/choga)의 PRESETS 병합 — 특수 건물 편집 반영용
//   style: 'palace' | 'temple' | 'choga' | 'hanok'(ㄱ자 반가 안채)
const STYLE_MAP = {
  palace: { preset: 'korea', gate: 'soseuldaemun', gateW: 6.6, plot: [34, 28], fenceH: 2.2, wings: true, wall: 'jeondol' },
  temple: { preset: 'temple', gate: 'soseuldaemun', gateW: 6.6, plot: [30, 30], fenceH: 2.2, wings: false, wall: 'toseok' },
  choga: { preset: 'choga', gate: 'saripmun', gateW: 1.8, plot: [13, 12], fenceH: 1.3, wall: 'stone' },
  hanok: { preset: 'hanok', gate: 'soseuldaemun', gateW: 5.2, plot: [24, 22], fenceH: 2.0, wings: true, wall: 'toseok' },
};

//   lanterns: 필지 등롱(대문·마당 걸이등롱, #83)을 루트 직속에 심을지. 기본 true(focus 오버레이·뷰어).
//     mergeStatic 병합 경로(populate 히어로·절·궁 코어)는 false 로 넘겨 PointLight 유실·bulb 오염을 막는다.
export function buildParcel({ seed = 20260716, style = 'palace', plotW, plotD, roofOpts, wallH = 2.7, presetOverrides, lanterns = true } = {}) {
  const cfg = STYLE_MAP[style] || STYLE_MAP.palace;
  const rng = makeRng(seed);
  const W = plotW || cfg.plot[0];
  const D = plotD || cfg.plot[1];
  const hw = W / 2, hd = D / 2;
  const mats = makeMaterials(cfg.preset === 'korea' ? 'palace' : cfg.preset);

  const root = new THREE.Group();
  root.name = `parcel-${style}`;

  // ── 마당 (밝은 흙) ──
  const yard = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshStandardMaterial({ color: 0xcabfa2, roughness: 1.0 }));
  yard.rotation.x = -Math.PI / 2;
  yard.position.y = 0.01;
  yard.receiveShadow = true;
  root.add(yard);

  // ── 담장 (폐곡선) + 남측 대문 개구부 ──
  // 코너: SW(-hw,+hd) → SE(+hw,+hd) → NE(+hw,-hd) → NW(-hw,-hd)
  const corners = [
    { x: -hw, z: hd }, { x: hw, z: hd }, { x: hw, z: -hd }, { x: -hw, z: -hd },
  ];
  const { group: fence, openings } = buildFence({
    points: corners, closed: true, height: cfg.fenceH, thickness: cfg.wall === 'stone' ? 0.5 : 0.46,
    seed, mats, wallStyle: cfg.wall, openings: [{ seg: 0, center: 0.5, width: cfg.gateW }],
  });
  root.add(fence);

  // ── 대문 ──
  const gateWidth = cfg.gate === 'soseuldaemun' ? 2.6 : 1.5;
  const gate = buildGate(cfg.gate, { mats, seed, width: gateWidth });
  const op = openings[0];
  if (op) { gate.position.copy(op.position); gate.rotation.y = op.rotationY; }
  root.add(gate);

  // ── 몸채 (북측 중앙, 남향) ──
  let building, frontZ, buildingZ;
  if (cfg.preset === 'hanok') {
    // ㄱ자 반가 안채: 앞채(동서 긴 채) + 좌측 날개(남북). 남향 개방.
    const fp = [
      { x: -5, z: -2.6 }, { x: 5, z: -2.6 }, { x: 5, z: 2.6 },
      { x: -1.4, z: 2.6 }, { x: -1.4, z: 8 }, { x: -5, z: 8 },
    ];
    const cz = fp.reduce((s, p) => s + p.z, 0) / fp.length;
    const centered = fp.map((p) => ({ x: p.x, z: p.z - cz }));
    building = buildHanok({ footprint: centered, seed, mats, wallH, roofOpts });
    const zExtent = Math.max(...centered.map((p) => p.z)) + 1.15; // 처마 포함 남단
    buildingZ = -hd + (Math.max(...centered.map((p) => p.z)) - Math.min(...centered.map((p) => p.z))) / 2 + 3.5;
    building.position.set(0, 0, buildingZ);
    frontZ = buildingZ + zExtent;
  } else {
    const P = presetOverrides ? { ...PRESETS[cfg.preset], ...presetOverrides } : PRESETS[cfg.preset];
    building = buildBuilding(P);
    const L = building.userData.layout;
    const halfDepth = L.zEave + P.podiumMarginS + 1.0;
    buildingZ = -hd + halfDepth + 1.5;
    building.position.set(0, 0, buildingZ);
    frontZ = buildingZ + L.zEave + 0.6;
  }
  root.add(building);

  // ── 행각 (동·서, 마당 감싸기) — 대지 넉넉한 궁·반가 ──
  if (cfg.wings && W > 20) {
    const wingZ0 = -hd + 3.0, wingZ1 = hd - cfg.gateW / 2 - 2.5;
    const wx = hw - 2.2;
    for (const sx of [1, -1]) {
      // 마당 안쪽을 바라보도록 innerSide 로 방향 결정 (동쪽 채는 -x 가 마당)
      const { group } = buildCorridor({
        points: [{ x: sx * wx, z: wingZ0 }, { x: sx * wx, z: wingZ1 }],
        closed: false, mats, seed: seed + (sx > 0 ? 1 : 2), depth: 2.4,
        colH: cfg.fenceH + 0.4, innerSide: sx > 0 ? -1 : 1,
      });
      root.add(group);
    }
  }

  // ── 디딤돌 길 (대문 → 몸채) ──
  const pathZ0 = hd - 1.2;
  const pathZ1 = frontZ;
  const steps = Math.max(3, Math.round((pathZ0 - pathZ1) / 1.4));
  for (let i = 0; i < steps; i++) {
    const z = pathZ0 - (pathZ0 - pathZ1) * (i / (steps - 1));
    const st = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.42, 0.12, 8),
      mats.stone);
    st.scale.set(1, 1, 1.2);
    st.position.set((rng() - 0.5) * 0.2, 0.06, z);
    st.receiveShadow = true; st.castShadow = true;
    root.add(st);
  }

  // ── 행랑 자리 마커 (행각 없는 넉넉한 대지: 절 등) ──
  if (!cfg.wings && W > 22) {
    const markMat = new THREE.MeshStandardMaterial({ color: 0x9a8f7c, roughness: 1.0 });
    for (const sx of [1, -1]) {
      const n = 2;
      for (let i = 0; i < n; i++) {
        const z = -hd * 0.1 + i * 4.5 + 2;
        const mk = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.35, 2.4), markMat);
        mk.position.set(sx * (hw - 3.2), 0.17, z);
        mk.receiveShadow = true; mk.castShadow = true;
        root.add(mk);
        // 초석 4개
        for (const cx of [-1.2, 1.2]) for (const cz of [-0.9, 0.9]) {
          const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.4, 10), mats.stone);
          base.position.set(sx * (hw - 3.2) + cx, 0.2, z + cz);
          base.castShadow = true;
          root.add(base);
        }
      }
    }
  }

  // ── 필지 등롱 (대문·마당 걸이등롱, #83) ──
  //   루트 직속에 bulb + PointLight → focus 링(env/motes.js setupLanternSway)이 직속 자식을 훑어
  //   흔들림 구동(dormant 였던 레이어 활성). 병합 경로는 lanterns:false 로 skip.
  if (lanterns) attachOverlayLanterns(root, { style, W, D, seed });

  root.userData = { style, W, D, mats };
  return root;
}
