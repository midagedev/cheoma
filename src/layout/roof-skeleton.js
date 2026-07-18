import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { tileSurfaceMaterial } from '../builder/palette.js';
import { computeSkeleton } from './skeleton.js';

// 다각형 풋프린트 + straight skeleton → 곡면 기와지붕.
// rect / ㄱ자(L) / ㄷ자(U) 지원. skeleton 의 ridge/valley/hip 라인을 마루로 얹고,
// 각 face 를 처마(밑변)→마루로 로프트한 곡면으로 세운다.
//   - 물매(profileCurve): 처마로 갈수록 완만해지는 오목 프로파일
//   - 앙곡(cornerLift): 볼록 코너(추녀)에서 처마 끝이 위로 들림
//   - 안허리곡(planCurve): 볼록 코너에서 처마가 밖으로 더 내밈
//
// footprint: 기둥열(벽선) 2D 다각형 [{x,z}...]. 처마는 eaveOverhang 만큼 밖으로.
// opts: { eaveY, eaveOverhang, riseScale, profileCurve, cornerLift, planCurve,
//         ridgeH, mats, tileBump }
// 반환: THREE.Group (원점 = footprint 좌표계, y=eaveY 가 처마).
export function buildSkeletonRoof(footprint, opts = {}) {
  const {
    eaveY = 0, eaveOverhang = 1.4, riseScale = 0.8,
    profileCurve = 0.5, cornerLift = 0.5, planCurve = 0.35,
    ridgeH = 0.4, mats, tileBump = 0.6,
    // 기와집 격상 옵션(기본 off → 정자·기타 스켈레톤 지붕은 영향 없음).
    // sugiwaRolls: 수키와 볼록 롤 3D 지오메트리, rafters: 처마 밑 연목·부연,
    // junctionCaps: ㄱ/ㄷ자 마루 접합부 solid 회첨 캡.
    sugiwaRolls = false, rafters = false, junctionCaps = false,
  } = opts;
  const M = mats;
  const g = new THREE.Group();
  g.name = 'skeleton-roof';

  const sk = computeSkeleton(footprint);
  const poly = sk.poly;
  const n = poly.length;
  const edges = sk.edges;

  const yOf = (h) => eaveY + h * riseScale;

  // ── 처마 다각형(마이터 오프셋) + 코너별 앙곡·안허리곡 ──
  // eaveVertex[i] = poly[i] + (outward_prev + outward_cur) * overhang (+ 볼록 코너 안허리곡)
  const eaveV = [];
  const eaveLift = [];
  for (let i = 0; i < n; i++) {
    const oPrev = neg(edges[(i - 1 + n) % n].normal); // 바깥 법선
    const oCur = neg(edges[i].normal);
    const convex = edges[i].startConvex;
    const bis = norm(add(oPrev, oCur));
    const extra = convex ? planCurve : 0;
    const off = add(scl(add(oPrev, oCur), eaveOverhang), scl(bis, extra));
    eaveV.push({ x: poly[i].x + off.x, z: poly[i].z + off.z });
    eaveLift.push(convex ? cornerLift : 0);
  }

  const NU = 14, NV = 8;
  const fprofile = (v) => Math.pow(v, 1 + profileCurve);      // 높이 분율(오목)
  const smooth = (t) => t * t * (3 - 2 * t);

  // 기와집 격상 어휘 누적기(옵션 켜졌을 때만 채워진다).
  const rollGeoms = [];                 // 수키와 볼록 롤(면별 튜브 → 병합)
  const rafterRound = [], rafterSquare = []; // 연목(원)·부연(각) InstancedMesh 대상
  const capTips = [];                   // 연목 끝 원형 마구리 위치

  // ── face 별 곡면 ──
  for (const face of sk.faces) {
    if (face.polygon.length < 3) continue;
    const ei = face.edgeIndex;
    const A = poly[ei], B = poly[(ei + 1) % n];
    const Ae = eaveV[ei], Be = eaveV[(ei + 1) % n];
    const liftA = eaveLift[ei], liftB = eaveLift[(ei + 1) % n];

    // 상단 체인: h>0 정점을 A→B 방향으로 정렬
    const dir = norm(sub(B, A));
    const upper = face.polygon.filter((p) => p.h > 1e-4)
      .map((p) => ({ ...p, t: dot(sub(p, A), dir) }))
      .sort((a, b) => a.t - b.t);
    if (upper.length === 0) continue;
    // 체인 양 끝을 처마 파라미터에 맞춰 확장(삼각 face 는 정점 1개 → 양쪽 동일)
    const chain = upper.length === 1 ? [upper[0], upper[0]] : upper;

    // 처마선 리샘플(직선 Ae→Be), 상단 체인 리샘플(호길이)
    const eavePts = resampleLine(Ae, Be, NU);
    const eaveLifts = resampleScalarEnds(liftA, liftB, NU);
    const upPts = resampleChain(chain, NU);

    const pos = [], uv = [], idx = [];
    const width = dist(Ae, Be);
    let slopeLen = 0;
    for (let iu = 0; iu <= NU; iu++) {
      const e = eavePts[iu], u = upPts[iu];
      const eY = eaveY + eaveLifts[iu];
      const uY = yOf(u.h);
      slopeLen = Math.max(slopeLen, Math.hypot(dist(e, u), uY - eY));
      for (let iv = 0; iv <= NV; iv++) {
        const v = iv / NV;
        // 평면 위치: 처마→마루 선형, 단 앙곡/안허리곡은 낮은 v 에서만 살아있게 감쇠
        const px = e.x + (u.x - e.x) * v;
        const pz = e.z + (u.z - e.z) * v;
        const py = eY + (uY - eY) * fprofile(v);
        pos.push(px, py, pz);
        uv.push((iu / NU) * (width / 0.34), (1 - v) * (slopeLen / 0.9));
      }
    }
    for (let iu = 0; iu < NU; iu++) for (let iv = 0; iv < NV; iv++) {
      const a = iu * (NV + 1) + iv, b = a + 1, c = a + (NV + 1), d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = tileSurfaceMaterial(M, Math.max(2, width), Math.max(1.5, slopeLen), tileBump);
    mat.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    g.add(mesh);

    // 처마 단면 띠(연함·기와 마구리 두께)
    const bandPos = [], bandIdx = [];
    for (let iu = 0; iu <= NU; iu++) {
      const e = eavePts[iu]; const eY = eaveY + eaveLifts[iu];
      // 처마 끝을 상단 반대 방향으로 약간 더(안허리곡 살린 실제 처마 끝)
      bandPos.push(e.x, eY + 0.03, e.z, e.x, eY - 0.12, e.z);
    }
    for (let iu = 0; iu < NU; iu++) {
      const a = iu * 2, b = a + 1, c = a + 2, d = a + 3;
      bandIdx.push(a, b, c, c, b, d);
    }
    const bgeo = new THREE.BufferGeometry();
    bgeo.setAttribute('position', new THREE.Float32BufferAttribute(bandPos, 3));
    bgeo.setIndex(bandIdx);
    bgeo.computeVertexNormals();
    const band = new THREE.Mesh(bgeo, M.eaveBand.clone());
    band.material.side = THREE.DoubleSide;
    band.castShadow = true;
    g.add(band);

    // ── 기와집 격상: 이 face 곡면 위의 수키와 롤 + 처마 밑 서까래 ──
    if (sugiwaRolls || rafters) {
      // 곡면 점 P(s,v): 표면 그리드와 동일 공식(s=폭 0..1, v=처마0..마루1).
      const pointAt = (s, v) => {
        const ex = Ae.x + (Be.x - Ae.x) * s;
        const ez = Ae.z + (Be.z - Ae.z) * s;
        const ends = Math.pow(Math.abs(2 * s - 1), 4.5);
        const eY = eaveY + (s < 0.5 ? liftA : liftB) * ends;
        const U = interpArr(upPts, s);
        const uY = yOf(U.h);
        return new THREE.Vector3(
          ex + (U.x - ex) * v,
          eY + (uY - eY) * fprofile(v),
          ez + (U.z - ez) * v);
      };
      // 곡면 바깥 법선(위로 향하게).
      const normalAt = (s, v) => {
        const eps = 0.02;
        const dv = pointAt(s, Math.min(1, v + eps)).sub(pointAt(s, Math.max(0.001, v - eps)));
        const ds = pointAt(Math.min(1, s + eps), v).sub(pointAt(Math.max(0, s - eps), v));
        const nrm3 = new THREE.Vector3().crossVectors(dv, ds).normalize();
        if (nrm3.y < 0) nrm3.negate();
        return nrm3;
      };

      if (sugiwaRolls) {
        const nRolls = Math.max(2, Math.round(width / 0.30));
        const rollR = 0.052, KV = 9;
        for (let j = 0; j < nRolls; j++) {
          const s = (j + 0.5) / nRolls;
          const pts = [];
          for (let iv = 0; iv <= KV; iv++) {
            const v = 0.02 + (1 - 0.02) * (iv / KV); // 처마 살짝 안쪽→마루
            pts.push(pointAt(s, v).addScaledVector(normalAt(s, v), rollR * 0.72));
          }
          // 처마 끝: v=0.02 접선 방향으로 처마 밖으로 살짝 내밀어 둥근 마구리 확보
          const p0 = pointAt(s, 0.02), p1 = pointAt(s, 0.09);
          const tipDir = p0.clone().sub(p1).normalize();
          const n0 = normalAt(s, 0.02);
          const tip = p0.clone().addScaledVector(tipDir, 0.12).addScaledVector(n0, rollR * 0.72);
          pts.unshift(tip);
          const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), KV + 2, rollR, 6, false);
          rollGeoms.push(tube);
          capTips.push({ p: tip, dir: tipDir, n: n0 });
        }
      }

      if (rafters) {
        // 연목(아래 열)·부연(위 열): 처마 밑에서 밖으로 방사. 코너 근처는 선자연이 덮음.
        const nR = Math.max(6, Math.round(width / 0.42));
        for (let j = 0; j <= nR; j++) {
          const s = j / nR;
          if (Math.abs(2 * s - 1) > 0.88) continue;
          // 연목: 처마 안쪽(v≈0.32) 밑 → 처마 밖으로 내민 끝
          const inner = pointAt(s, 0.32); inner.y -= 0.20;
          const edge = pointAt(s, 0.02);
          const dir = edge.clone().sub(pointAt(s, 0.12)).normalize();
          const tip = edge.clone().addScaledVector(dir, 0.14); tip.y -= 0.14;
          inner.y -= 0.02;
          rafterRound.push({ from: inner, to: tip });
          // 부연(위 열, 겹처마): 연목보다 얕게·바깥으로 더
          const bi = pointAt(s, 0.16); bi.y -= 0.10;
          const bt = edge.clone().addScaledVector(dir, 0.30); bt.y -= 0.055;
          rafterSquare.push({ from: bi, to: bt });
        }
      }
    }
  }

  // ── 기와집 격상: 수키와 롤 병합 + 처마 밑 서까래 인스턴싱 ──
  if (rollGeoms.length) {
    const merged = mergeGeometries(rollGeoms, false);
    rollGeoms.forEach((geo) => geo.dispose());
    const rollMat = M.tileConvex.clone();
    const rolls = new THREE.Mesh(merged, rollMat);
    rolls.castShadow = true; rolls.receiveShadow = false;
    rolls.name = 'sugiwa-rolls';
    g.add(rolls);
    // 수키와 롤 끝 둥근 마구리(처마 끝 원형 단면)
    if (capTips.length) {
      const capGeo = new THREE.SphereGeometry(0.052, 8, 6);
      const caps = new THREE.InstancedMesh(capGeo, rollMat, capTips.length);
      const m4 = new THREE.Matrix4();
      capTips.forEach((c, i) => { m4.makeTranslation(c.p.x, c.p.y, c.p.z); caps.setMatrixAt(i, m4); });
      caps.instanceMatrix.needsUpdate = true;
      caps.castShadow = true; caps.name = 'sugiwa-caps';
      g.add(caps);
    }
  }
  const placeRafters = (list, geo, mat) => {
    if (!list.length) return;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    const m4 = new THREE.Matrix4(), qt = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3();
    list.forEach((it, i) => {
      dir.copy(it.to).sub(it.from);
      const len = dir.length() || 1e-3;
      qt.setFromUnitVectors(up, dir.normalize());
      m4.compose(it.from, qt, new THREE.Vector3(1, len, 1));
      im.setMatrixAt(i, m4);
    });
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = true; im.receiveShadow = false;
    im.userData.asmGroup = 'rafters';   // 조립 애니: 서까래는 지붕 통덩어리 직전 청크(rafters 옵션=기와집 전용)
    g.add(im);
  };
  if (rafterRound.length || rafterSquare.length) {
    // 백골 목재 톤(반가): 처마 밑이 검게 후퇴하지 않도록 미량 emissive.
    const rmat = M.wood.clone(); rmat.emissive = new THREE.Color(0x241d12);
    const rGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 8); rGeo.translate(0, 0.5, 0);
    const bGeo = new THREE.BoxGeometry(0.075, 1, 0.075); bGeo.translate(0, 0.5, 0);
    placeRafters(rafterRound, rGeo, rmat);
    placeRafters(rafterSquare, bGeo, rmat);
  }

  // ── 마루(마루선) ──
  const tube = (a, b, r, mat) => {
    const va = new THREE.Vector3(a.x, a.y, a.z), vb = new THREE.Vector3(b.x, b.y, b.z);
    const len = va.distanceTo(vb);
    const geo = new THREE.CylinderGeometry(r, r, len, 8);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(va).lerp(vb, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
    mesh.castShadow = true;
    return mesh;
  };
  const p3 = (p, dy = 0) => ({ x: p.x, y: yOf(p.h) + dy, z: p.z });

  // 용마루: 각형 큰 마루
  for (const s of sk.ridges) {
    const a = p3(s.a, ridgeH * 0.5), b = p3(s.b, ridgeH * 0.5);
    // 각진 용마루(BoxGeometry 로 단면 두껍게)
    const va = new THREE.Vector3(a.x, a.y, a.z), vb = new THREE.Vector3(b.x, b.y, b.z);
    const len = va.distanceTo(vb);
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.34, ridgeH, len), M.tileRidge);
    box.position.copy(va).lerp(vb, 0.5);
    box.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), vb.clone().sub(va).normalize());
    box.castShadow = true;
    g.add(box);
  }
  // 오목 곡면을 따라 마루선을 휘게 하는 곡선 튜브
  const curvedTube = (top, botPlan, botY, r, dy) => {
    const pts = [];
    const K = 10;
    for (let i = 0; i <= K; i++) {
      const v = i / K; // 0=처마, 1=절점
      const x = botPlan.x + (top.x - botPlan.x) * v;
      const z = botPlan.z + (top.z - botPlan.z) * v;
      const y = botY + (yOf(top.h) - botY) * fprofile(v) + dy;
      pts.push(new THREE.Vector3(x, y, z));
    }
    const mesh = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), K, r, 8), M.tileRidge);
    mesh.castShadow = true;
    return mesh;
  };
  // 내림·추녀마루(hip): 절점 → 처마 코너(앙곡 반영)로 오목하게 내려감
  for (const s of sk.hips) {
    const hi = s.a.h >= s.b.h ? s.a : s.b;
    const lo = s.a.h >= s.b.h ? s.b : s.a;
    const ci = poly.findIndex((v) => Math.abs(v.x - lo.x) < 1e-3 && Math.abs(v.z - lo.z) < 1e-3);
    const botPlan = ci >= 0 ? eaveV[ci] : lo;
    const botY = eaveY + (ci >= 0 ? eaveLift[ci] : 0);
    g.add(curvedTube(hi, botPlan, botY, 0.1, 0.07));
  }
  // 회첨(valley): 반사 코너 → 절점, 곡면보다 살짝 낮게(골)
  for (const s of sk.valleys) {
    const hi = s.a.h >= s.b.h ? s.a : s.b;
    const lo = s.a.h >= s.b.h ? s.b : s.a;
    const ci = poly.findIndex((v) => Math.abs(v.x - lo.x) < 1e-3 && Math.abs(v.z - lo.z) < 1e-3);
    const botPlan = ci >= 0 ? poly[ci] : lo;
    g.add(curvedTube(hi, botPlan, eaveY + 0.05, 0.085, -0.04));
  }

  // ── ㄱ/ㄷ자 마루 접합부 solid 캡 ──
  // 두 용마루가 만나는 절점에서 상단이 열려 하늘이 비치던 삼각 공극을,
  // 마루 방향 사이(회첨이 열린 안쪽)를 채우는 solid 회첨 봉으로 봉합한다.
  if (junctionCaps) {
    const rkey = (p) => `${p.x.toFixed(3)},${p.z.toFixed(3)}`;
    const junc = new Map();
    for (const s of sk.ridges) for (const [p, o] of [[s.a, s.b], [s.b, s.a]]) {
      const k = rkey(p);
      if (!junc.has(k)) junc.set(k, { node: p, dirs: [] });
      junc.get(k).dirs.push(norm(sub(o, p)));
    }
    for (const info of junc.values()) {
      if (info.dirs.length < 2) continue; // 마루 교차 절점만
      const J = info.node;
      const surfY = yOf(J.h), topY = surfY + ridgeH * 0.5;
      // 열린 안쪽 방향(회첨 쪽) = 마루 방향들의 반대 합
      let ox = 0, oz = 0;
      for (const d of info.dirs) { ox -= d.x; oz -= d.z; }
      const od = norm({ x: ox, z: oz });
      const perp = { x: -od.z, z: od.x };
      // 상단 절점 봉우리 → 안쪽·아래로 벌어지는 삼각 솔리드(양면)로 공극 봉합
      const A = [J.x, topY + 0.04, J.z];
      const w = 0.34, fwd = 0.62;
      const B = [J.x + od.x * fwd + perp.x * w, surfY + 0.02, J.z + od.z * fwd + perp.z * w];
      const C = [J.x + od.x * fwd - perp.x * w, surfY + 0.02, J.z + od.z * fwd - perp.z * w];
      const D = [J.x + od.x * 0.18, surfY + ridgeH * 0.35, J.z + od.z * 0.18];
      const pos = [...A, ...B, ...C, ...D];
      // A(apex)-B-C 바닥 삼각 + D 로 지붕(A-D-B, A-C-D) → 닫힌 회첨 봉
      const idx = [0, 1, 2, 0, 3, 1, 0, 2, 3, 3, 2, 1];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx); geo.computeVertexNormals();
      const capMat = M.tileRidge.clone(); capMat.side = THREE.DoubleSide;
      const cap = new THREE.Mesh(geo, capMat);
      cap.castShadow = true; cap.name = 'junction-cap';
      g.add(cap);
      // 절점 위 둥근 회첨 보주(작은 눌린 돔)로 봉우리 마감
      const boss = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), M.tileRidge);
      boss.scale.set(1, 0.8, 1);
      boss.position.set(J.x, topY + 0.02, J.z);
      boss.castShadow = true;
      g.add(boss);
    }
  }

  g.userData = { skeleton: sk };
  return g;
}

// ── 벡터 유틸 ──
const sub = (a, b) => ({ x: a.x - b.x, z: a.z - b.z });
const add = (a, b) => ({ x: a.x + b.x, z: a.z + b.z });
const scl = (a, s) => ({ x: a.x * s, z: a.z * s });
const neg = (a) => ({ x: -a.x, z: -a.z });
const dot = (a, b) => a.x * b.x + a.z * b.z;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const norm = (a) => { const l = Math.hypot(a.x, a.z) || 1; return { x: a.x / l, z: a.z / l }; };

// 배열(리샘플된 상단 체인)에 분율 인덱스 s∈[0,1]로 선형 보간.
function interpArr(arr, s) {
  const n = arr.length - 1;
  const f = Math.max(0, Math.min(n, s * n));
  const i = Math.min(n - 1, Math.floor(f)), t = f - i;
  const a = arr[i], b = arr[i + 1];
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, h: a.h + (b.h - a.h) * t };
}
function resampleLine(A, B, N) {
  const out = [];
  for (let i = 0; i <= N; i++) { const t = i / N; out.push({ x: A.x + (B.x - A.x) * t, z: A.z + (B.z - A.z) * t }); }
  return out;
}
function resampleScalarEnds(a, b, N) {
  // 앙곡: 처마 끝(추녀) 근처에서만 들림. 끝 ~25% 구간에 집중(고power)해
  // 처마 전체가 출렁이지 않게 한다.
  const out = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const ends = Math.pow(Math.abs(2 * t - 1), 4.5); // 0(중앙)→1(끝), 끝에 급집중
    const side = t < 0.5 ? a : b;
    out.push(side * ends);
  }
  return out;
}
function resampleChain(chain, N) {
  // 폴리라인 호길이 균등 리샘플
  const segLen = [];
  let total = 0;
  for (let i = 0; i + 1 < chain.length; i++) { const l = dist(chain[i], chain[i + 1]); segLen.push(l); total += l; }
  if (total < 1e-6) { const out = []; for (let i = 0; i <= N; i++) out.push({ ...chain[0] }); return out; }
  const out = [];
  for (let i = 0; i <= N; i++) {
    let d = (i / N) * total, k = 0;
    while (k < segLen.length && d > segLen[k]) { d -= segLen[k]; k++; }
    if (k >= segLen.length) { out.push({ ...chain[chain.length - 1] }); continue; }
    const t = segLen[k] > 1e-9 ? d / segLen[k] : 0;
    const a = chain[k], b = chain[k + 1];
    out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, h: a.h + (b.h - a.h) * t });
  }
  return out;
}
