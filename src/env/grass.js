import * as THREE from 'three';
import { makeRng } from '../rng.js';
import { getWind } from './wind.js';

// focus 링 바람 풀(#90) — 줌인 한정 인스턴스드 풀. 부감엔 링 자체가 없으므로 grass 도 비존재.
//
//   const grass = setupGrass(parent, {
//     bounds: { W, D },           // 필지 로컬 치수(중심 0, +z=남 대문/−z=북 몸채)
//     matrix,                     // 필지 월드 강체행렬(로컬→월드). 회전 반영. 기본 identity
//     yard: { x, z, r },          // 로컬 마당(닭) 중심 — 비워둘 동선. 선택
//     style, gateW,               // 건물 발자국·대문 개구부 비움 휴리스틱
//     sun,                        // 역광 글로우용 DirectionalLight. 선택
//     seed, count,                // 결정론 시드 / 포기 수(기본 둘레 비례)
//     season,                     // 초기 계절(spring|summer|autumn|winter). 기본 summer
//   });
//   grass.setFade(0..1);   // focus 링 크로스페이드(animals/smoke/motes 규약). GPU 셰이더 배율(높이).
//   grass.setSeason(name); // 여름 초록 / 가을 금빛 / 겨울 마름 — 색 크로스페이드
//   grass.setTime(name);   // 시간대별 역광 글로우 세기·틴트(sunset/dawn 최대)
//   grass.update(dt);      // 매 프레임: 바람 판독→흔들림 uniform, 계절/글로우 보간
//   grass.dispose();       // 지오/재질 해제(container disposeSubtree 도 커버)
//
// 구현 방침:
//  - 단일 InstancedMesh(삼각 블레이드 포기 지오) → 드로우콜 +1. castShadow=false(그림자 패스 0).
//    수백 포기를 한 콜에. 부감 비존재(링 생성 시에만 존재).
//  - 흔들림: onBeforeCompile 버텍스 셰이더 — 블레이드 높이 가중(aBladeH) 굽힘 + 시간 uniform +
//    인스턴스별 위상 지터(instanceMatrix 위치 해시). wind.js getWind(t) 판독으로 연기·낙엽과
//    같은 방향·거스트 타이밍에 흔들린다(wind.js 무수정).
//  - 역광 글로우: 카메라→풀 방향이 태양 방향과 정렬될 때(역광) 끝단이 따뜻하게 발광(forward-scatter,
//    motes 게이트와 동일 원리) → 골든아워 머니샷.
//  - 계절 틴트: uGrassRoot/uGrassTip 두 색 uniform 을 크로스페이드. 겨울은 마른 짚색+짧게.
//  - 결정론: makeRng(seed) 만 사용(Math.random 금지) → shot 재현.
//  - onBeforeCompile 함정 준수: 커스텀 uniform 은 전부 스칼라/vec3(배열 동적 인덱싱 없음),
//    색 uniform 은 THREE.Color(.copy(Color)→NaN 회피), 고유 접두 이름(체이닝 충돌 없음 —
//    grass 재질은 이 파일 전용 신규 인스턴스라 seasons/weather 패치와 무관).

const TAU = Math.PI * 2;

// 계절별 풀색(뿌리/끝). 끝이 밝고 따뜻, 뿌리는 어둡고 채도 낮게 → 깊이감.
const SEASON_COL = {
  spring: { root: 0x3c5322, tip: 0x8fb84a, dry: 0.0, hMul: 1.0 },   // 신록
  summer: { root: 0x33501e, tip: 0x74992f, dry: 0.0, hMul: 1.0 },   // 짙은 여름 초록
  autumn: { root: 0x6b5a24, tip: 0xc7a24a, dry: 0.5, hMul: 0.92 },  // 금빛 마름
  winter: { root: 0x6a5c3f, tip: 0x9b8a63, dry: 0.85, hMul: 0.74 }, // 마른 짚·성김
};

// 시간대별 역광 글로우 세기·틴트. sunset/dawn 최대(골든아워), day 미약, night 극미·쿨.
const TIME_GLOW = {
  dawn:   { int: 1.5, warm: 0xffd9a0 },
  day:    { int: 0.5, warm: 0xeef0e4 },
  sunset: { int: 1.9, warm: 0xffca7a },
  night:  { int: 0.25, warm: 0xb9c6e0 },
};

const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// ── 삼각 블레이드 포기 지오메트리 ─────────────────────────────────────────────
// 한 포기 = 여러 블레이드(테이퍼 리본, 앞으로 살짝 굽음)를 방사로 모은 클러스터. 로컬 뿌리=원점,
// +y=위. aBladeH: 블레이드 높이 분율(0 뿌리→1 끝) — 셰이더 굽힘/색 그라디언트/글로우 가중.
// 인덱스드 → 인스턴싱 호환. 노멀은 위로 살짝 편향(잔디 매스가 하늘·태양을 부드럽게 받게).
function buildTuftGeometry(rng) {
  const BLADES = 6;
  const SEG = 3;                 // 높이 세그(부드러운 굽힘)
  const pos = [], nrm = [], bh = [], idx = [];
  let base = 0;

  const up = new THREE.Vector3(0, 1, 0);
  const _p = new THREE.Vector3(), _n = new THREE.Vector3();
  const rotY = new THREE.Matrix4(), trans = new THREE.Matrix4(), m = new THREE.Matrix4();

  for (let b = 0; b < BLADES; b++) {
    const az = rng() * TAU;                       // 방사 방향
    const off = 0.02 + rng() * 0.10;              // 포기 중심에서 벌어짐
    const cx = Math.cos(az) * off, cz = Math.sin(az) * off;
    const H = 0.40 + rng() * 0.34;                // 블레이드 높이(역광 림 위해 살짝 웃자람)
    const arc = (0.10 + rng() * 0.18);            // 앞으로 굽는 정도(로컬 +x)
    const baseW = 0.032 + rng() * 0.016;
    rotY.makeRotationY(az + (rng() - 0.5) * 0.8); // 블레이드 자체 yaw
    trans.makeTranslation(cx, 0, cz);
    m.multiplyMatrices(trans, rotY);

    // 각 세그 두 정점(폭 방향 ±). 로컬: 높이 y, 폭 z, 굽힘 x.
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      const y = H * t;
      const x = arc * t * t;                      // 2차 아크(끝일수록 앞으로)
      const w = baseW * (1 - 0.88 * t);           // 끝으로 테이퍼
      for (const sign of [-1, 1]) {
        _p.set(x, y, sign * w * 0.5).applyMatrix4(m);
        pos.push(_p.x, _p.y, _p.z);
        // 리본 면노멀 근사(굽힘 반영) — 위로 편향은 아래 일괄 처리.
        _n.set(-2 * arc * t, 1, 0).normalize().applyMatrix4(rotY);
        nrm.push(_n.x, _n.y, _n.z);
        bh.push(t);
      }
    }
    // 세그 사이 쿼드 두 삼각형
    for (let s = 0; s < SEG; s++) {
      const a = base + s * 2, c = base + s * 2 + 1, d = base + (s + 1) * 2, e = base + (s + 1) * 2 + 1;
      idx.push(a, c, d, c, e, d);
    }
    base += (SEG + 1) * 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('aBladeH', new THREE.Float32BufferAttribute(bh, 1));
  geo.setIndex(idx);
  // 노멀 위 편향: 잔디 매스가 개별 블레이드 각도 대신 하늘/태양을 부드럽게 받게(잔디밭 느낌).
  const na = geo.attributes.normal.array;
  for (let i = 0; i < na.length; i += 3) {
    _n.set(na[i], na[i + 1], na[i + 2]).lerp(up, 0.55).normalize();
    na[i] = _n.x; na[i + 1] = _n.y; na[i + 2] = _n.z;
  }
  geo.attributes.normal.needsUpdate = true;
  const trisPerTuft = BLADES * SEG * 2;
  return { geo, trisPerTuft };
}

// ── 배치: 담장 안쪽 둘레 밴드 + 마당 가장자리 + 필지 외곽 성긴 프린지 ──────────────
// 비움: 마당 중앙 동선(대문→몸채 디딤돌 길)·건물 발자국·대문 개구부·마당(닭) 중심.
function buildPlacements({ W, D, yard, style, gateW, seed, count }) {
  const rng = makeRng(seed);
  const hw = W / 2, hd = D / 2;
  const band = Math.min(2.4, Math.min(W, D) * 0.22);   // 담장 밑 밴드 폭
  const inMargin = 0.32;                                // 담장에서 살짝 안쪽부터

  // 건물 발자국 회피 박스(북쪽). buildParcel: 몸채는 −z(북) 중앙. 정확 footprint 대신 견고한
  // 휴리스틱 박스(스타일 무관 안전). 북벽 코너·측벽엔 풀 허용, 몸채 발자국만 비움.
  const bHalfW = W * 0.30;
  const bZtop = -hd;                 // 북벽
  const bZbot = -hd + D * (style === 'choga' ? 0.42 : 0.55);
  const inBuilding = (x, z) => Math.abs(x) < bHalfW && z > bZtop && z < bZbot;

  // 중앙 동선(대문→몸채 디딤돌 길): x≈0 회랑. 마당(몸채 남쪽)에서만.
  const pathHalf = 1.35;
  const onPath = (x, z) => Math.abs(x) < pathHalf && z > bZbot - 0.5;

  // 대문 개구부(남벽 +z): 진입 폭 비움.
  const gHalf = (gateW || 2.0) * 0.5 + 0.7;
  const inGateGap = (x, z) => z > hd - 1.2 && Math.abs(x) < gHalf;

  // 마당(닭) 중심: 동선 유지 위해 성기게 비움.
  const inYard = yard && Number.isFinite(yard.x)
    ? (x, z) => ((x - yard.x) ** 2 + (z - yard.z) ** 2) < (yard.r * 1.05) ** 2
    : () => false;

  const pts = [];
  const excluded = (x, z) => inBuilding(x, z) || onPath(x, z) || inGateGap(x, z) || inYard(x, z);

  // 1) 내부: 담장 근접 강한 편향(둘레 밴드·코너 밀집), 열린 중앙엔 성긴 몇 포기만.
  const maxAtt = count * 40;
  let att = 0;
  while (pts.length < count && att < maxAtt) {
    att++;
    const x = (rng() * 2 - 1) * (hw - inMargin);
    const z = (rng() * 2 - 1) * (hd - inMargin);
    if (excluded(x, z)) continue;
    const ed = Math.min(hw - Math.abs(x), hd - Math.abs(z));   // 최근접 벽까지
    // 벽에 붙을수록 밀. 밴드 안에서 부드럽게 감쇠, 밴드 밖 열린 중앙엔 성긴 몇 포기만.
    const w = ed <= band ? (1.0 - 0.45 * (ed / band)) : 0.06;
    if (rng() > w) continue;
    pts.push({ x, z, ext: false, yaw: rng() * TAU, s: 0.72 + rng() * 0.55, hVar: 0.82 + rng() * 0.4 });
  }

  // 2) 외곽 프린지("필지 주변"): 담장 바깥 밑동에 성긴 잡초. 대문 앞은 비움. 짧게·밀착.
  const extN = Math.round(count * 0.10);
  let extA = 0;
  const extMax = extN * 30;
  while (pts.filter((p) => p.ext).length < extN && extA < extMax) {
    extA++;
    const side = rng.int(0, 3);           // 0:S(+z) 1:N(-z) 2:E(+x) 3:W(-x)
    const out = 0.15 + rng() * 0.32;      // 담장 밑동 밀착
    let x, z;
    if (side === 0) { x = (rng() * 2 - 1) * (hw - 0.4); z = hd + out; if (Math.abs(x) < gHalf) continue; }
    else if (side === 1) { x = (rng() * 2 - 1) * (hw - 0.4); z = -hd - out; }
    else if (side === 2) { x = hw + out; z = (rng() * 2 - 1) * (hd - 0.4); }
    else { x = -hw - out; z = (rng() * 2 - 1) * (hd - 0.4); }
    pts.push({ x, z, ext: true, yaw: rng() * TAU, s: 0.5 + rng() * 0.35, hVar: 0.7 + rng() * 0.3 });
  }

  return pts;
}

export function setupGrass(parent, {
  bounds = { W: 20, D: 18 }, matrix = null, yard = null, style = 'hanok', gateW = 2.0,
  sun = null, seed = 4343, count, season = 'summer',
} = {}) {
  const W = bounds.W || 20, D = bounds.D || 18;
  const N = count || Math.max(160, Math.min(700, Math.round(2 * (W + D) * 7)));

  const geoRng = makeRng((seed ^ 0x9e3d) >>> 0);
  const { geo, trisPerTuft } = buildTuftGeometry(geoRng);
  const pts = buildPlacements({ W, D, yard, style, gateW, seed: (seed ^ 0x51ed) >>> 0, count: N });

  // ── 재질(MeshStandardMaterial 패치) ──
  const uGrassTime = { value: 0 };
  const uGrassWind = { value: new THREE.Vector2(0, 0) };
  const uGrassGust = { value: 0 };
  const uGrassFade = { value: 0 };                     // 크로스페이드(높이 배율)
  const uGrassRoot = { value: linCol(SEASON_COL[season] ? SEASON_COL[season].root : 0x33501e) };
  const uGrassTip = { value: linCol(SEASON_COL[season] ? SEASON_COL[season].tip : 0x74992f) };
  const uSunDir = { value: new THREE.Vector3(0, 1, 0) };
  const uGrassGlow = { value: 0.5 };
  const uGrassWarm = { value: linCol(0xffca7a) };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGrassTime = uGrassTime;
    shader.uniforms.uGrassWind = uGrassWind;
    shader.uniforms.uGrassGust = uGrassGust;
    shader.uniforms.uGrassFade = uGrassFade;
    shader.uniforms.uGrassRoot = uGrassRoot;
    shader.uniforms.uGrassTip = uGrassTip;
    shader.uniforms.uSunDir = uSunDir;
    shader.uniforms.uGrassGlow = uGrassGlow;
    shader.uniforms.uGrassWarm = uGrassWarm;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aBladeH;
        uniform float uGrassTime;
        uniform vec2  uGrassWind;
        uniform float uGrassGust;
        uniform float uGrassFade;
        uniform vec3  uGrassRoot;
        uniform vec3  uGrassTip;
        uniform vec3  uSunDir;
        uniform float uGrassGlow;
        varying vec3  vGrassTint;
        varying float vGrassGlowV;`)
      // 색 그라디언트(뿌리→끝) + 인스턴스별 편차. 크로스페이드는 uGrassFade(아래 높이 배율).
      .replace('#include <color_vertex>', `#include <color_vertex>
        #ifdef USE_INSTANCING
        vec3 gInst = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float gJit = fract(sin(dot(gInst, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        #else
        float gJit = 0.5;
        #endif
        vGrassTint = mix(uGrassRoot, uGrassTip, aBladeH) * (0.80 + 0.42 * gJit);`)
      // 높이 배율(크로스페이드 grow-in): 뿌리 고정, 끝이 자란다. 오브젝트 공간(로컬 +y=수직).
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed.y *= uGrassFade;`)
      // instanceMatrix 적용 후 월드 방향 바람 굽힘 + 역광 글로우 산출.
      .replace('#include <project_vertex>', `
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_BATCHING
          mvPosition = batchingMatrix * mvPosition;
        #endif
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          vec3 gip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float gph = fract(sin(dot(gip, vec3(12.9898, 78.233, 37.719))) * 43758.5453) * 6.2831853;
          float gbw = aBladeH * aBladeH;                                  // 끝일수록 크게 굽음
          float gsw = 0.66 * sin(uGrassTime * 1.6 + gph) + 0.34 * sin(uGrassTime * 3.3 + gph * 1.7);
          float gamp = (0.55 + 0.95 * uGrassGust) * (0.55 + 0.85 * gsw);
          mvPosition.x += uGrassWind.x * gbw * gamp;
          mvPosition.z += uGrassWind.y * gbw * gamp;
        #endif
        vec4 gWorld = modelMatrix * mvPosition;
        vec3 gView = normalize(gWorld.xyz - cameraPosition);
        float gFwd = max(dot(gView, normalize(uSunDir)), 0.0);
        vGrassGlowV = pow(gFwd, 3.0) * (0.15 + 0.85 * aBladeH) * uGrassGlow;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uGrassWarm;
        varying vec3 vGrassTint;
        varying float vGrassGlowV;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= vGrassTint;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += uGrassWarm * vGrassGlowV;`);
  };

  const mesh = new THREE.InstancedMesh(geo, mat, pts.length);
  mesh.name = 'focusGrass';
  mesh.castShadow = false;          // 그림자 패스 0(드로우콜 +1 유지) + 얇은 블레이드 자기그림자 노이즈 회피
  mesh.receiveShadow = true;        // 담장·몸채 그림자를 받아 지면에 안착(추가 드로우콜 없음)
  mesh.frustumCulled = false;

  // 인스턴스 행렬: 로컬 TRS(yaw+scale+pos) → 필지 월드행렬 곱(회전 반영). y=0=지면.
  const parcelM = matrix ? matrix.clone() : new THREE.Matrix4();
  const _lm = new THREE.Matrix4(), _wm = new THREE.Matrix4();
  const _q = new THREE.Quaternion(), _pos = new THREE.Vector3(), _scl = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const hMul = SEASON_COL[season] ? SEASON_COL[season].hMul : 1.0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    _q.setFromAxisAngle(_up, p.yaw);
    _pos.set(p.x, 0, p.z);
    _scl.set(p.s, p.s * p.hVar * hMul, p.s);
    _lm.compose(_pos, _q, _scl);
    _wm.multiplyMatrices(parcelM, _lm);
    mesh.setMatrixAt(i, _wm);
  }
  mesh.instanceMatrix.needsUpdate = true;

  parent.add(mesh);

  // ── 시간대·계절 상태(크로스페이드) ──
  let t = 0;
  const rootCur = uGrassRoot.value, tipCur = uGrassTip.value;
  const rootTgt = rootCur.clone(), tipTgt = tipCur.clone();
  let glowCur = uGrassGlow.value, glowTgt = glowCur;
  const warmTgt = uGrassWarm.value.clone();
  const _sunDir = new THREE.Vector3();
  const SEASON_RATE = 2.4, TIME_RATE = 2.2;

  function setSeason(name, opts = {}) {
    const s = SEASON_COL[name] || SEASON_COL.summer;
    rootTgt.copy(linCol(s.root));
    tipTgt.copy(linCol(s.tip));
    if (opts.immediate) { rootCur.copy(rootTgt); tipCur.copy(tipTgt); }
    // hMul(겨울 성김·마름)은 인스턴스 스케일에 반영돼 rebuild 없이는 즉시 미반영 — 색만 크로스페이드.
  }
  function setTime(name, opts = {}) {
    const g = TIME_GLOW[name] || TIME_GLOW.day;
    glowTgt = g.int;
    warmTgt.copy(linCol(g.warm));
    if (opts.immediate) { glowCur = glowTgt; uGrassGlow.value = glowCur; uGrassWarm.value.copy(warmTgt); }
  }
  setSeason(season, { immediate: true });

  // 크로스페이드 배율(focus 링 규약). 0=지면에 잠김, 1=완전. GPU 셰이더 배율(CPU 비용 0).
  function setFade(v) { uGrassFade.value = Math.max(0, Math.min(1, v)); }

  function update(dt) {
    t += dt;
    // 바람: wind.js 판독(연기·낙엽과 동일 필드·거스트 타이밍). 흔들림 진폭 계수.
    const w = getWind(t);
    uGrassTime.value = t;
    uGrassWind.value.set(w.dirX * w.speed * 0.55, w.dirZ * w.speed * 0.55);
    uGrassGust.value = w.gust;
    if (sun) { _sunDir.copy(sun.position).normalize(); uSunDir.value.copy(_sunDir); }
    // 계절 색·시간대 글로우 지수 접근(크로스페이드).
    const ks = Math.min(1, dt * SEASON_RATE), kt = Math.min(1, dt * TIME_RATE);
    rootCur.lerp(rootTgt, ks); tipCur.lerp(tipTgt, ks);
    glowCur += (glowTgt - glowCur) * kt; uGrassGlow.value = glowCur;
    uGrassWarm.value.lerp(warmTgt, kt);
  }

  function dispose() {
    parent.remove(mesh);
    geo.dispose();
    mat.dispose();
  }

  return {
    mesh, setFade, setSeason, setTime, update, dispose,
    drawInfo: { instances: pts.length, triangles: pts.length * trisPerTuft },
  };
}
