import * as THREE from 'three';
import { normalizeVillageLensScale } from '../camera/optics.js';
import { getWind } from './wind.js';
import { makePresenceGate } from './present-gate.js';
import { createMoteWorldRepresentation } from './detail-particle-geometry.js';

// 앰비언트 생명감 — 무엇도 완전히 정지해 있지 않되, 모든 움직임은 미세하게.
//   setupMotes({ scene, sun, renderer })      → 공기 중 먼지·반딧불 물리 geometry(단일 드로우)
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
// int: 마스터 알파 배율. sunset/dawn 이 최대(골든아워 역광 먼지)이나, 히어로·부감처럼 카메라가 볼륨에서
//   멀면 원거리 모트가 DoF 로 번져 보케가 과해진다 → #116 에서 sunset/dawn 을 소폭 낮춰 "은은한 반짝"으로
//   절제(역광 헤이즈는 유지, 전멸 금지).
const MOTE_TIME = {
  dawn:   { int: 1.9, color: 0xffe7c6 },  // 새벽 온기
  day:    { int: 0.7, color: 0xf2f4f6 },  // 낮은 미약·중성
  sunset: { int: 2.1, color: 0xffdca8 },  // 해질녘 최대·금빛
  night:  { int: 0.5, color: 0xcdd8f0 },  // 밤 극미·달빛 쿨
};

const MOTE_COUNT = 160;
const MOTE_RADIUS = 22;      // 건물 주변 볼륨 반경(m). 리그가 건물 고정이라 원점 중심.
const MOTE_CENTER_Y = 6.0;   // 볼륨 중심 높이(지면~처마 위 공기층)

// opts(선택): radius/centerY/count/ySpan 로 볼륨을 좁혀 근접 링(마당 볼륨 한정)에 재사용한다.
//   기본값 = 기존 상수(집 단독 모드 호출자 무회귀). fade(setFade)=활성/해제 크로스페이드 배율.
//   ySpan: 수직 눌림 계수(작을수록 납작한 공기층). 근접 링은 낮춰 "대기 헤이즈"가 아닌 "마당 먼지"로.
export function setupMotes({
  scene, sun, renderer, radius, centerY, count, ySpan, fireflies = false,
} = {}) {
  let time = 'sunset';
  let season = 'summer';
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
    const alpha = 0.15 + hash1(i * 11.3 + 5.1) * 0.20;       // 기준알파 0.15~0.35
    const isFirefly = fireflies && hash1(i * 17.3 + 9.7) >= 0.92; // 선택 링만 독립 membership(~8%)
    rands[i * 4 + 2] = isFirefly ? -alpha : alpha;           // 부호 bit 재사용(추가 attribute 없음)
    rands[i * 4 + 3] = 0.6 + hash1(i * 13.9 + 8.4) * 0.8;   // 크기배율 0.6~1.4
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aRand', new THREE.BufferAttribute(rands, 4));
  // 프러스텀 컬링이 원점 bbox 로 오판하지 않게 볼륨 크기 sphere 를 지정.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, CY, 0), RAD + 4);

  const worldDetail = createMoteWorldRepresentation(geo, { renderOrder: 4 });
  const object = worldDetail.object;
  object.name = 'dustMotes';
  const uniforms = worldDetail.material.uniforms;
  const prof = MOTE_TIME[time] || MOTE_TIME.day;
  uniforms.uIntensity.value = prof.int;
  uniforms.uColor.value.setHex(prof.color);
  const group = new THREE.Group();
  group.name = 'motes';
  group.add(object);
  group.visible = false;

  const _sunDir = new THREE.Vector3();
  const isInk = () => !!(renderer && renderer.toneMapping === THREE.NoToneMapping);

  // 시간대 크로스페이드 목표(강도·색). setTime 이 목표만, update 가 지수 접근.
  // curInt 는 시간대 애니 상태(순수), 셰이더 uIntensity = curInt*fade(외부 크로스페이드 분리).
  let curInt = uniforms.uIntensity.value;
  let tgtInt = curInt;
  let curFirefly = 0, tgtFirefly = 0, wetSuppression = 0, lastCalm = 1;
  const tgtColor = new THREE.Color(uniforms.uColor.value);
  const TIME_RATE = 2.4;   // ≈1.6s(sky 크로스페이드와 결이 맞게)
  function setTimeTarget(name) {
    const p = MOTE_TIME[name] || MOTE_TIME.day;
    tgtInt = p.int;
    tgtColor.setHex(p.color);
    // 낮은 바람이 화면 전체를 흔들면 과하니 바람 쓸림도 시간대로 살짝 조절.
    uniforms.uWindSway.value = 0.6;   // 기준(거스트가 추가로 키움)
    tgtFirefly = fireflies && name === 'night' && season === 'summer' ? 1 : 0;
  }
  setTimeTarget(time);

  function update(dt) {
    if (!enabled || fade <= 0.002) return;
    // ink 모드에선 비표시(반투명 글린트가 먹 뷰티 패스에 이물감).
    object.visible = !isInk();
    if (!object.visible) return;
    t += dt;
    const u = uniforms;
    u.uTime.value = t;
    // 시간대 강도·색 크로스페이드(순수 curInt) → 셰이더엔 fade 곱해 반영.
    const k = Math.min(1, dt * TIME_RATE);
    curInt += (tgtInt - curInt) * k;
    u.uIntensity.value = curInt * fade;
    curFirefly += (tgtFirefly - curFirefly) * k;
    u.uColor.value.lerp(tgtColor, k);
    // 태양(달) 방향: sky.apply 가 sun.position 을 방향*64 로 세팅 → 정규화해 사용.
    if (sun) { _sunDir.copy(sun.position).normalize(); u.uSunDir.value.copy(_sunDir); }
    const w = getWind(t);
    lastCalm = 1 - 0.72 * Math.max(0, Math.min(1, w.gust));
    u.uFirefly.value = curFirefly * fade * (1 - wetSuppression) * lastCalm;
    u.uWindDir.value.set(w.dirX, 0, w.dirZ);
    u.uGust.value = w.gust;
  }

  function setTime(name, opts = {}) {
    time = name;
    setTimeTarget(name);
    if (opts.immediate) {
      curInt = tgtInt; curFirefly = tgtFirefly;
      uniforms.uIntensity.value = curInt * fade;
      uniforms.uFirefly.value = curFirefly * fade * (1 - wetSuppression) * lastCalm;
      uniforms.uColor.value.copy(tgtColor);
    }
  }
  function setSeason(name, opts = {}) {
    season = name || 'summer';
    tgtFirefly = fireflies && time === 'night' && season === 'summer' ? 1 : 0;
    if (opts.immediate) {
      curFirefly = tgtFirefly;
      uniforms.uFirefly.value = curFirefly * fade * (1 - wetSuppression) * lastCalm;
    }
  }
  function setWeather(weather) {
    const wet = typeof weather === 'string'
      ? (weather === 'rain' || weather === 'snow' ? 1 : 0)
      : Math.max(weather?.rain || 0, weather?.snow || 0, weather?.accum || 0);
    wetSuppression = Math.max(0, Math.min(1, wet));
    uniforms.uFirefly.value = curFirefly * fade * (1 - wetSuppression) * lastCalm;
  }
  function applyPresentation() { group.visible = enabled && fade > 0.002; }
  function setEnabled(v) { enabled = !!v; applyPresentation(); }
  // 근접 링 활성/해제 크로스페이드(0..1). 시간대 애니와 독립적으로 최종 알파를 배율한다.
  function setFade(v) {
    fade = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    uniforms.uIntensity.value = curInt * fade;
    uniforms.uFirefly.value = curFirefly * fade * (1 - wetSuppression) * lastCalm;
    applyPresentation();
  }

  function setLensScale(value) {
    uniforms.uLensScale.value = normalizeVillageLensScale(value);
  }

  function dispose() {
    geo.dispose();
    worldDetail.dispose();
  }

  return {
    group, setTime, setSeason, setWeather, setEnabled, update, setFade, setLensScale, dispose,
    object,
  };
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
    if (!bulbs.length) return false;   // 등롱 몸체(bulb)만 있어도 흔들림 구동(light 는 선택 — #141 풀링 셀)
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
