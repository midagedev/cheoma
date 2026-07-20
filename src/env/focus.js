import * as THREE from 'three';
import { setupAnimals } from './animals.js';
import { setupSmoke } from './smoke.js';
import { setupMotes, setupLanternSway } from './motes.js';
import { makePresenceGate } from './present-gate.js';
import { setupGrass } from './grass.js';
import { attachOverlayLanterns, getLanternMaterials } from '../layout/props.js';

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
//  - 기존 env 시스템 재사용(신규 발명 금지): animals.js·smoke.js·motes.js(모트+등롱흔들림)·grass.js.
//    (#131: 지붕 적설 쉘·빗물 리벌릿 물리는 제거 — 눈은 weather.js 지붕 흰틴트(uSnowAmount)가 대체.)
//  - 활성/해제 모두 크로스페이드(팟 금지) — present-gate(조립 정착 후 상승)를 강도(strength)로 쓴다.
//  - 동시 1개 링만. set 재호출 시 기존 링을 페이드아웃(retiring) 후 교체, ~0 도달 시 dispose.
//  - dispose 철저: 지오/재질/텍스처 누수 금지(Sprite 공유 지오는 제외 — 전역 손상 방지).
//
// 날씨(#131): 지붕 눈/비 물리는 제거됨. 눈은 weather.js 지붕 흰틴트(uSnowAmount 공유 uniform)가 전역
//   담당(focus-in 지붕도 자동 흰색화), 비는 낙하 커튼만. readWeather 는 잔존하나 현재 미사용(dormant).
//
// 좌표: buildParcel 컴파운드는 이미 필지 월드 위치에 놓여 있다(group.matrixWorld). 링 컨테이너는
//   씬 루트(identity)에 두고 모든 배치를 월드 좌표로 계산한다(populate 소동물 배치 패턴과 동일).

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

  // 4) 등롱 바람 흔들림 — focus 오버레이 스코프(env 전역 lanternSway 와 대상 분리). 오버레이(parcel-*)는
  //    emitLight:false 로 발광 bulb 만 갖는다(#141) → light 없이 bulb 만 흔들린다.
  const lantern = setupLanternSway({ scene, getBuilding, scope: group });
  lantern.setEnabled(true);
  // 오버레이 등롱 국소 조명(#141): 오버레이는 PointLight 를 안 갖는다(개수 요동 방지). bulb 를 모아
  //   createFocusRing 고정 풀(ringPool)이 링 강도로 점등 → focus-in/out·hop 로 오버레이가 add/remove
  //   돼도 씬 조명 개수 불변. group 직속 자식 bulb 만 수집(frame·건물 배제).
  const ringLanterns = [];
  for (const c of group.children) if (c.name === 'lantern-bulb') ringLanterns.push({ bulb: c, baseI: 0.65 });

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

  // 5) 지붕 적설/빗물(#131): 눈 쌓임 볼륨 쉘·빗물 리벌릿 물리는 사용자 지시로 제거(roofcapture +
  //    2×mergeGeometries 성능 부담). 눈은 weather.js 지붕 흰틴트(uSnowAmount 공유 uniform)가 대체하고
  //    focus-in 지붕도 그 전역 셰이더 틴트로 자동 흰색화(별도 배선 불필요), 비는 낙하 커튼만 남긴다.

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

    // 지붕 적설/빗물(#131): 물리 제거됨 — 눈은 weather.js 지붕 흰틴트가, 비는 낙하 커튼이 담당(위 5 참조).
  }

  function beginOut() { phase = 'out'; }
  function dead() { return phase === 'out' && strength < 0.01; }
  function dispose() {
    smoke.setEnabled(false);    // 건물의 아궁이 불씨(그룹 밖 라이트)까지 소등 후 해제
    lantern.setEnabled(false);
    scene.remove(container);
    disposeSubtree(container);
  }

  return { setTime, setSeason, update, beginOut, dead, dispose, lanterns: ringLanterns, get strength() { return strength; }, get phase() { return phase; } };
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

  // 오버레이 등롱 국소 조명 고정 풀(#141) — createFocusRing 수명 동안 씬에 상주하는 RING_POOL_N 개
  //   PointLight. 항상 visible(개수 불변) → focus-in/out·hop 로 오버레이가 add/remove 돼도 씬 조명
  //   개수 불변. 미사용은 intensity 0 파킹. 활성 링(≤3 등롱) 우선 배정, 남으면 페이드아웃 링(hop
  //   크로스페이드)에 배분. 카메라 불요(단일 필지라 링 강도로만 점등).
  const RING_POOL_N = 4;
  const ringPool = (() => {
    const lights = [];
    for (let i = 0; i < RING_POOL_N; i++) {
      const l = new THREE.PointLight(0xffb266, 0, 5.5, 2);   // attachOverlayLanterns 등롱과 동일 파라미터
      l.name = 'ringPoolLight'; l.castShadow = false; l.visible = true;
      scene.add(l); lights.push(l);
    }
    const _wp = new THREE.Vector3();
    function assign() {
      let slot = 0;
      const use = (ring) => {
        if (!ring || slot >= RING_POOL_N) return;
        const ls = ring.lanterns, s = ring.strength;
        if (!ls || !ls.length || s < 0.02) return;
        for (const L of ls) {
          if (slot >= RING_POOL_N) break;
          L.bulb.getWorldPosition(_wp);
          lights[slot].position.copy(_wp); lights[slot].intensity = L.baseI * s; slot++;
        }
      };
      use(active);
      for (const r of retiring) use(r);
      for (; slot < RING_POOL_N; slot++) lights[slot].intensity = 0;
    }
    function dispose() { for (const l of lights) scene.remove(l); }
    return { assign, dispose };
  })();

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
    ringPool.assign();   // #141 오버레이 등롱 국소광을 고정 풀에 배정(개수 불변)
  }

  // 전체 해제(즉시 dispose — 씬 파괴 시).
  function dispose() {
    if (active) { active.dispose(); active = null; }
    for (const r of retiring) r.dispose();
    retiring.length = 0;
    ringPool.dispose();
  }

  return {
    set, clear, setSeason, update, dispose,
    // 검증 전용: 현재 활성 링 강도(0..1)·페이드아웃 대기 수.
    get strength() { return active ? active.strength : 0; },
    get retiringCount() { return retiring.length; },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 카메라 앵커 앰비언스 필드(#105)
// ══════════════════════════════════════════════════════════════════════════════
// 선택 종속(focus 링 1개)이던 앰비언스를 카메라 지면점 기준 3계층 LOD 필드로 확장한다. 어댑터가
// updateLod(camera) 경로에서 구동하며, 비선택(인스턴스) 이웃 필지에 계층별 앰비언스를 점등한다.
//   (선택 필지 자체는 engine focusRing 이 풀 오버레이 링으로 담당 — 필드는 excluded 로 제외해 중복 방지.)
//
//   const field = createAmbientField(scene, { heightAt, sun, renderer, lowPerf });
//   field.setParcels(descriptors);         // 어댑터가 필지 서술자 배열 주입(월드좌표·치수·굴뚝·seed)
//   field.setExcluded(fn);                 // (id)=>bool — 오버레이(선택) 필지 제외
//   field.setTime(name, immediate); field.setSeason(name);
//   field.update(dt, camera);              // 매 프레임(어댑터 update 에서 same-frame dt·camera). 없으면 no-op.
//   field.dispose();
//   window.__ambLookahead(x, z)            // 시네마틱 프리워밍 훅 — 드론 경로 앞 지점 선행 점등(TTL)
//
// 3계층:
//   근접(NEAR): 먼지 모트 + 등롱 sway + 공유 굴뚝 연기. 캡 NEAR_CAP.
//               (풀·소동물·지붕 날씨 오버레이는 오버레이 지오가 필요 → 선택 필지 engine 링 전용.
//                필드 이웃은 지오가 없어 생략 — 드로우콜 예산 준수. 풀은 #106 그대로 engine 링 +1.)
//   중간(MID) : 등롱 sway(프레임 제거 bulb+light) + 공유 굴뚝 연기. 캡 MID_CAP, 거리랭크 LRU 교체.
//   원경      : 어댑터 기존 일괄(vnight·정적 등롱 발광) — 필드 무개입.
//
// 원칙:
//  - 히스테리시스: 진입 반경 < 이탈 반경(1인칭 워커가 경계에서 왕복해도 명멸 없게).
//  - 속도 게이트: 카메라 이동 속도(위치 히스토리 추정)가 높으면 신규 점등 억제, 감속 시 재개.
//  - 프레임 분산: 한 프레임에 신규 셀 1개까지(히치 방지).
//  - 크로스페이드: 셀 present-gate(팟 금지). 공유 연기는 앵커 집합 변경에도 게이트 미리셋(smoke gateOnChange=false).
//  - 공유 연기: 굴뚝 앵커를 합성 name='chimney' 미니 메시(비렌더)로 등록 → setupSmoke 재사용(smoke.js 무개입).
//  - 드로우콜 절약: 등롱은 프레임(갓·끈·기둥) 제거 후 bulb+light 만(공유 재질). 셀 dispose 시 공유 재질 미해제.

const NEAR_ENTER = 26, NEAR_EXIT = 34;     // 근접 진입/이탈 반경(m) — 히스테리시스 8m
const MID_ENTER = 62, MID_EXIT = 74;       // 중간 진입/이탈 반경(m) — 히스테리시스 12m
const NEAR_CAP = 2, MID_CAP = 6;           // 계층별 동시 셀 상한
const SPEED_GATE = 18, SPEED_RESUME = 11;  // 신규 점등 억제 속도(m/s) — 히스테리시스
const SMOKE_ANCHORS = 4, SMOKE_PARTICLES = 6;   // 공유 연기 캡(≤24 스프라이트 = 드로우콜 상한)
const LOOKAHEAD_TTL = 3.0;                  // 프리워밍 지점 유효시간(초) — 갱신 없으면 소멸

const nowSec = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

export function createAmbientField(scene, { heightAt = () => 0, sun = null, renderer = null, lowPerf = false } = {}) {
  const _sun = sun || findSun(scene);
  const shared = getLanternMaterials();
  const sharedMats = new Set([shared.glow, shared.frame]);   // 셀 dispose 시 미해제(공유 재질 보호)

  let parcels = [];
  const descById = new Map();
  let excluded = () => false;
  let curTime = 'day', curSeason = 'summer';
  let enabled = true;

  // 공유 굴뚝 연기 — 다중 앵커(합성 chimney 메시)를 하나의 스프라이트 풀로. 앵커 집합 변경에도 미명멸.
  const anchorGroup = new THREE.Group(); anchorGroup.name = 'ambFieldChimneys';
  scene.add(anchorGroup);
  const chimneyGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
  const chimneyMat = new THREE.MeshBasicMaterial({ visible: false });   // 비렌더(드로우콜 0), bbox 만 제공
  const smoke = setupSmoke({ scene, getBuilding: () => anchorGroup, particles: SMOKE_PARTICLES, maxAnchors: SMOKE_ANCHORS, gateOnChange: false });
  scene.add(smoke.group);
  smoke.setTime(curTime, { immediate: true });
  smoke.setEnabled(true);
  let smokeKey = '';
  let smokeFade = 0;

  const cells = new Map();   // id -> cell(active)
  const retiring = [];
  let frameNo = 0;

  // PointLight 고정 풀(#141) — 필드 수명 동안 씬에 상주하는 POOL_N 개 PointLight. 항상 visible 이라
  //   씬의 numPointLights 가 상수(=재컴파일 폭풍 소멸). 미사용 슬롯은 intensity 0 으로 파킹(visible=false 는
  //   개수에서 빠져 다시 요동하므로 금지). 매 프레임 active/retiring 셀 등롱을 카메라 근접 순으로 배정,
  //   초과분은 자연 탈락(기존에도 원경 등롱은 국소광이 약했음). N=10 은 근접 우선 점등 + 프래그먼트 상한.
  const POOL_N = 10;
  function makeLightPool() {
    const lights = [];
    for (let i = 0; i < POOL_N; i++) {
      const l = new THREE.PointLight(0xffb266, 0, 5.5, 2);   // attachOverlayLanterns 등롱과 동일 파라미터
      l.name = 'ambPoolLight'; l.castShadow = false; l.visible = true;
      scene.add(l); lights.push(l);
    }
    const _wp = new THREE.Vector3();
    const _cand = [];   // 재사용 후보 배열(프레임당 clear)
    function assign(camera) {
      _cand.length = 0;
      const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
      const gather = (cell) => {
        const ls = cell.lanterns; if (!ls) return;
        const s = cell.strength; if (s < 0.02) return;
        for (const L of ls) {
          L.bulb.getWorldPosition(_wp);
          const dx = _wp.x - cx, dy = _wp.y - cy, dz = _wp.z - cz;
          _cand.push({ x: _wp.x, y: _wp.y, z: _wp.z, i: L.baseI * s, d: dx * dx + dy * dy + dz * dz });
        }
      };
      for (const c of cells.values()) gather(c);
      for (const r of retiring) gather(r);
      _cand.sort((a, b) => a.d - b.d);
      for (let i = 0; i < POOL_N; i++) {
        const c = _cand[i];
        if (c) { lights[i].position.set(c.x, c.y, c.z); lights[i].intensity = c.i; }
        else lights[i].intensity = 0;
      }
    }
    function clear() { for (const l of lights) l.intensity = 0; }
    function dispose() { for (const l of lights) scene.remove(l); }
    return { assign, clear, dispose, get size() { return POOL_N; } };
  }
  const lightPool = makeLightPool();

  // 카메라 히스토리(속도) + 앵커(지면점) + 룩어헤드(프리워밍).
  const _camPrev = new THREE.Vector3(); let _camHas = false; let speed = 0; let speedHot = false;
  const _dir = new THREE.Vector3();
  let anchorX = 0, anchorZ = 0;
  let lookahead = null;      // { x, z, t }
  const lookaheadFn = (x, z) => { if (Number.isFinite(x) && Number.isFinite(z)) lookahead = { x, z, t: nowSec() }; };
  if (typeof window !== 'undefined') window.__ambLookahead = lookaheadFn;

  // ── 셀 공용 helpers ──
  function stripLanternFrames(scope) {
    for (let i = scope.children.length - 1; i >= 0; i--) {
      const c = scope.children[i];
      if (c.name === 'lantern-frame') { c.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); scope.remove(c); }  // 지오만(재질 공유)
    }
  }
  function attachSway(container, desc) {
    const scope = new THREE.Group();
    scope.position.set(desc.cx, desc.baseY, desc.cz); scope.rotation.y = desc.rotY;
    container.add(scope);
    // PointLight 풀링(#141): 셀은 발광 bulb(공유 glow 재질 emissive — 야간 어댑터가 hanjiGlow 로 점등)만
    //   두고 PointLight 는 심지 않는다(emitLight:false). 셀 스핀업/은퇴마다 조명 개수가 요동해 씬 전체
    //   조명 재질이 개수별로 재컴파일되는 전환 셰이더 폭풍을 막는다. 국소 조명(warm cast)은 필드 고정
    //   풀(makeLightPool)이 카메라 근접 순으로 배정한다.
    attachOverlayLanterns(scope, { style: desc.style, W: desc.W, D: desc.D, seed: desc.seed, emitLight: false });
    stripLanternFrames(scope);
    const bulbs = [], lanterns = [];
    for (const c of scope.children) {
      if (c.name === 'lantern-bulb') { bulbs.push({ mesh: c, base: c.scale.clone() }); lanterns.push({ bulb: c, baseI: 0.65 }); }
    }
    const sway = setupLanternSway({ scene, scope }); sway.setEnabled(true);   // light 없이 bulb 만 흔들림(#141)
    return { sway, bulbs, lanterns };
  }
  function applyLanternFade(bulbs, s) {
    for (const b of bulbs) b.mesh.scale.set(b.base.x * s, b.base.y * s, b.base.z * s);
  }
  // 셀 dispose: 지오·전용 재질만 해제(공유 등롱 재질 보호). motes ShaderMaterial·bulb SphereGeometry 등.
  function disposeCell(container) {
    const geos = new Set(), mats = new Set(), texs = new Set();
    container.traverse((o) => {
      if (o.geometry && !o.isSprite) geos.add(o.geometry);
      const m = o.material;
      if (m) (Array.isArray(m) ? m : [m]).forEach((mm) => { if (mm && !sharedMats.has(mm)) mats.add(mm); });
    });
    for (const m of mats) for (const k in m) { const v = m[k]; if (v && v.isTexture) texs.add(v); }
    for (const t of texs) t.dispose();
    for (const m of mats) m.dispose();
    for (const g of geos) g.dispose();
  }

  function makeCell(tier, container, desc, subs) {
    const gate = makePresenceGate({ delay: 0.12, up: 0.7, down: 0.6 });
    let firstFrame = true, phase = 'in', strength = 0;
    return {
      tier, container, desc, _dist: 0, touch: frameNo,
      lanterns: subs.lanterns || null,   // #141 풀 배정용(bulb 월드좌표·baseI). strength 곱해 국소 조명.
      setTime(name, imm) { if (subs.motes) subs.motes.setTime(name, { immediate: !!imm }); },
      update(dt) {
        const present = phase === 'out' ? false : firstFrame ? false : true;   // 첫 프레임 prime→0(팟 방지)
        firstFrame = false;
        strength = gate.update(dt, { present });
        if (subs.motes) { subs.motes.setFade(strength); subs.motes.update(dt); }
        if (subs.sway) subs.sway.update(dt);
        applyLanternFade(subs.bulbs, strength);
      },
      beginOut() { phase = 'out'; },
      dead() { return phase === 'out' && strength < 0.02; },
      dispose() {
        if (subs.sway) subs.sway.setEnabled(false);
        if (subs.motes) subs.motes.setEnabled(false);
        scene.remove(container);
        disposeCell(container);
      },
      get strength() { return strength; },
    };
  }
  function buildNearCell(desc) {
    const container = new THREE.Group(); container.name = 'ambNear'; scene.add(container);
    const moteR = Math.max(5.5, Math.max(desc.W, desc.D) * 0.5);
    const motes = setupMotes({ scene, sun: _sun, renderer, radius: moteR, centerY: 2.8, ySpan: 0.22, count: 70 });
    motes.group.position.set(desc.cx, desc.baseY, desc.cz);
    container.add(motes.group); motes.setEnabled(true); motes.setTime(curTime, { immediate: true });
    const sway = attachSway(container, desc);
    return makeCell('near', container, desc, { motes, ...sway });
  }
  function buildMidCell(desc) {
    const container = new THREE.Group(); container.name = 'ambMid'; scene.add(container);
    const sway = attachSway(container, desc);
    return makeCell('mid', container, desc, { ...sway });
  }

  // ── 티어 판정(히스테리시스) ──
  function tierFor(cur, dist) {
    if (cur === 'near') return dist <= NEAR_EXIT ? 'near' : dist <= MID_EXIT ? 'mid' : null;
    if (cur === 'mid') return dist <= NEAR_ENTER ? 'near' : dist <= MID_EXIT ? 'mid' : null;
    return dist <= NEAR_ENTER ? 'near' : dist <= MID_ENTER ? 'mid' : null;
  }

  function computeAnchor(camera) {
    camera.getWorldDirection(_dir);
    if (_dir.y < -1e-3) {
      const t = -camera.position.y / _dir.y;   // y=0 평면(지면) 교점 = 카메라가 보는 지면점
      if (t > 0 && t < 1400) { anchorX = camera.position.x + _dir.x * t; anchorZ = camera.position.z + _dir.z * t; return; }
    }
    anchorX = camera.position.x; anchorZ = camera.position.z;   // 위/수평 시선 폴백
  }
  function updateSpeed(camera, dt) {
    if (_camHas && dt > 1e-4) {
      const inst = camera.position.distanceTo(_camPrev) / dt;
      speed += (inst - speed) * Math.min(1, dt * 6);   // 평활(순간 지터 억제)
    }
    _camPrev.copy(camera.position); _camHas = true;
    if (speed > SPEED_GATE) speedHot = true; else if (speed < SPEED_RESUME) speedHot = false;
  }

  function syncSmokeAnchors() {
    const list = [];
    for (const [id, cell] of cells) { const d = descById.get(id); if (d && d.chimney) list.push({ id, ch: d.chimney, dist: cell._dist }); }
    list.sort((a, b) => a.dist - b.dist);
    const chosen = list.slice(0, SMOKE_ANCHORS);
    const key = chosen.map((c) => c.id).sort().join(',');
    if (key !== smokeKey) {
      smokeKey = key;
      for (let i = anchorGroup.children.length - 1; i >= 0; i--) anchorGroup.remove(anchorGroup.children[i]);
      for (const c of chosen) { const m = new THREE.Mesh(chimneyGeo, chimneyMat); m.name = 'chimney'; m.position.set(c.ch.x, c.ch.y, c.ch.z); anchorGroup.add(m); }
      smoke.onBuildingChanged();
    }
  }

  function update(dt, camera) {
    if (!enabled || !camera) { lightPool.clear(); smoke.update(dt); return; }
    frameNo++;
    computeAnchor(camera);
    updateSpeed(camera, dt);
    if (lookahead && (nowSec() - lookahead.t) > LOOKAHEAD_TTL) lookahead = null;

    // 희망 티어 산출(유효거리 = min(앵커, 룩어헤드)).
    const desired = new Map();
    if (parcels.length) {
      for (const d of parcels) {
        if (excluded(d.id)) continue;
        let dist = Math.hypot(d.cx - anchorX, d.cz - anchorZ);
        if (lookahead) dist = Math.min(dist, Math.hypot(d.cx - lookahead.x, d.cz - lookahead.z));
        const cur = cells.get(d.id);
        const tier = tierFor(cur ? cur.tier : null, dist);
        if (tier) desired.set(d.id, { tier, dist });
      }
      // 캡(거리 랭크). near 초과분은 mid 강등(범위 내) 아니면 드롭. mid 초과분(원거리)은 드롭 = LRU.
      const near = [...desired].filter(([, v]) => v.tier === 'near').sort((a, b) => a[1].dist - b[1].dist);
      for (let i = NEAR_CAP; i < near.length; i++) { const [id, v] = near[i]; if (v.dist <= MID_EXIT) v.tier = 'mid'; else desired.delete(id); }
      const mid = [...desired].filter(([, v]) => v.tier === 'mid').sort((a, b) => a[1].dist - b[1].dist);
      for (let i = MID_CAP; i < mid.length; i++) desired.delete(mid[i][0]);
    }

    // 리컨사일: 드롭/티어변경 → 리타이어, 유지 → 거리·touch 갱신.
    for (const [id, cell] of [...cells]) {
      const d = desired.get(id);
      if (!d || d.tier !== cell.tier) { cell.beginOut(); retiring.push(cell); cells.delete(id); }
      else { cell._dist = d.dist; cell.touch = frameNo; }
    }
    // 프레임 분산 스핀업(속도 게이트 시 신규 억제). 희망인데 미생성인 가장 가까운 1개만.
    if (!speedHot) {
      let bestId = null, bestDist = Infinity, bestTier = null;
      for (const [id, v] of desired) { if (cells.has(id)) continue; if (v.dist < bestDist) { bestDist = v.dist; bestId = id; bestTier = v.tier; } }
      if (bestId != null) {
        const desc = descById.get(bestId);
        const cell = bestTier === 'near' ? buildNearCell(desc) : buildMidCell(desc);
        cell._dist = bestDist; cell.setTime(curTime, true);
        cells.set(bestId, cell);
      }
    }

    for (const c of cells.values()) c.update(dt);
    for (let i = retiring.length - 1; i >= 0; i--) { const r = retiring[i]; r.update(dt); if (r.dead()) { r.dispose(); retiring.splice(i, 1); } }

    lightPool.assign(camera);   // #141 셀 등롱 국소광을 고정 풀에 근접 순 배정(개수 불변)

    syncSmokeAnchors();
    const sTarget = anchorGroup.children.length > 0 ? 1 : 0;
    smokeFade += (sTarget - smokeFade) * Math.min(1, dt * 1.4);
    smoke.setFade(smokeFade);
    smoke.update(dt);
  }

  function setParcels(list) {
    parcels = Array.isArray(list) ? list : [];
    descById.clear();
    for (const d of parcels) descById.set(d.id, d);
  }
  function setExcluded(fn) { excluded = typeof fn === 'function' ? fn : () => false; }
  function setTime(name, immediate) {
    if (!name) return; curTime = name;
    smoke.setTime(name, { immediate: !!immediate });
    for (const c of cells.values()) c.setTime(name, immediate);
    for (const r of retiring) r.setTime(name, immediate);
  }
  function setSeason(name) { if (name) curSeason = name; }   // 필드엔 풀 없음(모트·연기·등롱 계절 무관)
  function setEnabled(v) { enabled = !!v; }

  function dispose() {
    if (typeof window !== 'undefined' && window.__ambLookahead === lookaheadFn) delete window.__ambLookahead;
    for (const c of cells.values()) c.dispose(); cells.clear();
    for (const r of retiring) r.dispose(); retiring.length = 0;
    lightPool.dispose();
    smoke.setEnabled(false); scene.remove(smoke.group); disposeSubtree(smoke.group);
    scene.remove(anchorGroup);
    chimneyGeo.dispose(); chimneyMat.dispose();
  }

  return {
    setParcels, setExcluded, setTime, setSeason, setEnabled, update, dispose,
    // 검증 전용: 연기 서브시스템 가시성 토글(드로우콜 표에서 구조/연기 분해 실측용).
    _setSmokeVisible(v) { smoke.group.visible = !!v; },
    // 검증 전용.
    _debug() {
      const near = [], mid = [];
      for (const [id, c] of cells) (c.tier === 'near' ? near : mid).push(id);
      return {
        nearIds: near, midIds: mid, near: near.length, mid: mid.length,
        retiring: retiring.length, speed: +speed.toFixed(2), speedHot,
        smokeAnchors: anchorGroup.children.length, lookahead: !!lookahead,
        anchorX: +anchorX.toFixed(1), anchorZ: +anchorZ.toFixed(1),
      };
    },
  };
}
