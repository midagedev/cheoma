import * as THREE from 'three';
import { makeRng } from '../rng.js';
import { PRESETS } from '../params.js';
import { buildBuilding } from '../builder/index.js';
import { buildParcel } from '../layout/parcel.js';
import { makeMaterials, setTextureRandom, applyThatchAge } from '../builder/palette.js';
import { setGateRandom } from '../layout/gate.js';
import { candleFlicker } from '../env/night-glow.js';
import { planVillage } from './plan.js';
import { populateVillage, populateVillageSteps } from './populate.js';
import { buildPalaceCompound } from './palace.js';
import { houseMatrix, parcelMatrix, parcelRotY } from './instancing.js';
import { buildVillageWall } from './walls.js';
import { toneOf, variantOv, variantThatchAge, assignVariation } from './variants.js';
import { TIME_PRESETS } from '../env/sky.js';
import { setupClouds } from '../env/clouds.js';
import { createAmbientField } from '../env/focus.js';
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
    // hemiGround(하향면 웜 바운스)는 분지를 둘러싼 배산 안쪽 사면(아래-안쪽 향)까지 데워 저채도
    //   부감에서 능선을 주황 화염으로 blowout 시키는 주범(#119). 채도·밝기를 크게 낮춰 화염을 끄되
    //   처마밑·기단 그늘의 웜 바운스는 남긴다. fill(웜 directional)도 능선 grazing 화염에 가세하므로
    //   절반 이하로. hemiSky(쿨)는 능선을 초록으로 유지하므로 그대로.
    hemiSky: 0x9fb0d6, hemiGround: 0x2a241e, hemiInt: 0.54,
    fillColor: 0xecc09c, fillInt: 0.62, fillElev: 0.42, glowBoost: 1.0,
  },
  night: {
    // 야간은 어둠(무드) 유지하되 순흑 뭉갬만 완화 — 달빛 쿨 리프트로 지붕·담 형태가 읽히게.
    // 창호등이 어둠을 깨도록 발광 부스트도 함께(applyNightGlow).
    hemiSky: 0x3d4c6e, hemiGround: 0x1b2233, hemiInt: 0.42,
    fillColor: 0xa9bde0, fillInt: 0.30, fillElev: 0.42, glowBoost: 1.5,
  },
};

// 시드 해석(number|string|기본). 동기·워커·청킹 경로 공유.
function resolveVillageSeed(opts) {
  return (typeof opts.seed === 'number' ? opts.seed
    : typeof opts.seed === 'string' ? hashStr(opts.seed) : 20260716) >>> 0;
}

// ── 재현성(같은 seed → 픽셀 동일) 시드 창 ──────────────────────────────────────
//   plan+populate 는 시드 고정 난수원 안에서 실행하고 즉시 원복한다(앱 나머지 Math.random 불침해).
//   · palette 캔버스텍스처·gate 싸리문은 전용 시더로(명시 계약).
//   · props/materials 등 그 밖의 전역 Math.random 소비자는 임시 교체로 덮는다.
//   ★ #123 결정론 핵심: createVillageAsync 는 이 창을 "슬라이스마다" 설치/원복하되 rng 클로저는 1벌을
//     재사용한다 → 슬라이스 사이(rAF)엔 실 Math.random 이 렌더 루프를 구동하고, 슬라이스 안에선 시드
//     스트림이 이어져 소비 순서가 동기 경로(1회 창)와 byte-identical. runInWindow 를 스텝마다 감싸면 됨.
function makeSeedWindow(seed) {
  const texRng = makeRng((seed ^ 0x7e17) >>> 0);
  const gateRng = makeRng((seed ^ 0x6a1e) >>> 0);
  const mainRng = makeRng((seed ^ 0x9e3779b9) >>> 0);
  return function runInWindow(fn) {
    const origRandom = Math.random;
    setTextureRandom(texRng); setGateRandom(gateRng); Math.random = mainRng;
    try { return fn(); } finally { Math.random = origRandom; setTextureRandom(null); setGateRandom(null); }
  };
}

// 동기 코어: 시드 창 안에서 plan + populate 를 일괄 실행. createVillage 가 소비.
function buildVillageCore(opts) {
  const seed = resolveVillageSeed(opts);
  const run = makeSeedWindow(seed);
  let plan, group;
  run(() => {
    plan = planVillage({ ...opts, seed });
    group = populateVillage(plan);      // optimize 기본 ON
  });
  return { seed, plan, group };
}

export function createVillage(opts = {}) {
  const { seed, plan, group } = buildVillageCore(opts);
  return finishVillage(opts, seed, plan, group);
}

// ── forest 크런치 워커(#123) ── 프리즈의 64~90%인 forest 배치 루프를 메인 밖으로. 단일 워커를 지연
//   생성·재사용(작업마다 재-spawn 하면 THREE 파싱 비용 반복). id 로 작업 구분. ?worker=0·미지원 폴백.
let _forestWorker = null;               // null=미시도, false=사용불가, Worker=활성
let _workerJobSeq = 0;
const _workerJobs = new Map();
function workerAllowed() {
  if (typeof Worker === 'undefined') return false;
  if (typeof location !== 'undefined') { try { if (new URLSearchParams(location.search).get('worker') === '0') return false; } catch {} }
  return true;
}
function getForestWorker() {
  if (_forestWorker !== null) return _forestWorker || null;
  if (!workerAllowed()) { _forestWorker = false; return null; }
  try {
    const w = new Worker(new URL('./populate.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { const d = e.data || {}; const job = _workerJobs.get(d.id); if (job) { _workerJobs.delete(d.id); job(d); } };
    w.onerror = () => { _forestWorker = false; for (const job of _workerJobs.values()) job({ ok: false, error: 'worker error' }); _workerJobs.clear(); };
    _forestWorker = w;
    return w;
  } catch { _forestWorker = false; return null; }
}
// opts+seed → 워커에서 crunchForest 실행 → Promise<{trees,rocks}>. 워커 불가 시 reject(메인 폴백).
function crunchForestInWorker(opts, seed) {
  return new Promise((resolve, reject) => {
    const w = getForestWorker();
    if (!w) { reject(new Error('no-worker')); return; }
    const id = ++_workerJobSeq;
    _workerJobs.set(id, (d) => { if (d && d.ok) resolve(d.crunch); else reject(new Error((d && d.error) || 'worker-fail')); });
    try { w.postMessage({ opts, seed, id }); } catch (e) { _workerJobs.delete(id); reject(e); }
  });
}

// ── 비동기 코어(#123) ── plan + populateVillageSteps 를 rAF 프레임에 분산 구동해 롱프레임 스파이크를
//   없앤다. 각 스텝 .next() 를 시드 창(makeSeedWindow, rng 1벌 재사용)으로 감싸 결정론을 동기 경로와
//   byte-identical 로 유지한다. 프레임당 budgetMs 를 넘기 전까지 여러 값싼 스텝을 이어 실행.
//   ★ forest(비용 64~90%)는 워커가 병렬 크런치 → 그루/암괴 버퍼가 도착하면 forest 스텝이 "조립만"(값싼)
//     한다. 워커 결과 미도착이면 forest 스텝 직전에서 프레임 양보하며 대기(메인은 그동안 다른 스텝 진행).
//     워커 불가/실패(?worker=0 포함)면 forest 스텝이 메인에서 크런치(동기 경로와 동일 — 결정론 불변, 단
//     롱프레임 잔존 = 폴백). onStep(label,i) 진행 콜백. nextFrame 주입 가능(테스트/헤드리스).
export function createVillageAsync(opts = {}, { onStep, budgetMs = 8, nextFrame } = {}) {
  const seed = resolveVillageSeed(opts);
  const run = makeSeedWindow(seed);
  const raf = nextFrame || ((typeof requestAnimationFrame === 'function')
    ? (cb) => requestAnimationFrame(() => cb())
    : (cb) => setTimeout(cb, 0));
  // forest 워커 조기 착수(plan+다른 스텝과 병렬). 결과/실패를 ref 로 forest 스텝에 전달.
  const forestRef = { value: null };
  let workerErr = false, useWorker = workerAllowed();
  if (useWorker) crunchForestInWorker(opts, seed).then((cr) => { forestRef.value = cr; }, () => { workerErr = true; });
  return new Promise((resolve, reject) => {
    let plan = null, it = null, stepI = 0, lastLabel = null;
    const genOpts = { forestCrunchRef: forestRef };   // populateVillageSteps 가 forest 스텝에서 판독
    const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const slice = () => {
      try {
        const t0 = nowMs();
        if (!plan) {                                   // 스텝 0: plan(시드 창)
          run(() => { plan = planVillage({ ...opts, seed }); });
          it = populateVillageSteps(plan, genOpts);
          onStep && onStep('plan', stepI++);
          if (nowMs() - t0 < budgetMs) return slice();
          return raf(slice);
        }
        let r = { done: false };
        do {
          // forest 스텝 게이트: 직전 라벨이 'trees'면 다음 .next() 가 forest. 워커 사용 중인데 결과가
          //   아직 없고 에러도 아니면 이번 프레임은 여기서 양보(워커 병렬 진행 → 다음 프레임 재확인).
          if (lastLabel === 'trees' && useWorker && !forestRef.value && !workerErr) return raf(slice);
          r = run(() => it.next());
          if (!r.done) { lastLabel = r.value; onStep && onStep(r.value, stepI++); }
        } while (!r.done && (nowMs() - t0) < budgetMs);
        if (r.done) { resolve(finishVillage(opts, seed, plan, r.value)); return; }
        return raf(slice);
      } catch (e) { reject(e); }
    };
    raf(slice);
  });
}

// plan+group 이후 핸들(VillageHandle) 조립 — 동기/비동기 경로가 공유(THREE 오브젝트 확정 후, 시드창 무관).
function finishVillage(opts, seed, plan, group) {
  const char01 = typeof plan.opts.char01 === 'number' ? plan.opts.char01 : 0.5;
  const site = plan.site;

  // 오버레이 재생성(단일 필지 리롤 #100)용 결정론 난수 창 — createVillage 진입부와 동형(같은 시드→같은
  //   텍스처·싸리문·소품). 새 필지 시드로 감싸 buildBuilding/buildParcel/buildPalaceCompound 를 굴린 뒤 원복.
  function withSeededBuild(s, fn) {
    const prev = Math.random;
    setTextureRandom(makeRng((s ^ 0x7e17) >>> 0));
    setGateRandom(makeRng((s ^ 0x6a1e) >>> 0));
    Math.random = makeRng((s ^ 0x9e3779b9) >>> 0);
    try { return fn(); } finally { Math.random = prev; setTextureRandom(null); setGateRandom(null); }
  }
  const handle = group.userData.houseHandle;   // { giwa, choga } InstancedMesh 그룹(또는 null)

  // ── 편집 오버레이 계층: rebuildParcel 이 만든 개별(풀디테일) 필지를 담는다. ──
  const overrides = new THREE.Group(); overrides.name = 'village-overrides';
  group.add(overrides);
  const overrideById = new Map();                 // parcelId -> THREE.Group
  const editWallMats = makeMaterials('giwa');      // 편집 담장 공유 재질(base 씬 wallMats 와 동일 팔레트)

  // ── #129 오버레이 셰이더 프로그램 앵커(반복 focus-in/hop 재컴파일 방지) ────────────
  //   focus-in/hop/리롤마다 오버레이(비인스턴스 풀디테일)가 makeMaterials/buildParcel 로 새 재질을
  //   만들고 focus-out 에서 disposeTree 로 dispose 한다. three 는 재질 dispose 시 그 프로그램의
  //   usedTimes 를 0 으로 떨궈 GL 프로그램을 캐시에서 삭제 → 다음 오버레이가 동일 cacheKey 재질을 다시
  //   컴파일한다(전환 히치 잔여, #128 후속). 인스턴스드 마을 재질은 USE_INSTANCING define 으로 cacheKey 가
  //   달라 비인스턴스 오버레이 프로그램을 공유하지 못한다 → 오버레이 프로그램은 오버레이 전용으로,
  //   매번 삭제·재컴파일된다.
  //   대책: 오버레이 "종류(kind×눈상태)"의 첫 빌드 재질 1벌을 __kept 로 표시해 영구 미dispose 앵커로
  //   삼는다. 앵커 재질은 그 오버레이가 최소 1프레임 렌더될 때 프로그램을 획득하고, 이후 오버레이가
  //   dispose 돼도(disposeTree 가 __kept 건너뜀) 살아 usedTimes≥1 을 유지 → 프로그램이 캐시에 남는다.
  //   그 뒤 빌드의 새 재질은 동일 cacheKey 로 컴파일 없이 재사용(색은 uniform 이라 cacheKey 불변 —
  //   부위별 곱틴트 #55·편집 라이브 반영 #48 무영향). #131 눈틴트: injectSnow 후 retain 하고 anchorKey 에
  //   |snow 를 붙여 snowtint cacheKey 변형까지 앵커에 포함(맑음/눈 각각 1벌). 앵커는 dispose() 에서만 해제.
  const _anchoredKinds = new Set();
  const keptMats = [];   // 프로그램 앵커(영구 보존) — 전 마을 수명 동안 미dispose
  function retainOverlayPrograms(root, anchorKey) {
    if (!root || _anchoredKinds.has(anchorKey)) return;
    _anchoredKinds.add(anchorKey);
    root.traverse((o) => {
      const list = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of list) {
        if (m && m.userData && !m.userData.__kept) { m.userData.__kept = true; keptMats.push(m); }
      }
    });
  }
  // 편집 담장 공유 재질은 전 오버레이가 재사용하는 영구 1벌 → 앵커로 고정(오버레이 dispose 가 이를
  //   해제하던 잠재 결함도 차단: 공유 재질이 dispose 되면 다음 오버레이가 그 재질을 재컴파일했다).
  for (const k in editWallMats) {
    const m = editWallMats[k];
    if (m && m.isMaterial && m.userData && !m.userData.__kept) { m.userData.__kept = true; keptMats.push(m); }
  }

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
  vlights.setSiteR(villageFogR);   // 규모 인지 골든아워 감쇠(#119) — 큰 규모 능선 화염 억제
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
      // 구름 그림자 커버리지 정밀화(#108 후속): 어댑터가 아는 마을 실반경(site.R)을 프레임 반경으로 넘겨
      //   블롭·그림자를 마을 중심 원(원점)에 가둔다(terrainMax*0.42 파생 대신 실측 — 프레임 밖 표류 감소).
      siteCenter: { x: 0, z: 0 }, coverR: villageFogR,
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
    g.userData.snowRoofKind = 'giwa';   // 종가(한옥)=기와 지붕 — 눈 흰틴트 게이트(#131)
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
    if (snowActive()) injectSnow(g);   // 눈 중 생성된 오버레이 지붕도 즉시 흰틴트(#131, 신규 재질)
    heroOverride = { id: parcelId, group: g };
    // 오버레이 창호·문 발광(#98) — collectGlowMats 는 생성 시 마을 병합본만 훑어, 나중에 얹는 focus/히어로
    //   오버레이의 창은 미포착이었다(석양·야간에 정작 focus 한 집만 불이 안 켜짐). 오버레이 hanjiGlow 재질을
    //   glow 목록에 합류시키고 현재 vnight 레벨로 즉시 패치 → 석양(vnight 0.42)에 종가 창이 은은히 켜진다.
    const hg = collectGlowMats(g);
    if (hg.length) { glow.push(...hg); heroOverride.glow = hg; ensureGlowPatched(vnight > 0.001); applyGlowLevel(false); }
    if (heroHandle && heroHandle.get(parcelId)) heroHandle.get(parcelId).visible = false;
    else { const lm = landmarksGroup(); if (lm) { lm.visible = false; landmarksHidden = true; } }
    retainOverlayPrograms(g, 'hero-' + (parcel.heroStyle || 'hanok') + (snowActive() ? '|snow' : ''));   // #129 프로그램 앵커
    return g;
  }
  function hideHeroDetail() {
    if (heroOverride) {
      if (heroOverride.glow) { for (const rec of heroOverride.glow) { const i = glow.indexOf(rec); if (i >= 0) glow.splice(i, 1); } }
      disposeTree(heroOverride.group); overrides.remove(heroOverride.group); heroOverride = null;
    }
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
  const palaceCore = group.userData.palaceCore || null;                        // 미병합 palace-core 그룹(편집 메타 소스) | null
  // #140-B 부감 병합본. optimize 시 populate 가 palaceCore 를 재질별로 접어(palace-merged) 씬에 얹고
  //   palaceCore 지오는 dispose(메타·재질만 보존) → 부감 −~350 콜·힙. focus-in 은 이 병합본을 가리고
  //   미병합 오버레이(buildPalaceCompound)로 교체(히어로 heroHandle #62 동형). 비최적화·구빌드면 null 이라
  //   palaceCore(씬에 상주) 를 대신 토글(폴백). 아래 palaceVisNode 가 "부감에 보이는 궁 노드"를 가리킨다.
  const palaceMerged = group.userData.palaceMerged || null;                    // 부감 병합본(씬 상주) | null
  const palaceVisNode = palaceMerged || palaceCore;                            // focus 시 가릴 대상(병합본 우선, 없으면 미병합)
  const palaceCompound = palaceCore ? (palaceCore.userData.palaceCompound || null) : null;  // buildPalaceCompound 루트(편집 메타)
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
    g.userData.snowRoofKind = 'giwa';   // 궁 전각=기와 지붕 — 눈 흰틴트 게이트(#131)
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
    if (palaceVisNode) palaceVisNode.visible = false; palaceHidden = true;   // #140-B 부감 병합본(또는 미병합 폴백) 은닉
    return g;
  }
  function hidePalaceDetail() {
    // 오버레이는 원본 palaceCore 와 재질(mats)을 공유하므로 지오메트리만 dispose — 재질을 dispose 하면
    //   focus-out 후 되살린 palaceCore 가 깨진 재질로 렌더된다. (지오는 buildPalaceCompound 마다 신규.)
    if (palaceOverride) {
      palaceOverride.group.traverse((o) => { if (o.geometry) o.geometry.dispose?.(); });
      overrides.remove(palaceOverride.group); palaceOverride = null;
    }
    if (palaceHidden && palaceVisNode) { palaceVisNode.visible = true; palaceHidden = false; }   // #140-B 병합본 복원
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

  // ── 절(산사) 픽킹 프록시(#147) — features.temple 이 있으면 추가. 궁·종가와 달리 절은 village-landmarks
  //   로 정적 병합된 랜드마크라 편집·오버레이가 없다(populate 가 palace-core 만 병합에서 뺀다). 프록시는
  //   "픽 → focus 돌리 + DoF" 만 지원한다: showParcelDetail('temple') 은 temple 이 plan.parcels 에 없어
  //   자연히 null 을 반환 → villageSelect 가 오버레이 없이 카메라만 절로 돌리·초점한다(병합본 그대로). detail
  //   이 null 이라 attachFocusRing 도 걸리지 않아 농가 앰비언스 링(마당 닭·연기)이 대웅전 마당에 안 깔린다
  //   (궁과 동일한 생략 규약). replay/reroll 은 focusAssembly/rerollParcel 이 temple 에 null 을 돌려 self-guard
  //   (엔진 무수정). buildingSpec.editable:false → 편집 섹션 없음. 박스는 경내(30×30+pad)를 덮어 어디를 눌러도
  //   절이 잡힌다. temple 자리엔 민가 필지가 없어(plan) 픽킹 하이재킹 없음.
  if (plan.features && plan.features.temple) {
    const tf = plan.features.temple;
    const rotY = G.facingY(tf.frontDir || { x: 0, z: 1 });
    const groundY = (site && typeof site.heightAt === 'function') ? site.heightAt(tf.x, tf.z) : 0;
    const W = 36, D = 36, H = 30;                    // 경내 + 석축 대지 + 대웅전 지붕을 여유롭게 덮는 픽 박스
    const worldCenter = new THREE.Vector3(tf.x, groundY + 9, tf.z);   // 대지(석축 pad) 상면 근사(병합본이라 정확 padY 미조회)
    const pmesh = new THREE.Mesh(new THREE.BoxGeometry(W, H, D));
    pmesh.position.set(tf.x, groundY + H / 2, tf.z);
    pmesh.rotation.y = rotY;
    pmesh.userData.parcelId = 'temple';
    pmesh.updateMatrixWorld(true);
    const proxy = {
      parcelId: 'temple', mesh: pmesh, bbox: new THREE.Box3().setFromObject(pmesh), worldCenter,
      dims: new THREE.Vector3(W, H, D), rotY,
      // family 'temple' — edit-schema/패널이 편집 섹션을 열지 않는다(editable:false). landmark:true = 병합 랜드마크.
      buildingSpec: { parcelId: 'temple', family: 'temple', style: 'temple', editable: false, landmark: true },
      cameraFraming: templeFraming(worldCenter, rotY, W, D),
    };
    proxies.push(proxy);
    proxyGroup.add(pmesh); proxyGroup.updateMatrixWorld(true);
    proxyById.set('temple', proxy);
  }

  // ── 카메라 앵커 앰비언스 필드(#105) ─────────────────────────────────────────────
  //   비선택(인스턴스) 이웃 필지에 카메라 근접도 기반 3계층 앰비언스(모트·등롱 sway·굴뚝 연기)를
  //   점등한다. 선택 필지는 engine focusRing 이 담당 → excluded 로 제외(중복 방지). enterVillageMode
  //   에서 생성, updateLod(camera) 에서 same-frame dt(update 저장)로 구동, exitVillageMode 에서 해제.
  //   ?ambfield=0 으로 끔. 렌더타임 동작이라 마을 생성 결정론 불침해.
  const AMBFIELD_ON = (typeof location === 'undefined') || new URLSearchParams(location.search).get('ambfield') !== '0';
  let ambField = null;
  let _lastDt = 0.016;

  // 필드 서술자: 주거형(민가) 필지만. 월드중심·회전·치수·굴뚝 앵커(월드 추정)·seed.
  function buildFieldDescriptors() {
    const out = [];
    for (const parcel of plan.parcels) {
      if (parcel.hero) continue;                        // 종가·관아는 engine·궁 경로가 담당
      const px = proxyById.get(parcel.id);
      if (!px) continue;
      const kind = parcel.kind === 'giwa' ? 'giwa' : 'choga';
      const rotY = px.rotY, wc = px.worldCenter;
      const baseY = parcel.baseY != null ? parcel.baseY : wc.y;
      const W = parcel.plotW || 20, D = parcel.plotD || 18;
      // 굴뚝 앵커(월드): 몸채 뒤(-z 북)·좌우 오프셋. parcelMatrix(T·Ry) 규약으로 회전.
      const sgn = (parcel.seed & 4) ? 1 : -1;
      const lx = W * 0.22 * sgn, lz = -D * 0.30;
      const cos = Math.cos(rotY), sin = Math.sin(rotY);
      out.push({
        id: parcel.id, cx: wc.x, cz: wc.z, baseY, rotY, W, D,
        style: kind, seed: (parcel.seed || 7) >>> 0,
        chimney: {
          x: parcel.center.x + lx * cos + lz * sin,
          y: baseY + (kind === 'giwa' ? 4.6 : 3.4),
          z: parcel.center.z - lx * sin + lz * cos,
        },
      });
    }
    return out;
  }
  function ensureAmbField(scene) {
    if (!AMBFIELD_ON || ambField || !scene) return;
    ambField = createAmbientField(scene, {
      heightAt: (x, z) => (site && typeof site.heightAt === 'function' ? site.heightAt(x, z) : 0),
      sun: findSun(scene),
    });
    ambField.setParcels(buildFieldDescriptors());
    ambField.setExcluded((id) => overrideById.has(id));   // 오버레이(선택) 필지는 engine 링이 담당
    ambField.setTime(time, true);
    ambField.setSeason(season);
  }
  function disposeAmbField() {
    if (ambField) { ambField.dispose(); ambField = null; }
  }

  // ── 눈 = 지붕 흰틴트, 마을 실경로 배선(#131) ─────────────────────────────────
  //   env(weather.js)의 patchSnow 는 setupWeather 시점(마을 생성 전)에 씬을 한 번 훑고 그 뒤엔 단일건물
  //   rebuild 때만 재수집한다 → 마을 진입 후 얹힌 인스턴스드 건물 청크(inst-giwa-v2-m*)·focus 오버레이
  //   지붕엔 닿지 않아, 눈 날씨에도 지붕이 안 희어졌다(낙하 입자만 보임). 여기서 어댑터가 "마을 소관"
  //   지붕 재질(role='roof')에 weather.js 와 동일한 흰틴트 셰이더를 공유 uniform(snowU)으로 주입하고,
  //   accum(0..1)을 시간 램프로 구동한다. env 경로 불침해: env 는 env 오브젝트를, 어댑터는 마을
  //   오브젝트를 각각 소유(공유 재질 없음). 가드 __snowPatched 는 env 와 공유 → 혹 겹쳐 훑어도 이중
  //   패치(varying 재정의 컴파일 실패) 방지.
  const SNOW_MAX = 0.82, ACCUM_UP = 46, ACCUM_DOWN = 16;   // weather.js 와 동일 상수(램프 톤 정합)
  const snowU = { value: 0 };            // 공유 적설 uniform — 마을 지붕 재질 전부가 이 참조를 공유
  let snowTarget = 0, snowAccum = 0, snowPinned = null;      // 램프 목표·진행도 + shot 고정(null=자유)

  // 지붕 재질(MeshStandardMaterial)에 눈 흰틴트 주입 — weather.js patchSnow 와 동일 GLSL(월드 노멀 상향
  //   기반, 양면 셸 뒤집힘 보정 포함). prev onBeforeCompile 체인(#110 구름그림자 등 보존) + cacheKey 접미
  //   (미패치 동일재질과 프로그램 공유 방지, #52). 반환: 신규 패치 여부.
  function patchRoofSnow(m, isThatch) {
    if (!m || !m.isMeshStandardMaterial) return false;
    if (m.userData && m.userData.__snowPatched) return false;
    m.userData = m.userData || {};
    m.userData.__snowPatched = true;
    // 초가(볏짚) 지붕은 기와보다 눈을 성글게·덜 하얗게 인다(#131): 부감에서 둥근 이엉 지붕이 눈+bloom 으로
    //   순백 발광 덩어리가 되던 아티팩트 해소. 볏짚만 흰 목표색·최대 커버리지·고적설 채움·뒤집힌 셸면 부스트를
    //   낮춰 bloom 임계 아래로 — 기와·양성바름(궁·절)은 현행 유지(정상 흰틴트). 사실적으로도 볏짚은 눈을 덜 얹음.
    // #136 기와 blowout 톤다운: 소형 급경사 기와(정자 사모/육모)·담 코핑 기와가 최대 적설+bloom 에서
    //   순백 포화되던 문제 — 흰 목표색·고적설 채움·뒤집힌 셸 부스트를 낮춰 peak 휘도를 bloom 임계 아래로.
    //   큰 몸채 지붕(완경사 대면적)은 여전히 눈답게 하얗되(0.93), 소형·급경사만 STEEPMIN 으로 추가 감쇠.
    const WHITE = isThatch ? 'vec3(0.80, 0.80, 0.78)' : 'vec3(0.92, 0.93, 0.95)';
    const CEIL = isThatch ? '0.50' : '1.0';        // 최대 커버리지 계수(볏짚=절반, 성글게 덮인 느낌)
    const THICKFILL = isThatch ? '0.28' : '0.62';  // 고적설 시 사면 채움(볏짚·기와 모두 억제, 둥근 돔 blowout 방지)
    const FIXB = isThatch ? '0.30' : '0.78';       // 뒤집힌 셸면 밝기 부스트(과밝음 완화)
    const STEEPMIN = isThatch ? '1.0' : '0.55';    // 급경사 면 눈 감쇠 하한(기와만; 물매로 미끄러지는 사면 순백 방지)
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (shader, r) => {
      if (prev) prev(shader, r);
      shader.uniforms.uSnowAmount = snowU;   // 공유 참조(어댑터 램프가 갱신)
      const twoSided = m.side === THREE.DoubleSide ? '1.0' : '0.0';
      // 월드 노멀·좌표: 마을 건물은 InstancedMesh 청크(inst-giwa-v2-m*)라 각 인스턴스의 배치·방향이
      //   instanceMatrix 에 있다 → modelMatrix 만으로는 프로토타입 로컬 노멀이 세워지지 않아 위 향함
      //   판정(up 게이트)이 실패해 눈이 안 걸린다(구름그림자 #110 과 동일 함정). USE_INSTANCING 시
      //   instanceMatrix 를 합성. 지형·병합/오버레이 지오는 #else(기존 modelMatrix)로 하위호환.
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSnowWN;\nvarying vec3 vSnowWP;')
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        #ifdef USE_INSTANCING
          vSnowWN = mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal;
        #else
          vSnowWN = mat3(modelMatrix) * objectNormal;
        #endif`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vSnowWP = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vSnowWP = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSnowWN;\nvarying vec3 vSnowWP;\nuniform float uSnowAmount;\nfloat snowCov = 0.0;\nfloat snowFix = 0.0;')
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 swn = normalize(vSnowWN);
          float fixup = ${twoSided} * step(swn.y, -0.05)
                      * smoothstep(0.30, 0.55, abs(swn.y))
                      * smoothstep(0.0, 0.20, uSnowAmount);
          vec3 vUp = normalize((viewMatrix * vec4(-swn, 0.0)).xyz);
          normal = normalize(mix(normal, vUp, fixup));
          snowFix = fixup;
        }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 wn = normalize(vSnowWN);
          float ny = mix(wn.y, abs(wn.y), ${twoSided});
          float thresh = mix(0.72, 0.20, uSnowAmount);
          float up = smoothstep(thresh - 0.10, thresh + 0.18, ny);
          float ridge = 0.5 + 0.5 * sin(vSnowWP.x * 3.0 + vSnowWP.z * 0.6);
          float blotch = 0.55 + 0.45 * sin(vSnowWP.x * 1.3) * sin(vSnowWP.z * 1.7);
          float flatFace = smoothstep(0.80, 0.97, wn.y);
          float slopeCov = (0.72 + 0.28 * blotch) * (0.86 + 0.14 * ridge);
          float floorCov = 0.90 + 0.10 * blotch;
          float thick = smoothstep(0.35, 0.85, uSnowAmount);
          slopeCov = mix(slopeCov, 0.98, thick * ${THICKFILL});
          float cov = up * mix(slopeCov, floorCov, flatFace);
          cov *= smoothstep(0.0, 0.14, uSnowAmount);
          // #136 급경사 감쇠: 물매 급한 면(낮은 ny)일수록 눈 덜 얹힘 — 소형 급경사 기와·코핑 순백 포화 완화.
          cov *= mix(${STEEPMIN}, 1.0, smoothstep(0.34, 0.66, ny));
          cov = clamp(cov * ${CEIL}, 0.0, 1.0);
          snowCov = cov;
          diffuseColor.rgb = mix(diffuseColor.rgb, ${WHITE}, cov);
        }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.96, snowCov);`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.0, snowCov);`)
        .replace('#include <dithering_fragment>', `{
          gl_FragColor.rgb *= 1.0 + snowFix * snowCov * ${FIXB};
        }
        #include <dithering_fragment>`);
    };
    const baseKey = (m.customProgramCacheKey && m.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey)
      ? m.customProgramCacheKey() : '';
    // 초가/기와는 baked 상수가 달라 프로그램 분리(캐시 접미) — 미패치 동일재질과의 공유도 계속 방지.
    m.customProgramCacheKey = () => 'snowtint' + (isThatch ? '-th' : '') + '|' + baseKey;
    m.needsUpdate = true;
    return true;
  }

  // 이 메시가 초가(볏짚) 지붕인지 판정(#131 톤다운 게이트). 인스턴스드 마을은 giwa/choga 가 완전히 분리된
  //   그룹(houses-{kind})·청크(inst-{kind}-…)라 이름 토큰으로, 풀디테일 오버레이는 종류를 이름에 담지 않으므로
  //   생성 시 심은 userData.snowRoofKind 마커로 식별. 마커가 우선(오버레이 내부 'sugiwa-…' 등 부분문자열 오탐
  //   방지) — 마커 없으면 '-choga'/'-giwa' 토큰, 둘 다 없으면 기와(궁·절 병합본·임포스터 기본).
  function roofIsThatch(o) {
    for (let n = o; n; n = n.parent) {
      if (n.userData && n.userData.snowRoofKind) return n.userData.snowRoofKind === 'choga';
    }
    for (let n = o; n; n = n.parent) {
      const nm = n.name || '';
      if (nm.indexOf('-choga') >= 0) return true;
      if (nm.indexOf('-giwa') >= 0) return false;
    }
    return false;
  }

  // root 를 traverse 해 지붕(role='roof') 재질만 눈틴트 주입(멱등). 인스턴스드 청크·병합 랜드마크·
  //   풀디테일 오버레이 모두 동일 role 태그를 지니므로 한 순회로 커버(overrides 는 group 자식 → group
  //   한 번이면 현 오버레이도 포함). 초가/기와는 roofIsThatch 로 갈라 흰 세기를 달리 굽는다(#131). 반환: 신규 패치 수.
  function injectSnow(root) {
    if (!root) return 0;
    let n = 0;
    root.traverse((o) => {
      const m = o.material; if (!m) return;
      const list = Array.isArray(m) ? m : [m];
      const th = roofIsThatch(o);
      for (const mm of list) if (mm && mm.userData && mm.userData.role === 'roof' && patchRoofSnow(mm, th)) n++;
    });
    return n;
  }

  // 눈 활성 여부 — 오버레이 생성 시(hero/palace/parcel) 신규 지붕 재질을 즉시 패치할지 게이트.
  const snowActive = () => snowTarget > 0;
  // 검증/shot 훅: accum 을 특정 단계로 고정(v=null 이면 자유 램프 복귀). window.__wx.setAccum 과 대칭.
  group.userData.setSnowAccum = (v) => {
    snowPinned = v;
    if (v != null) { snowAccum = v; snowU.value = v * SNOW_MAX; }
  };
  group.userData.getSnowInfo = () => ({ target: snowTarget, accum: +snowAccum.toFixed(3), value: +snowU.value.toFixed(3), pinned: snowPinned });

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
        // 종가 랜딩(enterVillageHero)이 나선 줌인 구도를 직접 산출할 때 쓰는 치수·회전.
        //   dims=Vector3(W,H,D). 미노출 시 pr.H/pr.maxDim/pr.rotY 가 undefined → 카메라 NaN(정지) 회귀.
        dims: p.dims.clone(), rotY: p.rotY,
        H: p.dims.y, maxDim: Math.max(p.dims.x, p.dims.y, p.dims.z),
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
      g.userData.snowRoofKind = gk;   // 이 집 종류(giwa/choga) — 눈 흰틴트 게이트(#131, 초가 톤다운)
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
      // 담·마당(개별) — 유형·부속채 어휘 + 마당 소품 편집(#96). newParams 오버라이드 우선, 없으면 필지 원본값.
      const wallType = newParams.wallType || parcel.wallType || 'stone';
      const aux = newParams.aux != null ? newParams.aux : parcel.aux;
      const jangdok = newParams.jangdok != null ? newParams.jangdok : parcel.jangdok;
      const yardStack = newParams.yardStack != null ? newParams.yardStack : parcel.yardStack;
      const clothesline = newParams.clothesline != null ? newParams.clothesline : parcel.clothesline;
      const vegBed = newParams.vegBed != null ? newParams.vegBed : parcel.vegBed;
      g.add(buildVillageWall(parcel.shape, editWallMats, {
        style: wallType, kind, seed: parcel.seed, char01, aux, plotW: parcel.plotW, plotD: parcel.plotD,
        wallHeightK: parcel.wallHeightK, jangdok,
        yardStack, clothesline, vegBed,
      }));
      g.applyMatrix4(parcelMatrix(parcel));
      overrides.add(g);
      overrideById.set(parcelId, g);
      if (snowActive()) injectSnow(g);   // 눈 중 생성된 오버레이 지붕도 즉시 흰틴트(#131, 신규 재질)
      retainOverlayPrograms(g, gk + (snowActive() ? '|snow' : ''));   // #129 프로그램 앵커(kind×눈상태)

      // 인스턴스 은닉(원래 종류 기준)
      const h = handle[parcel.kind === 'giwa' ? 'giwa' : 'choga'];
      h?.userData.setHidden(parcelId, true);
      // #148: 병합 담(village-walls-*)도 이 필지분만 접는다 — 오버레이가 자기 담을 새로 지으므로
      //   접지 않으면 동일평면 이중 렌더로 회전 중 플리커. 드로우콜 불변(레인지 접기).
      handle.walls?.setHidden(parcelId, true);
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
      if (parcel) {
        const h = handle[parcel.kind === 'giwa' ? 'giwa' : 'choga']; h?.userData.setHidden(parcelId, false);
        handle.walls?.setHidden(parcelId, false);   // #148 병합 담 원상복원(픽셀 일치)
      }
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

    // ── 이 필지만 다시 굴리기(#100) — 새 시드로 이 필지의 변주(유형은 유지)만 재유도 → 오버레이 재생성. ──
    //   마을 전체·이웃 필지는 불변(집 focus 리롤이 마을 리롤로 새던 배선 분리). 기존 편집 오버라이드는
    //   폐기하고 새 시드의 기본 변주로 리셋한다. 프록시 buildingSpec 도 갱신 → 패널 기본값 동기(desync 금지).
    //   반환 { group, compound, assembly, spec } — 엔진이 조립 재생 + 링 재부착 + 패널 재시드에 사용.
    rerollParcel(parcelId) {
      if (parcelId === 'palace') {
        if (!palaceEditable()) return null;
        palaceHandle.seed = (Math.random() * 0x100000000) >>> 0;    // 궁 다일곽 배치 변주 재굴림
        const g = withSeededBuild(palaceHandle.seed, () => showPalaceDetail(null));
        const px = proxyById.get('palace'); if (px) px.buildingSpec = palaceSpec();
        return g ? { group: g, compound: true, assembly: g, spec: px ? px.buildingSpec : palaceSpec() } : null;
      }
      const parcel = plan.parcels.find((p) => p.id === parcelId);
      if (!parcel) return null;
      parcel.seed = (Math.random() * 0x100000000) >>> 0;
      // 변주 재유도: 같은 char01·tuning 으로 마을 다양성 규율 유지, rank(빈부 계층) 보존 = 집 유형 고정
      //   (giwa↔choga 인스턴스 은닉/복원 짝이 어긋나지 않게). hero 는 assignVariation 이 고정 필드라
      //   parcel.seed 만 바뀌어 buildParcel 내부 배치가 새로 굴러간다.
      assignVariation(parcel, char01, plan.opts.tuning || {});
      const px = proxyById.get(parcelId);
      if (px) px.buildingSpec = buildSpec(parcel);
      // 새 변주로 오버레이 재생성(showParcelDetail → rebuildParcel(id,{}) 이 기존 오버라이드 폐기).
      const detail = withSeededBuild(parcel.seed, () => this.showParcelDetail(parcelId));
      if (detail) detail.spec = px ? px.buildingSpec : buildSpec(parcel);
      return detail;
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
      ambField?.setTime(name);               // 카메라 앵커 필드 앰비언스 시간대(연기·모트, #105)
    },
    setSeason(name, _opts) { season = name; group.userData.setSeason?.(name); ambField?.setSeason(name); },  // 마당 과실수 잎·꽃·열매 계절 토글(#41)
    setWeather(name) {
      weather = name;
      snowTarget = name === 'snow' ? 1 : 0;
      // 눈으로 전환될 때만 지붕 재질을 훑어 흰틴트를 주입한다(멱등 — 재패치 없음). group 한 순회로 인스턴스드
      //   건물 청크 + 현 focus 오버레이(overrides=group 자식)까지 커버. accum 은 update(dt) 램프가 구동하고,
      //   clear 로 바뀌면 램프가 0 으로 녹아 원본 외형 회복(재질은 패치된 채로 두되 uniform 0 → 무영향).
      if (snowTarget > 0) injectSnow(group);
    },
    get time() { return time; }, get season() { return season; }, get weather() { return weather; },

    update(dt) {
      _lastDt = dt;                                // updateLod(카메라 필요)가 same-frame dt 로 앰비언스 필드 구동(#105)
      vlights.step(dt);                            // 마을 조명 리그 시간대 크로스페이드(태스크 #50)
      group.userData.update?.(dt);                 // 개울 물결 uTime
      cloudsHandle?.update(dt);                    // 산 구름·물안개 표류 + 흐르는 구름 그림자(태양 판독, #57)
      stepNightGlow(dt);                           // 창호 발광 크로스페이드 + 촛불 일렁임(밤)
      // 지붕 눈 흰틴트 강도(#131): 선형 램프로 서서히(쌓임 ~46s, 녹음 ~16s) — 즉시 점프 아님(무드).
      //   shot 하네스가 setSnowAccum 으로 고정하면 그 값 유지. weather.js env 램프와 동일 상수라 정합.
      if (snowPinned != null) snowAccum = snowPinned;
      else if (snowTarget > 0) snowAccum = Math.min(1, snowAccum + dt / ACCUM_UP);
      else snowAccum = Math.max(0, snowAccum - dt / ACCUM_DOWN);
      snowU.value = snowAccum * SNOW_MAX;
    },
    // 원경 청크 LOD 스왑(매 프레임, 카메라 필요) — 임포스터↔풀디테일 거리 전환.
    //   engine.js 가 camera 를 넘겨 호출. far 청크 없으면(R<340) no-op.
    updateLod(camera) {
      const swaps = group.userData.updateChunkLod?.(camera) || 0;   // #140-E 스왑 수 반환(engine 이 그림자 1프레임 갱신)
      ambField?.update(_lastDt, camera);           // 카메라 앵커 앰비언스 필드(#105) — same-frame dt·camera
      // 흩날리는 낙엽 고도 게이트(#98 원경 정책) — 낙엽 입자는 나무·지면 근처에서만 의미. 부감(카메라
      //   고도 높음)에선 끈다(가을 무드는 능선 틴트·마당 단풍이 담당). env.update 가 매 프레임 autumn 이면
      //   leaves.visible=true 로 켜므로, 그 뒤 실행되는 여기서 고도 초과 시 되끈다. 먼지 모트는 유지.
      if (this._ambientLift && camera) {
        const high = camera.position.y > 46;   // focus/근경 <46, 부감 ≫46 — 명확 분리
        for (const rec of this._ambientLift) {
          if (rec.obj.name === 'seasonLeaves' && high && rec.obj.visible) rec.obj.visible = false;
        }
      }
      return swaps;   // #140-E LOD 스왑 수 — engine 렌더 루프가 그림자 캐시 무효화에 사용
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
      ensureAmbField(app.scene);             // 카메라 앵커 앰비언스 필드(#105) — 씬 직속(마을 활성 동안만)
      if (app.building) app.building.visible = false;
      if (app.ground) app.ground.visible = false;
      if (app.env?.group) app.env.group.visible = false;
      // 대기 앰비언트(먼지 모트·흩날리는 낙엽) 복원(#98). env.group 을 통째로 숨기면 지면 레이어(지형·
      //   나무)뿐 아니라 대기 입자까지 사라져 마을에서 "먼지·낙엽이 전멸"했다. 이 둘은 원점(≈마을 중심)
      //   상공의 대기 오버레이라 마을과 무관하게 유효 — 씬 루트로 이설해 env.group 은닉을 우회한다.
      //   env.update 가 참조로 계속 구동하고(위치/가시성), 계절(autumn) 이면 낙엽이 partAmt 로 드러난다.
      //   exit 시 원부모로 환원. (지면 낙엽 seasonLitter 는 마을 지형과 겹쳐 제외.)
      this._ambientLift = [];
      const eg = app.env?.group;
      if (eg) {
        for (const nm of ['motes', 'seasonLeaves']) {
          const o = eg.getObjectByName(nm);
          if (o && o.parent) { this._ambientLift.push({ obj: o, parent: o.parent }); app.scene.add(o); }
        }
      }
    },
    exitVillageMode(app = {}) {
      if (!app.scene) return;
      app.env?.removeFogModifier?.(villageFog); // 마을 fog 거리 오버라이드 해제(태스크 #50)
      detachClouds();                            // 구름 빌보드 정리(재진입마다 새로 붙임, #57)
      disposeAmbField();                         // 카메라 앵커 앰비언스 필드 해제(#105)
      // 대기 앰비언트 이설 환원(#98) — 원부모(env.group)로 복귀. env.group.visible 복원 전에 되돌린다.
      for (const rec of (this._ambientLift || [])) rec.parent.add(rec.obj);
      this._ambientLift = [];
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
      disposeAmbField();
      disposeTree(group);
      // #129 프로그램 앵커 최종 해제 — 오버레이 dispose 는 __kept 를 건너뛰므로 마을 파기 시 여기서 정리.
      for (const m of keptMats) { m.map?.dispose?.(); m.dispose?.(); }
      keptMats.length = 0;
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
      winSide: gk === 'choga' ? !!ov.winSide : undefined,   // #96 초기값(패널 정합, 불리언)
      doorPattern: gk === 'giwa' ? (ov.doorPattern || 'ttisal') : (ov.doorPattern || 'ttisal'),
      footprintScale: 1,
      wallType: parcel.wallType || 'stone',
      roofTone: parcel.toneIdx || 0,
      thatchAge: gk === 'giwa' ? undefined : (parcel.thatchAge != null ? parcel.thatchAge : 0.5),
      aux: !!parcel.aux,
      // #96 마당 소품 초기값 — rebuildParcel 오버라이드(newParams.*)와 동형 키. 패널 토글 초기상태가
      //   실제 필지값을 반영하도록 노출(미노출 시 항상 off 로 보이는 정합 문제).
      jangdok: parcel.jangdok != null ? parcel.jangdok : 0,
      yardStack: !!parcel.yardStack,
      clothesline: !!parcel.clothesline,
      vegBed: !!parcel.vegBed,
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
  const az = 38 * DEG, el = 7 * DEG, r = 2.25 * maxDim;
  const off = new THREE.Vector3(
    r * Math.cos(el) * Math.sin(az), r * Math.sin(el), r * Math.cos(el) * Math.cos(az));
  off.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);   // 정면(frontDir) 기준 배치
  const target = new THREE.Vector3(worldCenter.x, worldCenter.y + H * 0.42, worldCenter.z);
  return { position: target.clone().add(off), target, fov: 23 };
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

// 절(산사) focus 프레이밍(#147) — 절 정면(frontDir=마을 하향)에서 3/4 로 올려다보며 배산 능선을 배경에.
//   rotY=facingY(frontDir) 이라 로컬 +z 가 마을 방향(하향) → +z 성분 오프셋이 카메라를 절 앞(마을 쪽 아래)에
//   두어 대웅전 정면·일주문을 보고 뒤로 산이 솟는 산사 특유의 구도가 잡힌다. ext 는 경내(~36m) 기준.
function templeFraming(worldCenter, rotY, W, D) {
  const ext = Math.max(W, D);
  const fov = 34;
  const az = 24 * DEG, el = 17 * DEG;
  const r = (ext * 0.5) / Math.tan(fov * 0.5 * DEG) * 1.16 + ext * 0.14;
  const off = new THREE.Vector3(
    r * Math.cos(el) * Math.sin(az), r * Math.sin(el), r * Math.cos(el) * Math.cos(az));
  off.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
  const target = new THREE.Vector3(worldCenter.x, worldCenter.y + 4, worldCenter.z);
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

  // 규모 인지 골든아워 감쇠(#119). 석양·dawn 부감에서 배산 능선이 주황 화염으로 blowout 되는
  //   임계(bloom cliff)는 규모가 클수록 낮다: siteR 이 크면 원경 석양 fog(env)가 능선을 이미 웜하게
  //   데워 리그가 조금만 얹혀도 임계를 넘는다. 반대로 큰 규모는 그 fog 가 분지도 밝혀 리그 리프트가
  //   덜 필요하다. → siteR 로 리그 웜 강도를 스케일(작은 마을=full 리프트, 도성·한양=하향)해 규모별
  //   편차(마을 어두움 / 도성·한양 화염)를 함께 해소. day/night 는 무관(화염 없음)이라 불건드림.
  let warmMul = 1;                     // setSiteR 가 갱신(석양·dawn 에만 적용)
  function setSiteR(R) {
    const r = (typeof R === 'number' && R > 0) ? R : 150;
    // R170 이하 full(마을), R300 에서 0.4(도성), 그 위 0.3 바닥(한양·fog 지배).
    const t = Math.min(1, Math.max(0, (r - 170) / (300 - 170)));
    warmMul = Math.max(0.3, 1 - t * 0.6);
  }

  function setTarget(name) {
    const V = VILLAGE_LIGHT_BY_TIME[name] || VILLAGE_LIGHT_BY_TIME.day;
    tHemiSky.setHex(V.hemiSky); tHemiGround.setHex(V.hemiGround); tHemiInt = V.hemiInt;
    tFillColor.setHex(V.fillColor); tFillInt = V.fillInt;
    // 골든아워(석양·dawn)만 규모 감쇠 — 큰 규모에서 능선 화염 blowout 억제(day/night 불변).
    if (name === 'sunset' || name === 'dawn') { tHemiInt *= warmMul; tFillInt *= warmMul; }
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
    rig, apply, step, setSiteR,
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
    for (const m of mats) {
      if (m.userData && m.userData.__kept) continue;   // #129 프로그램 앵커 — dispose 하면 캐시 프로그램 삭제→재컴파일
      m.map?.dispose?.(); m.dispose?.();
    }
  });
}
