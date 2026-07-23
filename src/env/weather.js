import * as THREE from 'three';
import { getWind } from './wind.js';
import { makePresenceGate } from './present-gate.js';
import { createPetalField } from './petals.js';
import {
  patchSnowMaterial,
  snowProfileForObject,
  SNOW_ACCUMULATE_SECONDS,
  SNOW_AMOUNT_MAX,
  SNOW_MELT_SECONDS,
} from './snow-material.js';
import {
  createPhysicalRainRepresentation,
  createPhysicalSnowRepresentation,
} from './weather-physical-geometry.js';
import {
  advanceRainPrecipitation,
  advanceSnowPrecipitation,
  createRainPrecipitationState,
  createSnowPrecipitationState,
  setPrecipitationBounds,
} from './weather-particle-state.js';

// 날씨 시뮬레이터 (눈·비).
//   setupWeather(scene, { layout, getBuilding, getGround })
//     → { setWeather(name, opts), update(dt), applyAtmosphere({mode}), onBuildingChanged(), dispose(), get weather() }
//   name: 'clear' | 'rain' | 'snow'
//
// 구현 방침 (#131, #96): 눈·비 자체는 실제 월드 크기와 깊이를 가진 낙하 geometry로 표현하되,
//  적설 볼륨 쉘·빗물 지붕 리벌릿·처마 낙수·착지 스플래시 같은 비싼 표면 상호작용은 만들지 않는다
//  ("비는 지붕 별도 처리 불필요, 눈은 지붕 희게 칠하는 것으로 충분").
//  - 강설/강우는 scene 에 직접 붙는 인스턴스 geometry(건물 재생성과 무관하게 유지).
//  - 눈 룩 = 지붕 흰틴트: 건물 재질을 traverse 해 onBeforeCompile 로 "월드 노멀 상향" 기반 흰색
//    블렌딩을 주입 — 위를 향한 면(지붕·기단 윗면·난간 위)에만 눈이 걸린다(볼륨 지오 없음, 값싼 셰이더).
//    강도는 공유 uniform uSnowAmount(0~1) 로 제어, setWeather('snow') 시 수십 초에 걸쳐 서서히 희어진다
//    (accumLevel 램프). clear 전환 시 0 으로 복귀(원본 외형 회복).
//  - 젖은 재질은 roughness 를 원본*(1-0.45) 로 낮춘다(비 젖은 광택 룩, 물리 아님 — 원복 관리).
//  - 지면은 눈이면 흰색, 비면 암부 톤다운으로 색만 lerp(값싼, 볼륨 아님).

const SNOW_TAU = 1.4;    // 눈 파티클 등장/소멸 페이드 시상수(초) — 수 초에 걸쳐 나타남
const RAIN_TAU = 0.9;    // 강우/젖음 페이드 시상수(초)
const WET_FACTOR = 0.45; // 젖음 시 roughness 감쇠(원본*(1-0.45))

// 적설 "쌓임"은 파티클 등장과 분리한다. 눈발은 수 초 안에 흩날리지만, 지붕·기단·지면이
// 희어지는 건 30~60초에 걸쳐 서서히 진행돼야 무드가 산다(team-lead 지시). accumLevel(0..1)이
// 그 진행도이며, 선형 램프로 오른다(이징은 앞이 급해 "즉시 하얘짐"으로 읽힘).
const WET_DOWN = 3.0;    // 마당 젖음 회복 시간(초)

const GROUND_SNOW = new THREE.Color(0xeaeef4); // 지면 적설 톤
const RAIN_FOG = new THREE.Color(0x39424e);    // 비 대기 색
const SNOW_FOG = new THREE.Color(0xccd2da);    // 눈 대기 색(밝은 흐림)
const WET_GROUND = new THREE.Color(0x6b6154);  // 젖은 마당(암부 톤다운) 목표색

// env 를 넘기면(권장) 대기 틴트 모디파이어를 env.addFogModifier 로 자동 등록해 시간대 크로스페이드
// 중에도 비/눈 fog 틴트가 씻기지 않고 레벨(페이드)로 합성된다(태스크 #50). 없으면 소비자가
// applyAtmosphere 를 직접 호출하는 기존 경로로 동작(하위호환).
export function setupWeather(scene, {
  layout, getBuilding, getGround, env = null, sun = null, lowPerf = false,
}) {
  let L = layout;
  let name = 'clear';
  let roofColliders = []; // 지붕 충돌 박스 목록 (AABB Box3 배열)

  // 공유 적설 uniform — 모든 패치 재질이 같은 객체를 참조 → 한 번 갱신으로 전체 반영.
  const snowUniform = { value: 0 };

  // 이징 레벨(0..1). snowLevel → 눈발 파티클 가시성, rainLevel → 젖음/비 파티클.
  let snowLevel = 0, rainLevel = 0;
  let snowTarget = 0, rainTarget = 0;
  // #131 물리 제거로 건물 종속 FX(처마 낙수·스플래시·적설 쉘·리벌릿)가 모두 사라져 bldGate 도 폐기.
  //   눈 지붕 흰틴트는 공유 uniform(uSnowAmount) 이라 조기노출 게이트가 불필요(빈 터엔 눈 걸릴 위 향한
  //   면 자체가 없음). lastBld 는 계절 입자(꽃잎/낙엽) petalGate 의 건물 교체 reset 판정에만 남긴다.
  let lastBld = null;          // 건물 교체(리롤/유형변경) 감지 → petalGate reset
  // accumLevel(0..1): 지붕·기단·지면에 눈이 "쌓인" 진행도. 눈발(snowLevel)과 분리돼 천천히 오른다.
  let accumLevel = 0;
  // pinnedAccum: shot 하네스(window.__wx.setAccum)로 특정 쌓임 단계를 고정할 때의 값(null=자유 진행).
  let pinnedAccum = null;

  let t = 0; // 누적 시간(파티클 흔들림/재순환·바람 위상용)

  // 하늘 입자 필드 중심(#98). 눈·비 낙하 박스는 원점 기준 ±boxHalf 로 좁게(밀도 유지) 두되, 이 중심을
  //   매 프레임 카메라 타깃으로 옮겨(setWeatherCenter) "보는 곳에 눈/비가 온다"를 보장한다. 단일건물은
  //   타깃≈원점이라 무변, 마을 부감/종가 클로즈업은 필지·마을 중심으로 따라간다. 낙하 파티클
  //   낙하 geometry와 계절 입자만 이설(#131 제거로 건물 앵커 FX 없음).
  let fieldCX = 0, fieldCZ = 0;
  let disposed = false;
  let fogModifierRegistered = false;

  // 계절 입자 필드(#111): 봄 벚꽃·가을 낙엽의 카메라 추종 볼륨. 눈·비와 동일하게 scene 루트에 붙여
  //   env.group 은닉(마을 모드)을 우회하고, setWeatherCenter 로 카메라 타깃을 따라온다. season 은
  //   weather 로 직접 흐르지 않으므로(engine 은 env.setSeason 만 호출) env.setSeason → window.__wx.setSeason
  //   브릿지로 받는다. present(조기노출)와 viewHeight(시선 타깃 대비 높이)는 아래
  //   update/센터에서 판정해 넘긴다.
  let season = 'summer';
  let petalCamDist = NaN, petalViewHeight = null, petalDetail = null;
  let precipitationDetail = 1;
  // 꽃잎/낙엽 조기노출 게이트(#61): 원점 빈 터(단일건물 재생성 중)에선 억제, 씬이 정착하면 스멀스멀.
  //   present = 건물이 서 있거나(단일건물) 필드 중심이 원점을 벗어났을 때(마을 부감·focus·히어로 랜딩).
  //   마을에선 앱 building.visible=false 라 present 로는 못 켜므로 centerAway(fieldC)를 OR 로 함께 본다.
  const petalGate = makePresenceGate({ delay: 0.6, up: 1.2, down: 0.5 });
  let petalPresent = 1;

  // ---------- 파티클 시스템 ----------
  // #131: 낙하 눈·비만 유지. 처마 낙수(drips)·착지 스플래시·지붕 볼륨(snowvol/rainflow)은
  //   제거 — 비는 지붕/지면 별도 처리 없이 그냥 내리고, 눈은 아래 patchSnow 흰틴트로 지붕이 희어진다.
  // 눈·비 위치/속도/크기/위상은 renderer가 아니라 이 CPU state가 단독 소유한다. 인스턴스
  // geometry는 이 배열을 직접 참조하므로 별도의 renderer 상태나 복사본이 없다. 두 입자는
  // 실제 월드 크기·가림·광학 깊이를 가지며, 부감에서는 기존 visibility sleep 계약으로 쉰다.
  const snowState = createSnowPrecipitationState({ top: yTop() });
  const rainState = createRainPrecipitationState({ top: yTop() });
  const snow = createPhysicalSnowRepresentation(snowState);
  const rain = createPhysicalRainRepresentation(rainState);
  const petals = createPetalField({
    getWind,
    getLightDirection: sun ? () => sun.position : null,
    lowPerf,
  });
  scene.add(snow.object);
  scene.add(rain.object);
  scene.add(petals.object);

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
        patchSnowMaterial(m, snowUniform, { profile: snowProfileForObject(o, m) });
        patched.set(m.uuid, { mat: m, roughness: m.roughness });
      }
    });
  }

  function applyWetness() {
    for (const rec of patched.values()) {
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
      snowUniform.value = accumLevel * SNOW_AMOUNT_MAX;
      env?.setSnowAccumulation?.(accumLevel);
      applyWetness();
      applyGround();
    }
  }

  function onBuildingChanged() {
    collectMaterials();
    const top = yTop();
    setPrecipitationBounds(snowState, { top });
    setPrecipitationBounds(rainState, { top });
    snowUniform.value = accumLevel * SNOW_AMOUNT_MAX; // 새 재질에 현재 적설 흰틴트 즉시 반영
    applyWetness();
  }

  function update(dt) {
    t += dt;
    const wind = getWind(t);
    // 눈발·비 파티클 가시성은 빠르게(수 초) 페이드.
    // 비↔눈 교차는 겹침 없이 순차(태스크 #50): 들어오는 강수는 나가는 강수가 옅어진(≤0.15) 뒤에
    //   오른다 — clear↔단일 전환은 지연 없음(반대 강수 레벨이 0이라 즉시 목표 추종).
    const effSnowTarget = (snowTarget > 0 && rainLevel > 0.15) ? 0 : snowTarget;
    const effRainTarget = (rainTarget > 0 && snowLevel > 0.15) ? 0 : rainTarget;
    snowLevel += (effSnowTarget - snowLevel) * Math.min(1, dt / SNOW_TAU);
    rainLevel += (effRainTarget - rainLevel) * Math.min(1, dt / RAIN_TAU);

    // 건물 교체(리롤/유형변경) 감지 — 계절 입자 petalGate reset 판정용(#131 로 건물 종속 FX 게이트 폐기).
    const bObj = getBuilding && getBuilding();
    const bldReset = bObj !== lastBld; lastBld = bObj;
    const present = !!(bObj && bObj.visible);

    // 적설 흰틴트 강도는 선형 램프로 천천히(올라갈 땐 ~46s, 녹을 땐 ~16s). shot 하네스가 고정하면 그 값 유지.
    if (pinnedAccum != null) {
      accumLevel = pinnedAccum;
    } else if (snowTarget > 0) {
      accumLevel = Math.min(1, accumLevel + dt / SNOW_ACCUMULATE_SECONDS);
    } else {
      accumLevel = Math.max(0, accumLevel - dt / SNOW_MELT_SECONDS);
    }
    snowUniform.value = accumLevel * SNOW_AMOUNT_MAX;
    env?.setSnowAccumulation?.(accumLevel);

    // 마당 젖음: 비 오는 동안 서서히 젖고, 개면 서서히 마른다.
    const wetTarget = rainTarget;
    wetLevel += (wetTarget - wetLevel) * Math.min(1, dt / (wetTarget > wetLevel ? RAIN_TAU * 2.2 : WET_DOWN));

    applyWetness();
    applyGround();

    // 파티클 가시성/갱신 — 낙하 눈·비 커튼만(값싼 입자, 하늘 소속). 처마 낙수·스플래시·볼륨은 #131 로 제거.
    const snowVis = snowLevel * precipitationDetail > 0.003;
    const rainVis = rainLevel * precipitationDetail > 0.003;
    snow.object.visible = snowVis;
    rain.object.visible = rainVis;
    if (snowVis) {
      advanceSnowPrecipitation(snowState, {
        dt,
        time: t,
        wind,
        centerX: fieldCX,
        centerZ: fieldCZ,
        roofColliders,
        collide: !lowPerf,
        top: yTop(),
      });
      snow.sync({ level: snowLevel * precipitationDetail, time: t });
    }
    if (rainVis) {
      advanceRainPrecipitation(rainState, {
        dt,
        time: t,
        wind,
        centerX: fieldCX,
        centerZ: fieldCZ,
        roofColliders,
        collide: !lowPerf,
        top: yTop(),
      });
      rain.sync({ level: rainLevel * precipitationDetail, time: t });
    }

    // 계절 입자(봄 꽃잎·가을 낙엽): 조기노출 게이트(원점 빈 터 억제) + 카메라 추종 볼륨. 눈·비처럼
    //   하늘/대기 소속이라 accumLevel·rainLevel 과 무관하게 season 이 spring/autumn 이면 발현한다.
    //   present = 건물 존재(단일건물) OR 필드가 원점을 벗어남(마을·focus·히어로) — petalGate 로 원점 빈 터
    //   조립 전엔 0, 씬 정착 후 오른다. 디테일 게이트는 petals 내부(viewHeight).
    // 유한 detailWeight는 engine이 마을 공통 LOD를 주입했다는 명시적 신호다. 도성 중심 8m
    // 안을 보더라도 앱의 단일집 building은 숨겨져 있으므로 좌표 이격만으로 마을 존재를 판정하면
    // 중심 필지의 꽃잎/낙엽이 영구 OFF가 된다. 원경은 detailWeight=0이 최종 level을 그대로 재운다.
    const petalPresentRaw = present || petalDetail !== null
      || Math.abs(fieldCX) > 8 || Math.abs(fieldCZ) > 8;
    petalPresent = petalGate.update(dt, { present: petalPresentRaw, reset: bldReset && !petalPresentRaw });
    petals.update(dt, {
      t,
      camDist: petalCamDist,
      viewHeight: petalViewHeight,
      detailWeight: petalDetail,
      present: petalPresent,
      wind,
    });
  }

  // shot 하네스 훅: 특정 쌓임 단계로 고정(시간 경과 비교 컷). v=null 이면 자유 진행 복귀.
  // main.js 무수정으로 촬영 재현성을 얻기 위해 weather 모듈이 직접 window 에 노출한다.
  function setAccum(v) {
    pinnedAccum = v;
    if (v != null) {
      accumLevel = v;
      snowUniform.value = accumLevel * SNOW_AMOUNT_MAX;
      env?.setSnowAccumulation?.(accumLevel);
      applyGround();
    }
  }
  let weatherDebug = null;
  if (typeof window !== 'undefined') {
    weatherDebug = {
      // accum(0..1)=지붕 눈 흰틴트 진행도(#131: 볼륨 아님, patchSnow 강도). setAccum 으로 shot 고정.
      setAccum, get accum() { return accumLevel; }, get wind() { return getWind(t); },
      // 이징된 강수 레벨(0..1) — 외부 소비자(post 렌즈 플레어 등)가 엔진 배선 없이 읽는 읽기 전용 신호.
      get rain() { return rainLevel; },
      get snow() { return snowLevel; },
      // 계절 입자 필드(#111): env.setSeason 이 이 브릿지로 season 을 전달(engine 은 weather 에 season 미전달).
      //   'spring'|'autumn' 만 꽃잎/낙엽 발현. 읽기 전용 petalLevel 로 검증/외부 소비.
      setSeason: (name) => { season = name; petals.setSeason(name); },
      get petalLevel() { return petals.level; },
    };
    window.__wx = weatherDebug;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (fogModifierRegistered && env && typeof env.removeFogModifier === 'function') {
      env.removeFogModifier(applyAtmosphereScaled);
    }
    fogModifierRegistered = false;
    for (const rec of patched.values()) rec.mat.roughness = rec.roughness;
    patched.clear();
    const g = getGround && getGround();
    if (g && groundOrig) g.material.color.copy(groundOrig);
    snowUniform.value = 0;
    env?.setSnowAccumulation?.(0);
    for (const system of [snow, rain]) {
      scene.remove(system.object);
      system.dispose();
    }
    petals.dispose();   // 계절 입자 필드(#111)
    if (typeof window !== 'undefined' && window.__wx === weatherDebug) delete window.__wx;
  }

  // 초기 재질 수집(눈 흰틴트 patchSnow 를 씬 전체 재질에 주입)
  collectMaterials();

  // env fog 모디파이어 자동 등록(태스크 #50): 넘겨받았으면 대기 틴트를 매 틱 base fog 위에 레벨
  // 스케일로 합성한다. dispose 에서 같은 함수 참조를 제거해 재마운트 시 모디파이어가 누적되지 않게 한다.
  if (env && typeof env.addFogModifier === 'function') {
    env.addFogModifier(applyAtmosphereScaled);
    fogModifierRegistered = true;
  }

  // 현재 레이아웃이 바뀐 뒤 충돌 respawn 높이도 함께 갱신한다.
  function yTop() { return (L.totalH || 20) + 34; }

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
    setWeatherCenter(
      x,
      z,
      camDist,
      viewHeight,
      detailWeight,
      visualDistance = camDist,
      _explicitLensScale = null,
    ) {
      if (Number.isFinite(x) && Number.isFinite(z) && (x !== fieldCX || z !== fieldCZ)) {
        fieldCX = x; fieldCZ = z;
        snow.object.position.set(x, 0, z);
        rain.object.position.set(x, 0, z);
        petals.object.position.set(x, 0, z);   // 계절 입자도 카메라 타깃 추종(#111)
      }
      const visualDist = Number.isFinite(visualDistance) ? visualDistance : camDist;
      // 강수도 공통 디테일 가중치를 직접 소비한다. 중간 band에서는 color/depth가 함께 옅어지고,
      // 원경 0에서는 CPU state advance와 draw를 모두 쉰다. 개별 크기는 월드 단위 그대로다.
      precipitationDetail = Number.isFinite(detailWeight)
        ? Math.max(0, Math.min(1, detailWeight)) : 1;
      // 계절 입자는 눈·비와 달리 근경 디테일이다. 4번째 인자는 절대 world Y가 아니라
      // 카메라와 현재 시선 타깃/지면 사이의 수직 높이다. petals가 공통 디테일 밴드로 소거한다.
      // 기존 3-인자 호출은 camDist 근사치를 사용하도록 보존한다.
      petalCamDist = visualDist;
      petalViewHeight = Number.isFinite(viewHeight) ? Math.max(0, viewHeight) : null;
      petalDetail = Number.isFinite(detailWeight)
        ? Math.max(0, Math.min(1, detailWeight)) : null;
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
