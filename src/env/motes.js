import * as THREE from 'three';
import { getWind } from './wind.js';
import { makePresenceGate } from './present-gate.js';

// 앰비언트 생명감 — 무엇도 완전히 정지해 있지 않되, 모든 움직임은 미세하게.
//   setupMotes({ scene, sun, renderer })      → 공기 중 먼지 모트(THREE.Points 단일 드로우)
//   setupLanternSway({ scene })               → 처마 등롱 진자 미세 요동(traverse 참조)
//
// 구현 방침:
//  - 결정론(Math.random 미사용): 시드/해시 기반 초기 배치 + 위상/시간 t 순수 함수 →
//    shot 재현성 유지(같은 t → 같은 프레임).
//  - 바람 연동: wind.js getWind(t) 를 read-only import — 거스트 때 살짝 더 쓸리고 잦아들면 감쇠.
//  - 카메라는 setupEnvironment 로 넘어오지 않지만, three.js ShaderMaterial 은 world 카메라
//    위치를 built-in uniform `cameraPosition` 으로 자동 주입한다 → 역광 게이트에 이것만 쓴다.
//  - ink 게이트: main.js 가 ink 모드에서 renderer.toneMapping=NoToneMapping 으로 두므로,
//    renderer 를 read-only 로 받아 그 신호로 모트를 숨긴다(main.js 무수정).

const fract = (x) => x - Math.floor(x);
// 정수 → [0,1) 결정론 해시(wind.js 와 동일 계열, sin 기반 순수 함수).
function hash1(n) { const x = Math.sin(n * 127.13 + 11.7) * 43758.5453; return x - Math.floor(x); }

// 시간대별 먼지 강도·색. int=마스터 알파 배율, color=먼지 틴트.
//  sunset/dawn 최대(골든아워 공기 중 먼지), day 미약, night 극미(달빛 반짝).
// int 는 앱 렌더(bloom 有)에서 다소 증폭되므로 raw 하네스에서 "살짝" 읽히는 값으로 잡되,
// 시간대 비율(sunset≈dawn ≫ day ≫ night)을 유지한다.
const MOTE_TIME = {
  dawn:   { int: 2.2, color: 0xffe7c6 },  // 새벽 온기
  day:    { int: 0.7, color: 0xf2f4f6 },  // 낮은 미약·중성
  sunset: { int: 2.6, color: 0xffdca8 },  // 해질녘 최대·금빛
  night:  { int: 0.5, color: 0xcdd8f0 },  // 밤 극미·달빛 쿨
};

const MOTE_COUNT = 160;      // THREE.Points 단일 드로우
const MOTE_RADIUS = 22;      // 건물 주변 볼륨 반경(m). 리그가 건물 고정이라 원점 중심.
const MOTE_CENTER_Y = 6.0;   // 볼륨 중심 높이(지면~처마 위 공기층)

// 카메라가 태양 쪽을 볼 때 먼지가 빛을 받아 반짝이는 forward-scatter 게이트의 로브 폭.
const FORWARD_POW = 3.0;

const MOTE_VERT = /* glsl */`
uniform float uTime;
uniform float uSize;        // 기준 크기(logical px)
uniform float uPixelRatio;
uniform vec3  uSunDir;      // 태양(달)을 가리키는 단위벡터(world)
uniform float uDrift;       // 브라운 드리프트 진폭(m)
uniform vec3  uWindDir;     // 수평 바람 단위벡터
uniform float uWindSway;    // 바람 쓸림 진폭(m)
uniform float uGust;        // 0..1 거스트
uniform float uIntensity;   // 마스터 알파 배율(시간대)
uniform float uForwardPow;  // 역광 로브 폭

attribute vec4 aRand;       // x=위상, y=주파수배율, z=기준알파, w=크기배율

varying float vAlpha;

void main() {
  vec3 p = position;
  float t = uTime;
  float ph = aRand.x;
  float fm = aRand.y;
  // 느린 브라운 드리프트(비정수비 사인 합성 → 유계, 볼륨 이탈 없음).
  p.x += uDrift * sin(t * 0.50 * fm + ph);
  p.y += uDrift * 0.55 * sin(t * 0.37 * fm + ph * 1.7 + 1.3);
  p.z += uDrift * cos(t * 0.43 * fm + ph * 2.1);
  // 바람 쓸림(거스트가 진폭을 키움). 유계 사인이라 떠내려가지 않는다.
  float windAmp = uWindSway * (0.35 + uGust);
  float ws = 0.5 + 0.5 * sin(t * 0.30 + ph);
  p.x += uWindDir.x * windAmp * ws;
  p.z += uWindDir.z * windAmp * ws;

  vec4 world = modelMatrix * vec4(p, 1.0);
  vec4 mv = viewMatrix * world;
  gl_Position = projectionMatrix * mv;

  // 역광(forward-scatter) 게이트: 카메라→모트 방향(viewDir)이 모트→태양 방향(uSunDir)과
  // 정렬될 때(=태양이 모트 너머 정면 = 역광) forward≈1 로 반짝. 순광(태양이 등 뒤)은 ≈-1→0.
  vec3 viewDir = normalize(world.xyz - cameraPosition);
  float forward = max(dot(viewDir, normalize(uSunDir)), 0.0);
  float shimmer = 0.12 + 0.88 * pow(forward, uForwardPow);  // 순광·그늘은 바닥값만

  // 먼지가 구르며 빛을 받는 미세 반짝임(twinkle).
  float tw = 0.72 + 0.28 * sin(t * (1.7 + fm) + ph * 3.1);

  vAlpha = aRand.z * uIntensity * shimmer * tw;

  // 원근 감쇠(먼 모트는 작게), physical px. 최소/최대 클램프로 1~2px 감성.
  float sz = uSize * aRand.w * uPixelRatio;
  gl_PointSize = clamp(sz * (50.0 / -mv.z), 1.0 * uPixelRatio, 5.0 * uPixelRatio);
}`;

const MOTE_FRAG = /* glsl */`
precision mediump float;
uniform vec3 uColor;
varying float vAlpha;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;
  float soft = smoothstep(0.5, 0.0, d);   // 부드러운 원형 글린트
  gl_FragColor = vec4(uColor, vAlpha * soft);
}`;

// opts(선택): radius/centerY/count/ySpan 로 볼륨을 좁혀 근접 링(마당 볼륨 한정)에 재사용한다.
//   기본값 = 기존 상수(집 단독 모드 호출자 무회귀). fade(setFade)=활성/해제 크로스페이드 배율.
//   ySpan: 수직 눌림 계수(작을수록 납작한 공기층). 근접 링은 낮춰 "대기 헤이즈"가 아닌 "마당 먼지"로.
export function setupMotes({ scene, sun, renderer, radius, centerY, count, ySpan } = {}) {
  let time = 'sunset';
  let enabled = false;
  let t = 0;   // 결정론 시계
  let fade = 1;             // 외부 크로스페이드 배율(근접 링 활성/해제). 1=무영향.

  const RAD = radius ?? MOTE_RADIUS;
  const CY = centerY ?? MOTE_CENTER_Y;
  const YSPAN = ySpan ?? 0.75;   // 기본 0.75 = 기존 동작

  // 결정론 초기 배치: 볼륨 구 내부 균일(반지름 cbrt) + 상방 약간 편향, 지면 위 클램프.
  const N = count ?? MOTE_COUNT;
  const positions = new Float32Array(N * 3);
  const rands = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const r = RAD * Math.cbrt(hash1(i * 1.11 + 0.5));
    const theta = hash1(i * 2.13 + 1.7) * Math.PI * 2;
    const cphi = 2 * hash1(i * 3.71 + 4.2) - 1;   // cos(phi) ∈ [-1,1]
    const sphi = Math.sqrt(Math.max(0, 1 - cphi * cphi));
    const x = r * sphi * Math.cos(theta);
    const z = r * sphi * Math.sin(theta);
    let y = CY + r * cphi * YSPAN;                 // y 눌러 공기층 느낌(ySpan 낮추면 더 납작)
    if (y < 0.4) y = 0.4 + hash1(i * 5.3) * 1.2;   // 지면 아래 방지
    positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;

    rands[i * 4] = hash1(i * 7.7 + 0.3) * Math.PI * 2;      // 위상
    rands[i * 4 + 1] = 0.6 + hash1(i * 9.1 + 2.2) * 0.9;    // 주파수배율 0.6~1.5
    rands[i * 4 + 2] = 0.15 + hash1(i * 11.3 + 5.1) * 0.20; // 기준알파 0.15~0.35
    rands[i * 4 + 3] = 0.6 + hash1(i * 13.9 + 8.4) * 0.8;   // 크기배율 0.6~1.4
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aRand', new THREE.BufferAttribute(rands, 4));
  // 프러스텀 컬링이 원점 bbox 로 오판하지 않게 볼륨 크기 sphere 를 지정.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, CY, 0), RAD + 4);

  const prof = MOTE_TIME[time] || MOTE_TIME.day;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSize: { value: 2.6 },
      uPixelRatio: { value: renderer ? renderer.getPixelRatio() : 2 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uDrift: { value: 0.75 },
      uWindDir: { value: new THREE.Vector3(1, 0, 0) },
      uWindSway: { value: 0.0 },
      uGust: { value: 0.0 },
      uIntensity: { value: prof.int },
      uForwardPow: { value: FORWARD_POW },
      uColor: { value: new THREE.Color(prof.color) },
    },
    vertexShader: MOTE_VERT,
    fragmentShader: MOTE_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,          // 건물에 가려진 뒤쪽 모트는 오클루전
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geo, mat);
  points.name = 'dustMotes';
  points.renderOrder = 4;    // 연기(3) 뒤, 불투명 이후
  points.frustumCulled = false;

  const group = new THREE.Group();
  group.name = 'motes';
  group.add(points);

  const _sunDir = new THREE.Vector3();
  const isInk = () => !!(renderer && renderer.toneMapping === THREE.NoToneMapping);

  // 시간대 크로스페이드 목표(강도·색). setTime 이 목표만, update 가 지수 접근.
  // curInt 는 시간대 애니 상태(순수), 셰이더 uIntensity = curInt*fade(외부 크로스페이드 분리).
  let curInt = mat.uniforms.uIntensity.value;
  let tgtInt = curInt;
  const tgtColor = new THREE.Color(mat.uniforms.uColor.value);
  const TIME_RATE = 2.4;   // ≈1.6s(sky 크로스페이드와 결이 맞게)
  function setTimeTarget(name) {
    const p = MOTE_TIME[name] || MOTE_TIME.day;
    tgtInt = p.int;
    tgtColor.setHex(p.color);
    // 낮은 바람이 화면 전체를 흔들면 과하니 바람 쓸림도 시간대로 살짝 조절.
    mat.uniforms.uWindSway.value = 0.6;   // 기준(거스트가 추가로 키움)
  }
  setTimeTarget(time);

  function update(dt) {
    if (!enabled) return;
    // ink 모드에선 비표시(반투명 글린트가 먹 뷰티 패스에 이물감).
    points.visible = !isInk();
    if (!points.visible) return;
    t += dt;
    const u = mat.uniforms;
    u.uTime.value = t;
    // 시간대 강도·색 크로스페이드(순수 curInt) → 셰이더엔 fade 곱해 반영.
    const k = Math.min(1, dt * TIME_RATE);
    curInt += (tgtInt - curInt) * k;
    u.uIntensity.value = curInt * fade;
    u.uColor.value.lerp(tgtColor, k);
    if (renderer) u.uPixelRatio.value = renderer.getPixelRatio();
    // 태양(달) 방향: sky.apply 가 sun.position 을 방향*64 로 세팅 → 정규화해 사용.
    if (sun) { _sunDir.copy(sun.position).normalize(); u.uSunDir.value.copy(_sunDir); }
    const w = getWind(t);
    u.uWindDir.value.set(w.dirX, 0, w.dirZ);
    u.uGust.value = w.gust;
  }

  function setTime(name, opts = {}) {
    time = name;
    setTimeTarget(name);
    if (opts.immediate) { curInt = tgtInt; mat.uniforms.uIntensity.value = curInt * fade; mat.uniforms.uColor.value.copy(tgtColor); }
  }
  function setEnabled(v) { enabled = !!v; group.visible = enabled; }
  // 근접 링 활성/해제 크로스페이드(0..1). 시간대 애니와 독립적으로 최종 알파를 배율한다.
  function setFade(v) { fade = v; mat.uniforms.uIntensity.value = curInt * fade; }

  return { group, setTime, setEnabled, update, setFade };
}

// ── 처마 등롱 진자 미세 요동 ────────────────────────────────────────────────
// sky.js 가 env 그룹 직속 자식으로 PointLight(등롱빛 4)+소형 SphereGeometry bulb(4)를
// 만든다(이름 없음). sky.js 무수정 → env 그룹 직속 자식만 훑어 색 비의존으로 식별:
//   · PointLight  → 등롱 빛(env 직속엔 이것뿐: nightGlow 램프·아궁이 불은 건물 자식).
//   · 소형 구 Mesh → bulb(돔 r=720·달 r=11 은 반경으로 배제; critters/moon 은 하위 그룹).
// bulb.position === light.position 이라 위치로 짝짓는다. 흔들림은 위치만(구는 회전 무의미):
//   진자 = 위상·주기 다른 사인 합성(비정수비) + getWind 거스트 시 살짝 더 기울고 잦아들면 감쇠.
//   진폭 아주 작게(회전각 ~1.5°, 거스트 시 ~3~4° → 수 cm). 촛불 플리커(intensity)와 독립 공존.
// scope(선택): 등롱 탐지 루트. 기본은 scene 의 'environment' 그룹(집 단독/env 전역 인스턴스).
//   근접 링은 focus 오버레이 그룹을 scope 로 넘겨 env 전역 lanternSway 와 대상이 겹치지 않게 한다.
export function setupLanternSway({ scene, getBuilding = null, scope = null }) {
  let enabled = false;
  let t = 0;
  let detected = false;
  let lanterns = [];   // [{ bulb, light, base:Vector3, phX, phZ, w1, w2, w3, w4 }]
  // 조기 노출 게이트(#61): 등롱은 처마에 매달린 건물 종속 오브(sky.js 가 고정 위치 배치). 히어로
  // 빈 터엔 "처마 없는 공중 등롱"으로 뜨므로, 건물이 서기 전엔 소등한다. sky.updateFlicker 다음에
  // 돌아 sky 값을 덮어쓴다(present=1 이면 무간섭). getBuilding 없으면 게이트 비활성(항상 present).
  const gate = getBuilding ? makePresenceGate({ delay: 1.2, up: 1.6, down: 0.4 }) : null;
  let lastBld = null;

  const HANG = 0.4;          // 등롱 매단 길이(m) → 요동을 수평 변위로 환산
  const BASE_AMP = 0.030;    // 기준 스윙 각(rad) ≈ 1.7°
  const _v = new THREE.Vector3();

  function detect() {
    const root = (typeof scope === 'function' ? scope() : scope) || scene.getObjectByName('environment');
    if (!root) return false;
    const lights = [];
    const bulbs = [];
    for (const o of root.children) {
      if (o.isPointLight) lights.push(o);
      else if (o.isMesh && o.geometry && o.geometry.type === 'SphereGeometry'
        && o.geometry.parameters && o.geometry.parameters.radius < 0.5) {
        bulbs.push(o);
      }
    }
    if (!lights.length || !bulbs.length) return false;
    // bulb↔light 위치로 짝짓기(정확 동일 위치). 위상은 인덱스로 갈라 동기화 방지.
    lanterns = [];
    bulbs.forEach((bulb, i) => {
      let light = null, best = Infinity;
      for (const l of lights) {
        const d = l.position.distanceToSquared(bulb.position);
        if (d < best) { best = d; light = l; }
      }
      lanterns.push({
        bulb, light: best < 0.01 ? light : null,
        base: bulb.position.clone(),
        phX: i * 1.7, phZ: i * 2.3 + 0.9,
        w1: 0.9 + i * 0.07, w2: 1.43 + i * 0.05,   // 비정수비 → 절대 정렬 안 됨
        w3: 0.83 + i * 0.06, w4: 1.27 + i * 0.04,
      });
    });
    return true;
  }

  function update(dt) {
    if (!enabled) return;
    if (!detected) { detected = detect(); if (!detected) return; }
    // 조기 노출 게이트 갱신(sky 가 이 프레임에 이미 bulb.visible/light.intensity 세팅 → 여기서 덮어씀).
    let g = 1;
    if (gate) {
      const bObj = getBuilding();
      const reset = bObj !== lastBld; lastBld = bObj;
      const present = !!(bObj && bObj.visible);
      g = gate.update(dt, { present, reset });
      if (g < 0.999) {
        for (const L of lanterns) {
          L.bulb.visible = L.bulb.visible && g > 0.04;   // sky 의도(가시) AND 건물 존재
          if (L.light) L.light.intensity *= g;
        }
      }
    }
    t += dt;
    const w = getWind(t);
    const gustAmp = 1 + w.gust * 1.6;          // 거스트 때 더 기울고
    const lean = w.speed * 0.010;              // 바람 방향으로 미세 상시 기울기
    for (const L of lanterns) {
      // 진자 각(비정수비 사인 합성) — X·Z 축 독립.
      let ax = BASE_AMP * (0.6 * Math.sin(t * L.w1 + L.phX) + 0.4 * Math.sin(t * L.w2 + L.phX * 1.7));
      let az = BASE_AMP * (0.6 * Math.sin(t * L.w3 + L.phZ) + 0.4 * Math.sin(t * L.w4 + L.phZ * 1.3));
      ax = ax * gustAmp + w.dirX * lean;
      az = az * gustAmp + w.dirZ * lean;
      const dx = HANG * Math.sin(ax);
      const dz = HANG * Math.sin(az);
      const dy = HANG * ((1 - Math.cos(ax)) + (1 - Math.cos(az))) * 0.5;  // 스윙 시 살짝 들림
      _v.set(L.base.x + dx, L.base.y + dy, L.base.z + dz);
      L.bulb.position.copy(_v);
      if (L.light) L.light.position.copy(_v);
    }
  }

  function setEnabled(v) {
    enabled = !!v;
    if (!enabled) {   // 원복(정지 위치로)
      for (const L of lanterns) {
        L.bulb.position.copy(L.base);
        if (L.light) L.light.position.copy(L.base);
      }
    }
  }

  return { update, setEnabled };
}
