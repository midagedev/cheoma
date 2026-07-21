import * as THREE from 'three';
import { makeRng } from '../rng.js';
import { parcelRotY } from './instancing.js';

// 원경 창불 발광 포인트(태스크 #60) — 부감 야경의 마법.
//   문제: 창호 실내광(adapter vnight, 재질 emissive)은 원거리 부감에서 발광면이 픽셀 이하로
//   작아져 소실 → "원경에서 집 조명이 하나도 안 보임". 이 레이어는 집집이 창·처마 밑 등롱 자리에
//   additive 발광 포인트를 얹어, 원거리에서 또렷한 점광으로 읽히고(post bloom 이 헤일로) 근접하면
//   페이드 아웃(재질 창호 발광이 바통 터치)한다.
//
//   설계:
//   · 단일 THREE.Points(1 드로우콜) — 집당 1~2점, 종가·궁·절은 밝게 여러 점. 호수 무관.
//   · 점등 곡선: uNight(0..1) = adapter vnight 를 매 프레임 그대로 받음(#50 크로스페이드 자동 정합).
//     각 점은 aThreshold(집집이 다른 점등 문턱)를 uNight 이 넘어설 때 smoothstep 으로 서서히 켜짐
//     → 석양(vnight≈0.42) 절반, 밤(1.0) 대부분. 팟 없이 차오름.
//   · 분포 서사: per-parcel wealth 상관 — 부유·격식 높은 집은 일찍(낮은 문턱)·밝게, 가난한 집은
//     늦게·어둡게, 일부는 아예 불 꺼짐(빈집·잠듦). 결정론(parcel.seed) — 같은 시드 같은 점등.
//   · 거리 곡선: gl_PointSize 는 거리 감쇠하되 min/max 로 클램프(원거리에서도 읽히는 하한). 근접
//     밴드(uFadeNear..uFadeNearEnd)에서 투명도 0 으로 페이드 아웃 → 눈높이에선 점광 잔재 없음.
//
//   드로우콜: Points 1개. 결정론: Math.random 미사용(전부 parcel/plan seed).

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);

// 창불 팔레트(호롱·등잔) — night-glow WARM(0xffb35c) 계열. 촛불 주황 ↔ 등잔 노랑 사이 개체차.
const COLOR_CANDLE = new THREE.Color(0xff9a45);
const COLOR_LAMP = new THREE.Color(0xffcf88);

// 집 종류별 창불 높이(성토 패드 baseY 위) · 점 크기 배율.
function windowY(parcel) {
  if (parcel.hero) return 3.4;
  return parcel.kind === 'giwa' ? 2.5 : 1.9;
}

// 필지 로컬(lx,lz) → 월드 (parcelMatrix 규약 T·Ry: x'=lx·cos+lz·sin, z'=-lx·sin+lz·cos).
function localToWorld(parcel, lx, lz, cos, sin) {
  return {
    x: parcel.center.x + lx * cos + lz * sin,
    z: parcel.center.z - lx * sin + lz * cos,
  };
}

// 한 필지의 창불 점 목록 → [{x,y,z, lit, threshold, phase, warm, scale}]. 결정론(parcel.seed).
function parcelLights(parcel) {
  const rng = makeRng((parcel.seed ^ 0x9117e5) >>> 0);
  const wealth = clamp01(parcel.wealth != null ? parcel.wealth : 0.5);
  const rotY = parcelRotY(parcel);
  const cos = Math.cos(rotY), sin = Math.sin(rotY);
  const baseY = parcel.baseY || 0;
  const wy = windowY(parcel);
  const plotW = parcel.plotW || 6, plotD = parcel.plotD || 6;
  const out = [];

  if (parcel.hero) {
    // 종가·반가 대형: 여러 방(사랑채·안채) 창불이 환하게. 일찍 점등, 밝게.
    const spots = [[0, plotD * 0.08], [-plotW * 0.2, -plotD * 0.05], [plotW * 0.22, plotD * 0.02]];
    for (let i = 0; i < spots.length; i++) {
      const w = localToWorld(parcel, spots[i][0], spots[i][1], cos, sin);
      out.push({
        x: w.x, y: baseY + wy + (i === 0 ? 0 : 0.3 * (rng() - 0.5)), z: w.z,
        lit: 0.95 + rng() * 0.15, threshold: 0.10 + rng() * 0.06,
        phase: rng() * TAU, warm: 0.2 + rng() * 0.3, scale: 1.5,
      });
    }
    return out;
  }

  // 정규 주택: ~6% 는 불 꺼진 집(빈집·잠듦) → 균일 크리스마스트리 방지·현실감.
  if (rng() < 0.06) return out;

  // 점등 문턱: 부유할수록 일찍(낮은 문턱), 가난할수록 늦게. 개체 노이즈로 이웃 변별(팟 방지).
  const threshold = clamp(0.16 + (1 - wealth) * 0.4 + (rng() * 2 - 1) * 0.13, 0.06, 0.9);
  // 밝기: 부유할수록 환하게(더 많은 방·기름불), 가난할수록 은은.
  const lit = clamp01(0.5 + wealth * 0.5 + (rng() * 2 - 1) * 0.16);
  const warm = rng();
  const isGiwa = parcel.kind === 'giwa';

  // 1점(민가·초가) 또는 2점(기와·부유) — 앞채 창불 + (여유 시) 곁방/부속.
  const nPts = (isGiwa || wealth > 0.62) ? 2 : 1;
  const front = { lx: (rng() * 2 - 1) * plotW * 0.1, lz: plotD * (0.05 + rng() * 0.06) };
  const w0 = localToWorld(parcel, front.lx, front.lz, cos, sin);
  out.push({
    x: w0.x, y: baseY + wy, z: w0.z,
    lit, threshold, phase: rng() * TAU, warm, scale: isGiwa ? 1.12 : 1.0,
  });
  if (nPts === 2) {
    // 곁방: 살짝 옆·뒤 + 조금 낮게·어둡게·늦게(문턱↑). 같은 집 안의 밝기 편차.
    const w1 = localToWorld(parcel, (rng() < 0.5 ? -1 : 1) * plotW * 0.24, -plotD * (0.02 + rng() * 0.1), cos, sin);
    out.push({
      x: w1.x, y: baseY + wy - 0.25, z: w1.z,
      lit: lit * (0.55 + rng() * 0.2), threshold: clamp(threshold + 0.06 + rng() * 0.08, 0.06, 0.95),
      phase: rng() * TAU, warm: clamp01(warm + (rng() * 2 - 1) * 0.2), scale: isGiwa ? 0.95 : 0.85,
    });
  }
  return out;
}

// 궁·절(features) 등롱·창불 — 랜드마크라 여러 점, 밝게, 일찍 점등.
function featureLights(plan, site) {
  const F = plan.features || {};
  const out = [];
  const add = (f, count, litBase, scale, seedSalt) => {
    if (!f || typeof f.x !== 'number') return;
    const rng = makeRng(((f.seed || 7) ^ seedSalt) >>> 0);
    const gy = site.heightAt(f.x, f.z);
    for (let i = 0; i < count; i++) {
      const a = rng() * TAU, r = 6 + rng() * 12;
      out.push({
        x: f.x + Math.cos(a) * r, y: gy + 3.0 + rng() * 2.5, z: f.z + Math.sin(a) * r,
        lit: litBase + rng() * 0.2, threshold: 0.08 + rng() * 0.05,
        phase: rng() * TAU, warm: 0.15 + rng() * 0.25, scale,
      });
    }
  };
  add(F.palace, 4, 1.05, 1.8, 0x9a11);   // 궁: 크고 환한 등롱군
  add(F.temple, 3, 0.95, 1.6, 0x7e12);   // 절: 대웅전·석등 불빛
  add(F.pavilion, 1, 0.7, 1.2, 0x5a13);  // 정자: 은은한 한 점
  return out;
}

// plan 전체 → 창불 점 목록.
function collectLights(plan, site) {
  const pts = [];
  for (const p of plan.parcels || []) {
    for (const L of parcelLights(p)) pts.push(L);
  }
  for (const L of featureLights(plan, site)) pts.push(L);
  return pts;
}

const VERT = `
uniform float uNight;
uniform float uTime;
uniform float uPixelRatio;
uniform float uSizeBase;
uniform float uMinPx;
uniform float uMaxPx;
uniform float uFadeNear;
uniform float uFadeNearEnd;
uniform float uLensScale;
attribute float aPhase;
attribute float aLit;
attribute float aThreshold;
attribute float aWarm;
attribute float aScale;
varying float vIntensity;
varying float vWarm;

// 호롱불 일렁임(결정론) — night-glow.candleFlicker 경량판(숨쉬기 + 미세 지터).
float flick(float t, float ph) {
  float breathe = 0.5 * sin(t * 1.7 + ph) + 0.5 * sin(t * 0.63 + ph * 1.7);
  float jitter = sin(t * 9.3 + ph * 3.1);
  return clamp(1.0 + 0.12 * breathe + 0.03 * jitter, 0.62, 1.15);
}

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(-mv.z, 0.001);
  float visualDist = dist / max(uLensScale, 0.0001);
  // 집집이 다른 문턱을 uNight 이 넘을 때 서서히 점등(0.16 밴드 → 크로스페이드 부드럽게).
  float on = smoothstep(aThreshold, aThreshold + 0.16, uNight);
  float fl = flick(uTime, aPhase);
  float base = aLit * on * fl;
  // 근접 페이드: 아주 가까우면 0(재질 창호광이 바통 터치), 멀어질수록 1.
  float nearFade = smoothstep(uFadeNear, uFadeNearEnd, visualDist);
  vIntensity = base * nearFade;
  vWarm = aWarm;
  if (vIntensity <= 0.002) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  // 거리 감쇠 + 하/상한 클램프(원거리에서도 읽히는 최소 픽셀).
  float px = uSizeBase * aScale * uPixelRatio * uLensScale / dist;
  px = clamp(px, uMinPx * uPixelRatio, uMaxPx * uPixelRatio);
  gl_PointSize = px * (0.55 + 0.45 * smoothstep(0.0, 0.6, base));
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = `
precision mediump float;
uniform vec3 uColorCandle;
uniform vec3 uColorLamp;
varying float vIntensity;
varying float vWarm;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float r = length(uv);
  if (r > 0.5) discard;
  // 밝은 코어 + 부드러운 헤일로(post bloom 과 협력).
  float core = smoothstep(0.5, 0.0, r);
  float glow = pow(core, 1.8) + 0.35 * pow(core, 5.0);
  vec3 col = mix(uColorCandle, uColorLamp, vWarm);
  // #66 광량 톤다운(0.6): 부감 창불이 형광처럼 쨍하지 않게. bloom 임계 위 코어는 유지해
  //   헤일로(점점이 번짐)는 살리되 전반 휘도만 낮춘다(물글린트<창불 위계 보존).
  gl_FragColor = vec4(col * glow * vIntensity * 0.6, 1.0);   // CustomBlending One/One → 순수 가산
}
`;

// buildNightLights(plan, site) → { group, setLevel, setPixelRatio, update, dispose }.
//   update(dt, level): level(=adapter vnight 0..1)을 uNight 에 직접 반영(#50 크로스페이드 자동 정합),
//     uTime 누적(일렁임). level<=0(낮)이면 Points 자체를 숨겨 완전 소등 + 픽셀 처리 0.
export function buildNightLights(plan, site) {
  const group = new THREE.Group();
  group.name = 'village-nightlights';
  const lights = collectLights(plan, site);
  if (!lights.length) {
    return { group, setLevel() {}, setPixelRatio() {}, update() {}, dispose() {} };
  }

  const n = lights.length;
  const pos = new Float32Array(n * 3);
  const aPhase = new Float32Array(n);
  const aLit = new Float32Array(n);
  const aThreshold = new Float32Array(n);
  const aWarm = new Float32Array(n);
  const aScale = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const L = lights[i];
    pos[i * 3] = L.x; pos[i * 3 + 1] = L.y; pos[i * 3 + 2] = L.z;
    aPhase[i] = L.phase; aLit[i] = L.lit; aThreshold[i] = L.threshold;
    aWarm[i] = L.warm; aScale[i] = L.scale;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
  geo.setAttribute('aLit', new THREE.BufferAttribute(aLit, 1));
  geo.setAttribute('aThreshold', new THREE.BufferAttribute(aThreshold, 1));
  geo.setAttribute('aWarm', new THREE.BufferAttribute(aWarm, 1));
  geo.setAttribute('aScale', new THREE.BufferAttribute(aScale, 1));
  geo.computeBoundingSphere();

  const dpr = clamp(typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1, 1, 2);
  const uniforms = {
    uNight: { value: 0 },
    uTime: { value: 0 },
    uPixelRatio: { value: dpr },
    uSizeBase: { value: 1900 },   // #66 톤다운: 오브 지름 축소(호롱불 점점이, 형광 구슬 아님)
    uMinPx: { value: 3.2 },
    uMaxPx: { value: 17 },        // 근·중거리 오브가 부풀지 않게 상한 하향(26→17)
    uFadeNear: { value: 15 },
    uFadeNearEnd: { value: 62 },
    uLensScale: { value: 1 },
    uColorCandle: { value: COLOR_CANDLE.clone() },
    uColorLamp: { value: COLOR_LAMP.clone() },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG,
    // 필지 단위의 근사 창 좌표는 건물 내부에 놓이므로 일반 깊이 테스트 시 벽에 완전히 묻힌다.
    // 실제 전면 벽 바깥 좌표를 갖기 전까지 기존 발광 레이어 계약을 유지한다.
    transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });

  const points = new THREE.Points(geo, mat);
  points.name = 'nightlight-points';
  points.frustumCulled = false;   // 부감에서 항상 처리(경계 소실 방지, 단일 드로우콜이라 저렴)
  points.renderOrder = 4;         // 안개·운해 뒤(발광이 대기 위에)
  points.visible = false;
  group.add(points);

  let level = 0;
  return {
    group,
    setLevel(v) { level = clamp01(v || 0); uniforms.uNight.value = level; points.visible = level > 0.001; },
    setPixelRatio(v) { uniforms.uPixelRatio.value = clamp(v || 1, 0.5, 3); },
    update(dt, v, lensScale = 1) {
      if (v != null) { level = clamp01(v); uniforms.uNight.value = level; }
      uniforms.uLensScale.value = Number.isFinite(lensScale)
        ? clamp(lensScale, 0.5, 2) : 1;
      points.visible = level > 0.001;
      if (points.visible) uniforms.uTime.value += dt || 0;
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
