import * as THREE from 'three';
import { makeRng } from '../rng.js';
import { buildTileGableRoof } from './tileroof.js';

// 토석담(土石담): 하부 자연석 켜(어두운 흙+화강 막돌) + 상부 회벽(밝은 톤)
// + 위에 작은 기와 지붕담. 폴리라인을 따라 세우고 모서리를 기둥으로 잇는다.
// 문 개구부(openings)에서는 담이 끊기고, 그 자리 월드 변환을 반환해 문이 채운다.
//
// opts:
//   points   [{x,z}...] 폴리라인 (또는 폐곡선)
//   closed   폐곡선 여부
//   height   담 높이(기와 처마 기준, 기본 2.1)
//   thickness 담 두께(기본 0.46)
//   seed     시드
//   mats     builder/palette.makeMaterials 결과
//   openings [{seg, center(0..1), width}]  담이 끊기는 구간
// 반환: { group, openings:[{position:Vector3, rotationY, width, seg}] }
// wallStyle: 'toseok'(기본, 하부 자연석+상부 회벽+기와 지붕담),
//            'stone'(초가: 낮은 막돌담, 지붕 없음), 'jeondol'(궁·반가: 전돌 화방담+기와 코핑).
export function buildFence({ points, closed = false, height = 2.1, thickness = 0.46, seed = 1, mats, openings = [], wallStyle = 'toseok' }) {
  const rng = makeRng((seed | 0) ^ 0x9e37);
  const M = mats;
  const group = new THREE.Group();
  group.name = 'fence';

  const lowStone = wallStyle === 'stone'; // 초가 막돌담
  const jeondol = wallStyle === 'jeondol';
  const stoneH = lowStone ? height : Math.min(0.85, height * 0.42);
  const wallTop = height - 0.16;             // 회벽 상단(=지붕 처마)
  const earthMat = new THREE.MeshStandardMaterial({ color: lowStone ? 0x7d6a52 : 0x8f6f4e, roughness: 1.0 });
  const brickMat = new THREE.MeshStandardMaterial({ color: 0x8a6656, roughness: 0.95 }); // 전돌
  const graniteGeo = new THREE.DodecahedronGeometry(0.16, 0);

  const seg = (a, b) => {
    const d = { x: b.x - a.x, z: b.z - a.z };
    const L = Math.hypot(d.x, d.z);
    return { d, L, rotY: Math.atan2(-d.z, d.x), mid: { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 } };
  };

  // 담 몸체 한 스팬 (로컬: X=길이, Z=두께, Y=높이). 중앙 정렬.
  function wallSpan(len) {
    const g = new THREE.Group();
    // 하부 코어: 전돌담=벽돌, 그 외=흙 줄눈
    const core = new THREE.Mesh(new THREE.BoxGeometry(len, stoneH, thickness * 0.86),
      jeondol ? brickMat : earthMat);
    core.position.y = stoneH / 2;
    core.castShadow = core.receiveShadow = true;
    g.add(core);
    // 화강 막돌 (전돌담은 생략). 초가 막돌담은 위까지 촘촘히.
    if (!jeondol) {
      const rows = lowStone ? 3 : 2;
      const perFace = Math.max(6, Math.round(len / 0.34) * rows);
      for (const sign of [1, -1]) {
        const im = new THREE.InstancedMesh(graniteGeo, M.stone, perFace);
        const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
        for (let i = 0; i < perFace; i++) {
          const x = -len / 2 + len * rng();
          const y = 0.12 + (stoneH - 0.22) * rng();
          const sc = (lowStone ? 0.85 : 0.7) + rng() * 0.8;
          p.set(x, y, sign * (thickness * 0.43));
          q.setFromEuler(new THREE.Euler(rng() * 3, rng() * 3, rng() * 3));
          s.set(sc, sc * (0.7 + rng() * 0.4), sc * 0.7);
          m.compose(p, q, s);
          im.setMatrixAt(i, m);
        }
        im.instanceMatrix.needsUpdate = true;
        im.castShadow = im.receiveShadow = true;
        g.add(im);
      }
    }
    if (lowStone) return g; // 초가 막돌담: 회벽·지붕 없음

    // 상부: 전돌담=벽돌 화방, 그 외=회벽
    const upper = new THREE.Mesh(
      new THREE.BoxGeometry(len, wallTop - stoneH, thickness * 0.8), jeondol ? brickMat : M.plaster);
    upper.position.y = (stoneH + wallTop) / 2;
    upper.castShadow = upper.receiveShadow = true;
    g.add(upper);
    // 지붕담 (기와 맞배 코핑)
    const roof = buildTileGableRoof(M, {
      length: len, halfSpan: thickness / 2, eaveY: wallTop, ridgeY: height + 0.12,
      overhangX: 0.0, overhangZ: 0.12, curve: 0.4, dots: true, gableEnds: false, ridgeR: 0.08,
    });
    g.add(roof);
    return g;
  }

  function placeAlong(child, s, offset = 0) {
    child.position.set(s.mid.x, 0, s.mid.z);
    child.rotation.y = s.rotY;
    group.add(child);
  }

  // 스팬 생성 (개구부 제외)
  const verts = points.map((p) => ({ x: p.x, z: p.z }));
  const nSeg = closed ? verts.length : verts.length - 1;
  const openOut = [];
  for (let si = 0; si < nSeg; si++) {
    const a = verts[si], b = verts[(si + 1) % verts.length];
    const s = seg(a, b);
    // 이 세그먼트의 개구부들 → [start,end] 거리 구간 (points[si] 기준)
    const gaps = openings.filter((o) => o.seg === si)
      .map((o) => {
        const c = o.center * s.L;
        return { s: c - o.width / 2, e: c + o.width / 2, o };
      })
      .sort((p, q) => p.s - q.s);
    // 개구부 월드 변환 기록
    for (const gp of gaps) {
      const c = (gp.s + gp.e) / 2;
      openOut.push({
        position: new THREE.Vector3(a.x + s.d.x * (c / s.L), 0, a.z + s.d.z * (c / s.L)),
        rotationY: s.rotY, width: gp.o.width, seg: si,
      });
    }
    // 벽 스팬 = [0,L] 에서 gap 구간 제외
    let cursor = 0;
    const spans = [];
    for (const gp of gaps) {
      if (gp.s - cursor > 0.05) spans.push([cursor, gp.s]);
      cursor = Math.max(cursor, gp.e);
    }
    if (s.L - cursor > 0.05) spans.push([cursor, s.L]);
    for (const [d0, d1] of spans) {
      const len = d1 - d0;
      const cd = (d0 + d1) / 2;
      const child = wallSpan(len);
      child.position.set(a.x + s.d.x * (cd / s.L), 0, a.z + s.d.z * (cd / s.L));
      child.rotation.y = s.rotY;
      group.add(child);
    }
  }

  // 모서리·끝 기둥 (스팬 이음 + 각진 코너 마감). 초가 막돌담은 기둥 생략.
  if (!lowStone) verts.forEach((v) => {
    const post = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(thickness, stoneH, thickness),
      jeondol ? brickMat : earthMat);
    base.position.y = stoneH / 2; base.castShadow = true; post.add(base);
    const up = new THREE.Mesh(
      new THREE.BoxGeometry(thickness * 1.02, wallTop - stoneH, thickness * 1.02),
      jeondol ? brickMat : M.plaster);
    up.position.y = (stoneH + wallTop) / 2; up.castShadow = true; post.add(up);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(thickness * 0.85, 0.34, 4), M.tileRidge);
    cap.rotation.y = Math.PI / 4;
    cap.position.y = height + 0.05; cap.castShadow = true; post.add(cap);
    post.position.set(v.x, 0, v.z);
    group.add(post);
  });

  return { group, openings: openOut };
}
