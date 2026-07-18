import * as THREE from 'three';
import { setupAnimals } from './animals.js';
import { setupSmoke } from './smoke.js';
import { setupMotes, setupLanternSway } from './motes.js';
import { makePresenceGate } from './present-gate.js';
import { captureRoofSurfaces } from './roofcapture.js';
import { createSnowVolume } from './snowvol.js';
import { createRainFlow } from './rainflow.js';
import { getWind } from './wind.js';
import { setupGrass } from './grass.js';

// 필지 스타일별 대문 개구부 폭(buildParcel STYLE_MAP 대응) — 풀이 대문 앞을 막지 않게 비운다.
const GATE_W = { palace: 6.6, temple: 6.6, hanok: 5.2, choga: 1.8 };

// 앰비언스 근접 링(#79·#84) — 부감에서 필지에 focus-in 하면 그 필지 반경에 "집 모드"의 풀 앰비언스
// (마당 닭·굴뚝 연기·먼지 모트·등롱 흔들림 + 날씨 시 지붕 적설/빗물)를 점등한다. 앰비언스는 배율에
// 종속 — 부감은 저비용 세트, focus-in 은 근접 링.
//
//   const ring = createFocusRing(scene, { heightAt, sun?, renderer?, lowPerf? });
//   ring.set({ group, parcel, radius = 18, seed, getWeather? });  // group=풀디테일 buildParcel 컴파운드
//   ring.clear();                                     // focus-out — 페이드아웃 후 dispose
//   ring.update(dt, timeName);                        // 매 프레임. timeName: dawn|day|sunset|night
//
// 원칙:
//  - 기존 env 시스템 재사용(신규 발명 금지): animals.js·smoke.js·motes.js(모트+등롱흔들림)·
//    snowvol.js/rainflow.js(지붕 적설 쉘·빗물 리벌릿, roofOnly).
//  - 활성/해제 모두 크로스페이드(팟 금지) — present-gate(조립 정착 후 상승)를 강도(strength)로 쓴다.
//  - 동시 1개 링만. set 재호출 시 기존 링을 페이드아웃(retiring) 후 교체, ~0 도달 시 dispose.
//  - dispose 철저: 지오/재질/텍스처 누수 금지(Sprite 공유 지오는 제외 — 전역 손상 방지).
//
// 날씨(#84): 계약 시그니처는 불변. 적설/빗물은 window.__wx(weather.js) 를 직접 판독한다
//   (FlarePass #67 이 확립한 선례 — 명시 배선 없이 env 코드가 __wx.accum/rain/snow 자동 판독).
//   신호 부재/0 이면 dormant(현행 동일) = forward-compatible. ring.set({getWeather}) 로 명시
//   오버라이드 가능(미래 명시성). ?snowvol=0·lowPerf 는 볼륨 미생성(틴트만) 폴백 존중.
//
// 좌표: buildParcel 컴파운드는 이미 필지 월드 위치에 놓여 있다(group.matrixWorld). 링 컨테이너는
//   씬 루트(identity)에 두고 모든 배치를 월드 좌표로 계산한다(populate 소동물 배치 패턴과 동일).
//   적설 쉘·빗물 리벌릿은 captureRoofSurfaces 월드좌표를 지오에 베이크하므로 volume group=origin
//   유지 시 오프셋 필지 지붕에 정확히 얹힌다(roofOnly 로 origin 상대 지면 드리프트·웅덩이 배제).

// window.__wx(weather.js 노출) 자동 판독. getWeather 오버라이드 우선. 신호 없으면 전부 0(dormant).
function readWeather(getWeather) {
  if (getWeather) { const w = getWeather(); if (w) return w; }
  if (typeof window !== 'undefined' && window.__wx) {
    const wx = window.__wx;
    return {
      accum: wx.accum || 0, rain: wx.rain || 0, snow: wx.snow || 0,
      wet: wx.wet != null ? wx.wet : (wx.rain || 0),   // __wx 는 wet 미노출 → rain 근사
      wind: wx.wind || null,
    };
  }
  return { accum: 0, rain: 0, snow: 0, wet: 0, wind: null };
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();

// 씬에서 태양(DirectionalLight)을 찾는다 — 계약 시그니처가 sun 을 강제하지 않으므로 폴백.
function findSun(scene) {
  let sun = null;
  scene.traverse((o) => { if (!sun && o.isDirectionalLight) sun = o; });
  return sun;
}

// 서브트리 dispose: 지오·재질·텍스처를 중복 제거해 각 1회만 해제한다.
//   Sprite 는 three 내부 공유 지오(_geometry)를 쓰므로 지오 dispose 제외(전역 손상 방지).
function disposeSubtree(obj) {
  const geos = new Set(), mats = new Set(), texs = new Set();
  obj.traverse((o) => {
    if (o.geometry && !o.isSprite) geos.add(o.geometry);
    const m = o.material;
    if (m) (Array.isArray(m) ? m : [m]).forEach((mm) => mm && mats.add(mm));
  });
  for (const m of mats) for (const k in m) { const v = m[k]; if (v && v.isTexture) texs.add(v); }
  for (const t of texs) t.dispose();
  for (const m of mats) m.dispose();
  for (const g of geos) g.dispose();
}

// 단일 링 인스턴스(활성 또는 페이드아웃 중). 자기 컨테이너·서브시스템·게이트를 소유한다.
function makeRing({ scene, heightAt, sun, renderer, group, parcel, radius, seed, getWeather, vol, season }) {
  const container = new THREE.Group();
  container.name = 'focusRing';
  scene.add(container);

  // focus 오버레이의 월드 변환(위치·회전) — 이미 배치 완료 상태.
  group.updateWorldMatrix(true, false);
  group.matrixWorld.decompose(_pos, _quat, _scl);
  const worldX = _pos.x, groundY = _pos.y, worldZ = _pos.z;
  // 필지 강체행렬(위치·회전, 스케일 무시) — 풀 배치를 로컬에서 계산해 이 행렬로 월드 변환.
  const parcelRigid = new THREE.Matrix4().compose(_pos.clone(), _quat.clone(), new THREE.Vector3(1, 1, 1));
  const parcelRigidInv = parcelRigid.clone().invert();

  // 필지 치수(buildParcel 이 root.userData 에 심음). 없으면 보수적 기본값.
  const ud = group.userData || {};
  const W = ud.W || 20, D = ud.D || 18, style = ud.style || 'hanok';

  // 마당(닭 무리) 월드 앵커: parcel.yard(월드) 우선, 없으면 필지 로컬 앞마당(+z 대문측·+x off-axis)을
  //   오버레이 월드행렬로 변환(회전 반영). buildParcel 좌표규약: +z=남(대문), 몸채는 -z(북).
  let yardX, yardZ, yardR;
  if (parcel && parcel.yard && Number.isFinite(parcel.yard.x)) {
    yardX = parcel.yard.x; yardZ = parcel.yard.z; yardR = parcel.yard.r;
  } else {
    const local = new THREE.Vector3(W * 0.08, 0, D * 0.24).applyMatrix4(group.matrixWorld);
    yardX = local.x; yardZ = local.z;
  }
  if (yardR == null) yardR = Math.max(1.4, Math.min(3.2, Math.min(W, D) * 0.11));

  // 소동물: 격식 건물(궁·절) 마당엔 닭 부적절 → 주거형만 기본 점등(parcel.chickens 로 강제 가능).
  const residential = style === 'choga' || style === 'hanok' || style === 'giwa';
  const wantChickens = parcel && parcel.chickens != null ? !!parcel.chickens : residential;

  // 1) 소동물 — 마당 닭(+옵션 소). 지면 Y 는 필지 패드 상면(groundY) 상수(평평한 마당).
  const animals = setupAnimals(container, {
    heightAt: () => groundY,
    yard: { x: yardX, z: yardZ, r: yardR },
    cowSite: parcel && parcel.cowSite ? parcel.cowSite : null,
    seed: (seed ^ 0x6b17) >>> 0,
    chickens: wantChickens,
  });

  // 2) 굴뚝 연기·아궁이 — 오버레이 내부 몸채 조회(교체 self-heal). choga=M.mud 재질, giwa/hanok=name='chimney'.
  const getBuilding = () => group.getObjectByName('building') || group.getObjectByName('hanok') || null;
  const smoke = setupSmoke({ scene, getBuilding });
  container.add(smoke.group);
  smoke.setEnabled(true);

  // 3) 먼지 모트 — 마당 볼륨 한정(반경을 필지에 맞춰 좁힘). 볼륨을 필지 상공으로 이설.
  //    수직 스팬을 납작하게(ySpan) + centerY 낮춰 "대기 헤이즈"가 아닌 "마당 먼지"로 조인다(#79 크리틱).
  //    최대 높이 ≈ centerY + moteR*ySpan ≈ 지붕 처마선(≈2.8+moteR·0.22) — 마루 위로 뜨지 않게.
  const moteR = Math.min(radius, Math.max(5.5, Math.max(W, D) * 0.5));
  const motes = setupMotes({ scene, sun, renderer, radius: moteR, centerY: 2.8, ySpan: 0.22, count: 90 });
  motes.group.position.set(worldX, groundY, worldZ);
  container.add(motes.group);
  motes.setEnabled(true);

  // 4) 등롱 바람 흔들림 — focus 오버레이 스코프(env 전역 lanternSway 와 대상 분리). 현재 필지엔
  //    매달린 등롱이 없어 dormant(no-op) 이나, 오버레이가 등롱을 갖게 되면 자동 흔들린다.
  const lantern = setupLanternSway({ scene, getBuilding, scope: group });
  lantern.setEnabled(true);

  // 4.5) 바람 풀(#90) — 담장 밑·마당 가장자리·필지 외곽에 인스턴스드 풀 포기. 마당 중앙 동선·
  //    건물 발자국·대문 앞은 비운다. 버텍스 셰이더 흔들림(wind.js 판독, 연기·낙엽과 동방향).
  //    로컬 필지 좌표로 배치 후 강체행렬로 월드 변환(회전 반영). 마당(닭) 중심은 로컬로 환산해 비움.
  const yardLocal = new THREE.Vector3(yardX, groundY, yardZ).applyMatrix4(parcelRigidInv);
  const grass = setupGrass(container, {
    bounds: { W, D }, matrix: parcelRigid,
    yard: { x: yardLocal.x, z: yardLocal.z, r: yardR },
    style, gateW: GATE_W[style] || 2.4,
    sun, seed: (seed ^ 0x3aa9) >>> 0, season,
  });

  // 5) 지붕 적설 쉘·빗물 리벌릿(#84, roofOnly) — window.__wx 날씨 판독으로 구동. 볼륨 group 은
  //    origin 유지(쉘·리벌릿이 captureRoofSurfaces 월드좌표 베이크라 오프셋 필지 지붕에 정확). 지붕
  //    표면 캡처는 조립 정착 후 1회(부재가 솟는 중 캡처하면 쉘이 어긋남) — strength 상승 시점에 지연 캡처.
  const snowVol = vol ? createSnowVolume(scene, { getBuilding, getGround: () => null, layout: {}, roofOnly: true }) : null;
  const rainFlow = vol ? createRainFlow(scene, { layout: {}, roofOnly: true }) : null;
  let roofCaptured = false;
  function captureRoofOnce() {
    if (roofCaptured || !vol) return;
    const b = getBuilding();
    if (!b) return;
    const surfaces = captureRoofSurfaces(b);
    if (surfaces && surfaces.length) { snowVol.rebuild(surfaces); rainFlow.rebuild(surfaces); roofCaptured = true; }
  }

  // present-gate 를 강도(strength)로 재사용: 조립 정착(delay) 후 상승(up), 해제 시 하강(down).
  //   첫 프레임 present=false 강제(prime→0) → 오버레이가 이미 보여도 팟 없이 페이드인.
  const gate = makePresenceGate({ delay: 0.9, up: 0.7, down: 0.6 });
  let firstFrame = true;
  let phase = 'in';   // 'in' 활성 | 'out' 페이드아웃(retiring)
  let strength = 0;
  let _wt = 0;        // 날씨 시뮬 시계(__wx.wind 부재 시 getWind 폴백용)

  function setTime(name, immediate) {
    animals.setTime(name);
    smoke.setTime(name, { immediate: !!immediate });
    motes.setTime(name, { immediate: !!immediate });
    grass.setTime(name, { immediate: !!immediate });
  }
  function setSeason(name) { grass.setSeason(name); }

  function update(dt) {
    let present;
    if (phase === 'out') present = false;
    else if (firstFrame) present = false;               // prime → 0(팟 방지)
    else { const b = getBuilding(); present = !!(b && b.visible); }
    firstFrame = false;
    strength = gate.update(dt, { present });

    animals.setFade(strength);
    smoke.setFade(strength);
    motes.setFade(strength);
    grass.setFade(strength);

    animals.update(dt);
    smoke.update(dt);
    motes.update(dt);
    lantern.update(dt);
    grass.update(dt);

    // 지붕 적설/빗물(#84): 날씨 신호(__wx 또는 getWeather)를 판독해 구동. 강도(strength)로 크로스페이드
    //   — accum·rain·wet 에 strength 를 곱해 활성 시 서서히 쌓이고 해제 시 서서히 녹는다(팟 없음).
    //   조립 정착(strength 상승) 후에만 지붕 캡처 → 부재가 솟는 중 어긋난 쉘 방지.
    if (vol) {
      if (!roofCaptured && strength > 0.02) captureRoofOnce();
      const wx = readWeather(getWeather);
      const wind = wx.wind || getWind(_wt += dt);
      const snowOn = (wx.accum > 0.004 || wx.snow > 0.004) && strength > 0.004;
      snowVol.setVisible(snowOn);
      if (snowOn) snowVol.update(dt, { accum: wx.accum * strength, t: _wt, wind });
      const rainOn = (wx.rain > 0.004 || wx.wet > 0.004) && strength > 0.004;
      rainFlow.setVisible(rainOn);
      if (rainOn) rainFlow.update(dt, { rain: wx.rain * strength, wet: wx.wet * strength, t: _wt });
    }
  }

  function beginOut() { phase = 'out'; }
  function dead() { return phase === 'out' && strength < 0.01; }
  function dispose() {
    smoke.setEnabled(false);    // 건물의 아궁이 불씨(그룹 밖 라이트)까지 소등 후 해제
    lantern.setEnabled(false);
    if (snowVol) snowVol.dispose();   // 씬 직속 group(container 밖) — 명시 해제
    if (rainFlow) rainFlow.dispose();
    scene.remove(container);
    disposeSubtree(container);
  }

  return { setTime, setSeason, update, beginOut, dead, dispose, get strength() { return strength; }, get phase() { return phase; } };
}

export function createFocusRing(scene, { heightAt = () => 0, sun = null, renderer = null, lowPerf = false } = {}) {
  const _sun = sun || findSun(scene);
  // 지붕 적설/빗물 볼륨 생성 여부(#84): 모바일 lowPerf·?snowvol=0 은 미생성(틴트만) 폴백 존중.
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const VOL = !lowPerf && q.get('snowvol') !== '0';
  let active = null;
  const retiring = [];
  let curTime = 'day';
  let curSeason = 'summer';

  // 활성 링 점등. 기존 링은 페이드아웃 대기열로. getWeather: __wx 대신 쓸 명시 날씨 게터(선택).
  //   season: 풀 색 계절(spring|summer|autumn|winter). 기본 현행 유지(마지막 setSeason 값).
  function set({ group, parcel = null, radius = 18, seed = 4343, getWeather = null, season } = {}) {
    if (!group) return;
    if (season) curSeason = season;
    if (active) { active.beginOut(); retiring.push(active); active = null; }
    active = makeRing({ scene, heightAt, sun: _sun, renderer, group, parcel, radius, seed: seed >>> 0, getWeather, vol: VOL, season: curSeason });
    active.setTime(curTime, true);   // 시간대 프로파일 즉시 정합(발현 세기는 strength 로 페이드)
  }

  // 계절 변경(풀 색 크로스페이드). 앱 engine 이 env.setSeason 과 나란히 호출(main 배선 명세).
  function setSeason(name) {
    if (!name) return;
    curSeason = name;
    if (active) active.setSeason(curSeason);
    for (const r of retiring) r.setSeason(curSeason);
  }

  // focus-out: 활성 링 페이드아웃 후 dispose.
  function clear() {
    if (active) { active.beginOut(); retiring.push(active); active = null; }
  }

  function update(dt, timeName) {
    if (timeName && timeName !== curTime) {
      curTime = timeName;
      if (active) active.setTime(timeName, false);
      for (const r of retiring) r.setTime(timeName, false);
    }
    if (active) active.update(dt);
    for (let i = retiring.length - 1; i >= 0; i--) {
      const r = retiring[i];
      r.update(dt);
      if (r.dead()) { r.dispose(); retiring.splice(i, 1); }
    }
  }

  // 전체 해제(즉시 dispose — 씬 파괴 시).
  function dispose() {
    if (active) { active.dispose(); active = null; }
    for (const r of retiring) r.dispose();
    retiring.length = 0;
  }

  return {
    set, clear, setSeason, update, dispose,
    // 검증 전용: 현재 활성 링 강도(0..1)·페이드아웃 대기 수.
    get strength() { return active ? active.strength : 0; },
    get retiringCount() { return retiring.length; },
  };
}
