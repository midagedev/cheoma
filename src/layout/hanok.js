import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../rng.js';
import { computeSkeleton } from './skeleton.js';
import { buildSkeletonRoof } from './roof-skeleton.js';

// 다각형 풋프린트(rect/ㄱ자/ㄷ자) 기와집 몸채: 기단 + 기둥 + 회벽 + straight-skeleton 곡면 지붕.
// 백골(무단청) 반가 톤. buildBuilding(궁·절·초가)과 별개로, 꺾인 평면 살림집을 만든다.
//
// buildHanok({ footprint, seed, mats, wallH, podiumH, roofOpts }) → THREE.Group
//   footprint: 기둥열 2D 다각형 [{x,z}], 원점 기준. (원점 정렬은 호출측 책임)
export function buildHanok({ footprint, seed = 1, mats, wallH = 2.7, podiumH = 0.5, roofOpts = {} } = {}) {
  const rng = makeRng(seed);
  const M = mats;
  const g = new THREE.Group();
  g.name = 'hanok';

  // 방향 판정용 CCW 보정
  const poly = footprint.map((p) => ({ x: p.x, z: p.z }));
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    area += a.x * b.z - b.x * a.z;
  }
  if (area < 0) poly.reverse();
  const n = poly.length;

  const shapeFrom = (pts) => {
    const s = new THREE.Shape();
    pts.forEach((p, i) => (i ? s.lineTo(p.x, -p.z) : s.moveTo(p.x, -p.z)));
    s.closePath();
    return s;
  };
  const extrudeY = (shape, depth) => {
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2); // (x, -z, d) → (x, d, z)
    return geo;
  };

  // ── 기단 (낮은 장대석, 풋프린트보다 살짝 넓게) ──
  const podPts = offsetPoly(poly, 0.7);
  const pod = new THREE.Mesh(extrudeY(shapeFrom(podPts), podiumH), M.stone);
  pod.receiveShadow = true; pod.castShadow = true;
  g.add(pod);
  // 기단 상부 어두운 면
  const cap = new THREE.Mesh(extrudeY(shapeFrom(offsetPoly(poly, 0.55)), 0.06), M.stoneDark);
  cap.position.y = podiumH; g.add(cap);

  // ── 회벽 (풋프린트 압출) ──
  const wallGeo = extrudeY(shapeFrom(poly), wallH - podiumH);
  const walls = new THREE.Mesh(wallGeo, M.plaster);
  walls.position.y = podiumH;
  walls.castShadow = walls.receiveShadow = true;
  g.add(walls);
  // 인방 띠(중방) + 하부 심벽 톤
  const midGeo = extrudeY(shapeFrom(offsetPoly(poly, 0.02)), 0.12);
  const mid = new THREE.Mesh(midGeo, M.woodDark);
  mid.position.y = podiumH + (wallH - podiumH) * 0.55;
  g.add(mid);

  // ── 기둥 (모서리 + 변 중간, 벽 앞면에 살짝 돌출) ──
  const colGeo = new THREE.CylinderGeometry(0.16, 0.17, wallH - podiumH, 12);
  colGeo.translate(0, (wallH - podiumH) / 2, 0);
  const colMat = M.wood;
  const placeCol = (x, z) => {
    const c = new THREE.Mesh(colGeo, colMat);
    c.position.set(x, podiumH, z); c.castShadow = true; g.add(c);
  };
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    placeCol(a.x, a.z);
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    const k = Math.max(1, Math.round(segLen / 2.5));
    for (let j = 1; j < k; j++) {
      placeCol(a.x + (b.x - a.x) * (j / k), a.z + (b.z - a.z) * (j / k));
    }
  }
  // 창방 (기둥머리 가로 부재) — 풋프린트 상단 테
  const beamGeo = extrudeY(shapeFrom(poly), 0.16);
  const beam = new THREE.Mesh(beamGeo, M.woodDark);
  beam.position.y = wallH - 0.16;
  g.add(beam);

  // ── 지붕 ──
  const eaveOverhang = roofOpts.eaveOverhang ?? 1.15;
  const roof = buildSkeletonRoof(poly, {
    eaveY: wallH, eaveOverhang, riseScale: 1.3, profileCurve: 0.45,
    cornerLift: 0.45, planCurve: 0.25, ridgeH: 0.42, mats: M, ...roofOpts,
  });
  g.add(roof);

  // ── 부엌 날개채 굴뚝 (연기 발원) ──
  addHanokChimney(g, poly, M, rng, eaveOverhang);

  g.userData = { skeleton: computeSkeleton(poly), footprint: poly };
  return g;
}

// ── 부엌 날개채 서측 독립 전돌 굴뚝 (반가) ──
// name='chimney' — smoke.js(setupSmoke)가 이 그룹의 월드 bbox 상단 중심을 밥짓는 연기 anchor 로 탐지한다.
//   그래서 몸통은 좌우 대칭으로 두어 anchor 가 처마선 밖에 오게 한다(연기가 지붕을 태우지 않게).
// 고증: 아궁이(부엌)→구들→굴뚝. 회흑 전돌 켜쌓기 몸통 + 코르벨 2단 코니스 + 작은 기와 갓지붕 +
//   연가(오지 토관) 3개. 반가 굴뚝은 아미산 궁 굴뚝과 달리 무문양 소박형(전돌 켜만).
//   처마선 밖(x = minX − eaveOverhang − 여유)에 독립식으로 세워 연기가 곧게 오른다.
// 드로우콜 억제: 재질별 지오메트리 병합 → 전돌(몸통+코니스) 1 · 기와(갓+연가) 1 · 돌 기초 1 = 3.
function addHanokChimney(g, poly, M, rng, eaveOverhang) {
  // 서측 벽(x≈minX) 정점들의 z 범위 → 남쪽(부엌 날개) 쪽으로 굴뚝을 앉힌다.
  let minX = Infinity;
  for (const p of poly) minX = Math.min(minX, p.x);
  let zWmin = Infinity, zWmax = -Infinity;
  for (const p of poly) if (Math.abs(p.x - minX) < 0.6) { zWmin = Math.min(zWmin, p.z); zWmax = Math.max(zWmax, p.z); }
  const cw = 0.46;                                       // 전돌 몸통 한 변
  const chimH = 2.85;                                    // 몸통 높이(처마 위로 실루엣이 서게)
  const cz0 = zWmin + (zWmax - zWmin) * 0.76;            // 날개 남측(부엌)
  const cx0 = minX - (eaveOverhang + 0.7) - cw / 2;      // 처마선 밖으로 이격(연기 anchor 여유)

  const chimney = new THREE.Group();
  chimney.name = 'chimney';
  chimney.position.set(cx0, 0, cz0);                     // 이하 지오메트리는 로컬 원점 기준

  // 1) 자연석 기초(독립식 자체 지대)
  const baseH = 0.26;
  const base = new THREE.Mesh(new THREE.BoxGeometry(cw + 0.28, baseH, cw + 0.28), M.stoneDark);
  base.position.y = baseH / 2;
  base.castShadow = base.receiveShadow = true;
  chimney.add(base);

  // 2) 전돌 몸통 + 코르벨 2단 코니스 → 병합(전돌 재질 1 드로우콜)
  const jm = M.jeondol.clone();
  jm.map = M.jeondol.map.clone();
  jm.map.repeat.set(2, Math.round(chimH / 0.34));        // 세로로 전돌 켜 반복
  jm.map.needsUpdate = true;
  const cTop = baseH + chimH;
  const jeon = [];
  const body = new THREE.BoxGeometry(cw, chimH, cw); body.translate(0, baseH + chimH / 2, 0); jeon.push(body);
  const cornLo = new THREE.BoxGeometry(cw + 0.09, 0.09, cw + 0.09); cornLo.translate(0, cTop - 0.02, 0); jeon.push(cornLo);
  const cornHi = new THREE.BoxGeometry(cw + 0.17, 0.11, cw + 0.17); cornHi.translate(0, cTop + 0.08, 0); jeon.push(cornHi);
  const brick = new THREE.Mesh(mergeGeometries(jeon, false), jm);
  brick.castShadow = brick.receiveShadow = true;
  chimney.add(brick);

  // 3) 기와 갓지붕(작은 사모) + 연가(오지 토관 3개) + 연가 갓 → 병합(기와 재질 1 드로우콜)
  const capY = cTop + 0.14;
  const tile = [];
  const cap = new THREE.ConeGeometry(cw * 1.0, 0.34, 4); cap.rotateY(Math.PI / 4); cap.translate(0, capY + 0.17, 0); tile.push(cap);
  const yBase = capY + 0.30;
  // 연가: 갓 위 오지 토관 3개(결정론 미세 변주). 뭉툭한 항아리형 + 간격 벌림 → 개별 실루엣.
  const spots = [{ dx: -0.13, dz: -0.05 }, { dx: 0.13, dz: -0.04 }, { dx: 0.0, dz: 0.14 }];
  for (const s of spots) {
    const h = 0.20 + rng() * 0.09;                       // 0.20~0.29 (뭉툭)
    const r = 0.080 + rng() * 0.018;                     // 0.080~0.098 (통통)
    const tube = new THREE.CylinderGeometry(r * 0.9, r, h, 10); tube.translate(s.dx, yBase + h / 2, s.dz); tile.push(tube);
    const dome = new THREE.SphereGeometry(r + 0.014, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2); dome.translate(s.dx, yBase + h, s.dz); tile.push(dome);
  }
  const cap3 = new THREE.Mesh(mergeGeometries(tile, false), M.tileRidge);
  cap3.castShadow = true;
  chimney.add(cap3);

  g.add(chimney);
}

// 다각형을 바깥으로 d 만큼 마이터 오프셋 (볼록/반사 모두)
function offsetPoly(poly, d) {
  const n = poly.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n], cur = poly[i], next = poly[(i + 1) % n];
    const e1 = norm({ x: cur.x - prev.x, z: cur.z - prev.z });
    const e2 = norm({ x: next.x - cur.x, z: next.z - cur.z });
    // 바깥 법선(우측, CCW 기준 외측) = (e.z, -e.x)
    const o1 = { x: e1.z, z: -e1.x }, o2 = { x: e2.z, z: -e2.x };
    const bis = norm({ x: o1.x + o2.x, z: o1.z + o2.z });
    const cosH = Math.max(0.4, bis.x * o1.x + bis.z * o1.z);
    out.push({ x: cur.x + bis.x * d / cosH, z: cur.z + bis.z * d / cosH });
  }
  return out;
}
const norm = (a) => { const l = Math.hypot(a.x, a.z) || 1; return { x: a.x / l, z: a.z / l }; };
