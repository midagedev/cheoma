import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../rng.js';

// 빗물 흐름 시뮬 — 셰이더 틴트(젖음 roughness)를 물리적 흐름 표현으로 격상.
//   createRainFlow(scene, { layout }) → { group, rebuild(surfaces), update(dt,{rain,wet,t}), setVisible, setLayout, dispose }
//
// 구성:
//  ① 지붕 리벌릿: 지붕 표면 복제 오버레이(기와면 위 살짝) 위에 기왓골 방향(경사 아래)으로 흐르는
//     물줄기 + 젖은 시트 광택(fresnel). 처마쪽(uv.y→0)에서 짙어져 기존 처마 낙수(makeDrips)로 이어짐.
//  ② 지면 웅덩이: 마당·처마 낙수 착지선에 물웅덩이. 시간(wet)에 비례해 반경이 자라고(uGrow),
//     비 갬 후 wet 이 줄면 서서히 마른다. 하늘 반사 톤 + 잔물결 글린트.
//
// 성능: 리벌릿 1병합 메시(1 드로우콜) + 웅덩이 1병합(1). rain·wet 레벨로 알파 게이트.

const RIV_SKY = new THREE.Color(0x9db2c6);       // 젖은 지붕 시트 반사 톤(차가운 회청)
const RIV_GLINT = new THREE.Color(0.55, 0.66, 0.78);
const PUD_SKY = new THREE.Color(0x8fa6bd);
const PUD_GLINT = new THREE.Color(0.62, 0.72, 0.86);
const PUD_MAX = 1.0;                              // 웅덩이 최대 반경 배율(월드 m 는 base*이 배율)

// roofOnly(선택): 지붕 리벌릿만 구성하고 지면 웅덩이를 생략한다. 근접 링(#84) 전용 — 웅덩이는
//   layout 기준 origin 상대라 월드 오프셋 필지에선 오배치되나, 리벌릿은 captureRoofSurfaces
//   월드좌표 베이크라 group=origin 유지 시 오프셋 필지 지붕에 정확히 얹힌다. 기본 false = 무회귀.
export function createRainFlow(scene, { layout, roofOnly = false }) {
  let L = layout || {};
  const group = new THREE.Group();
  group.name = 'rainFlow';
  group.visible = false;
  scene.add(group);

  const uTime = { value: 0 };
  const uRain = { value: 0 };     // 리벌릿 가시성(강우 레벨)
  const uWet = { value: 0 };      // 웅덩이 성장/가시성(젖음 누적 레벨)

  const rivMat = makeRivuletMaterial(uTime, uRain);
  const pudMat = makePuddleMaterial(uTime, uWet);
  let rivMesh = null, pudMesh = null;

  function clearMesh(m) { if (m) { group.remove(m); m.geometry.dispose(); } }

  function rebuild(surfaces) {
    clearMesh(rivMesh); rivMesh = null;
    if (surfaces && surfaces.length) {
      const geo = buildRivuletGeometry(surfaces);
      if (geo) {
        rivMesh = new THREE.Mesh(geo, rivMat);
        rivMesh.name = 'rainRivulets';
        rivMesh.frustumCulled = false;
        rivMesh.renderOrder = 3;
        group.add(rivMesh);
      }
    }
    if (!roofOnly) rebuildPuddles();
  }

  function rebuildPuddles() {
    clearMesh(pudMesh); pudMesh = null;
    const geo = buildPuddleGeometry(L);
    if (geo) {
      pudMesh = new THREE.Mesh(geo, pudMat);
      pudMesh.name = 'rainPuddles';
      pudMesh.frustumCulled = false;
      pudMesh.renderOrder = 2;
      group.add(pudMesh);
    }
  }

  function setLayout(nl) { if (nl) L = nl; }

  function update(dt, ctx) {
    uTime.value += dt;
    uRain.value = ctx.rain || 0;
    uWet.value = ctx.wet || 0;
  }

  function setVisible(v) { group.visible = v; }

  function dispose() {
    clearMesh(rivMesh); clearMesh(pudMesh);
    scene.remove(group);
    rivMat.dispose(); pudMat.dispose();
  }

  return { group, rebuild, update, setVisible, setLayout, dispose };
}

// ── 지붕 리벌릿 오버레이 지오메트리(표면 복제, 기와면 위 살짝) ────────────────
function buildRivuletGeometry(surfaces) {
  const parts = [];
  for (const s of surfaces) {
    const n = s.count;
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const nx = s.nor[i * 3], ny = s.nor[i * 3 + 1], nz = s.nor[i * 3 + 2];
      pos[i * 3] = s.pos[i * 3] + nx * 0.035;      // 눈 쉘(0.02)보다 위 — 겹쳐도 물이 위
      pos[i * 3 + 1] = s.pos[i * 3 + 1] + ny * 0.035;
      pos[i * 3 + 2] = s.pos[i * 3 + 2] + nz * 0.035;
      nor[i * 3] = nx; nor[i * 3 + 1] = ny; nor[i * 3 + 2] = nz;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(s.uv), 2));
    g.setIndex(new THREE.BufferAttribute(s.index, 1));
    parts.push(g);
  }
  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

function makeRivuletMaterial(uTime, uRain) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime, uRain,
      uSky: { value: RIV_SKY }, uGlint: { value: RIV_GLINT },
    },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: `
      varying vec2 vUv; varying vec3 vN; varying vec3 vView; varying vec3 vWP;
      void main(){
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = -mv.xyz;
        vN = normalMatrix * normal;
        vWP = (modelMatrix * vec4(position,1.0)).xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec2 vUv; varying vec3 vN; varying vec3 vView; varying vec3 vWP;
      uniform float uTime; uniform float uRain; uniform vec3 uSky; uniform vec3 uGlint;
      float h1(float n){ return fract(sin(n*12.9898)*43758.5453); }
      void main(){
        // 세로 물줄기 열(기왓골): uv.x 를 열로 나눠, 열마다 위상·간헐. 경사 아래로 흐른다.
        float col = vUv.x * 24.0;
        float ci = floor(col);
        float fx = fract(col);
        float ph = h1(ci) * 6.2831;
        // 아래로(uv.y 감소=처마쪽) 흐르는 물덩이 스크롤
        float flow = sin(vUv.y * 8.0 + uTime * 1.9 + ph) * 0.5 + 0.5;
        flow = pow(flow, 2.2);
        float line = smoothstep(0.36, 0.02, abs(fx - 0.5));  // 열 중심 얇은 줄기
        float onCol = step(0.42, h1(ci * 3.7 + 1.3));         // 일부 열만 흐름(간헐)
        float riv = line * flow * onCol;
        // 처마쪽(uv.y 작음)으로 갈수록 물이 모여 짙어짐 → 처마 낙수로 이어지는 연속성
        riv *= mix(0.5, 1.35, 1.0 - clamp(vUv.y, 0.0, 1.0));
        // 젖은 시트 광택
        vec3 N = normalize(vN); vec3 V = normalize(vView);
        float fres = pow(clamp(1.0 - abs(dot(N, V)), 0.0, 1.0), 2.6);
        float sheen = 0.10 + 0.42 * fres;
        // 글린트 스파클(흐름 따라 흐르는 교차 고주파)
        float g1 = sin(dot(vWP.xz, vec2(2.1, -1.4)) + uTime * 2.2);
        float g2 = sin(dot(vWP.xz, vec2(-1.2, 2.5)) - uTime * 1.3);
        float sp = pow(clamp(g1 * g2, 0.0, 1.0), 8.0);
        float a = (sheen * 0.5 + riv * 0.85) * uRain;
        vec3 c = mix(uSky, vec3(0.96, 0.98, 1.0), clamp(riv, 0.0, 1.0)) + uGlint * sp * (0.4 + 0.6 * fres);
        if (a < 0.015) discard;
        gl_FragColor = vec4(c, clamp(a, 0.0, 0.8));
      }`,
  });
}

// ── 지면 웅덩이(단위 원반 병합, uGrow 로 반경 성장) ──────────────────────────
function buildPuddleGeometry(L) {
  const rng = makeRng(0x9add1e ^ Math.round((L.W || 12) * 5 + (L.D || 8) * 11));
  const xE = L.xEave ?? 8, zE = L.zEave ?? 6;
  const centers = [];
  // ① 처마 낙수 착지선(처마 footprint 바로 밖 지면) — 낙수·스플래시와 같은 자리
  for (const sz of [1, -1]) for (let k = -2; k <= 2; k++) {
    centers.push([k * (xE / 2.2) + rng.range(-0.4, 0.4), sz * (zE + 0.5) + rng.range(-0.3, 0.3), rng.range(0.5, 0.95)]);
  }
  // ② 마당 흩뿌림(가까운 저지대)
  const nYard = 9;
  for (let i = 0; i < nYard; i++) {
    const th = rng.range(0, Math.PI * 2);
    const rr = (Math.max(xE, zE) + 1.0) + Math.pow(rng(), 0.7) * 14;
    centers.push([Math.cos(th) * rr, Math.sin(th) * rr, rng.range(0.7, 1.7)]);
  }

  const SEG = 20;
  const posA = [], radA = [], cenA = [], uvA = [], idxA = [];
  let base = 0;
  for (const [cx, cz, baseR] of centers) {
    const y = 0.03;
    // 중심 정점
    posA.push(cx, y, cz); radA.push(0, 0); cenA.push(cx, y, cz); uvA.push(0.5, 0.5);
    for (let a = 0; a <= SEG; a++) {
      const th = (a / SEG) * Math.PI * 2;
      const rx = Math.cos(th) * baseR, rz = Math.sin(th) * baseR;
      posA.push(cx + rx, y, cz + rz);
      radA.push(rx, rz);
      cenA.push(cx, y, cz);
      uvA.push(0.5 + Math.cos(th) * 0.5, 0.5 + Math.sin(th) * 0.5);
    }
    for (let a = 0; a < SEG; a++) {
      idxA.push(base, base + 1 + a, base + 1 + ((a + 1) % (SEG + 1)));
    }
    base += SEG + 2;
  }
  if (!centers.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(posA, 3));
  g.setAttribute('aRadial', new THREE.Float32BufferAttribute(radA, 2));
  g.setAttribute('aCenter', new THREE.Float32BufferAttribute(cenA, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvA, 2));
  g.setIndex(idxA);
  return g;
}

function makePuddleMaterial(uTime, uWet) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime, uWet, uSky: { value: PUD_SKY }, uGlint: { value: PUD_GLINT } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: `
      attribute vec2 aRadial; attribute vec3 aCenter;
      uniform float uWet;
      varying vec2 vUv; varying vec3 vView; varying vec3 vWP; varying float vEdge;
      void main(){
        vUv = uv;
        // 반경이 uWet 으로 자란다(0→1). 중심에서 밖으로 성장.
        float grow = smoothstep(0.05, 1.0, uWet);
        vec3 p = aCenter + vec3(aRadial.x, 0.0, aRadial.y) * grow;
        vEdge = length(aRadial);
        vWP = (modelMatrix * vec4(p,1.0)).xyz;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec2 vUv; varying vec3 vView; varying vec3 vWP; varying float vEdge;
      uniform float uTime; uniform float uWet; uniform vec3 uSky; uniform vec3 uGlint;
      void main(){
        vec3 V = normalize(vView);
        // 수평면 노멀(위) 기준 fresnel — 얕은 각에서 하늘 반사 밝게
        float fres = pow(clamp(1.0 - V.y, 0.0, 1.0), 3.0);
        // 잔물결 글린트
        float r1 = sin(dot(vWP.xz, vec2(3.1, 2.2)) + uTime * 1.6);
        float r2 = sin(dot(vWP.xz, vec2(-2.4, 3.3)) - uTime * 1.1);
        float sp = pow(clamp(r1 * r2, 0.0, 1.0), 6.0);
        float d = length(vUv - 0.5) * 2.0;
        float disk = smoothstep(1.0, 0.82, d);      // 가장자리 부드럽게
        float a = disk * uWet * (0.34 + 0.5 * fres);
        vec3 c = uSky * (0.5 + 0.7 * fres) + uGlint * sp;
        if (a < 0.02) discard;
        gl_FragColor = vec4(c, clamp(a, 0.0, 0.72));
      }`,
  });
}
