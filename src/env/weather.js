import * as THREE from 'three';
import { makeRng } from '../rng.js';
import { getWind } from './wind.js';
import { captureRoofSurfaces } from './roofcapture.js';
import { createSnowVolume } from './snowvol.js';
import { createRainFlow } from './rainflow.js';
import { makePresenceGate } from './present-gate.js';
import { createPetalField } from './petals.js';

// 날씨 시뮬레이터 (눈·비).
//   setupWeather(scene, { layout, getBuilding, getGround })
//     → { setWeather(name, opts), update(dt), applyAtmosphere({mode}), onBuildingChanged(), dispose(), get weather() }
//   name: 'clear' | 'rain' | 'snow'
//
// 구현 방침:
//  - 강설/강우는 scene 에 직접 붙는 파티클(건물 재생성과 무관하게 유지).
//  - 지붕 적설은 건물 재질을 traverse 해 onBeforeCompile 로 "월드 노멀 상향" 기반
//    흰색 블렌딩을 주입 — 위를 향한 면(지붕·기단 윗면·난간 위)에만 눈이 쌓인다.
//    강도는 공유 uniform uSnowAmount(0~1) 로 제어, setWeather('snow') 시 수 초에 걸쳐
//    0→0.8 로 애니메이션. clear 전환 시 0 으로 복귀(원본 외형 회복).
//  - 젖은 재질은 roughness 를 원본*0.55 로 낮춘다(원복 관리).
//  - 처마 낙숫물은 layout 의 처마선(전/후 z=±zEave, 좌/우 x=±xEave, 높이 eaveEdgeY)을
//    직선 근사해 일정 간격으로 떨어지는 물방울 라인.

const TAU = Math.PI * 2;
const WEATHER_SEED = 0x5e450; // 결정론 시드 (snow/rain 배치 재현)

const SNOW_MAX = 0.82;   // 적설 최대 강도
const SNOW_TAU = 1.4;    // 눈 파티클 등장/소멸 페이드 시상수(초) — 수 초에 걸쳐 나타남
const RAIN_TAU = 0.9;    // 강우/젖음 페이드 시상수(초)
const WET_FACTOR = 0.45; // 젖음 시 roughness 감쇠(원본*(1-0.45))

// 적설 "쌓임"은 파티클 등장과 분리한다. 눈발은 수 초 안에 흩날리지만, 지붕·기단·지면이
// 희어지는 건 30~60초에 걸쳐 서서히 진행돼야 무드가 산다(team-lead 지시). accumLevel(0..1)이
// 그 진행도이며, 선형 램프로 오른다(이징은 앞이 급해 "즉시 하얘짐"으로 읽힘).
const ACCUM_UP = 46;     // 0→1 쌓이는 시간(초)
const ACCUM_DOWN = 16;   // 1→0 녹는 시간(초, 좀 더 빠르게)
const WET_DOWN = 3.0;    // 마당 젖음 회복 시간(초)

const SNOW_TINT = new THREE.Color(0xf3f6fa);   // 적설 색
const GROUND_SNOW = new THREE.Color(0xeaeef4); // 지면 적설 톤
const RAIN_FOG = new THREE.Color(0x39424e);    // 비 대기 색
const SNOW_FOG = new THREE.Color(0xccd2da);    // 눈 대기 색(밝은 흐림)
const WET_GROUND = new THREE.Color(0x6b6154);  // 젖은 마당(암부 톤다운) 목표색

// env 를 넘기면(권장) 대기 틴트 모디파이어를 env.addFogModifier 로 자동 등록해 시간대 크로스페이드
// 중에도 비/눈 fog 틴트가 씻기지 않고 레벨(페이드)로 합성된다(태스크 #50). 없으면 소비자가
// applyAtmosphere 를 직접 호출하는 기존 경로로 동작(하위호환).
export function setupWeather(scene, { layout, getBuilding, getGround, env = null, lowPerf = false }) {
  let L = layout;
  let name = 'clear';
  let roofColliders = []; // 지붕 충돌 박스 목록 (AABB Box3 배열)

  // 공유 적설 uniform — 모든 패치 재질이 같은 객체를 참조 → 한 번 갱신으로 전체 반영.
  const snowUniform = { value: 0 };

  // 이징 레벨(0..1). snowLevel → 눈발 파티클 가시성, rainLevel → 젖음/비 파티클.
  let snowLevel = 0, rainLevel = 0;
  let snowTarget = 0, rainTarget = 0;
  // bldGate(0..1): 건물 종속 FX(처마 낙수·기단/처마선 스플래시·적설 쉘·기왓골 리벌릿)가 "집이 실제로
  // 서고 조립이 정착한 뒤"에만 오르는 게이트(#61 로 #36 의 bldFx 를 지연 게이트로 일반화). 히어로 빈 터·
  // 리롤 조립 중엔 0 → 빈 터/골조 위에 이펙트가 먼저 뜨는 조기 노출을 막는다. 조립 완료 ~1.4s 뒤부터
  // 스멀스멀 오름("보상 신호"). 지면 스플래시·비 스트릭·낙하 눈발 파티클은 게이트 무관(하늘/지면 소속).
  // 기본 present 로 프라임 → shot·히어로 없는 로드는 첫 프레임부터 1(재현성 유지).
  const bldGate = makePresenceGate({ delay: 1.4, up: 1.6, down: 0.35 });
  let bldFx = 1;               // bldGate.value 캐시(매 틱 갱신)
  let lastBld = null;          // 건물 교체(리롤/유형변경) 감지 → 게이트 reset
  // accumLevel(0..1): 지붕·기단·지면에 눈이 "쌓인" 진행도. 눈발(snowLevel)과 분리돼 천천히 오른다.
  let accumLevel = 0;
  // pinnedAccum: shot 하네스(window.__wx.setAccum)로 특정 쌓임 단계를 고정할 때의 값(null=자유 진행).
  let pinnedAccum = null;

  let t = 0; // 누적 시간(파티클 흔들림/재순환·바람 위상용)

  // 하늘 입자 필드 중심(#98). 눈·비 낙하 박스는 원점 기준 ±boxHalf 로 좁게(밀도 유지) 두되, 이 중심을
  //   매 프레임 카메라 타깃으로 옮겨(setWeatherCenter) "보는 곳에 눈/비가 온다"를 보장한다. 단일건물은
  //   타깃≈원점이라 무변, 마을 부감/종가 클로즈업은 필지·마을 중심으로 따라간다. 낙하 파티클(snow.points·
  //   rain.lines)만 이설 — 처마 낙수·스플래시는 건물 앵커(월드 베이크)+bldFx 게이트라 불변.
  let fieldCX = 0, fieldCZ = 0;

  // 계절 입자 필드(#111): 봄 벚꽃·가을 낙엽의 카메라 추종 볼륨. 눈·비와 동일하게 scene 루트에 붙여
  //   env.group 은닉(마을 모드)을 우회하고, setWeatherCenter 로 카메라 타깃을 따라온다. season 은
  //   weather 로 직접 흐르지 않으므로(engine 은 env.setSeason 만 호출) env.setSeason → window.__wx.setSeason
  //   브릿지로 받는다. present(조기노출)·camDist(고도)는 아래 update/센터에서 판정해 넘긴다.
  let season = 'summer';
  let petalCamDist = NaN, petalCamY = null;
  // 꽃잎/낙엽 조기노출 게이트(#61): 원점 빈 터(단일건물 재생성 중)에선 억제, 씬이 정착하면 스멀스멀.
  //   present = 건물이 서 있거나(단일건물) 필드 중심이 원점을 벗어났을 때(마을 부감·focus·히어로 랜딩).
  //   마을에선 앱 building.visible=false 라 bldFx 로는 못 켜므로 centerAway 를 OR 로 함께 본다.
  const petalGate = makePresenceGate({ delay: 0.6, up: 1.2, down: 0.5 });
  let petalPresent = 1;

  // ---------- 파티클 시스템 ----------
  const snow = makeSnow();
  const rain = makeRain();
  const drips = makeDrips();
  const splash = makeSplashes();
  const petals = createPetalField({ getWind, lowPerf });
  scene.add(snow.points);
  scene.add(rain.lines);
  scene.add(drips.lines);
  scene.add(splash.points);
  scene.add(petals.points);

  // ── 볼륨 시뮬(태스크 #52) ──────────────────────────────────────────────
  // 셰이더 틴트(#21) 위에 "실제 두께의 눈 쉘 + 빗물 흐름"을 얹는다. 두께/성장은 이미 존재하는
  // accumLevel(눈)·rainLevel/wetLevel(비) 램프를 시뮬 입력으로 그대로 재사용(#50 트윈 정합).
  // 모바일 perf 프로파일·?snowvol=0 은 틴트만 남기는 폴백(볼륨 미생성). shot·데스크톱은 ON.
  const q52 = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const VOL = !lowPerf && q52.get('snowvol') !== '0';
  const snowVol = VOL ? createSnowVolume(scene, { getBuilding, getGround, layout: L }) : null;
  const rainFlow = VOL ? createRainFlow(scene, { layout: L }) : null;

  // 지붕 표면을 캡처해 눈 쉘·리벌릿 오버레이를 (재)구성한다. 초기 1회 + 건물 재생성마다.
  function rebuildVolume() {
    if (!VOL) return;
    const b2 = getBuilding && getBuilding();
    const surfaces = captureRoofSurfaces(b2);
    snowVol.setLayout(L); snowVol.rebuild(surfaces);
    rainFlow.setLayout(L); rainFlow.rebuild(surfaces);
  }

  // ---------- 재질 패치(적설/젖음) ----------
  // material.uuid → { mat, roughness } (원본 roughness 보관)
  let patched = new Map();
  // 지면 원본 색 보관
  let groundOrig = null;

  function collectMaterials() {
    for (const rec of patched.values()) rec.mat.roughness = rec.roughness; // 이전 것 원복
    patched = new Map();
    // 최신 레이아웃 반영(적설 패치는 씬 전체를 훑는다).
    const b = getBuilding && getBuilding();
    if (b && b.userData && b.userData.layout) L = b.userData.layout;
    // 씬 전체 traverse — 건물·지형·수목뿐 아니라 소품(석탑·석등·장독)·정자·돌다리·행각·문·
    // 바위 등 "그외 물체"의 위 향한 면에도 눈이 쌓이게 한다. MeshBasic(하늘돔·능선·안개·
    // 등불)·Line(비·낙숫물)·Shader(눈·스플래시·낙엽) 재질은 아래 가드로 자동 제외된다.
    scene.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        if (!m || !m.isMeshStandardMaterial) continue;
        if (patched.has(m.uuid)) continue;
        patchSnow(m);
        patched.set(m.uuid, { mat: m, roughness: m.roughness });
      }
    });
  }

  function patchSnow(m) {
    if (m.userData && m.userData.__snowPatched) return;
    m.userData = m.userData || {};
    m.userData.__snowPatched = true;
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (shader, r) => {
      if (prev) prev(shader, r);
      shader.uniforms.uSnowAmount = snowUniform; // 공유 참조
      // 양면(DoubleSide) 셸인지 컴파일 시 확정해 GLSL 상수로 주입. 지붕면은 전부 DoubleSide.
      const twoSided = m.side === THREE.DoubleSide ? '1.0' : '0.0';
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSnowWN;\nvarying vec3 vSnowWP;')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvSnowWN = mat3(modelMatrix) * objectNormal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSnowWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSnowWN;\nvarying vec3 vSnowWP;\nuniform float uSnowAmount;\nfloat snowCov = 0.0;\nfloat snowFix = 0.0;')
        // 라이팅 노멀 교정: 양면 지붕 셸 중 정점 노멀이 아래로 뒤집힌 면(궁·절 우측·후면 지붕면
        // — computeVertexNormals 와인딩 탓)은 위 향한 면으로 라이팅되게 노멀을 세운다. 이렇게
        // 해야 흰 적설 diffuse 에 어두운 빛이 곱해져 남색으로 남던 문제가 라이팅 단계에서 해소되고
        // 주간=밝게/야간=달빛대로 자연히 셰이딩된다. 눈 올 때만·아래 향한 지붕면만 → 맑음/벽 무영향.
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 swn = normalize(vSnowWN);
          float fixup = ${twoSided} * step(swn.y, -0.05)
                      * smoothstep(0.30, 0.55, abs(swn.y))
                      * smoothstep(0.0, 0.20, uSnowAmount);
          vec3 vUp = normalize((viewMatrix * vec4(-swn, 0.0)).xyz);
          normal = normalize(mix(normal, vUp, fixup));
          snowFix = fixup; // 그늘 리프트에서 재사용(뒤집힌 눈 덮인 지붕면 기하 게이트)
        }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 wn = normalize(vSnowWN);
          // 양면 셸(지붕면)은 computeVertexNormals 와인딩에 따라 정점 노멀이 아래로 뒤집힐 수
          // 있다(궁·절 우측·후면 지붕면 등). 그런 면은 |y|로 위 향함을 판정해 부호와 무관하게
          // 적설이 걸리게 한다. 단면(FrontSide) 재질은 부호 그대로 써서 처마 밑면·서까래
          // 아랫면 등 진짜 아래 향한 면에는 눈이 앉지 않게 한다.
          float ny = mix(wn.y, abs(wn.y), ${twoSided});
          // 쌓임이 진행될수록 눈이 걸리는 경계가 내려간다: 처음엔 평평한 윗면만, 나중엔
          // 경사진 지붕면·기왓골까지 덮인다 → "서서히 쌓이는" 시간감이 노멀 기준으로 읽힌다.
          float thresh = mix(0.72, 0.20, uSnowAmount);
          float up = smoothstep(thresh - 0.10, thresh + 0.18, ny);
          // 기왓골: 월드 좌표 저주파 줄무늬로 골과 마루의 적설 편차(스타일라이즈).
          float ridge = 0.5 + 0.5 * sin(vSnowWP.x * 3.0 + vSnowWP.z * 0.6);
          float blotch = 0.55 + 0.45 * sin(vSnowWP.x * 1.3) * sin(vSnowWP.z * 1.7);
          // 두꺼운 "바닥눈"은 실제로 위 향한 수평면(부호 있는 wn.y)에만 — 뒤집힌/아래 향한
          // 양면 셸이 바닥눈으로 오인돼 밑면이 하얘지는 것 방지. 경사 지붕면은 골 편차 유지.
          float flatFace = smoothstep(0.80, 0.97, wn.y);
          float slopeCov = (0.72 + 0.28 * blotch) * (0.86 + 0.14 * ridge); // 얇을 땐 골 편차 유지
          float floorCov = 0.90 + 0.10 * blotch;                            // 수평면: 두껍게
          // 눈이 두꺼워질수록(thick) 골/얼룩 편차를 죽여 균일하게 덮는다 → 두꺼운 눈이 기왓골
          // corrugation 을 메워, 그늘진 면이 "얇은 눈+골 줄무늬"가 아니라 균일한 눈면으로 읽힘.
          float thick = smoothstep(0.35, 0.85, uSnowAmount);
          slopeCov = mix(slopeCov, 0.98, thick * 0.85);
          float cov = up * mix(slopeCov, floorCov, flatFace);
          cov *= smoothstep(0.0, 0.14, uSnowAmount); // 극초기엔 티끌도 없음
          cov = clamp(cov, 0.0, 1.0);
          snowCov = cov;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.95, 0.96, 0.98), cov);
        }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.96, snowCov);`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.0, snowCov);`)
        // 그늘진 눈면 미드톤 리프트: 노멀 교정 대상(뒤집혀 어둡게 셰이딩되는 눈 덮인 지붕면 —
        // 동측 하합각 등)만 곱연산으로 살짝 밝혀 전면 눈과의 밝기 이질감(약 40%→15~20%)을 줄인다.
        // 기하 게이트(snowFix)라 색공간·라이팅 무관하게 그 면만 정확히 잡고, 밝은 전면·벽은 무변화,
        // 곱연산+국소라 야간 무드 유지(화이트아웃 없음). post 톤매핑이 뒤에서 다시 압축.
        .replace('#include <dithering_fragment>', `{
          gl_FragColor.rgb *= 1.0 + snowFix * snowCov * 1.05;
        }
        #include <dithering_fragment>`);
    };
    m.needsUpdate = true;
  }

  function applyWetness() {
    for (const rec of patched.values()) {
      // 적설 볼륨 재질(customProgramCacheKey 가 'snowvol_' 로 시작)은 젖음 감쇠(roughness 깎기)에서 제외합니다.
      const hasCustom = typeof rec.mat.customProgramCacheKey === 'function';
      const key = hasCustom ? rec.mat.customProgramCacheKey() : '';
      if (key && key.startsWith('snowvol_')) {
        continue;
      }
      rec.mat.roughness = rec.roughness * (1.0 - WET_FACTOR * rainLevel);
    }
  }

  // 마당 색: 눈이면 쌓임(accumLevel)만큼 희어지고, 비면 젖어서 어두워진다(암부 톤다운).
  let wetLevel = 0; // 마당 젖음 진행도(0..1) — 비 시작 후 서서히 올라 개면 서서히 마름.
  function applyGround() {
    const g = getGround && getGround();
    if (!g || !g.material || !g.material.color) return;
    if (!groundOrig) groundOrig = g.material.color.clone();
    const c = g.material.color.copy(groundOrig);
    if (snowTarget > 0 || accumLevel > 0.001) {
      c.lerp(GROUND_SNOW, accumLevel * 0.92);
    } else if (wetLevel > 0.001) {
      c.lerp(WET_GROUND, wetLevel * 0.55);
    }
  }

  // ---------- 대기 오버레이 ----------
  // reapplyEnvBase → refreshAppearance 뒤에 호출되어 신선한 base fog/bg 위에 한 번 물든다(멱등).
  // env-OFF(폴백 fog)·ink 폴백 경로용 즉시 적용(전강도). env-ON pbr 에서는 env.addFogModifier 로
  // 등록한 applyAtmosphereScaled 가 매 틱 rainLevel/snowLevel 로 스케일해 크로스페이드한다(태스크 #50).
  function applyAtmosphere({ mode } = {}) {
    if (mode === 'ink') return;           // 수묵은 종이색 fog 유지
    if (name === 'clear' || !scene.fog) return;
    const fog = scene.fog;
    if (name === 'rain') {
      fog.color.lerp(RAIN_FOG, 0.42);
      fog.far *= 0.7;
      if (scene.background && scene.background.isColor) scene.background.lerp(RAIN_FOG, 0.42);
    } else if (name === 'snow') {
      fog.color.lerp(SNOW_FOG, 0.4);
      fog.far *= 0.82;
      if (scene.background && scene.background.isColor) scene.background.lerp(SNOW_FOG, 0.4);
    }
  }

  // env fog 모디파이어(태스크 #50): env 가 매 틱 base fog 를 리셋한 뒤 호출한다. 비/눈 대기 틴트를
  // rainLevel/snowLevel(파티클과 함께 페이드)로 스케일 → fog 가 파티클과 동조해 서서히 물든다.
  // 멱등(매 틱 fresh base 위 적용). name 이 아닌 레벨로 게이트해 비↔눈·개임 전환도 자연 크로스페이드.
  function applyAtmosphereScaled(scn) {
    const fog = scn && scn.fog;
    if (!fog) return;
    if (rainLevel > 0.001) {
      fog.color.lerp(RAIN_FOG, 0.42 * rainLevel);
      fog.far *= (1 - 0.30 * rainLevel);
      if (scn.background && scn.background.isColor) scn.background.lerp(RAIN_FOG, 0.42 * rainLevel);
    }
    if (snowLevel > 0.001) {
      fog.color.lerp(SNOW_FOG, 0.4 * snowLevel);
      fog.far *= (1 - 0.18 * snowLevel);
      if (scn.background && scn.background.isColor) scn.background.lerp(SNOW_FOG, 0.4 * snowLevel);
    }
  }

  // ---------- 공개 API ----------
  function setWeather(n, opts = {}) {
    name = (n === 'rain' || n === 'snow') ? n : 'clear';
    snowTarget = name === 'snow' ? 1 : 0;
    rainTarget = name === 'rain' ? 1 : 0;
    if (opts.immediate) {
      snowLevel = snowTarget;
      rainLevel = rainTarget;
      // 즉시 모드(shot): 쌓임·젖음도 목표까지 채운다. opts.accum(0..1) 로 특정 단계를 지정하면
      // 그 진행도로 고정(시간 경과 비교 컷용).
      accumLevel = snowTarget > 0 ? (opts.accum != null ? opts.accum : 1) : 0;
      wetLevel = rainTarget;
      snowUniform.value = accumLevel * SNOW_MAX;
      applyWetness();
      applyGround();
    }
  }

  function onBuildingChanged() {
    collectMaterials();
    snowUniform.value = accumLevel * SNOW_MAX; // 새 재질에 현재 적설 즉시 반영
    applyWetness();
    rebuildDrips();
    splash.rebuild();
    rebuildVolume();                            // 새 지붕 지오로 눈 쉘·리벌릿 재구성(#52)
  }

  function update(dt) {
    t += dt;
    // 눈발·비 파티클 가시성은 빠르게(수 초) 페이드.
    // 비↔눈 교차는 겹침 없이 순차(태스크 #50): 들어오는 강수는 나가는 강수가 옅어진(≤0.15) 뒤에
    //   오른다 — clear↔단일 전환은 지연 없음(반대 강수 레벨이 0이라 즉시 목표 추종).
    const effSnowTarget = (snowTarget > 0 && rainLevel > 0.15) ? 0 : snowTarget;
    const effRainTarget = (rainTarget > 0 && snowLevel > 0.15) ? 0 : rainTarget;
    snowLevel += (effSnowTarget - snowLevel) * Math.min(1, dt / SNOW_TAU);
    rainLevel += (effRainTarget - rainLevel) * Math.min(1, dt / RAIN_TAU);

    // 건물 종속 FX 지연 게이트(#61): 집이 보이고(building.visible) 조립이 정착한 뒤에만 오른다.
    // 건물 교체(리롤/유형변경)는 reset 으로 0 스냅 후 지연 재상승 → 조립 중 빈 골조 위 조기 노출 차단.
    const bObj = getBuilding && getBuilding();
    const bldReset = bObj !== lastBld; lastBld = bObj;
    const present = !!(bObj && bObj.visible);
    bldFx = bldGate.update(dt, { present, reset: bldReset });

    // 적설 쌓임은 선형 램프로 천천히(올라갈 땐 ~46s, 녹을 땐 ~16s). shot 하네스가 고정하면 그 값 유지.
    if (pinnedAccum != null) {
      accumLevel = pinnedAccum;
    } else if (snowTarget > 0) {
      accumLevel = Math.min(1, accumLevel + dt / ACCUM_UP);
    } else {
      accumLevel = Math.max(0, accumLevel - dt / ACCUM_DOWN);
    }
    snowUniform.value = accumLevel * SNOW_MAX;

    // 마당 젖음: 비 오는 동안 서서히 젖고, 개면 서서히 마른다.
    const wetTarget = rainTarget;
    wetLevel += (wetTarget - wetLevel) * Math.min(1, dt / (wetTarget > wetLevel ? RAIN_TAU * 2.2 : WET_DOWN));

    applyWetness();
    applyGround();

    // 파티클 가시성/갱신
    const snowVis = snowLevel > 0.003;
    const rainVis = rainLevel > 0.003;
    // 처마 낙수는 전량 건물 종속 → bldFx 로 게이트(빈 터에선 0). 스플래시는 지면분(상시)과
    // 건물분(기단·처마선)이 한 지오메트리에 섞여 있어 uBldFade 유니폼으로 건물분만 페이드한다.
    const dripVis = rainVis && bldFx > 0.02;
    snow.points.visible = snowVis;
    rain.lines.visible = rainVis;
    drips.lines.visible = dripVis;
    splash.points.visible = rainVis;
    if (snowVis) snow.update(dt, t, snowLevel);
    if (rainVis) { rain.update(dt, t, rainLevel); splash.update(dt, t, rainLevel, bldFx); }
    if (dripVis) drips.update(dt, t, rainLevel * bldFx);

    // 계절 입자(봄 꽃잎·가을 낙엽): 조기노출 게이트(원점 빈 터 억제) + 카메라 추종 볼륨. 눈·비처럼
    //   하늘/대기 소속이라 accumLevel·rainLevel 과 무관하게 season 이 spring/autumn 이면 발현한다.
    //   present = 건물 존재(단일건물) OR 필드가 원점을 벗어남(마을·focus·히어로) — bldGate 와 별개
    //   페이드(petalGate)로 원점 빈 터 조립 전엔 0, 씬 정착 후 오른다. 고도 게이트는 petals 내부(camDist).
    const petalPresentRaw = present || Math.abs(fieldCX) > 8 || Math.abs(fieldCZ) > 8;
    petalPresent = petalGate.update(dt, { present: petalPresentRaw, reset: bldReset && !petalPresentRaw });
    petals.update(dt, { t, camDist: petalCamDist, camY: petalCamY, present: petalPresent, wind: getWind(t) });

    // 볼륨 시뮬: 눈 쉘은 accumLevel(쌓임 진행)로, 빗물은 rainLevel/wetLevel 로 구동.
    // 건물 종속분(지붕 눈 쉘·기단 두둑·기왓골 리벌릿)은 bldFx 로 게이트 → 조립 전 빈 터/골조엔 안 뜬다(#61).
    // 눈 쉘 두께는 accum*bldFx 로 전달해 "지붕이 정착하면 눈이 서서히 쌓이는" 인과로 자란다.
    // 지면 웅덩이(wet)·낙하 눈발/빗줄기 파티클은 하늘/지면 소속이라 게이트 없이 유지.
    if (VOL) {
      const snowActive = accumLevel > 0.004 || snowLevel > 0.004;
      snowVol.setVisible(snowActive);
      if (snowActive) snowVol.update(dt, { accum: accumLevel * bldFx, t, wind: getWind(t) });
      const rainActive = rainLevel > 0.004 || wetLevel > 0.004;
      rainFlow.setVisible(rainActive);
      if (rainActive) rainFlow.update(dt, { rain: rainLevel * bldFx, wet: wetLevel, t });
    }
  }

  // shot 하네스 훅: 특정 쌓임 단계로 고정(시간 경과 비교 컷). v=null 이면 자유 진행 복귀.
  // main.js 무수정으로 촬영 재현성을 얻기 위해 weather 모듈이 직접 window 에 노출한다.
  function setAccum(v) {
    pinnedAccum = v;
    if (v != null) { accumLevel = v; snowUniform.value = accumLevel * SNOW_MAX; applyGround(); }
  }
  if (typeof window !== 'undefined') {
    window.__wx = {
      setAccum, get accum() { return accumLevel; }, get wind() { return getWind(t); },
      // 낙설 이벤트 훅(#52): triggerSlip()=지금 1회 발생, setSlip(p)=진행도 p(0..1)로 고정(shot 중간 컷),
      //   setSlip(null)=고정 해제. vol=볼륨 시뮬 활성 여부.
      triggerSlip: () => { if (VOL) snowVol.fireSlip(t); },
      setSlip: (p) => { if (VOL) snowVol.setSlip(p); },
      get vol() { return VOL; },
      // 이징된 강수 레벨(0..1) — 외부 소비자(post 렌즈 플레어 등)가 엔진 배선 없이 읽는 읽기 전용 신호.
      get rain() { return rainLevel; },
      get snow() { return snowLevel; },
      // 계절 입자 필드(#111): env.setSeason 이 이 브릿지로 season 을 전달(engine 은 weather 에 season 미전달).
      //   'spring'|'autumn' 만 꽃잎/낙엽 발현. 읽기 전용 petalLevel 로 검증/외부 소비.
      setSeason: (name) => { season = name; petals.setSeason(name); },
      get petalLevel() { return petals.level; },
    };
  }

  function dispose() {
    for (const rec of patched.values()) rec.mat.roughness = rec.roughness;
    const g = getGround && getGround();
    if (g && groundOrig) g.material.color.copy(groundOrig);
    snowUniform.value = 0;
    for (const sys of [snow, rain, drips, splash]) {
      scene.remove(sys.points || sys.lines);
      (sys.points || sys.lines).geometry.dispose();
      (sys.points || sys.lines).material.dispose();
    }
    scene.remove(petals.points); petals.dispose();   // 계절 입자 필드(#111)
    if (VOL) { snowVol.dispose(); rainFlow.dispose(); }
    if (typeof window !== 'undefined' && window.__wx) delete window.__wx;
  }

  // 초기 재질 수집
  collectMaterials();
  // 초기 볼륨 구성(첫 건물 — onBuildingChanged 이전 최초 로드 경로). L 은 collectMaterials 가 실제
  // 건물 layout 으로 갱신한 값을 쓴다.
  rebuildVolume();

  // env fog 모디파이어 자동 등록(태스크 #50): 넘겨받았으면 대기 틴트를 매 틱 base fog 위에 레벨
  // 스케일로 합성. weather 는 앱 수명 내내 살아있으므로 해제 불필요.
  if (env && typeof env.addFogModifier === 'function') env.addFogModifier(applyAtmosphereScaled);

  // ---------- 파티클 팩토리 ----------
  function boxHalf() { return 46; }
  function yTop() { return (L.totalH || 20) + 34; }
  function yBottom() { return -1.0; }

  function makeSnow() {
    const rng = makeRng(WEATHER_SEED ^ 0x1111);
    const N = 3600;
    const half = boxHalf(), yb = yBottom(), H = yTop() - yb;
    const pos = new Float32Array(N * 3);
    const aSize = new Float32Array(N);
    const aOpacity = new Float32Array(N);
    const bx = new Float32Array(N), bz = new Float32Array(N);
    const spd = new Float32Array(N), phase = new Float32Array(N), sway = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      bx[i] = (rng() * 2 - 1) * half;
      bz[i] = (rng() * 2 - 1) * half;
      pos[i * 3 + 1] = yb + rng() * H;
      spd[i] = rng.range(2.4, 6.0);
      phase[i] = rng() * TAU;
      sway[i] = rng.range(0.3, 1.1);
      aSize[i] = rng.range(1.1, 2.7);
      aOpacity[i] = rng.range(0.45, 1.0);
      pos[i * 3] = bx[i];
      pos[i * 3 + 2] = bz[i];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
    geo.setAttribute('aOpacity', new THREE.BufferAttribute(aOpacity, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uFade: { value: 0 }, uScale: { value: 340 } },
      transparent: true, depthWrite: false,
      vertexShader: `
        attribute float aSize;
        attribute float aOpacity;
        uniform float uScale;
        varying float vOp;
        void main() {
          vOp = aOpacity;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * (uScale / max(-mv.z, 1.0));
        }`,
      fragmentShader: `
        uniform float uFade;
        varying float vOp;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          float a = smoothstep(0.5, 0.12, d) * vOp * uFade;
          if (a < 0.01) discard;
          gl_FragColor = vec4(1.0, 1.0, 1.0, a);
        }`,
    });
    const points = new THREE.Points(geo, mat);
    points.name = 'weatherSnow';
    points.frustumCulled = false;
    points.renderOrder = 20;
    points.visible = false;
    const posAttr = geo.attributes.position;
    const WIND_CARRY = 7.0;   // 눈은 가벼워 바람에 크게 실려간다(횡류 계수)
    function update(dt, tt, level) {
      mat.uniforms.uFade.value = level;
      const w = getWind(tt);
      const wx = w.dirX * w.speed, wz = w.dirZ * w.speed;
      // 거스트가 불면 낙하가 눕고 난류가 커진다 → 흩날림이 격해진다.
      const swirl = 1.0 + w.gust * 2.6;
      const fall = 0.85 + 0.15 * (1 - Math.min(1, w.speed)); // 강풍일수록 수직 낙하 완화(옆으로 감)
      const arr = posAttr.array;
      for (let i = 0; i < N; i++) {
        let px = arr[i * 3];
        let py = arr[i * 3 + 1] - spd[i] * fall * dt;
        let pz = arr[i * 3 + 2];

        // 지붕 충돌 검사(월드 좌표 — 필드가 카메라 타깃으로 이설돼 있으면 fieldC 를 더해 월드로 환산).
        let hit = false;
        if (!lowPerf) {
          const wx2 = px + fieldCX, wz2 = pz + fieldCZ;
          for (let j = 0; j < roofColliders.length; j++) {
            const b = roofColliders[j];
            if (wx2 >= b.min.x && wx2 <= b.max.x &&
                wz2 >= b.min.z && wz2 <= b.max.z &&
                py >= b.min.y && py <= b.max.y) {
              hit = true;
              break;
            }
          }
        }

        if (hit) {
          py = yTop() - Math.random() * 4.0;
          bx[i] = (Math.random() * 2 - 1) * half;
          bz[i] = (Math.random() * 2 - 1) * half;
        } else if (py < yb) {
          py += H;
        }
        arr[i * 3 + 1] = py;
        // 기저 위치를 바람 방향으로 실어 나른다(박스 안에서 랩). 순환 유지하며 "부는 눈".
        bx[i] += wx * WIND_CARRY * dt;
        bz[i] += wz * WIND_CARRY * dt;
        if (bx[i] > half) bx[i] -= 2 * half; else if (bx[i] < -half) bx[i] += 2 * half;
        if (bz[i] > half) bz[i] -= 2 * half; else if (bz[i] < -half) bz[i] += 2 * half;
        arr[i * 3] = bx[i] + Math.sin(tt * 0.6 + phase[i]) * sway[i] * swirl
          + Math.sin(tt * 1.9 + phase[i] * 2.1) * 0.6 * w.gust;
        arr[i * 3 + 2] = bz[i] + Math.cos(tt * 0.45 + phase[i]) * sway[i] * 0.6 * swirl;
      }
      posAttr.needsUpdate = true;
    }
    return { points, update };
  }

  function makeRain() {
    const rng = makeRng(WEATHER_SEED ^ 0x2222);
    const N = 2600;
    const half = boxHalf(), yb = yBottom(), H = yTop() - yb;
    const pos = new Float32Array(N * 2 * 3);
    const x = new Float32Array(N), z = new Float32Array(N), y = new Float32Array(N);
    const spd = new Float32Array(N), len = new Float32Array(N);
    let leanX = 0.14, leanZ = 0.05; // 낙하 streak 의 수평 기울기 — 매 프레임 바람으로 갱신.
    for (let i = 0; i < N; i++) {
      x[i] = (rng() * 2 - 1) * half;
      z[i] = (rng() * 2 - 1) * half;
      y[i] = yb + rng() * H;
      spd[i] = rng.range(30, 46);
      len[i] = rng.range(1.4, 2.6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xbccde0, transparent: true, opacity: 0.3, depthWrite: false,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.name = 'weatherRain';
    lines.frustumCulled = false;
    lines.renderOrder = 21;
    lines.visible = false;
    function writeDrop(i) {
      const o = i * 6;
      const L2 = len[i];
      // streak 는 낙하 속도벡터(수직 -1 + 바람 수평)의 반대로 뻗어 위쪽으로 끌린다.
      pos[o] = x[i];               pos[o + 1] = y[i];       pos[o + 2] = z[i];
      pos[o + 3] = x[i] - leanX * L2; pos[o + 4] = y[i] - L2; pos[o + 5] = z[i] - leanZ * L2;
    }
    for (let i = 0; i < N; i++) writeDrop(i);
    const half2 = half;
    function update(dt, tt, level) {
      mat.opacity = 0.3 * level;
      const w = getWind(tt);
      // 비는 눈보다 무거워 바람 영향이 작다. 수평 성분/낙하속도 ≈ streak 기울기.
      const wx = w.dirX * w.speed, wz = w.dirZ * w.speed;
      leanX = wx * 3.4 / 38; leanZ = wz * 3.4 / 38; // 38≈평균 낙하속도 → streak 기울기 정규화
      const driftX = wx * 6.5, driftZ = wz * 6.5;    // 낙하하며 옆으로 밀린다
      for (let i = 0; i < N; i++) {
        y[i] -= spd[i] * dt;
        x[i] += driftX * dt; z[i] += driftZ * dt;

        // 지붕 충돌 검사(월드 좌표 — 필드 이설분 fieldC 를 더해 환산).
        let hit = false;
        if (!lowPerf) {
          const wx2 = x[i] + fieldCX, wz2 = z[i] + fieldCZ;
          for (let j = 0; j < roofColliders.length; j++) {
            const b = roofColliders[j];
            if (wx2 >= b.min.x && wx2 <= b.max.x &&
                wz2 >= b.min.z && wz2 <= b.max.z &&
                y[i] >= b.min.y && y[i] <= b.max.y) {
              hit = true;
              break;
            }
          }
        }

        if (hit) {
          y[i] = yTop() - Math.random() * 4.0;
          x[i] = (Math.random() * 2 - 1) * half2;
          z[i] = (Math.random() * 2 - 1) * half2;
        } else if (y[i] < yb) {
          y[i] += H;
        }
        if (x[i] > half2) x[i] -= 2 * half2; else if (x[i] < -half2) x[i] += 2 * half2;
        if (z[i] > half2) z[i] -= 2 * half2; else if (z[i] < -half2) z[i] += 2 * half2;
        writeDrop(i);
      }
      geo.attributes.position.needsUpdate = true;
    }
    return { lines, update };
  }

  function makeDrips() {
    const mat = new THREE.LineBasicMaterial({
      color: 0xaccbe0, transparent: true, opacity: 0.5, depthWrite: false,
    });
    const lines = new THREE.LineSegments(new THREE.BufferGeometry(), mat);
    lines.name = 'weatherDrips';
    lines.frustumCulled = false;
    lines.renderOrder = 22;
    lines.visible = false;
    let ax = new Float32Array(0), az = new Float32Array(0), y = new Float32Array(0);
    let spd = new Float32Array(0), len = new Float32Array(0);
    let gper = new Float32Array(0), gph = new Float32Array(0); // 간헐 낙수 주기·위상
    let pos = new Float32Array(0);
    let N = 0;
    let topY = 6, botY = 0;
    let leanX = 0; // 바람에 의한 낙수 줄기 살짝 기울기

    function build() {
      const rng = makeRng(WEATHER_SEED ^ 0x3333);
      const xE = L.xEave ?? 9, zE = L.zEave ?? 6;
      topY = L.eaveEdgeY ?? 6.5;
      botY = 0;
      const spacing = 1.15;
      const anchors = [];
      // 전/후 처마선 (x 스캔)
      for (let s = -1; s <= 1; s += 2) {
        for (let px = -xE; px <= xE; px += spacing) anchors.push([px, s * zE]);
      }
      // 좌/우 처마선 (z 스캔)
      for (let s = -1; s <= 1; s += 2) {
        for (let pz = -zE + spacing; pz <= zE - spacing; pz += spacing) anchors.push([s * xE, pz]);
      }
      N = anchors.length;
      ax = new Float32Array(N); az = new Float32Array(N); y = new Float32Array(N);
      spd = new Float32Array(N); len = new Float32Array(N);
      gper = new Float32Array(N); gph = new Float32Array(N);
      pos = new Float32Array(N * 6);
      for (let i = 0; i < N; i++) {
        ax[i] = anchors[i][0] + rng.range(-0.15, 0.15);
        az[i] = anchors[i][1] + rng.range(-0.15, 0.15);
        y[i] = botY + rng() * (topY - botY);   // 위상 분산
        spd[i] = rng.range(9, 16);
        len[i] = rng.range(0.35, 0.7);
        gper[i] = rng.range(1.6, 3.4);          // 낙수 방울이 맺혔다 떨어지는 주기(초)
        gph[i] = rng();                          // 앵커별 위상 — 처마 전체가 동시에 안 떨어지게
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      lines.geometry.dispose();
      lines.geometry = geo;
      for (let i = 0; i < N; i++) writeDrip(i, 0);
      geo.attributes.position.needsUpdate = true;
    }
    function writeDrip(i, tt) {
      const o = i * 6;
      // 간헐: 주기 안에서 앞쪽 55% 구간만 낙수 활성. 나머지는 방울이 맺히는 중(비가시).
      const cyc = ((tt / gper[i] + gph[i]) % 1 + 1) % 1;
      if (cyc > 0.55) { pos[o] = pos[o + 3] = ax[i]; pos[o + 1] = pos[o + 4] = topY; pos[o + 2] = pos[o + 5] = az[i]; return; }
      pos[o] = ax[i];              pos[o + 1] = y[i];          pos[o + 2] = az[i];
      pos[o + 3] = ax[i] - leanX * len[i]; pos[o + 4] = y[i] - len[i]; pos[o + 5] = az[i];
    }
    function update(dt, tt, level) {
      mat.opacity = 0.5 * level;
      const w = getWind(tt);
      leanX = w.dirX * w.speed * 0.25;
      for (let i = 0; i < N; i++) {
        y[i] -= spd[i] * dt;
        if (y[i] < botY) y[i] = topY;
        writeDrip(i, tt);
      }
      lines.geometry.attributes.position.needsUpdate = true;
    }
    build();
    return { lines, update, rebuild: build };
  }
  function rebuildDrips() { drips.rebuild(); }

  // 빗방울/낙수가 "착지"할 때 튀는 스플래시. 착지점마다 작은 물방울 도트가 위로+밖으로
  // 튀어 포물선으로 떨어지는 크라운 + 그 아래 은은한 파문 링으로 구성(파티클/도트 감성).
  // 착지 표면(마당 지면 · 기단 상면 · 처마 낙수 착지선)에만 앵커를 흩뿌리고, 앵커 하나가
  // 결정론 위상으로 순환한다. 물이 "떠나는" 처마 끝·지붕면 공중에는 스폰하지 않는다.
  function makeSplashes() {
    const DROPS = 4; // 앵커당 물방울 도트 수(크라운)
    const geo = new THREE.BufferGeometry();
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uFade: { value: 0 }, uPix: { value: 260 }, uBldFade: { value: 1 } },
      transparent: true, depthWrite: false,
      vertexShader: `
        attribute float aPhase;
        attribute float aPeriod;
        attribute float aScale;
        attribute vec3 aDrop;   // xy=수평 비행(밖으로), z=솟는 높이. 파문은 0.
        attribute float aKind;  // 0=파문 링, 1=물방울 도트
        attribute float aBuilding; // 1=건물 종속(기단·처마선), 0=지면(상시)
        uniform float uTime;
        uniform float uPix;
        varying float vLife;
        varying float vKind;
        varying float vBuilding;
        void main() {
          float lt = fract(uTime / aPeriod + aPhase);
          vLife = lt; vKind = aKind; vBuilding = aBuilding;
          vec3 p = position;
          if (aKind > 0.5) {
            // 물방울: 밖으로 퍼지며 포물선(솟았다 낙하)
            p.x += aDrop.x * lt;
            p.z += aDrop.y * lt;
            p.y += aDrop.z * lt * (1.0 - lt) * 4.0;
          }
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float grow = (aKind > 0.5) ? (1.1 - 0.5 * lt) : sqrt(lt); // 도트=살짝 축소, 파문=팽창
          gl_PointSize = aScale * grow * (uPix / max(-mv.z, 1.0));
        }`,
      fragmentShader: `
        uniform float uFade;
        uniform float uBldFade;
        varying float vLife;
        varying float vKind;
        varying float vBuilding;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          float a;
          if (vKind > 0.5) {
            // 물방울: 작고 반짝 튀는 도트(액센트) — 낮은 알파, 작은 코어
            a = smoothstep(0.5, 0.18, d) * (1.0 - smoothstep(0.55, 1.0, vLife)) * 0.5;
          } else {
            // 파문: 팽창하는 링(주) — 물이 표면에 닿는 읽기. 살짝 넓은 밴드로 원거리서도 보이게.
            float ring = smoothstep(0.5, 0.40, d) - smoothstep(0.36, 0.20, d);
            a = ring * (1.0 - vLife) * 0.72;
          }
          a *= uFade;
          a *= mix(1.0, uBldFade, vBuilding); // 건물 종속(기단·처마선) 스플래시는 집이 없을 때 소거
          if (a < 0.02) discard;
          gl_FragColor = vec4(0.88, 0.93, 0.99, a);
        }`,
    });
    const points = new THREE.Points(geo, mat);
    points.name = 'weatherSplash';
    points.frustumCulled = false;
    points.renderOrder = 23;
    points.visible = false;

    function build() {
      const rng = makeRng(WEATHER_SEED ^ 0x4444);
      const xE = L.xEave ?? 9, zE = L.zEave ?? 6;
      const wallHX = (L.W ?? 12) / 2, wallHZ = (L.D ?? 8) / 2;
      const podY = L.podTopY ?? 1.0;   // 기단 상면 높이(평방 윗면 plateY 아님!)
      // 착지 표면만: ① 마당 지면(원반) ② 기단 상면 둘레 링 ③ 처마 낙수 착지선(지면).
      // 크라운 밀도는 드문드문 — 팝콘 밭이 아니라 톡톡 튀는 물방울.
      const nGround = 165, nPodium = 52, nEave = 83;
      const nAnchor = nGround + nPodium + nEave;
      const N = nAnchor * (1 + DROPS); // 앵커당 파문 1 + 물방울 DROPS
      const pos = new Float32Array(N * 3);
      const aPhase = new Float32Array(N);
      const aPeriod = new Float32Array(N);
      const aScale = new Float32Array(N);
      const aDrop = new Float32Array(N * 3);
      const aKind = new Float32Array(N);
      const aBuilding = new Float32Array(N); // 0=지면(상시) / 1=건물 종속(기단·처마선)
      let k = 0;
      let bflag = 0; // 현재 앵커 그룹의 건물 종속 여부(put 루프 사이에 토글)
      // 한 착지점 = 파문 링 1 + 물방울 도트 DROPS (같은 위상·주기로 함께 튄다)
      const put = (x, y, z, ripLo, ripHi, spread, rise, perLo, perHi) => {
        const ph = rng();
        const per = rng.range(perLo ?? 0.55, perHi ?? 1.1); // 짧은 수명(빠른 튐)
        const emit = (kind, sc, dx, dy, dz) => {
          pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
          aPhase[k] = ph; aPeriod[k] = per; aScale[k] = sc;
          aDrop[k * 3] = dx; aDrop[k * 3 + 1] = dy; aDrop[k * 3 + 2] = dz;
          aKind[k] = kind; aBuilding[k] = bflag; k++;
        };
        emit(0, rng.range(ripLo, ripHi), 0, 0, 0); // 파문
        for (let j = 0; j < DROPS; j++) {
          const th = (j + rng() * 0.7) / DROPS * TAU;
          const rad = rng.range(0.5, 1.0) * spread;
          const h = rng.range(0.5, 1.0) * rise;
          emit(1, rng.range(1.2, 2.0), Math.cos(th) * rad, Math.sin(th) * rad, h);
        }
      };
      // ① 마당 지면: 기단 밖에서 시작하는 원반(가까울수록 조밀). 지면 높이에서 튄다.
      //    지면분은 집 유무와 무관(빈 터에서도 비는 땅에 튄다) → bflag=0 유지.
      bflag = 0;
      for (let i = 0; i < nGround; i++) {
        const rr = (xE + 1.0) + Math.pow(rng(), 0.7) * 20;
        const th = rng.range(0, TAU);
        put(Math.cos(th) * rr, 0.05, Math.sin(th) * rr, 4.5, 9, 0.9, 0.6);
      }
      // ② 기단 상면(툇마루/월대 돌바닥): 건물 벽선 바로 밖 둘레 링, podTopY 높이.
      //    ②③ 은 건물 표면에 물이 튀는 FX → 집이 없으면 소거되게 bflag=1.
      bflag = 1;
      for (let i = 0; i < nPodium; i++) {
        const side = Math.floor(rng() * 4);
        const out = rng.range(0.1, 0.9);   // 벽선에서 기단 상면 쪽으로 살짝 밖(기단 위 유지)
        let x, z;
        if (side === 0) { z = wallHZ + out; x = rng.range(-wallHX, wallHX); }
        else if (side === 1) { z = -(wallHZ + out); x = rng.range(-wallHX, wallHX); }
        else if (side === 2) { x = wallHX + out; z = rng.range(-wallHZ, wallHZ); }
        else { x = -(wallHX + out); z = rng.range(-wallHZ, wallHZ); }
        put(x, podY + 0.06, z, 3, 5.5, 0.6, 0.45);
      }
      // ③ 처마 낙수 착지선: 처마 footprint(x=±xE, z=±zE) 바로 아래 지면. 낙수 줄기(drips)와
      //    같은 라인이라 "처마 끝→지면"의 인과가 읽힌다. 지면 높이에서 튄다.
      const eaveAnchors = [];
      const spc = 1.1;
      for (const s of [-1, 1]) for (let px = -xE; px <= xE; px += spc) eaveAnchors.push([px, s * zE]);
      for (const s of [-1, 1]) for (let pz = -zE + spc; pz <= zE - spc; pz += spc) eaveAnchors.push([s * xE, pz]);
      for (let i = 0; i < nEave; i++) {
        const a = eaveAnchors[i % eaveAnchors.length];
        put(a[0] + rng.range(-0.12, 0.12), 0.06, a[1] + rng.range(-0.12, 0.12), 3.5, 6, 0.8, 0.7, 0.45, 0.9);
      }
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
      geo.setAttribute('aPeriod', new THREE.BufferAttribute(aPeriod, 1));
      geo.setAttribute('aScale', new THREE.BufferAttribute(aScale, 1));
      geo.setAttribute('aDrop', new THREE.BufferAttribute(aDrop, 3));
      geo.setAttribute('aKind', new THREE.BufferAttribute(aKind, 1));
      geo.setAttribute('aBuilding', new THREE.BufferAttribute(aBuilding, 1));
    }
    function update(dt, tt, level, bldFade = 1) {
      mat.uniforms.uTime.value = tt;
      mat.uniforms.uFade.value = level;
      mat.uniforms.uBldFade.value = bldFade;
    }
    build();
    return { points, update, rebuild: build };
  }

  return {
    setWeather,
    update,
    applyAtmosphere,
    applyAtmosphereScaled,
    onBuildingChanged,
    setAccum,
    setRoofColliders(boxes) {
      roofColliders = boxes || [];
    },
    // 하늘 입자 낙하 필드 중심 이설(#98). 마을 부감·종가 클로즈업처럼 시선이 원점을 벗어난 뷰에서
    //   눈·비가 화면 밖(원점)에만 쌓여 안 보이던 문제를 해소한다. 낙하 파티클 오브젝트만 이동(처마
    //   낙수·스플래시는 건물 앵커라 불변). 값 변화가 없으면 no-op.
    setWeatherCenter(x, z, camDist, camY) {
      if (Number.isFinite(x) && Number.isFinite(z) && (x !== fieldCX || z !== fieldCZ)) {
        fieldCX = x; fieldCZ = z;
        snow.points.position.set(x, 0, z);
        rain.lines.position.set(x, 0, z);
        petals.points.position.set(x, 0, z);   // 계절 입자도 카메라 타깃 추종(#111)
      }
      // 고도(카메라↔타깃 거리) 비례 눈송이 크기(#98 원경 정책) — 부감에서 카메라가 멀어 점이 벼룩처럼
      //   작아지는 걸 상쇄(uScale 은 gl_PointSize 를 -mv.z 로 나눔). 근경 1× → 부감 최대 5×. 낙하 입자
      //   볼륨은 전 고도 유지(하늘 소속) — 매트릭스: 부감에서도 snow/rain count>0.
      if (Number.isFinite(camDist)) {
        snow.points.material.uniforms.uScale.value = 340 * Math.min(5, Math.max(1, camDist / 42));
      }
      // 계절 입자 고도 게이트 신호(#111): camDist 는 항상, camY(선택 4번째 인자)는 넘어오면 정밀 게이트.
      //   눈·비와 달리 꽃잎·낙엽은 부감(고도 높음)에서 소거된다(petals 내부 altGate). engine 이 camY 를
      //   아직 안 넘기면 camDist 프록시 사용(setWeatherCenter 4-arg 는 하위호환).
      petalCamDist = camDist;
      petalCamY = Number.isFinite(camY) ? camY : null;
    },
    // 계절 입자 필드 season 설정(#111). engine 은 weather 에 season 을 직접 안 넘기므로(env.setSeason 만
    //   호출) env.setSeason → window.__wx.setSeason 브릿지로 도달한다. 'spring'|'autumn' 만 발현, 그 외 OFF.
    setSeason(name) { season = name; petals.setSeason(name); },
    // 검증 전용(tools/verify-petals.mjs): 계절 입자 필드 핸들 노출.
    _petals: petals,
    dispose,
    get weather() { return name; }
  };
}
