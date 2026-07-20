// #85 검증(캡처 없음): choga 최대 적설 흰 돔 과다 — snowvol 볏짚 감쇠 수치 단언.
//   실제 빌더 수식(roof.js buildThatchRoof / roof-skeleton.js face / roof.js frontPoint)을 그대로
//   옮긴 합성 지붕면을 만들어 captureRoofSurfaces → buildShellGeometry 를 태우고, 셰이더 정점
//   변위(makeShellMaterial vertexShader, wind=0)를 JS로 재현해 bbox 높이 증분(정점 오프셋)을
//   실측한다. 렌더/스크린샷 없음 — 순수 계산. 실패 시 exit(1).
//
// 실행(esbuild 번들 → node; three/addons 해석 때문에 번들 필요):
//   SP=/private/tmp/.../scratchpad
//   \
//     npx --prefix app esbuild tools/verify-snowdome.mjs --bundle --format=esm \
//       --platform=node --outfile="$SP/_snowdome.mjs" && node "$SP/_snowdome.mjs"
import * as THREE from 'three';
import { captureRoofSurfaces } from '../src/env/roofcapture.js';
import {
  buildShellGeometry, domeCoherence, growFor,
} from '../src/env/snowvol.js';

const MAX_THICK = 0.52;   // snowvol.js 와 동일(accum=1). 값 바뀌면 여기도 갱신.
const THATCH_COHERENCE = 0.5;

// ── 합성 지붕면(실제 빌더 수식 복제) ────────────────────────────────────────
function meshFromGrid(pos, uv, idx) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const grp = new THREE.Group();
  grp.name = 'roof';
  grp.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
  return grp;
}

// 초가 볏짚 우진각 돔(roof.js buildThatchRoof 그리드 수식).
function chogaRoof({ W = 6, D = 5, ovh = 0.9, eaveY = 2.6, ridgeY = 4.4 } = {}) {
  const xEave = W / 2 + ovh, zEave = D / 2 + ovh;
  const rise = ridgeY - eaveY;
  const ridgeHalfX = Math.max(0.3, W / 2 - D / 2);
  const ne = 4.2, kHip = 2.6, profExp = 1.32, ridgeSag = 0.17;
  const rx = ridgeHalfX / xEave;
  const planXZ = (a, b) => {
    const m = Math.max(Math.abs(a), Math.abs(b));
    if (m < 1e-6) return [0, 0];
    const ux = Math.abs(a / m), uz = Math.abs(b / m);
    const r = 1 / Math.pow(Math.pow(ux, ne) + Math.pow(uz, ne), 1 / ne);
    return [a * r * xEave, b * r * zEave];
  };
  const descend = (a, b) => {
    const sa = Math.max(0, (Math.abs(a) - rx) / (1 - rx));
    return Math.min(1, Math.pow(Math.pow(Math.abs(b), kHip) + Math.pow(sa, kHip), 1 / kHip));
  };
  const heightAB = (a, b) => {
    const dd = descend(a, b);
    const along = Math.max(0, 1 - Math.pow(Math.abs(a) / Math.max(1e-3, rx), 2));
    return eaveY + rise * (1 - Math.pow(dd, profExp)) - ridgeSag * along * (1 - dd);
  };
  const slopeLen = Math.hypot(zEave, rise);
  const NA = 56, NB = 44;
  const pos = [], uv = [], idx = [];
  for (let ib = 0; ib <= NB; ib++) for (let ia = 0; ia <= NA; ia++) {
    const a = (ia / NA) * 2 - 1, b = (ib / NB) * 2 - 1;
    const [x, z] = planXZ(a, b);
    pos.push(x, heightAB(a, b), z);
    uv.push(x / 1.25, descend(a, b) * (slopeLen / 1.25));
  }
  for (let ib = 0; ib < NB; ib++) for (let ia = 0; ia < NA; ia++) {
    const q = ib * (NA + 1) + ia, w = q + 1, e = q + (NA + 1), r = e + 1;
    idx.push(q, e, w, w, e, r);
  }
  return meshFromGrid(pos, uv, idx);
}

// 기와집 팔작 지붕면 1장(roof-skeleton.js face 슬로프 평면 + 오목 물매).
function giwaRoof({ W = 6, run = 2.6, eaveY = 2.6, ridgeY = 4.4, profileCurve = 0.6 } = {}) {
  const NU = 14, NV = 8;
  const fprofile = (v) => Math.pow(v, 1 + profileCurve);
  const slopeLen = Math.hypot(run, ridgeY - eaveY);
  const pos = [], uv = [], idx = [];
  for (let iu = 0; iu <= NU; iu++) for (let iv = 0; iv <= NV; iv++) {
    const v = iv / NV;
    const x = (iu / NU - 0.5) * W;
    const pz = run * (1 - v);          // 처마(z=run) → 마루(z=0)
    const py = eaveY + (ridgeY - eaveY) * fprofile(v);
    pos.push(x, py, pz);
    uv.push((iu / NU) * (W / 0.34), (1 - v) * (slopeLen / 0.9));
  }
  for (let iu = 0; iu < NU; iu++) for (let iv = 0; iv < NV; iv++) {
    const a = iu * (NV + 1) + iv, b = a + 1, c = a + (NV + 1), d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  return meshFromGrid(pos, uv, idx);
}

// 궁·절 팔작 전면 곡면 1장(roof.js buildRoof frontPoint — 앙곡·안허리곡 코너 스윕 포함).
// roof.js 도 면(面)마다 별도 메시라 한 방위 → 코히런스 높음(돔 오분류 안 됨) 확인용.
function palaceFace({ W = 12, D = 8, ridgeY = 7, eaveY = 4.6 } = {}) {
  const NU = 48, NV = 22;
  const smooth = (t) => t * t * (3 - 2 * t);
  const xEave = W / 2 + 1.0, zEave = D / 2 + 1.0, xr = Math.max(0.5, W / 2 - D / 2);
  const q = 1.8, s0 = 1.4, s1 = 0.6, totalDrop = s1 + (s0 - s1) / (q + 1);
  const dropN = (v) => (s1 * v + ((s0 - s1) * (1 - Math.pow(1 - v, q + 1))) / (q + 1)) / totalDrop;
  const vStar = 0.34, cornerLift = 0.9, planCurve = 0.5, cornerEasePow = 1.7;
  const cornerEase = (t) => Math.pow(Math.abs(t), cornerEasePow);
  const frontPoint = (u, v) => {
    const e = cornerEase(u);
    const half = v <= vStar ? xr : xr + (xEave - xr) * smooth((v - vStar) / (1 - vStar));
    const planExtra = planCurve * e * Math.pow(v, 3);
    const x = u * (half + planExtra);
    const z = zEave * v + planExtra;
    const y = ridgeY - (ridgeY - eaveY) * dropN(v) + cornerLift * e * Math.pow(v, 2.0);
    return [x, y, z];
  };
  const pos = [], uv = [], idx = [];
  for (let iv = 0; iv <= NV; iv++) for (let iu = 0; iu <= NU; iu++) {
    const u = (iu / NU) * 2 - 1, v = iv / NV;
    const [x, y, z] = frontPoint(u, v);
    pos.push(x, y, z); uv.push((x + xEave) / (2 * xEave), 1 - v);
  }
  for (let iv = 0; iv < NV; iv++) for (let iu = 0; iu < NU; iu++) {
    const a = iv * (NU + 1) + iu, b = a + 1, c = a + (NU + 1), d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  return meshFromGrid(pos, uv, idx);
}

// ── 셰이더 정점 변위 재현(snowvol.js makeShellMaterial vertexShader, wind=0) ──
//   lift = uThick*grow*(0.85+0.30*gv);  transformed += aLift*lift + aOut*uThick*0.65*clamp(grow,0,1)
//   grow 는 aLift.y(=상향노멀 ny)로부터 growFor 로 재도출 → 정책(round)별 before/after 동시 산출.
function displacedBBox(geo, uThick, round) {
  const P = geo.attributes.position.array;
  const L = geo.attributes.aLift.array;
  const O = geo.attributes.aOut.array;
  const nv = geo.attributes.position.count;
  let maxY = -Infinity, minY = Infinity, maxX = -Infinity, minX = Infinity, maxZ = -Infinity, minZ = Infinity;
  for (let i = 0; i < nv; i++) {
    const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
    const ny = L[i * 3 + 1];
    const g = growFor(ny, round);
    const gv = 0.5 + 0.25 * Math.sin(px * 8.5) + 0.25 * Math.sin(pz * 8.5);
    const lift = uThick * g * (0.85 + 0.30 * gv);
    const oPush = uThick * 0.65 * Math.min(1, Math.max(0, g));
    const x = px + L[i * 3] * lift + O[i * 3] * oPush;
    const y = py + L[i * 3 + 1] * lift + O[i * 3 + 1] * oPush;
    const z = pz + L[i * 3 + 2] * lift + O[i * 3 + 2] * oPush;
    if (y > maxY) maxY = y; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (x < minX) minX = x;
    if (z > maxZ) maxZ = z; if (z < minZ) minZ = z;
  }
  return { topY: maxY, height: maxY - minY, width: Math.max(maxX - minX, maxZ - minZ) };
}
const topInc = (geo, round) => displacedBBox(geo, MAX_THICK, round).topY - displacedBBox(geo, 0, round).topY;
const widthInc = (geo, round) => displacedBBox(geo, MAX_THICK, round).width - displacedBBox(geo, 0, round).width;

// ── 실행 ────────────────────────────────────────────────────────────────────
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); return cond; };
const f = (x) => Number(x).toFixed(4);

const chogaSurf = captureRoofSurfaces(chogaRoof());
const giwaSurf = captureRoofSurfaces(giwaRoof());
const palaceSurf = captureRoofSurfaces(palaceFace());
ok(chogaSurf.length === 1, `choga 표면 캡처 1개 기대, 실제 ${chogaSurf.length}`);
ok(giwaSurf.length === 1, `giwa 표면 캡처 1개 기대, 실제 ${giwaSurf.length}`);
ok(palaceSurf.length === 1, `palace 표면 캡처 1개 기대, 실제 ${palaceSurf.length}`);

const chR = domeCoherence(chogaSurf[0]);
const giR = domeCoherence(giwaSurf[0]);
const paR = domeCoherence(palaceSurf[0]);
console.log('\n── ① 표면 판별(방위 코히런스, <0.5=둥근 돔) ──');
console.log(`  choga  coherence = ${f(chR)}  → ${chR < THATCH_COHERENCE ? '돔(감쇠)' : '평탄'}`);
console.log(`  giwa   coherence = ${f(giR)}  → ${giR < THATCH_COHERENCE ? '돔(감쇠)' : '평탄'}`);
console.log(`  palace coherence = ${f(paR)}  → ${paR < THATCH_COHERENCE ? '돔(감쇠)' : '평탄'}`);
ok(chR < THATCH_COHERENCE, `choga coherence(${f(chR)})가 임계 미만이어야(둥근 돔 판별)`);
ok(giR >= THATCH_COHERENCE, `giwa coherence(${f(giR)})가 임계 이상이어야(기와면 무회귀)`);
ok(paR >= THATCH_COHERENCE, `palace coherence(${f(paR)})가 임계 이상이어야(궁·절 면 오분류 없음)`);

const chogaGeo = buildShellGeometry(chogaSurf);
const giwaGeo = buildShellGeometry(giwaSurf);

// ── ② bbox 높이 증분(정점 오프셋) before/after ──
const giwaInc = topInc(giwaGeo, false);
const chBefore = topInc(chogaGeo, false);   // 감쇠 전(옛 거동)
const chAfter = topInc(chogaGeo, true);    // 감쇠 후(#85)
const ratioBefore = chBefore / giwaInc;
const ratioAfter = chAfter / giwaInc;
const chWBefore = widthInc(chogaGeo, false);
const chWAfter = widthInc(chogaGeo, true);

console.log('\n── ② 최대 적설 bbox 높이 증분(월드 m) ──');
console.log('  대상        높이증분   choga/giwa   폭증분');
console.log(`  giwa        ${f(giwaInc)}    1.000      ${f(widthInc(giwaGeo, false))}`);
console.log(`  choga 전    ${f(chBefore)}    ${f(ratioBefore)}      ${f(chWBefore)}   ← 흰 돔 과팽창`);
console.log(`  choga 후    ${f(chAfter)}    ${f(ratioAfter)}      ${f(chWAfter)}   ← #85 감쇠`);

ok(ratioBefore > 1.2, `근본원인 재현: 감쇠 전 choga/giwa(${f(ratioBefore)})가 1.2 초과여야(과팽창)`);
ok(ratioAfter < ratioBefore, `감쇠가 증분을 낮춰야(${f(ratioAfter)} < ${f(ratioBefore)})`);
ok(ratioAfter <= 1.0, `감쇠 후 choga가 giwa를 넘지 않아야(${f(ratioAfter)} ≤ 1.0)`);
ok(ratioAfter >= 0.45, `과감쇠 방지: 눈이 남아야(${f(ratioAfter)} ≥ 0.45)`);
ok(chWAfter < chWBefore, `폭 팽창(눈사람 머리)도 줄어야(${f(chWAfter)} < ${f(chWBefore)})`);

// ── ③ snow 0→1 램프 연속(불연속 점프 없음) ──
console.log('\n── ③ accum 0→1 램프 연속성(choga, 감쇠 후) ──');
const STEPS = 24;
let prevTop = displacedBBox(chogaGeo, 0, true).topY;
let mono = true, maxDelta = 0, minDelta = Infinity;
const base0 = prevTop;
for (let k = 1; k <= STEPS; k++) {
  const u = (k / STEPS) * MAX_THICK;
  const t = displacedBBox(chogaGeo, u, true).topY;
  const d = t - prevTop;
  if (d < -1e-9) mono = false;
  maxDelta = Math.max(maxDelta, d); minDelta = Math.min(minDelta, d);
  prevTop = t;
}
// 변위는 uThick 선형 → 스텝 delta 거의 일정. jitter(최대/최소 delta 비)로 불연속 점프 검출.
const jitter = maxDelta / Math.max(1e-9, minDelta);
console.log(`  단조증가=${mono}  step Δ [${f(minDelta)}..${f(maxDelta)}]  jitter=${f(jitter)}  총상승=${f(prevTop - base0)}`);
ok(mono, 'accum 램프가 단조증가여야(역행 없음)');
ok(jitter < 1.15, `램프 delta 균일(선형)이어야 — 불연속 점프 없음(jitter ${f(jitter)} < 1.15)`);

// ── ③′ giwa 무회귀: 베이크된 aGrow 가 옛 공식(round=false)과 바이트 동일 ──
console.log('\n── ③′ giwa 경로 무회귀(aGrow 불변) ──');
let giwaBakeOk = true, maxErr = 0;
{
  const G = giwaGeo.attributes.aGrow.array;
  const L = giwaGeo.attributes.aLift.array;
  for (let i = 0; i < G.length; i++) {
    const expect = growFor(L[i * 3 + 1], false);  // 옛 공식 == smooth01(ny)
    maxErr = Math.max(maxErr, Math.abs(G[i] - expect));
  }
  giwaBakeOk = maxErr < 1e-6;
}
console.log(`  giwa aGrow vs 옛 공식 최대오차 = ${maxErr.toExponential(2)}  (round=false 경로 불변)`);
ok(giwaBakeOk, `giwa aGrow 가 옛 공식과 동일해야(무회귀). 최대오차 ${maxErr}`);
// choga aGrow 가 감쇠 공식으로 정확히 베이크됐는지도 교차확인
{
  const G = chogaGeo.attributes.aGrow.array;
  const L = chogaGeo.attributes.aLift.array;
  let e = 0;
  for (let i = 0; i < G.length; i++) e = Math.max(e, Math.abs(G[i] - growFor(L[i * 3 + 1], true)));
  ok(e < 1e-6, `choga aGrow 가 감쇠 공식으로 베이크돼야. 최대오차 ${e}`);
  console.log(`  choga aGrow vs 감쇠 공식 최대오차 = ${e.toExponential(2)}  (round=true 베이크 확인)`);
}

// ── 결과 ──
console.log('\n' + '─'.repeat(48));
if (fails.length) {
  console.log(`FAIL — ${fails.length}건`);
  for (const m of fails) console.log('  ✗ ' + m);
  process.exit(1);
}
console.log('PASS — 모든 단언 통과, 0 에러');
