import * as THREE from 'three';
import { makeRng } from '../rng.js';
import { PRESETS } from '../params.js';
import { buildBuilding } from '../builder/index.js';
import { buildParcel } from '../layout/parcel.js';
import { makeMaterials, setTextureRandom, applyThatchAge } from '../builder/palette.js';
import { setGateRandom } from '../layout/gate.js';
import { candleFlicker } from '../env/night-glow.js';
import { planVillage } from './plan.js';
import { populateVillage } from './populate.js';
import { buildPalaceCompound } from './palace.js';
import { houseMatrix, parcelMatrix, parcelRotY } from './instancing.js';
import { buildVillageWall } from './walls.js';
import { toneOf, variantOv, variantThatchAge } from './variants.js';
import { TIME_PRESETS } from '../env/sky.js';
import { setupClouds } from '../env/clouds.js';
import * as G from './geom.js';

// v4 마을 어댑터 — 앱 실시간 파이프라인과 마을 생성기 사이의 단일 계약면.
//   createVillage(opts) → VillageHandle
//     opts: { scale, character, includePalace, includeTemple, seed }
//
// VillageHandle (UI 소비 API):
//   .group            THREE.Group — scene 에 add 할 마을 루트(지형·집·랜드마크·수목 포함)
//   .plan             planVillage 원본 데이터(집 목록·통계·경계)
//   .getPickProxies() → [{ parcelId, mesh, bbox, buildingSpec, worldCenter, cameraFraming }]
//   .raycast(raycaster) → 위 프록시 디스크립터 | null (히트한 필지)
//   .rebuildParcel(parcelId, newParams) → 해당 필지만 풀디테일로 재생성(집 편집 반영)
//   .highlightParcel(parcelId, on)      → 먹선 아웃라인 하이라이트 토글(호버 표시)
//   .setTime(name) / .setSeason(name, opts) / .setWeather(name)  → env 상태 전파
//   .update(dt)       매 프레임(개울 물결·야간 촛불 일렁임)
//   .enterVillageMode(app) / .exitVillageMode(app)  → 앱 단일건물 씬 ↔ 마을 씬 스왑
//   .dispose()        지오·텍스처 해제
//
// 성능: 정규 주택은 instancing.js 로 재질별 InstancedMesh, 담·도로·논·랜드마크는 재질별
//   정적 병합(populate.js optimize) → capital 68호 드로우콜 8,700+ → 수백 규모.
// 픽킹: 실제 메시가 아닌 필지 프록시(바운딩 박스) 레이캐스트 — 지붕·담·마당 어디든 그 집이 잡힘.

const WARM = 0xffb35c;   // 호롱불 온기(night-glow.js 와 동일 색)
const DEG = Math.PI / 180;

// ── 마을 조명 보정(태스크 #44) ─────────────────────────────────────────────
// 마을 부감은 고도가 높고 배산 능선이 저각 태양을 가려, 단일 씬용 처방(scene sun+hemi+post)
// 만으로는 산그늘·역광에서 지형·집이 실루엣(뭉갠 검정)으로 죽는다. 플래그십 원칙("너무 어두운
// 부분이 없어야, 대비 과하지 않게, HDR 충만") 위반. 단일 씬은 main.js 안티솔라 웜 필로 해결하지만
// 앱 엔진엔 그 필이 없다.
//
// 처방: 마을 활성 동안에만 씬에 얹는 전용 조명 리그. scene sun/hemi(단일 씬 공유)와 post
// POST_TUNING 을 전혀 건드리지 않으므로 단일 씬 룩은 완전 불변(리그가 씬에 없을 때 == 단일 씬).
//   (1) 헤미 리프트 — 전역 앰비언트를 올려 뭉갠 검정(특히 배산 북사면·분지)을 중간톤으로.
//       스카이돔(MeshBasic)·fog 는 조명 무관 → 하늘은 안 들뜨고 지형·집만 살아난다.
//   (2) 안티솔라 웜 필 — 태양 수평 반대편 저각 DirectionalLight(그림자 비캐스트). 카메라를 향한
//       그늘 수직면·근사면을 데워 실루엣을 깨되, 저각이라 위 보는 지면은 그레이징으로 덜 밝혀
//       "지면<건물" 과 사양(斜陽) 대비를 보존. 색은 채도 낮춘 살구빛(main.js 필과 동일 계열).
// 석양 무드(역광 실루엣 감성)는 유지 — 목표는 "밝게"가 아니라 "읽히게". 값은 하네스 히스토그램
// (순흑<0.5%·중간톤 회복)으로 튜닝.
const VILLAGE_LIGHT_BY_TIME = {
  dawn: {
    hemiSky: 0xb9c2da, hemiGround: 0x86745c, hemiInt: 0.62,
    fillColor: 0xffcda0, fillInt: 0.85, fillElev: 0.34, glowBoost: 1.0,
  },
  day: {
    // 낮은 이미 충분히 밝다 — 최소 리프트만(그늘 계곡 바닥이 검게 죽는 것 방지).
    hemiSky: 0xbcd4ec, hemiGround: 0x8a7a63, hemiInt: 0.22,
    fillColor: 0xfff0e0, fillInt: 0.18, fillElev: 0.4, glowBoost: 1.0,
  },
  sunset: {
    // 위는 쿨(황혼 하늘색 앰비언트)·아래는 웜(바운스) — 골든아워 색분리 골격을 리프트로 유지.
    hemiSky: 0x9fb0d6, hemiGround: 0x6d5236, hemiInt: 0.66,
    fillColor: 0xf2b28c, fillInt: 1.15, fillElev: 0.34, glowBoost: 1.0,
  },
  night: {
    // 야간은 어둠(무드) 유지하되 순흑 뭉갬만 완화 — 달빛 쿨 리프트로 지붕·담 형태가 읽히게.
    // 창호등이 어둠을 깨도록 발광 부스트도 함께(applyNightGlow).
    hemiSky: 0x3d4c6e, hemiGround: 0x1b2233, hemiInt: 0.42,
    fillColor: 0xa9bde0, fillInt: 0.30, fillElev: 0.42, glowBoost: 1.5,
  },
};

export function createVillage(opts = {}) {
  const seed = (typeof opts.seed === 'number' ? opts.seed
    : typeof opts.seed === 'string' ? hashStr(opts.seed) : 20260716) >>> 0;

  // ── 재현성(같은 seed → 픽셀 동일): plan+populate 는 동기 실행이므로 그 구간 동안만
  //    난수원을 시드로 고정하고 즉시 원복한다(앱 나머지 Math.random 불침해).
  //    · palette.js 캔버스텍스처·gate.js 싸리문은 전용 시더로(명시 계약).
  //    · props/materials.js 등 그 밖의 Math.random 소비자는 전역 Math.random 을 임시 교체해 덮는다.
  //    마을 배치 자체(makeRng)는 이미 완전 결정론.
  const origRandom = Math.random;
  setTextureRandom(makeRng((seed ^ 0x7e17) >>> 0));
  setGateRandom(makeRng((seed ^ 0x6a1e) >>> 0));
  Math.random = makeRng((seed ^ 0x9e3779b9) >>> 0);
  let plan, group;
  try {
    plan = planVillage({ ...opts, seed });
    group = populateVillage(plan);      // optimize 기본 ON
  } finally {
    Math.random = origRandom;
    setTextureRandom(null);
    setGateRandom(null);
  }

  const char01 = typeof plan.opts.char01 === 'number' ? plan.opts.char01 : 0.5;
  const site = plan.site;
  const handle = group.userData.houseHandle;   // { giwa, choga } InstancedMesh 그룹(또는 null)

  // ── 편집 오버레이 계층: rebuildParcel 이 만든 개별(풀디테일) 필지를 담는다. ──
  const overrides = new THREE.Group(); overrides.name = 'village-overrides';
  group.add(overrides);
  const overrideById = new Map();                 // parcelId -> THREE.Group
  const editWallMats = makeMaterials('giwa');      // 편집 담장 공유 재질(base 씬 wallMats 와 동일 팔레트)

  // ── 하이라이트(먹선 아웃라인 + 은은한 발광 박스) — 재사용 1벌을 이동/스케일. ──
  const hi = makeHighlight();
  hi.group.visible = false;
  group.add(hi.group);
  let highlighted = null;

  // ── 픽킹 프록시(필지 바운딩) — 렌더 트리에 넣지 않고 레이캐스트 전용. ──
  const proxies = buildProxies(plan, site, char01);
  const proxyGroup = new THREE.Group();          // scene 미포함(렌더 안 함) — 월드좌표 프록시
  for (const p of proxies) proxyGroup.add(p.mesh);
  proxyGroup.updateMatrixWorld(true);
  const proxyById = new Map(proxies.map((p) => [p.parcelId, p]));

  // ── env 상태 ──
  let time = 'day', season = 'summer', weather = 'clear';
  let glowT = 0;
  let glowBoost = 1.0;                                     // 마을 창호등 발광 배율(야간 부감 어둠 깨기)
  const glow = collectGlowMats(group);                    // [{mat, glow, phase, orig}] — 실제 렌더 창·문 재질

  // ── 마을 전용 조명 리그(태스크 #44). scene 에 add/remove 로 마을 활성 동안만 유효. ──
  const vlights = makeVillageLights();

  // ── 마을 fog 거리 모디파이어(태스크 #50). env 가 시간대 크로스페이드 중 매 틱 base fog 를
  //    다시 쓰므로(near/far=시간대 값), 마을 부감에 맞는 넓은 거리로 다시 늘린다. 색은 env 소유
  //    (시간대 크로스페이드)로 두고 near/far 만 오버라이드 — engine.reapplyVillageFog 와 동일 값
  //    (R*2.2/R*7.0)이라 멱등. enterVillageMode 에서 env.addFogModifier 로 등록. ──
  const villageFogR = (site && typeof site.R === 'number' && site.R > 0) ? site.R : 150;
  const villageFog = (scn) => {
    if (scn.fog) {
      scn.fog.near = villageFogR * 2.2; scn.fog.far = villageFogR * 7.0;
      // 지형 엣지 소실 헤이즈·운해 링 색을 대기(fog)색과 동기화(#50 시간대 크로스페이드 자동 정합).
      group.userData.setEnvHaze?.(scn.fog.color);
    }
  };

  // ── 흐르는 구름 그림자 빌보드(태스크 #57) ──────────────────────────────────
  // 빌보드는 태양 상태를 매 프레임 판독하므로 sun 이 필요 → 마을 진입(enterVillageMode)에서 scene 의
  //   sun 을 찾아 마을 그룹에 붙인다(env.group.visible 토글에 안 묶임). 그림자 uniform 은 populate 가
  //   지형 재질과 공유(group.userData.cloudUniforms) → 빌보드 update 가 그 uniform 을 갱신해 지면에 그늘.
  //   이탈 시 정리. 재진입마다 새로 붙여 중복·표류 누적 방지(shot·?clouds=0 은 clouds.js 가 처리).
  let cloudsHandle = null;
  function attachClouds(scene) {
    if (cloudsHandle) return;
    const sun = findSun(scene);
    if (!sun) return;
    cloudsHandle = setupClouds(group, {
      sun, edge: group.userData.edge || site.edge,
      terrainMax: group.userData.terrainMax || site.terrainR || 150,
      uniforms: group.userData.cloudUniforms,
      mistBillboards: false,   // 마을은 유기적 운해 링·능선 물안개(populate)가 산허리 물안개 역할 — 중복 제거
      highCloudCount: 4,       // 뭉게구름 4장(=대응 그림자 블롭 4). 마을에 드리우는 그림자 가독 확보(#68)
    });
  }
  function detachClouds() {
    if (!cloudsHandle) return;
    group.remove(cloudsHandle.group);
    cloudsHandle.dispose?.();
    cloudsHandle = null;
    // 지형 그림자 uniform 을 0 으로 되돌려(빌보드 없는 상태) 잔여 그늘이 남지 않게.
    const cu = group.userData.cloudUniforms;
    if (cu) cu.uCloudStr.value = 0;
  }

  // 마을 창호 발광 크로스페이드(태스크 #50): 밤 진입/이탈 시 창빛을 vnight(0..1)로 서서히 밝히/꺼뜨린다.
  //   재질 패치(WARM emissive)는 vnight>0 일 때 1회, 강도는 rec.glow*glowBoost*vnight*플리커.
  //   마을 진입(vGlowStarted=false)·shot 은 스냅, 이후 다이얼만 크로스페이드(단일건물 night-glow.js 와 동형).
  let vnight = 0, vnightGoal = 0, vGlowStarted = false;
  const VNIGHT_RATE = 2.4;
  // 시간대별 창불 점등 레벨(#60): 밤 1.0, 황혼 0.42(어스름 절반 점등), 새벽 0.22(성긴 이른 불),
  //   낮 0. sunset 은 앱 기본 뷰라 여기서 창불이 켜지는 게 "부감 야경의 마법"의 진입점.
  //   vnight 지수 lerp(VNIGHT_RATE)가 이 목표로 크로스페이드 → 창호 emissive·발광 포인트 자동 정합.
  const nightLevelFor = (name) => name === 'night' ? 1 : name === 'sunset' ? 0.42 : name === 'dawn' ? 0.22 : 0;
  function ensureGlowPatched(on) {
    for (const rec of glow) {
      if (on && !rec.orig) {
        rec.orig = { emHex: rec.mat.emissive.getHex(), emInt: rec.mat.emissiveIntensity, emMap: rec.mat.emissiveMap };
        rec.mat.emissive.setHex(WARM);
        rec.mat.emissiveMap = rec.mat.map || null;   // 한지 밝은 부분만 발광
        rec.mat.needsUpdate = true;
      } else if (!on && rec.orig) {
        rec.mat.emissive.setHex(rec.orig.emHex);
        rec.mat.emissiveIntensity = rec.orig.emInt;
        rec.mat.emissiveMap = rec.orig.emMap;
        rec.orig = null;
        rec.mat.needsUpdate = true;
      }
    }
  }
  function applyGlowLevel(flickerOn) {
    for (const rec of glow) {
      if (!rec.orig) continue;
      const fl = flickerOn ? candleFlicker(glowT, rec.phase) : 1;
      rec.mat.emissiveIntensity = rec.glow * glowBoost * vnight * fl;
    }
  }
  // 창빛 목표 세팅(setTime 경유). 진입 전(!vGlowStarted)·스냅 요청 시 즉시 반영.
  function setNightGlow(name, snap) {
    vnightGoal = nightLevelFor(name);
    if (snap || !vGlowStarted) { vnight = vnightGoal; ensureGlowPatched(vnight > 0.001); applyGlowLevel(false); group.userData.updateNightLights?.(0, vnight); }
  }
  // 매 프레임 창빛 크로스페이드 + 촛불 일렁임(밤). adapter.update 에서 호출.
  function stepNightGlow(dt) {
    vGlowStarted = true;
    if (Math.abs(vnight - vnightGoal) > 1e-4) {
      vnight += (vnightGoal - vnight) * Math.min(1, dt * VNIGHT_RATE);
      if (Math.abs(vnight - vnightGoal) <= 1e-4) vnight = vnightGoal;
      ensureGlowPatched(vnight > 0.001);
    }
    if (vnight > 0.001) { glowT += dt; applyGlowLevel(true); }
    group.userData.updateNightLights?.(dt, vnight);   // 원경 창불 발광 포인트(#60) — 같은 다이얼로 정합
  }

  // ── 히어로(종가) 포커스 — 랜딩·클로즈업·리플레이·편집을 위한 풀디테일 오버레이(#62·#59). ──
  //   종가는 정자·다리·소품과 함께 'village-landmarks' 로 정적 병합돼 개별 분리가 안 된다. populate
  //   가 히어로를 개별 그룹으로 노출(root.userData.heroHandle: Map<id,group>)하면 그 그룹만 가리고,
  //   없으면 merged 랜드마크를 통째로 가리는 폴백(랜딩/리플레이는 먹안개로 마스킹, 근접 소품 일시 은닉).
  //   오버레이는 buildParcel 컴파운드(병합본과 동일 지오) → playAssembly 로 조립·리플레이, 편집 시
  //   roofOpts 를 buildParcel 로 포워딩(코어 지원 시 반영).
  const heroHandle = group.userData.heroHandle instanceof Map ? group.userData.heroHandle : null;
  const heroParcels = plan.parcels.filter((p) => p.hero);
  const primaryHero = heroParcels.find((p) => p.heroStyle === 'hanok') || heroParcels[0] || null;
  const landmarksGroup = () => group.getObjectByName('village-landmarks');
  // 히어로 필지 편집 가능 여부(heroHandle 있어야 종가만 분리 은닉 가능). 프록시 스펙에 반영 —
  //   editable: 패널이 컨트롤을 열지 판단, compound: 컴파운드(hanok 종가)라 유형탭·칸수 대신 매무새만 노출.
  for (const p of proxies) {
    if (p.buildingSpec && p.buildingSpec.hero) { p.buildingSpec.editable = !!heroHandle; p.buildingSpec.compound = true; }
  }
  let heroOverride = null;       // { id, group } 표시 중 오버레이
  let landmarksHidden = false;   // 폴백: merged 랜드마크 통째 은닉 여부

  // building 편집 파라미터 → buildHanok roofOpts(eaveOverhang·profileCurve·riseScale=물매).
  //   패널 키: roofCurve/profileCurve → profileCurve, eaveOverhang → eaveOverhang. 물매(riseScale)는
  //   전용 축 범위가 필요해 #48 에서 확장(현재 roofPitch/riseScale 직결은 하위호환 유지).
  function heroRoofOpts(building) {
    if (!building) return null;
    const o = {};
    if (building.roofPitch != null) o.riseScale = building.roofPitch;
    if (building.riseScale != null) o.riseScale = building.riseScale;
    if (building.eaveOverhang != null) o.eaveOverhang = building.eaveOverhang;
    if (building.profileCurve != null) o.profileCurve = building.profileCurve;
    if (building.roofCurve != null) o.profileCurve = building.roofCurve;
    return Object.keys(o).length ? o : null;
  }
  // 특수 필지 편집(#48) — heroStyle 별로 buildParcel 편집 계약을 조립한다.
  //   hanok(종가): buildHanok roofOpts(지붕 매무새) + wallH(벽 높이).
  //   palace(관아·객사, 다포 전각): buildBuilding presetOverrides(공포·월대·지붕·평면 등).
  //   레거시 building 오버라이드 경로(구 패널)는 heroRoofOpts / presetOverrides 폴백으로 계속 수용.
  function heroEditOpts(parcel, np) {
    if ((parcel.heroStyle || 'hanok') === 'hanok') {
      const roofOpts = { ...(np.roofOpts || {}) };
      const legacy = heroRoofOpts(np.building);
      if (legacy) for (const k in legacy) if (roofOpts[k] == null) roofOpts[k] = legacy[k];
      const eo = {};
      if (Object.keys(roofOpts).length) eo.roofOpts = roofOpts;
      if (np.wallH != null) eo.wallH = np.wallH;
      return eo;
    }
    const presetOverrides = { ...(np.presetOverrides || np.building || {}) };
    return Object.keys(presetOverrides).length ? { presetOverrides } : {};
  }
  function buildHeroCompound(parcel, editOpts = {}) {
    const g = new THREE.Group();
    g.name = `hero-override-${parcel.id}`;
    const opts = { seed: parcel.seed || 7, style: parcel.heroStyle || 'hanok', plotW: parcel.plotW, plotD: parcel.plotD };
    if (editOpts.roofOpts) opts.roofOpts = editOpts.roofOpts;
    if (editOpts.presetOverrides) opts.presetOverrides = editOpts.presetOverrides;
    if (editOpts.wallH != null) opts.wallH = editOpts.wallH;
    g.add(buildParcel(opts));
    g.rotation.y = G.facingY(parcel.frontDir);
    g.position.set(parcel.center.x, parcel.baseY != null ? parcel.baseY : 0, parcel.center.z);
    return g;
  }
  // 히어로를 풀디테일 오버레이로 표시(원본 종가는 가림). 반환: 오버레이 그룹(조립·편집 대상).
  //   editOpts 무전달(랜딩·리플레이)이면 기본 컴파운드, 편집 시엔 heroEditOpts 결과를 포워딩.
  function showHeroDetail(parcelId, editOpts) {
    const parcel = heroParcels.find((p) => p.id === parcelId);
    if (!parcel) return null;
    hideHeroDetail();
    const g = buildHeroCompound(parcel, editOpts || {});
    overrides.add(g);
    heroOverride = { id: parcelId, group: g };
    if (heroHandle && heroHandle.get(parcelId)) heroHandle.get(parcelId).visible = false;
    else { const lm = landmarksGroup(); if (lm) { lm.visible = false; landmarksHidden = true; } }
    return g;
  }
  function hideHeroDetail() {
    if (heroOverride) { disposeTree(heroOverride.group); overrides.remove(heroOverride.group); heroOverride = null; }
    if (heroHandle) for (const g of heroHandle.values()) g.visible = true;
    if (landmarksHidden) { const lm = landmarksGroup(); if (lm) lm.visible = true; landmarksHidden = false; }
  }

  // ── 궁궐 다일곽 컴파운드 focus·편집(#93) ─────────────────────────────────────
  //   #88 이 마을 궁을 features.palace 다일곽 컴파운드로 격상하며 편집 승격 규약을 노출했다.
  //   populate 는 palace-core 를 landmarks 병합에서 빼 미병합 그룹으로 root.userData.palaceCore 에 노출
  //   (히어로와 동형 — 병합본이면 편집용 분리가 불가하므로). 그 규약이 아직 안 깔린 빌드에선 palaceCore
  //   가 없어 아래 전부 graceful no-op(궁 focus 는 프록시만 있고 편집 불가로 폴백).
  //   focus-in: palaceCore 를 가리고 buildPalaceCompound 오버레이(편집 가능)를 같은 자리에 얹는다.
  //   편집: 오버레이를 presetOverrides 로 재생성(일곽 단위 병합 유지 — 드로우콜 회귀 없음).
  //   focus-out: 오버레이 폐기 + palaceCore 복원.
  const palaceCore = group.userData.palaceCore || null;                        // 미병합 palace-core 그룹 | null
  const palaceCompound = palaceCore ? (palaceCore.userData.palaceCompound || null) : null;  // buildPalaceCompound 루트
  const palaceInner = palaceCompound ? palaceCompound.parent : null;           // 배치 변환(위치·회전) 보유 그룹
  const palaceHandle = palaceCompound ? (palaceCompound.userData.palaceHandle || null) : null;
  let palaceOverride = null;     // { group, comp } 표시 중 오버레이
  let palaceHidden = false;      // palaceCore 은닉 여부
  const palaceEditable = () => !!(palaceCompound && palaceInner && palaceHandle);

  // 편집 오버레이 컴파운드 — 원본과 동일 배치·재질·seed 로 재생성, presetOverrides 만 얹는다.
  function buildPalaceOverlay(presetOverrides) {
    const ph = palaceHandle;
    const g = new THREE.Group();
    g.name = 'palace-override';
    const comp = buildPalaceCompound({
      w: ph.regionW, d: ph.regionD, tier: ph.tier, variant: ph.variant,
      seed: ph.seed != null ? ph.seed : 5,
      mats: palaceCompound.userData.mats,           // 텍스처·재질 공유(픽셀 정합)
      presetOverrides: presetOverrides || null,      // 코어 B 미반영 빌드에선 palace.js 가 무시(안전)
    });
    g.add(comp);
    g.rotation.y = palaceInner.rotation.y;
    g.position.copy(palaceInner.position);           // palace-core 은 root 직속·무변환 → inner 로컬 = group 로컬 = overrides 로컬
    return g;
  }
  function showPalaceDetail(presetOverrides) {
    if (!palaceEditable()) return null;
    hidePalaceDetail();
    const g = buildPalaceOverlay(presetOverrides);
    overrides.add(g);
    palaceOverride = { group: g, comp: g.children[0] };
    palaceCore.visible = false; palaceHidden = true;
    return g;
  }
  function hidePalaceDetail() {
    // 오버레이는 원본 palaceCore 와 재질(mats)을 공유하므로 지오메트리만 dispose — 재질을 dispose 하면
    //   focus-out 후 되살린 palaceCore 가 깨진 재질로 렌더된다. (지오는 buildPalaceCompound 마다 신규.)
    if (palaceOverride) {
      palaceOverride.group.traverse((o) => { if (o.geometry) o.geometry.dispose?.(); });
      overrides.remove(palaceOverride.group); palaceOverride = null;
    }
    if (palaceHidden && palaceCore) { palaceCore.visible = true; palaceHidden = false; }
  }
  // 궁 편집 패널 명세(#93). family 'palace-compound' 로 edit-schema 가 궁 전용 스키마를 연다.
  //   editable 은 palaceCore(미병합 핸들) 유무 — 없으면 focus·프레이밍만 되고 편집은 비활성.
  //   축은 전 전각 일괄(공포·지붕·처마) 만 — 일곽 구조 종속(칸수·월대단수)은 배제(다일곽 일관성).
  function palaceSpec() {
    const tier = palaceHandle ? palaceHandle.tier : (plan.features?.palace?.tier || 'capital');
    return {
      parcelId: 'palace', family: 'palace-compound', style: 'palace', palace: true,
      tier, editable: palaceEditable(),
      params: palaceCompoundDefaults(),
    };
  }

  // ── 궁 픽킹 프록시(1개) — features.palace 가 있으면 항상 추가(편집 불가여도 focus·프레이밍은 가능). ──
  //   기존 필지 프록시 배열에 append(getPickProxies·raycast 가 자동 포함). 상자는 궁역(regionW×D) 전체를
  //   덮어 지붕·마당 어디를 눌러도 궁이 잡히게. 궁역엔 민가 필지가 없어(plan blockers) 픽킹 하이재킹 없음.
  if (plan.features && plan.features.palace) {
    const pf = plan.features.palace;
    const W = (palaceHandle ? palaceHandle.regionW : pf.plotW) || 60;
    const D = (palaceHandle ? palaceHandle.regionD : pf.plotD) || 90;
    const rotY = palaceInner ? palaceInner.rotation.y : G.facingY(pf.frontDir || { x: 0, z: 1 });
    const baseY = palaceInner ? palaceInner.position.y
      : (site && typeof site.heightAt === 'function' ? site.heightAt(pf.x, pf.z) : 0);
    const H = 20;
    const worldCenter = new THREE.Vector3(pf.x, baseY, pf.z);
    const pmesh = new THREE.Mesh(new THREE.BoxGeometry(W, H, D));
    pmesh.position.set(pf.x, baseY + H / 2, pf.z);
    pmesh.rotation.y = rotY;
    pmesh.userData.parcelId = 'palace';
    pmesh.updateMatrixWorld(true);
    const proxy = {
      parcelId: 'palace', mesh: pmesh, bbox: new THREE.Box3().setFromObject(pmesh), worldCenter,
      dims: new THREE.Vector3(W, H, D), rotY,
      buildingSpec: palaceSpec(),
      cameraFraming: palaceFraming(worldCenter, rotY, W, D),
    };
    proxies.push(proxy);
    proxyGroup.add(pmesh); proxyGroup.updateMatrixWorld(true);
    proxyById.set('palace', proxy);
  }

  const api = {
    group,
    plan,
    seed,

    // ── 히어로(종가) 포커스 (마을 우선 진입·모드 일원화·리플레이) ──
    heroParcelId: () => (primaryHero ? primaryHero.id : null),
    isHero: (id) => heroParcels.some((p) => p.id === id),
    heroEditable: () => !!heroHandle,     // 편집 반영 가능(populate 언머지 필요). 아니면 오버레이 폴백은 근접 소품 은닉
    showHeroDetail, hideHeroDetail,
    heroDetailGroup: () => (heroOverride ? heroOverride.group : null),

    // 검증용(#48): 현재 편집 오버레이(정규 override 또는 특수 hero override)의 월드 바운딩 크기.
    //   편집 전후로 비교해 지오가 실제로 바뀌었는지 정량 확인(스크린샷 육안 검수와 병행).
    overlayBox(parcelId) {
      const g = parcelId === 'palace' ? (palaceOverride && palaceOverride.group)
        : (heroOverride && heroOverride.id === parcelId) ? heroOverride.group : overrideById.get(parcelId);
      if (!g) return null;
      g.updateWorldMatrix(true, true);
      const b = new THREE.Box3().setFromObject(g);
      const s = b.getSize(new THREE.Vector3());
      return { x: +s.x.toFixed(2), y: +s.y.toFixed(2), z: +s.z.toFixed(2) };
    },

    getPickProxies() {
      return proxies.map((p) => ({
        parcelId: p.parcelId, mesh: p.mesh, bbox: p.bbox.clone(),
        buildingSpec: p.buildingSpec, worldCenter: p.worldCenter.clone(),
        cameraFraming: cloneFraming(p.cameraFraming),
      }));
    },

    // 레이캐스터(마우스→광선) 로 히트한 필지 디스크립터 반환(없으면 null).
    raycast(raycaster) {
      const hits = raycaster.intersectObjects(proxyGroup.children, false);
      if (!hits.length) return null;
      const id = hits[0].object.userData.parcelId;
      const p = proxyById.get(id);
      return p ? {
        parcelId: id, point: hits[0].point.clone(), worldCenter: p.worldCenter.clone(),
        buildingSpec: p.buildingSpec, cameraFraming: cloneFraming(p.cameraFraming), bbox: p.bbox.clone(),
      } : null;
    },

    // 한 필지만 풀디테일로 재생성 — 인스턴스는 은닉, 오버레이에 개별 집을 얹는다.
    //   newParams(전부 선택, 하위호환): {
    //     kind?, building?,        // building = buildBuilding 프리셋 오버라이드:
    //                              //   frontBays·sideBays·roofPitch·eaveOverhang·cornerLift·profileCurve[=roofCurve]
    //                              //   + 치수축 columnHeight(기둥높이)·ridgeH(지붕높이)·podiumTierH(기단높이)
    //     footprintScale?,         // 전체 풋프린트 스케일(변주 스케일에 곱)
    //     wallType?,               // 담장 유형 'tile'|'stone'|'brush'
    //     roofTone?,               // 지붕/집 톤 인덱스(variants.TONE) — 곱틴트
    //     thatchAge?,              // 초가 이엉 상태 0(신선 금빛)~1(노후 회갈·이끼)
    //     aux?,                    // 부속채 토글
    //   }
    //   편집 기준은 필지의 실제 변주(variantOv) — 슬라이더 미조정 축은 렌더된 집 그대로 유지.
    //   격식 가드(clampDims): 서민 초가가 궁 비례가 되지 않게 kind별 치수 클램프(가사제한 정신).
    rebuildParcel(parcelId, newParams = {}) {
      // 궁궐 컴파운드(#93): presetOverrides 로 오버레이 재생성(일곽 병합 유지). 특수 커밋 경로(pointerup).
      if (parcelId === 'palace') {
        if (!palaceEditable()) return null;
        return showPalaceDetail(newParams.presetOverrides || null);
      }
      const parcel = plan.parcels.find((p) => p.id === parcelId);
      if (!parcel) return null;
      // 기존 오버라이드 제거
      const prev = overrideById.get(parcelId);
      if (prev) { disposeTree(prev); overrides.remove(prev); overrideById.delete(parcelId); }

      if (parcel.hero) {
        // 특수 필지(종가·관아)는 풀디테일 오버레이로 편집 반영(#48·#62·#59). populate 언머지(heroHandle)
        // 전엔 근접 소품이 함께 가려지는 폴백을 피하려 편집 미지원(null) — 랜딩·리플레이는 showHeroDetail 경유.
        if (!heroHandle) return null;
        return showHeroDetail(parcelId, heroEditOpts(parcel, newParams));
      }
      const kind = newParams.kind || parcel.kind;
      const gk = kind === 'giwa' ? 'giwa' : 'choga';
      const g = new THREE.Group();
      g.name = `override-${parcelId}`;
      // 편집 오버라이드 정규화: 패널 키 roofCurve → 코어 buildBuilding 키 profileCurve.
      const bld = { ...(newParams.building || {}) };
      if (bld.roofCurve != null && bld.profileCurve == null) { bld.profileCurve = bld.roofCurve; delete bld.roofCurve; }
      // 프리셋 ← 변주 ov(실제 렌더 기준) ← 편집 오버라이드. 격식 가드로 치수 클램프.
      const preset = { ...PRESETS[gk], ...variantOv(parcel), ...bld };
      clampDims(preset, gk);
      const house = buildBuilding(preset);
      // 초가 이엉 상태(thatchAge) — 텍스처 후처리(빌더 코어 불침해).
      if (gk === 'choga') {
        const age = newParams.thatchAge != null ? newParams.thatchAge
          : (parcel.thatchAge != null ? parcel.thatchAge : variantThatchAge(parcel));
        applyThatchAge(house.userData.materials, age);
      }
      // 부위별 곱틴트(#55): 인스턴스와 동일 팔레트를 풀디테일에 재질 색 곱연산(신규 재질이라 clone 불필요).
      //   roofTone 은 편집 오버라이드(인덱스) 우선, 없으면 필지의 부위별 지붕톤. 벽·목·석은 필지 톤 유지.
      const roofTint = newParams.roofTone != null ? toneOf(kind, newParams.roofTone)
        : (parcel.roofTone || toneOf(kind, parcel.toneIdx || 0));
      applyRoleTones(house, { roof: roofTint, wall: parcel.wallTone, wood: parcel.woodTone, stone: parcel.stoneTone });
      const back = -parcel.plotD / 2 + (kind === 'giwa' ? 5.2 : 3.4);
      house.position.set(0, 0, back);
      // 변주 스케일 × 풋프린트 스케일 편집.
      const fs = Math.max(0.6, Math.min(1.6, newParams.footprintScale != null ? newParams.footprintScale : 1));
      house.scale.set((parcel.sx || 1) * fs, (parcel.sy || 1) * fs, (parcel.sz || 1) * fs);
      g.add(house);
      // 담·마당(개별) — 유형·부속채 어휘.
      const wallType = newParams.wallType || parcel.wallType || 'stone';
      const aux = newParams.aux != null ? newParams.aux : parcel.aux;
      g.add(buildVillageWall(parcel.shape, editWallMats, {
        style: wallType, kind, seed: parcel.seed, char01, aux, plotW: parcel.plotW, plotD: parcel.plotD,
        wallHeightK: parcel.wallHeightK, jangdok: parcel.jangdok,
        yardStack: parcel.yardStack, clothesline: parcel.clothesline, vegBed: parcel.vegBed,
      }));
      g.applyMatrix4(parcelMatrix(parcel));
      overrides.add(g);
      overrideById.set(parcelId, g);

      // 인스턴스 은닉(원래 종류 기준)
      const h = handle[parcel.kind === 'giwa' ? 'giwa' : 'choga'];
      h?.userData.setHidden(parcelId, true);
      return g;
    },

    // ── focus 오버레이 통합(#92) — 어느 필지든 풀디테일 오버레이로 승격 ──
    //   mode-integration §4: "focus 필지는 풀디테일 오버레이(buildParcel)". 종가·궁만이 아니라 정규
    //   필지도 focus-in 하면 개별 집으로 승격 → (1) 편집이 즉시 반영되고 (2) 조립 리플레이가 가능하며
    //   (3) 앰비언스 근접 링(#79)이 붙을 앵커(굴뚝·마당·지붕)가 생긴다. 부감에선 인스턴스로 남는다.
    //   반환 { group, compound, assembly }:
    //     group    = 오버레이 루트(편집·링 앵커·focus-out 해제 대상).
    //     compound = 조립을 playCompoundAssembly(청크 단위)로 할지 여부(종가=true, 정규 집=false).
    //     assembly = 조립 애니 대상 노드(정규=단일 집 그룹, 특수=컴파운드 루트).
    showParcelDetail(parcelId) {
      if (parcelId === 'palace') {
        const g = showPalaceDetail();   // 편집 없는 기본 오버레이(원본 palaceCore 가림) — 조립·편집 앵커
        return g ? { group: g, compound: true, assembly: g } : null;
      }
      const parcel = plan.parcels.find((p) => p.id === parcelId);
      if (!parcel) return null;
      if (parcel.hero) {
        const g = showHeroDetail(parcelId);
        return g ? { group: g, compound: true, assembly: g } : null;
      }
      const g = this.rebuildParcel(parcelId, {});   // 기본(변주) 오버레이 + 인스턴스 은닉
      if (!g) return null;
      return { group: g, compound: false, assembly: g.children[0] || g };
    },
    // focus-out: 오버레이 해제 + 원본 복원. 정규=인스턴스 재노출, 특수(종가)=병합본 복원.
    hideParcelDetail(parcelId) {
      if (parcelId === 'palace') { hidePalaceDetail(); return; }
      const parcel = plan.parcels.find((p) => p.id === parcelId);
      if (parcel && parcel.hero) { hideHeroDetail(); return; }
      const g = overrideById.get(parcelId);
      if (g) { disposeTree(g); overrides.remove(g); overrideById.delete(parcelId); }
      if (parcel) { const h = handle[parcel.kind === 'giwa' ? 'giwa' : 'choga']; h?.userData.setHidden(parcelId, false); }
    },
    // 현재 표시 중 focus 오버레이(정규/특수) — 리플레이(#92 再 일반화)가 조회. 재생성 없이 현 오버레이
    //   (편집 상태 보존)를 반환: group=링 앵커, assembly=조립 대상 노드, compound=playCompoundAssembly 여부.
    focusAssembly(parcelId) {
      if (parcelId === 'palace') return palaceOverride ? { group: palaceOverride.group, assembly: palaceOverride.group, compound: true } : null;
      const parcel = plan.parcels.find((p) => p.id === parcelId);
      if (!parcel) return null;
      if (parcel.hero) return heroOverride && heroOverride.id === parcelId ? { group: heroOverride.group, assembly: heroOverride.group, compound: true } : null;
      const g = overrideById.get(parcelId);
      return g ? { group: g, assembly: g.children[0] || g, compound: false } : null;
    },

    // 먹선 아웃라인 하이라이트 토글. on=true 면 해당 필지에 아웃라인+은은한 발광.
    highlightParcel(parcelId, on) {
      if (!on) { if (highlighted === parcelId) { hi.group.visible = false; highlighted = null; } return; }
      const p = proxyById.get(parcelId);
      if (!p) return;
      hi.set(p.worldCenter, p.dims, p.rotY);
      hi.group.visible = true;
      highlighted = parcelId;
    },

    setTime(name) {
      time = name;
      const V = VILLAGE_LIGHT_BY_TIME[name] || VILLAGE_LIGHT_BY_TIME.day;
      glowBoost = V.glowBoost ?? 1.0;        // 발광 배율 먼저 확정(applyGlowLevel 가 참조)
      setNightGlow(name);                     // 창호 발광 크로스페이드 목표(진입 전엔 스냅)
      vlights.apply(name);                    // 마을 전용 헤미 리프트 + 안티솔라 웜 필
      group.userData.setWaterTime?.(name);   // 개울 물 글린트·하늘반사 시간대 하향(야간 흰 띠 방지)
      group.userData.setAnimalsTime?.(name); // 마당 닭 야간 홰 자세(소동물 #41)
    },
    setSeason(name, _opts) { season = name; group.userData.setSeason?.(name); },  // 마당 과실수 잎·꽃·열매 계절 토글(#41)
    setWeather(name) { weather = name; /* 적설은 앱 weather 배선 필요(보고 참조) */ },
    get time() { return time; }, get season() { return season; }, get weather() { return weather; },

    update(dt) {
      vlights.step(dt);                            // 마을 조명 리그 시간대 크로스페이드(태스크 #50)
      group.userData.update?.(dt);                 // 개울 물결 uTime
      cloudsHandle?.update(dt);                    // 산 구름·물안개 표류 + 흐르는 구름 그림자(태양 판독, #57)
      stepNightGlow(dt);                           // 창호 발광 크로스페이드 + 촛불 일렁임(밤)
    },

    // 앱 단일건물 씬 → 마을 씬 스왑. app: { scene, building?, ground?, env? }.
    //   sky/fog/sun 은 scene 레벨이라 그대로 유지(앱 env.setTime 이 구동) → 마을이 재사용.
    //   env 의 지면 레이어(env.group)는 숨겨 마을 자체 지형이 드러나게 한다.
    enterVillageMode(app = {}) {
      if (!app.scene) return;
      // 마을 부감 fog 거리(near/far)를 env fog 합성에 모디파이어로 등록(태스크 #50). env 가 시간대
      // 크로스페이드로 fog 색은 이어가고, 거리는 이 훅이 매 틱 마을 스케일(R*2.2/R*7.0)로 오버라이드.
      app.env?.addFogModifier?.(villageFog);
      vGlowStarted = false;   // 진입은 현재 시간대 창빛으로 스냅(페이드-인 없음). 이후 다이얼만 크로스페이드.
      this._prev = {
        building: app.building?.visible, ground: app.ground?.visible, env: app.env?.group?.visible,
      };
      app.scene.add(group);
      app.scene.add(vlights.rig);            // 마을 전용 조명(활성 동안만) — 단일 씬 공유 조명 불침해
      vlights.apply(time, { immediate: true }); // 진입은 스냅(씬 스왑), 이후 setTime 다이얼은 크로스페이드
      attachClouds(app.scene);               // 산 구름·물안개 빌보드(마을 그룹 자식 — env.group 토글 무관, #57)
      if (app.building) app.building.visible = false;
      if (app.ground) app.ground.visible = false;
      if (app.env?.group) app.env.group.visible = false;
    },
    exitVillageMode(app = {}) {
      if (!app.scene) return;
      app.env?.removeFogModifier?.(villageFog); // 마을 fog 거리 오버라이드 해제(태스크 #50)
      detachClouds();                            // 구름 빌보드 정리(재진입마다 새로 붙임, #57)
      app.scene.remove(group);
      app.scene.remove(vlights.rig);         // 리그 제거 → 씬 조명은 단일 씬 상태로 완전 복귀
      const pv = this._prev || {};
      if (app.building && pv.building !== undefined) app.building.visible = pv.building;
      if (app.ground && pv.ground !== undefined) app.ground.visible = pv.ground;
      if (app.env?.group && pv.env !== undefined) app.env.group.visible = pv.env;
    },

    // 검증/디버그: 프록시 박스를 와이어프레임으로 씬에 노출(픽킹 프록시 시각화 컷).
    debugShowProxies(on) {
      if (on && !this._proxyViz) {
        this._proxyViz = new THREE.Group(); this._proxyViz.name = 'proxy-viz';
        for (const p of proxies) {
          const wire = new THREE.LineSegments(
            new THREE.EdgesGeometry(p.mesh.geometry),
            new THREE.LineBasicMaterial({ color: 0x1b6ec8 }));
          wire.position.copy(p.mesh.position); wire.quaternion.copy(p.mesh.quaternion);
          this._proxyViz.add(wire);
        }
        group.add(this._proxyViz);
      }
      if (this._proxyViz) this._proxyViz.visible = !!on;
    },

    dispose() {
      detachClouds();
      disposeTree(group);
      vlights.dispose();
      for (const p of proxies) p.mesh.geometry.dispose();
    },
  };

  return api;
}

// ───────────────────────── 헬퍼 ─────────────────────────

function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// 씬의 태양 DirectionalLight 를 찾는다(구름 빌보드가 태양 방향·색·세기를 매 프레임 판독).
//   engine.js 는 그림자 캐스터 DirectionalLight 를 scene 직속으로 add(유일). 마을 조명 리그의
//   안티솔라 필(fill)은 castShadow=false 이고 rig 그룹 안(중첩)이라 걸러진다.
function findSun(scene) {
  if (!scene) return null;
  for (const o of scene.children) if (o.isDirectionalLight && o.castShadow) return o;
  // 폴백: 중첩 포함 첫 그림자 캐스터(예외적 씬 구성 대비).
  let found = null;
  scene.traverse((o) => { if (!found && o.isDirectionalLight && o.castShadow) found = o; });
  return found;
}

// 필지별 픽킹 프록시(바운딩 박스, 실제보다 살짝 크게 — 작은 초가도 잡힘).
function buildProxies(plan, site, char01) {
  const out = [];
  for (const parcel of plan.parcels) {
    const kind = parcel.kind;
    const baseY = parcel.baseY != null ? parcel.baseY : site.heightAt(parcel.center.x, parcel.center.z);
    // 높이 추정: 초가 6 / 기와 8 / 히어로·궁·절 13. 박스는 지면~지붕 위 여유.
    const H = parcel.hero ? 14 : (kind === 'giwa' ? 9 : 6.5);
    const pad = 1.08;                                  // 실제 필지보다 8% 크게(호버 관대)
    // 부정형 필지: 로컬 shape 바운딩(전단·부채로 사각을 벗어남)으로 박스 산출 — 폴리곤 바운딩+여유.
    const pts = parcel.shape && parcel.shape.pts;
    let bw = parcel.plotW, bd = parcel.plotD, lcx = 0, lcz = 0;
    if (pts && pts.length >= 3) {
      let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
      for (const p of pts) { if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x; if (p.z < minz) minz = p.z; if (p.z > maxz) maxz = p.z; }
      bw = maxx - minx; bd = maxz - minz; lcx = (minx + maxx) / 2; lcz = (minz + maxz) / 2;
    }
    const W = bw * pad, D = bd * pad;
    const rotY = parcelRotY(parcel);
    // 로컬 bbox 중심 → 월드(parcelMatrix 규약 T·Ry). shape 이 전단돼 원점을 벗어날 수 있어 보정.
    const cos = Math.cos(rotY), sin = Math.sin(rotY);
    const wcx = parcel.center.x + lcx * cos + lcz * sin;
    const wcz = parcel.center.z - lcx * sin + lcz * cos;
    const worldCenter = new THREE.Vector3(wcx, baseY, wcz);

    const geo = new THREE.BoxGeometry(W, H, D);
    const mesh = new THREE.Mesh(geo);                  // 재질 불필요(레이캐스트 전용)
    mesh.position.set(wcx, baseY + H / 2, wcz);
    mesh.rotation.y = rotY;
    mesh.userData.parcelId = parcel.id;
    mesh.updateMatrixWorld(true);

    const bbox = new THREE.Box3().setFromObject(mesh);
    out.push({
      parcelId: parcel.id, mesh, bbox, worldCenter,
      dims: new THREE.Vector3(W, H, D), rotY,
      buildingSpec: buildSpec(parcel),
      cameraFraming: framingFor(worldCenter, rotY, Math.max(W, D, H), H),
    });
  }
  return out;
}

// 편집 패널(#48)이 읽을 필지 명세. params = UI 컨트롤 기본값(편집 시 rebuildParcel 로 전달). 키는 코어
//   buildBuilding/buildParcel 실제 키를 그대로 써 앱 스키마(edit-schema.js)가 무번역 라우팅한다.
//   family 로 편집 계약이 갈린다:
//     'regular' (기와/초가): building 오버라이드(frontBays·sideBays·roofPitch|riseScale·eaveOverhang·
//        profileCurve·cornerLift·columnHeight·ridgeH·podiumTierH·centerBayW·endBayW·mainHalfW/D·wingLen/W·
//        winBack·doorPattern) + 최상위(footprintScale·wallType·roofTone·thatchAge·aux). 기본값=변주(variantOv)
//        반영 → 편집 시작점이 렌더와 일치.
//     'hero'    (종가 hanok / 관아 palace): 특수 편집. hanok=buildHanok 기본값, palace=PRESETS.korea 기본값.
//        editable 은 프록시 루프에서 heroHandle 유무로 확정한다.
function palaceEditDefaults() {
  const P = PRESETS.korea;
  return {
    roofPitch: P.roofPitch, eaveOverhang: P.eaveOverhang, profileCurve: P.profileCurve,
    bracketTiers: P.bracketTiers, bracketScale: P.bracketScale, interBrackets: P.interBrackets,
    frontBays: P.frontBays, sideBays: P.sideBays, columnHeight: P.columnHeight,
    podiumTiers: P.podiumTiers, podiumTierH: P.podiumTierH, podiumRailing: P.podiumRailing,
    cornerLift: P.cornerLift, ridgeH: P.ridgeH,
  };
}
// 궁궐 다일곽 컴파운드 편집 기본값(#93) — 전 전각 일괄 적용 축만(공포·지붕·처마). buildPalaceCompound
//   presetOverrides 로 흘러 hallPreset 결과에 Object.assign. 일곽 구조(칸수·월대단수)는 배제.
function palaceCompoundDefaults() {
  const P = PRESETS.korea;
  return {
    roofPitch: P.roofPitch, eaveOverhang: P.eaveOverhang, profileCurve: P.profileCurve, cornerLift: P.cornerLift,
    bracketTiers: P.bracketTiers, bracketScale: P.bracketScale, interBrackets: P.interBrackets,
  };
}
function buildSpec(parcel) {
  const kind = parcel.kind;
  if (parcel.hero) {
    const heroStyle = parcel.heroStyle === 'hanok' ? 'hanok' : 'palace';
    // hanok 기본값은 buildHanok(hanok.js) 내부 기본(riseScale 1.3 등) + buildParcel wallH 기본 2.7.
    const params = heroStyle === 'hanok'
      ? { riseScale: 1.3, eaveOverhang: 1.15, profileCurve: 0.45, cornerLift: 0.45, ridgeH: 0.42, wallH: 2.7 }
      : palaceEditDefaults();
    return {
      kind, rank: parcel.rank, hero: true, heroStyle, family: 'hero', compound: true,
      plotW: parcel.plotW, plotD: parcel.plotD, seed: parcel.seed,
      editable: true, params,
    };
  }
  const gk = kind === 'giwa' ? 'giwa' : 'choga';
  const preset = PRESETS[gk] || {};
  const ov = variantOv(parcel);
  const d = (k) => (ov[k] != null ? ov[k] : preset[k]);   // 변주 우선, 없으면 프리셋(미지원 축은 undefined → 스키마가 걸러냄)
  return {
    kind, rank: parcel.rank, hero: false, family: 'regular',
    plotW: parcel.plotW, plotD: parcel.plotD, seed: parcel.seed,
    variant: parcel.variant, editable: true,
    params: {
      frontBays: d('frontBays'), sideBays: d('sideBays'),
      roofPitch: d('roofPitch'), riseScale: d('riseScale'),
      eaveOverhang: d('eaveOverhang'), profileCurve: d('profileCurve'), cornerLift: d('cornerLift'),
      columnHeight: d('columnHeight'), ridgeH: d('ridgeH'), podiumTierH: d('podiumTierH'),
      centerBayW: d('centerBayW'), endBayW: d('endBayW'),
      mainHalfW: d('mainHalfW'), mainHalfD: d('mainHalfD'), wingLen: d('wingLen'), wingW: d('wingW'),
      winBack: gk === 'choga' ? (ov.winBack != null ? ov.winBack : 0) : undefined,
      doorPattern: gk === 'giwa' ? (ov.doorPattern || 'ttisal') : undefined,
      footprintScale: 1,
      wallType: parcel.wallType || 'stone',
      roofTone: parcel.toneIdx || 0,
      thatchAge: gk === 'giwa' ? undefined : (parcel.thatchAge != null ? parcel.thatchAge : 0.5),
      aux: !!parcel.aux,
    },
  };
}

// 격식 가드: 치수축을 kind별 사관(仕官) 범위로 클램프 — 서민 초가가 궁 같은 비례가 되지 않게(가사제한 정신).
function clampDims(P, gk) {
  const cl = (k, lo, hi) => { if (P[k] != null) P[k] = Math.max(lo, Math.min(hi, P[k])); };
  if (gk === 'giwa') { cl('columnHeight', 2.4, 3.8); cl('ridgeH', 0.30, 0.60); cl('podiumTierH', 0.30, 0.95); }
  else { cl('columnHeight', 1.8, 2.7); cl('ridgeH', 0.24, 0.40); cl('podiumTierH', 0.16, 0.50); }
}

// 풀디테일 집에 부위별 곱틴트(#55) — 인스턴스 instanceColor 와 동일 팔레트를 재질 색에 직접 곱연산.
//   material.userData.role(roof/wall/wood/stone)로 톤을 분배. 개구부·기타는 중립(무틴트). 신규 재질이라
//   clone 불필요. _toned 가드로 중복 방지. tints 미지정 부위는 무틴트(하위호환).
function applyRoleTones(root, tints) {
  root.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      if (!m || !m.color || m.userData._toned) continue;
      const role = m.userData.role;
      const t = role === 'roof' ? tints.roof : role === 'wall' ? tints.wall
        : role === 'wood' ? tints.wood : role === 'stone' ? tints.stone : null;
      if (t) {
        m.color.setRGB(m.color.r * t[0], m.color.g * t[1], m.color.b * t[2]);
        m.userData._toned = true;
      }
    }
  });
}

// 단일 건물 뷰의 three-quarter 프레이밍을 이 집 기준으로(정면=frontDir). 앱 setAngle 공식.
function framingFor(worldCenter, rotY, maxDim, H) {
  const az = 38 * DEG, el = 13 * DEG, r = 3.0 * maxDim;
  const off = new THREE.Vector3(
    r * Math.cos(el) * Math.sin(az), r * Math.sin(el), r * Math.cos(el) * Math.cos(az));
  off.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);   // 정면(frontDir) 기준 배치
  const target = new THREE.Vector3(worldCenter.x, worldCenter.y + H * 0.42, worldCenter.z);
  return { position: target.clone().add(off), target, fov: 28 };
}
function cloneFraming(f) { return { position: f.position.clone(), target: f.target.clone(), fov: f.fov }; }

// 궁궐 프레이밍(#93): 궁역(regionW×D)이 넓어 일반 집 프레이밍(3×maxDim)은 너무 멀다. 규모 기반 fit
//   거리로 축선(정전→편전→침전)이 화면에 여유 있게 들어오게. 정면(frontDir)에서 40° 사, 고도 20°
//   (부감 아니고 근접이되 다일곽 배치가 읽히도록 살짝 위에서). 여유 패딩으로 궁장·후원 여백 포함.
function palaceFraming(worldCenter, rotY, W, D) {
  const ext = Math.max(W, D);
  const fov = 32;
  const az = 40 * DEG, el = 20 * DEG;
  const r = (ext * 0.5) / Math.tan(fov * 0.5 * DEG) * 1.12 + ext * 0.12;
  const off = new THREE.Vector3(
    r * Math.cos(el) * Math.sin(az), r * Math.sin(el), r * Math.cos(el) * Math.cos(az));
  off.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
  const target = new THREE.Vector3(worldCenter.x, worldCenter.y + 6, worldCenter.z);
  return { position: target.clone().add(off), target, fov };
}

// 야간 창호광 대상(#66): 마을 루트를 훑어 userData.hanjiGlow 태그가 붙은 창·문 재질을 모은다.
//   구 코드는 공유 matSets(M.door/hanji/salchang)를 패치했으나, 집 프로토는 문짝·살창을 per-mesh
//   clone 으로 써 공유 원본은 실제 렌더에 안 쓰여 발광이 나지 않았다(사용자 지적 "문으로도 빛").
//   태그가 clone 에 전파되므로(Material.copy 가 userData 딥카피) traverse 로 실제 렌더 재질
//   (InstancedMesh·히어로 메시)을 잡는다. glow=단위면적 계수(palette.hanjiGlow: 문<창), phase=플리커
//   위상(재질별 상이 → 동기 깜빡임 방지). 마을 결정론 빌드라 traverse 순서·위상 안정(shot 재현성).
function collectGlowMats(root) {
  const out = [];
  const seen = new Set();
  let i = 0;
  root.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      const base = m && m.userData ? m.userData.hanjiGlow : null;
      if (base == null || seen.has(m)) continue;
      seen.add(m);
      out.push({ mat: m, glow: base, phase: (i++) * 1.7, orig: null });
    }
  });
  return out;
}

// 마을 전용 조명 리그(태스크 #44). 리그(Group)에 헤미 리프트 + 안티솔라 웜 필(비캐스트)을 담아
// enterVillageMode 에서 scene 에 add, exitVillageMode 에서 remove — 마을 활성 동안만 유효하다.
// scene 에 직접 붙어 월드 공간(그룹 변환 무관)에서 방향이 정의된다.
//   apply(name,{immediate}): VILLAGE_LIGHT_BY_TIME[name] 를 목표로 세팅(immediate 면 스냅), step(dt)
//   가 헤미·필·필방위를 크로스페이드(태스크 #50, env 시간대 트윈과 결이 맞게). enter 는 스냅, 다이얼은 트윈.
function makeVillageLights() {
  const rig = new THREE.Group();
  rig.name = 'village-lights';

  const hemi = new THREE.HemisphereLight(0xffffff, 0x808080, 0);
  rig.add(hemi);

  // 안티솔라 웜 필 — 그림자 비캐스트(태양 DirectionalLight 만 그림자 캐스터로 남긴다).
  const fill = new THREE.DirectionalLight(0xffffff, 0);
  fill.castShadow = false;
  rig.add(fill);
  rig.add(fill.target);

  const RATE = 2.4;   // ≈1.6s 지수 접근(env sky 크로스페이드와 결이 맞게)
  const tHemiSky = new THREE.Color(), tHemiGround = new THREE.Color(), tFillColor = new THREE.Color();
  let tHemiInt = 0, tFillInt = 0;
  const curDir = new THREE.Vector3(1, 0.4, 1).normalize();   // 필 방위(정규화) — 태양 반대편 저각으로 lerp
  const tDir = new THREE.Vector3(1, 0.4, 1).normalize();
  const _p = new THREE.Vector3();

  function setTarget(name) {
    const V = VILLAGE_LIGHT_BY_TIME[name] || VILLAGE_LIGHT_BY_TIME.day;
    tHemiSky.setHex(V.hemiSky); tHemiGround.setHex(V.hemiGround); tHemiInt = V.hemiInt;
    tFillColor.setHex(V.fillColor); tFillInt = V.fillInt;
    // 태양 수평 반대편 + 저각(fillElev). 태양(TIME_PRESETS.sunDir)이 배산 뒤로 낮게 있으므로
    // 그 반대편(카메라 쪽)에서 그늘 수직면·근사면을 데운다.
    const s = (TIME_PRESETS[name] || TIME_PRESETS.day).sunDir;
    const hmag = Math.hypot(s[0], s[2]) || 1;
    tDir.set(-s[0], hmag * V.fillElev, -s[2]).normalize();
  }
  function place() {
    _p.copy(curDir).multiplyScalar(200);
    fill.position.copy(_p);
    fill.target.position.set(0, 0, 0);
    fill.target.updateMatrixWorld();
  }
  function apply(name, opts = {}) {
    setTarget(name);
    if (opts.immediate) {
      hemi.color.copy(tHemiSky); hemi.groundColor.copy(tHemiGround); hemi.intensity = tHemiInt;
      fill.color.copy(tFillColor); fill.intensity = tFillInt; curDir.copy(tDir); place();
    }
  }
  function step(dt) {
    const k = Math.min(1, dt * RATE);
    hemi.color.lerp(tHemiSky, k); hemi.groundColor.lerp(tHemiGround, k);
    hemi.intensity += (tHemiInt - hemi.intensity) * k;
    fill.color.lerp(tFillColor, k); fill.intensity += (tFillInt - fill.intensity) * k;
    curDir.lerp(tDir, k).normalize(); place();
  }

  return {
    rig, apply, step,
    dispose() { hemi.dispose(); fill.dispose(); },
  };
}

// 하이라이트: 먹선 아웃라인(EdgesGeometry) + 은은한 발광 박스(어드티브). 단위 박스를 스케일.
function makeHighlight() {
  const g = new THREE.Group(); g.name = 'village-highlight';
  const box = new THREE.BoxGeometry(1, 1, 1);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box),
    new THREE.LineBasicMaterial({ color: 0x2e2a28, transparent: true, opacity: 0.85 }));  // 먹선
  const glow = new THREE.Mesh(box.clone(), new THREE.MeshBasicMaterial({
    color: 0xffe6b0, transparent: true, opacity: 0.10, blending: THREE.AdditiveBlending, depthWrite: false }));
  g.add(edges); g.add(glow);
  const tmp = new THREE.Vector3();
  return {
    group: g,
    set(worldCenter, dims, rotY) {
      g.position.set(worldCenter.x, worldCenter.y + dims.y / 2, worldCenter.z);
      g.rotation.y = rotY;
      tmp.copy(dims).multiplyScalar(1.01);
      edges.scale.copy(tmp); glow.scale.copy(tmp);
    },
  };
}

function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) { m.map?.dispose?.(); m.dispose?.(); }
  });
}
