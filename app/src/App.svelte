<script>
  import { onMount, tick } from 'svelte';
  import { PRESETS } from '../../src/api/building.js';
  import { createEngine } from './engine/engine.js';
  import { configFromSeed, paramsFor, newSeed, FLAGSHIP_TIME } from './lib/seed.js';
  import { readUrl, writeUrl } from './lib/url.js';
  import { buildRebuildPayload, villageDefaults } from './lib/edit-schema.js';
  import { createLiveEditScheduler } from './lib/live-edit-scheduler.js';
  import { device, initDevice } from './lib/device.svelte.js';
  import Hero from './components/Hero.svelte';
  import SealLabel from './components/SealLabel.svelte';
  import ActionBar from './components/ActionBar.svelte';
  import EnvironmentDial, { weatherOkForSeason } from './components/EnvironmentDial.svelte';
  import ParamPanel from './components/ParamPanel.svelte';
  import ModeToggle from './components/ModeToggle.svelte';
  import ContextPanel from './components/ContextPanel.svelte';
  import HoverLabel from './components/HoverLabel.svelte';
  import ReferenceModal from './components/ReferenceModal.svelte';
  import CinematicOverlay from './components/CinematicOverlay.svelte';
  import { exportGLB, analyzeExport, filenameFor, triggerDownload } from '../../src/api/export.js';
  import { t } from './lib/i18n.svelte.js';

  let container;
  let engine = null;

  let ui = $state({
    seed: 0, preset: 'korea', time: 'day', sunsetLook: 'gold', season: 'summer', weather: 'clear',
    expansion: 1, selected: false, canMerge: false, params: {}, maxExpansion: 3,
  });
  let overrides = $state({ preset: false, time: false, sunsetLook: false, season: false, weather: false });
  let heroVisible = $state(false);
  let heroLeaving = $state(false);
  let chromaFaded = $state(false);
  let refOpen = $state(false);                 // 참고 자료 모달
  let audioOn = $state(false);
  let rerollCooldown = $state(false);

  // ---------- 오토로테이션("시간 흐르기" #64) ----------
  // 활성 시 FLOW_INTERVAL 마다 시간대를 한 칸 전진(dawn→day→sunset→night→dawn…). 전환은 기존
  // engine.setTime 경로만 호출 → #50 환경 크로스페이드가 자동으로 미니 타임랩스처럼 이어준다.
  // 하루가 한 바퀴(night→dawn) 돌 때 계절도 한 칸 전진(봄→여름→가을→봄, 겨울 없음),
  // 그 계절 전진으로 눈이 비-가을에 걸리면 맑음으로 정리(weatherOkForSeason, 그 외 날씨는 유지).
  const FLOW_INTERVAL_MS = 10000;                              // 상수 10초
  const FLOW_TIME_CYCLE = ['dawn', 'day', 'sunset', 'night'];
  const FLOW_SEASON_CYCLE = ['spring', 'summer', 'autumn'];    // 겨울 없음(#58 계절 축과 동일)
  const FLOW_STALL_S = 1.0;    // 프레임 간격이 이보다 길면 스톨(초기 셰이더 컴파일·탭 비활성)로 보고 흐름 시간에서 제외
  let flowing = $state(false);
  let flowRaf = null;                                         // 흐름 클록 rAF 핸들
  let flowAcc = 0;                                            // 흐름 누적 시간(초) — 표시된 프레임 dt 적산(스톨 제외)
  let flowLast = 0;                                           // 직전 rAF 타임스탬프(ms)
  let flowAdvancing = false;                                  // 전진 재진입 가드
  let flowIntervalMs = FLOW_INTERVAL_MS;                       // ?flowsec= 로 검증 시 오버라이드
  let shot = false;                                            // ?shot=1 — 오토로테이션 완전 비활성

  // ---------- 마을 모드 상태 ----------
  // "하나의 공간, 두 배율"(#59·#62): 기본 인터랙티브 부팅은 마을 씬 안에서 종가 클로즈업으로 시작한다.
  //   sceneVillage: 엔진이 마을 씬에 있는가(단일건물 씬 ↔ 마을 씬). villageMode 이벤트로 갱신.
  //   villageHome: 이 세션이 "마을 우선(#62)"으로 부팅됐는가 — 히어로 랜딩과 URL 기록 정책만 소유한다.
  //     마을 안 보기 버튼은 이 값과 무관하게 집 보기=종가 focus, 둘러보기=focus-out이다(#14).
  //   mode(파생): 마을 홈은 선택 집=집 보기/미선택=둘러보기, 그 외는 씬 기준.
  let sceneVillage = $state(false);
  let villageHome = $state(false);
  // 마을 옵션: 규모·궁·절 + 상세 파라미터(#91 지형·구성·어휘). villageDefaults() 는 전부 코어 no-op 기본
  //   (K=1·stream=true·cityWall/sijeon='auto'·char01=null) → 무변경 시 현행 픽셀 불변(결정론).
  let villageOpts = $state({ scale: 'village', character: 'yeoyeom', includePalace: false, includeTemple: false, ...villageDefaults() });
  let villageSeed = $state(0);
  let villageHouses = $state(0);               // 현재 마을 호수(패널 표시)
  // focus 연속체(#92): villageEditing = 현재 focus 필지 { parcelId, spec }(focus-in START 에 설정,
  //   focus-out 완료(villageReturnDone)에 null). focusMorph(0=마을·1=집)는 카메라 focus 트윈 진행을
  //   engine 이 흘려준다 → 단일 컨텍스트 패널이 카메라와 한 클록으로 crossfade(원칙 2·3).
  let villageEditing = $state(null);           // { parcelId, spec } — focus 중 필지
  let villageZooming = $state(false);          // focus 전환(돌리) 진행 중 — 크롬 숨김 판단
  let focusMorph = $state(0);                  // 0=마을(부감)·1=집(근접) 패널 컨텍스트 모프
  let heroLanding = $state(false);             // 부팅 종가 랜딩 중(패널 숨김 — 히어로 연출)
  // 전환 완료 감시(#155): focusMorph 는 카메라 focus 트윈이 흘려주는 값이고, 부감 복귀(0)·근접 안착(1)의
  //   확정은 그 트윈의 onDone(=villageReturnDone / villageSelect) 이벤트에만 달려 있다. 트윈이 다른 트윈으로
  //   교체(supersede)되거나 유실되면 그 이벤트가 안 와 focusMorph 가 부감에서 1 에 갇히고, 그러면 ContextPanel
  //   의 villageOpacity(1-smoothstep(morph))=0 이 되어 마을(부감) 편집 섹션이 통째로 사라진다("원경에서 항목이
  //   하나도 안 보임"). 전환 개시 시 절대 상한(FOCUS_SETTLE_CAP_MS)을 무장해, 정상 전환(≈1.7s)은 완료 이벤트가
  //   먼저 타이머를 해제하지만(무영향) 상한을 넘도록 완료 이벤트가 안 오면 엔진 권위 상태(getState().selected)로
  //   컨텍스트를 확정해 패널이 영구히 갇히지 않게 한다(늦게 발동해도 목적지 끝값으로 스냅 → 안전).
  let focusWatchdog = null;
  let focusMorphLatched = false;               // 재조정 후 스테일 트윈이 흘리는 늦은 morph 이벤트 무시(교체된
                                               //   트윈이 계속 이벤트를 흘리는 저사양·잔류 케이스 방어). 다음 전환
                                               //   개시(Start/Return)에서 해제 — 새 트윈의 morph 는 정상 반영.
  const FOCUS_SETTLE_CAP_MS = 3500;            // 최장 정상 전환(<2s) + 셰이더 컴파일 히치 여유
  function clearFocusWatchdog() { if (focusWatchdog) { clearTimeout(focusWatchdog); focusWatchdog = null; } }
  function armFocusWatchdog() {
    clearFocusWatchdog();
    focusMorphLatched = false;                 // 새 전환 개시 → morph 이벤트 다시 수용
    if (heroLanding) return;                   // 히어로 랜딩(조립 수 초)은 감시 제외 — villageSelect 가 정리
    focusWatchdog = setTimeout(reconcileFocusState, FOCUS_SETTLE_CAP_MS);
  }
  function reconcileFocusState() {
    focusWatchdog = null;
    if (!engine || !sceneVillage) return;
    const st = engine.village.getState();
    focusMorphLatched = true;                   // 이후 스테일 morph 이벤트가 확정값을 되돌리지 못하게 래치
    if (!st.selected) {                         // 엔진은 부감(비-focus) → 마을 섹션으로 확정(갇힌 morph 해소)
      liveEdit.cancel();
      villageEditing = null; villageZooming = false; focusMorph = 0;
    } else {                                    // 엔진은 특정 필지 focus → 집 섹션으로 확정
      villageZooming = false; focusMorph = 1;
      if (!villageEditing && st.spec) seedEdit({ parcelId: st.selected, spec: st.spec });
    }
  }
  let waving = $state(false);                  // 리롤 웨이브 진행 중(#56 — 입력·버튼 잠금)
  let editParams = $state({});                 // { kind, frontBays, sideBays, roofPitch, eaveOverhang }
  let hoverInfo = $state(null);                // 호버 미니라벨 { spec, x, y }
  let veil = $state(false);                    // 먹 안개 트랜지션 오버레이(#46) — 마을 생성 프리징 마스킹
  let veilPending = 0;                          // withVeil 재진입 카운터(#133) — 파라미터 연타(#69 라이브 반영) 시 마지막 호출만 베일 해제

  // ---------- 시네마틱 데모 모드(#112) ----------
  let cine = $state({ active: false, mode: null, pass: null });   // engine 'cinematic' 이벤트로 갱신
  let exporting = $state(false);               // glb 익스포트 진행(스피너·중복 클릭 방지)
  let toast = $state(null);                    // 안내 토스트 문구(overBudget 등) — null 이면 숨김
  let toastTimer;
  const showToast = (msg, ms = 3600) => { toast = msg; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast = null; }, ms); };
  // 데스크톱 1인칭 조작: WASD/화살표 이동 + 마우스 시선. autoStroll 기본, 수동 입력 시 해제(다시 안 켬).
  const walkKeys = new Set();
  let walkYaw = 0, walkPitch = 0, walkManual = false, walkRaf = null;

  function syncUrl() {
    // villageHome(기본 인터랙티브 부팅)은 village 파라미터를 URL 에 쓰지 않는다 — 써 두면 새로고침이
    // ?village=1 직행 부감 경로를 타서 히어로 랜딩이 재생되지 않는다(#59 "새로고침해도 재발생 안 됨"의
    // 원인). URL 을 담백하게 두어 새로고침마다 마을 우선 히어로 랜딩이 다시 재생되게 한다. 명시적
    // 마을 진입(?village=1·모드 토글로 들어간 비-home 세션)만 village 계약을 URL 에 반영한다.
    writeUrl(ui, {
      overrides,
      village: (sceneVillage && !villageHome) ? { seed: villageSeed, ...villageOpts } : null,
      flow: flowing,
    });
  }
  function pullState() {
    const s = engine.getState();
    ui.preset = s.preset; ui.time = s.time; ui.sunsetLook = s.sunsetLook; ui.season = s.season;
    ui.weather = s.weather; ui.expansion = s.expansion; ui.selected = s.selected;
    ui.canMerge = s.canMerge;
    ui.params = engine.getParams();
    ui.maxExpansion = engine.maxExpansion();
  }
  function pullVillage() {
    const vs = engine.village.getState();
    villageHouses = vs.stats ? vs.stats.houses : 0;
  }

  // ---------- 크로마 자동 페이드 (3초 무조작 → 감상 모드) ----------
  let idleTimer;
  function wake() {
    if (chromaFaded) chromaFaded = false;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!ui.selected && !villageEditing && !refOpen) chromaFaded = true; }, 3000);
  }

  // ---------- 모바일 크롬 가시성 (바텀 시트가 하단을 점유하는 상황) ----------
  // sheetLayout: 바텀 시트 레이아웃(세로 좁은 화면). editing: 우측 편집 시트가 열림.
  let sheetLayout = $derived(device.sheet);
  let editing = $derived(ui.selected || !!villageEditing || villageZooming);
  // 보기(파생): focus(편집·전환) 중이면 항상 집 보기, 아니면 마을 씬=둘러보기·단일건물=집 보기.
  //   ?village=1 세션도 선택 중 둘러보기가 켜지지 않으며, 둘러보기를 누르면 명시적으로 focus-out한다.
  let mode = $derived(
    (villageEditing || villageZooming) ? 'house' : (sceneVillage ? 'village' : 'house')
  );
  // 히어로 랜딩 크롬 은닉(#118 U4): 타이틀 표시(heroVisible)~종가 랜딩(heroLanding) 동안 ModeToggle·
  //   EnvironmentDial·ActionBar·낙관을 숨긴다(ContextPanel 과 동일 연출). 랜딩 종료 시 chroma 페이드로
  //   복원(전환은 opacity 트랜지션 1회 — chroma 감상 페이드와 이중 적용 없이 부드럽게).
  let heroChrome = $derived(heroVisible || heroLanding);
  // 마을 부감: 하단 peek 옵션 시트 위로 액션바를 올림.
  let villageAerial = $derived(sceneVillage && !villageEditing && !villageZooming);
  // 시네마틱 진입 버튼(드론/거닐기)은 마을 부감에서만 — focus·전환·웨이브·먹안개·데모 중엔 미노출.
  let cineButtons = $derived(villageAerial && !waving && !veil && !cine.active && !heroLanding);
  // 편집 중엔 액션바 숨김(모든 터치 디바이스 — 세로 시트/가로·태블릿 사이드 패널과 겹침 방지).
  // 데스크톱(perf=false)은 종전대로 유지. 낙관은 세로 시트에서만 하단 겹침이 생기므로 그때만 숨김.
  let hideActions = $derived(device.perf && editing);
  let hideSeal = $derived(sheetLayout && (editing || (sceneVillage && !villageEditing)));

  onMount(() => {
    initDevice();
    if (typeof window !== 'undefined') {
      window.__device = device;                                    // playwright 검증용
      // 오토로테이션 검증 훅(#64) — 크로마 페이드로 버튼이 숨어도 상태 확인·토글 가능.
      window.__envflow = {
        toggle: () => toggleFlow(),
        get flowing() { return flowing; },
        get interval() { return flowIntervalMs; },
      };
    }
    const url = readUrl();
    // 성능 프로파일: 터치/좁은 뷰포트 → perf(경량), 폰급 → compact(pixelRatio·bloom 하향).
    engine = createEngine({ container, perf: device.perf, compact: device.compact });

    engine.on('state', () => pullState());
    engine.on('seed', (seed) => { ui.seed = seed; syncUrl(); });
    engine.on('select', (v) => { ui.selected = v; if (v) { chromaFaded = false; } });

    // 마을 모드 이벤트 — 씬 스왑(단일건물↔마을). villageHome 세션은 여기서 벗어나지 않는다(부감/클로즈업만).
    engine.on('villageMode', (on) => {
      sceneVillage = on;
      // 마을 씬 이탈 = 랜딩 종료(정상 완주든 폴백/리버트든) → heroLanding 해제로 #118 U4 크롬 스턱 방지.
      if (!on) {
        liveEdit.cancel();
        villageEditing = null; hoverInfo = null; villageHome = false; focusMorph = 0;
        villageZooming = false; waving = false; heroLanding = false; pendingCommit = null;
        clearFocusWatchdog(); focusMorphLatched = false;
      }   // #151 이탈 시 큐 비움(스테일 재커밋 방지)
      else pullVillage();
      syncUrl();
    });
    engine.on('villageHover', (h) => { hoverInfo = h; });
    // focus-in START(집 클릭·집 보기·프로그램 진입·랜딩) — 스펙 선전달(#92)로 패널이 돌리 중 집 컨텍스트로
    //   모프하기 시작한다(도착 대기 없음). editParams 를 즉시 시드해 슬라이더가 렌더값에서 출발.
    engine.on('villageSelectStart', (p) => {
      hoverInfo = null; villageZooming = true;
      if (p && p.spec) { seedEdit(p); }
      chromaFaded = false;
      armFocusWatchdog();                       // #155 전환 개시 → 스톨 감시 무장
    });
    // 카메라 focus 트윈 진행 → 패널 컨텍스트 모프(같은 클록, 원칙 3). 감시 타이머는 전환 개시(Start/Return)에서
    //   한 번 무장하고 여기선 재무장하지 않는다 — 완료 이벤트가 정상 전환에서 먼저 해제하고, 안 오면 상한 발동(#155).
    engine.on('villageFocusMorph', (k) => { if (!focusMorphLatched) focusMorph = k; });
    engine.on('villageSelect', (p) => {
      villageZooming = false; heroLanding = false; focusMorph = 1;
      seedEdit(p);
      chromaFaded = false;
      clearFocusWatchdog(); focusMorphLatched = false;   // #155 근접 안착 → 감시 해제
    });
    // focus-out START — 패널은 집 컨텍스트를 유지한 채 모프가 역행(villageFocusMorph 가 1→0).
    engine.on('villageReturn', () => {
      liveEdit.cancel();
      villageZooming = true; hoverInfo = null; armFocusWatchdog();
    });   // #155
    // focus-out 완료(부감 도착) — 집 컨텍스트 해제, 마을 섹션만. 랜딩이 부감으로 귀착한 경우도 여기 —
    //   heroLanding 해제로 크롬 복원(#118 U4).
    engine.on('villageReturnDone', () => {
      liveEdit.cancel();
      villageEditing = null; villageZooming = false; focusMorph = 0; heroLanding = false;
      clearFocusWatchdog(); focusMorphLatched = false;
    });
    // 리롤 웨이브(#56): 진행 중 입력·버튼 잠금, 완료 시 호수·URL 갱신.
    engine.on('villageWave', (w) => {
      waving = w.phase === 'start';
      if (w.phase === 'done') {
        // #151 웨이브 중 유실된 최신 커밋이 큐에 있으면 완료 즉시 자동 재커밋 → 마지막 값으로 수렴. 큐를 먼저
        //   비우고 villageOpts(소스오브트루스, 웨이브 중 세터가 갱신) 를 그대로 다시 웨이브 커밋(연쇄 1회로 종료).
        if (pendingCommit) { pendingCommit = null; engine.village.setOpts({ ...villageOpts }, { wave: true }); return; }
        pullVillage(); syncUrl(); chromaFaded = false;
      }
    });
    engine.on('villageSeed', (s) => { villageSeed = s; pullVillage(); syncUrl(); });

    // 시네마틱 데모(#112): 진입/패스 전환/종료 상태를 크롬 최소화·오버레이 라벨에 반영.
    engine.on('cinematic', (c) => {
      cine = { active: !!c.active, mode: c.mode ?? cine.mode, pass: c.pass ?? null };
      if (c.active) { chromaFaded = false; hoverInfo = null; startWalkFeed(); }
      else { stopWalkFeed(); }
    });

    // glb 익스포트 검증 훅(#112) — 실제 코어(exportGLB/analyzeExport)를 앱 대상(마을·focus)에 태워
    //   직렬화 가능한 결과만 반환(스크린샷 없는 수치 단언). __hero/__engine 계열과 동일한 비침습 훅.
    if (typeof window !== 'undefined') {
      window.__glb = {
        hasFocus: () => !!engine.village.focusRoot(),
        analyzeVillage: () => { const r = engine.village.exportRoot(); return r ? analyzeExport(r) : null; },
        exportHouse: async () => {
          const r = engine.village.focusRoot(); if (!r) return { ok: false, reason: 'no-focus' };
          const b = await exportGLB(r);
          return b instanceof ArrayBuffer ? { ok: true, bytes: b.byteLength, name: filenameFor(r) } : { ok: false, over: !!b.overBudget };
        },
        exportVillage: async (opts) => {
          const r = engine.village.exportRoot(); if (!r) return { ok: false, reason: 'no-village' };
          const b = await exportGLB(r, opts);
          return b instanceof ArrayBuffer ? { ok: true, bytes: b.byteLength, name: filenameFor(r) }
            : { ok: false, over: !!b.overBudget, triangles: b.triangles, limit: b.limit };
        },
      };
    }

    // 초기 설정: seed 기반 + URL 명시 오버라이드.
    const cfg = configFromSeed(url.seed);
    // 히어로 기본 = 석양 역광(#98 사용자 지시). shot 만 결정론 유지(configFromSeed 기본, 보통 day),
    //   그 외엔 시드 유무와 무관하게 사용자가 ?time 을 명시하지 않으면 늘 석양으로 랜딩(구 !hasSeed
    //   게이트가 시드 URL에서 석양 기본을 실효시켜 역광 림이 안 나오던 회귀 수정).
    if (!url.shot && !url.time) cfg.time = FLAGSHIP_TIME;
    if (url.preset && PRESETS[url.preset]) { cfg.preset = url.preset; cfg.params = paramsFor(url.preset); overrides.preset = true; }
    if (url.time) { cfg.time = url.time; overrides.time = true; }
    if (url.sunsetLook) { cfg.sunsetLook = url.sunsetLook; overrides.sunsetLook = true; }
    if (url.season) { cfg.season = url.season; overrides.season = true; }
    if (url.weather) { cfg.weather = url.weather; overrides.weather = true; }
    ui.seed = url.seed;

    // 오토로테이션 복원: shot 에서는 항상 비활성(결정론). flowsec 은 검증용 간격 오버라이드.
    shot = url.shot;
    // 뷰포트 중심 보정(#124): 패널 점유 시 피사체 시프트. shot·검증 하네스는 패널이 없거나 결정론
    //   기준이므로 오프셋 0(기존 스크린샷 픽셀 불변). 그 외 실사용에서만 활성.
    engine.setViewShiftEnabled(!url.shot);
    if (url.flow && !url.shot) flowing = true;
    if (url.flowsec != null) flowIntervalMs = Math.round(url.flowsec * 1000);

    engine.start(cfg, url.seed);
    pullState();
    if (url.exp && url.exp > 1) engine.setExpansion(url.exp);

    // 마을 옵션 초기화(URL)
    if (url.vscale) villageOpts.scale = url.vscale;
    if (url.vchar) villageOpts.character = url.vchar;
    villageOpts.includePalace = (url.vpalace && (villageOpts.scale === 'capital' || villageOpts.scale === 'hanyang')) || villageOpts.scale === 'hanyang';
    villageOpts.includeTemple = url.vtemple;
    villageSeed = url.vseed != null ? url.vseed : newSeed();
    syncUrl();

    // 기본 인터랙티브 부팅(#62): 마을 우선 진입 — 타이틀 동안 마을 사전 생성, 클릭 시 종가 클로즈업
    // 랜딩. ?shot·?hero=0·?village=1은 기존 부팅 계약(단일건물·직행 부감)대로 villageHome이 아니지만,
    // 마을에 들어온 뒤의 보기 버튼 의미는 동일하다(#14).
    if (url.hero && !url.shot && !url.village) {
      heroVisible = true;
      villageHome = true;
      engine.hero.arm();   // 타이틀 동안 단일건물 은닉 + 오디오 준비(랜딩은 village.enterHero 로 교체)
    }

    // ?village=1 진입 — 히어로 없이 곧장 마을 부감.
    if (url.village) engine.village.enter({ ...villageOpts }, villageSeed);

    // 마을 사전 생성(#46): 히어로 타이틀이 화면을 덮는 동안(3D 조립 시작 전) 기본 시드 마을을
    // CPU 생성 + GPU 프리워밍까지 미리 끝내 hidden 보관 → 첫 마을 진입 시 프리징 없이 먹 안개
    // reveal+돌리인만. 타이틀이 덮는 지금 실행해야 생성 프리징이 안 보인다(reveal 재생 중이면 버벅임).
    // 타이틀 없는 진입(hero off·shot·직행)은 첫 토글에서 먹 안개 마스킹 → 여기서 앞당기지 않음.
    if (heroVisible) {
      requestAnimationFrame(() => requestAnimationFrame(() => engine?.village.preload({ ...villageOpts }, villageSeed)));
    }

    // 활동 감지 → 크로마 페이드.
    for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel']) {
      addEventListener(ev, wake, { passive: true });
    }
    addEventListener('keydown', onKey);
    wake();

    // 오토로테이션 흐름 클록 시작 — rAF 루프는 항상 돌며 매 프레임 게이트를 자체 검사한다(흐름 활성 +
    // shot 아님 + 히어로 미표시 + 탭 활성). 히어로 표시 중엔 acc 가 매 프레임 리셋돼 보류되고, 히어로
    // 해제 시 acc=0 에서 자연히 흐름이 시작된다(hero.enter onDone 재예약은 무해한 명시적 리셋).
    flowRaf = requestAnimationFrame(flowFrame);

    return () => {
      for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel']) removeEventListener(ev, wake);
      removeEventListener('keydown', onKey);
      cancelAnimationFrame(flowRaf);
      stopWalkFeed();
      clearTimeout(toastTimer);
      clearFocusWatchdog();
      liveEdit.dispose();
      engine?.dispose();
    };
  });

  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (cine.active) { engine.cine.stop(); return; }  // 시네마틱 데모 중이면 먼저 종료
    if (sceneVillage) { engine.village.escape(); }   // 클로즈업이면 부감 복귀(escape 가 selected 판정)
    else if (ui.selected) { engine.clearSelection(); }
  }

  // ---------- 액션 ----------
  function enterHero() {
    if (heroLeaving) return;
    heroLeaving = true;
    audioOn = true;
    // 마을 우선 진입(#62): 마을 씬 안에서 종가 클로즈업 랜딩 + 조립. 기본 인터랙티브 부팅.
    // (구 단일건물 히어로 reveal 은 villageHome 이 아닌 세션에만 — 현재 진입 계약상 도달 안 하나 계승.)
    // onDone 은 랜딩 시퀀스 완료(정상=villageSelect 후 · 예외=종가 없음 폴백 즉시) 양 경로에서 호출된다.
    //   여기서 heroLanding 을 확실히 해제해 #118 U4 크롬이 폴백/조기클릭 엣지에서도 스턱되지 않게 한다
    //   (정상 경로는 villageSelect 가 이미 해제 → 무해한 중복).
    const onDone = () => { heroLanding = false; scheduleFlowTick(); };
    if (villageHome) { heroLanding = true; engine.village.enterHero({ ...villageOpts }, villageSeed, { onDone }); }
    else engine.hero.enter({ onDone });
    setTimeout(() => { heroVisible = false; }, 900);
  }
  // 이 집 다시 짓기(#19): 예약된 이웃·도로는 보존하되 필지 내부 경계부터 집 변주, 마당 소품,
  //   과실수까지 하나의 결정론적 transaction으로 재생성한다. 마을 전체 리롤과는 분리한다.
  function rerollHouse() { if (sceneVillage && villageEditing && !villageZooming && !waving) { engine.village.rerollParcel(); chromaFaded = false; scheduleFlowTick(); } }
  // 단일건물 씬(?hero=0·?village=1 레거시) 액션바 도장 = 새 씨앗 재생성. 마을 씬에선 도장 미노출(리롤은 패널 소유).
  function reroll() {
    if (rerollCooldown || waving || sceneVillage) return;
    rerollCooldown = true;
    setTimeout(() => (rerollCooldown = false), 500);
    overrides = { preset: false, time: false, season: false, weather: false };
    engine.reroll();
    pullState();
    chromaFaded = false;
    scheduleFlowTick();   // 수동 개입 → 타이머 리셋(흐름 유지)
  }
  // 마을 리롤 웨이브(#56 배선) — focus 중이면 먼저 focus-out(링·오버레이 정리) 후 부감에서 웨이브 시작.
  function rerollVillage() {
    if (waving) return;
    chromaFaded = false;
    scheduleFlowTick();
    if (villageEditing || villageZooming) {
      engine.village.return();
      // focus-out 돌리(FOCUS_OUT_DUR≈1.7s) 완료 후 웨이브 — 부감 도착·정리 보장.
      setTimeout(() => { if (sceneVillage && !waving) engine.village.rerollWave(); }, 1850);
    } else {
      engine.village.rerollWave();
    }
  }
  function postcard() { engine.postcard({ download: true }); }
  function toggleAudio() { audioOn = !audioOn; engine.toggleAudio(audioOn); }

  // ---------- 시네마틱 데모 모드(#112) ----------
  function startDrone() { if (!waving) engine.cine.start('drone'); }        // 오토플레이 체인(순환)
  function startWalk() { if (!waving) engine.cine.start('walk'); }
  function stopCine() { engine.cine.stop(); }

  // 데스크톱 1인칭 입력 — cine walk 활성 동안만 rAF 로 키/마우스 델타를 walker 에 피드(모바일은 autoStroll).
  function startWalkFeed() {
    if (cine.mode !== 'walk' || device.perf) return;   // 터치/저사양은 autoStroll 전용
    walkKeys.clear(); walkYaw = 0; walkPitch = 0; walkManual = false;
    addEventListener('keydown', onWalkKey);
    addEventListener('keyup', onWalkKeyUp);
    addEventListener('pointermove', onWalkMouse, { passive: true });
    const feed = () => {
      if (!cine.active || cine.mode !== 'walk') { walkRaf = null; return; }
      walkRaf = requestAnimationFrame(feed);
      const fwd = (walkKeys.has('w') || walkKeys.has('ArrowUp') ? 1 : 0) - (walkKeys.has('s') || walkKeys.has('ArrowDown') ? 1 : 0);
      const strafe = (walkKeys.has('d') || walkKeys.has('ArrowRight') ? 1 : 0) - (walkKeys.has('a') || walkKeys.has('ArrowLeft') ? 1 : 0);
      const run = walkKeys.has('shift');
      if (fwd || strafe || walkYaw || walkPitch) {
        if (!walkManual) { walkManual = true; engine.cine.setAutoStroll(false); }   // 첫 조작에 자동산책 해제
        engine.cine.input({ fwd, strafe, run, yaw: walkYaw, pitch: walkPitch });
        walkYaw = 0; walkPitch = 0;
      }
    };
    walkRaf = requestAnimationFrame(feed);
  }
  function stopWalkFeed() {
    if (walkRaf != null) { cancelAnimationFrame(walkRaf); walkRaf = null; }
    removeEventListener('keydown', onWalkKey);
    removeEventListener('keyup', onWalkKeyUp);
    removeEventListener('pointermove', onWalkMouse);
    walkKeys.clear();
  }
  function onWalkKey(e) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) { walkKeys.add(k); e.preventDefault(); }
    if (e.shiftKey) walkKeys.add('shift');
  }
  function onWalkKeyUp(e) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    walkKeys.delete(k);
    if (!e.shiftKey) walkKeys.delete('shift');
  }
  function onWalkMouse(e) {
    // 버튼 눌린 드래그일 때만 시선 회전(자유 커서 이동과 구분). movementX/Y 는 상대 델타.
    if (e.buttons & 1) { walkYaw -= (e.movementX || 0) * 0.0026; walkPitch -= (e.movementY || 0) * 0.0022; }
  }

  // ---------- glb 내보내기(#104·#112) ----------
  // 대형 마을은 sanitize+parse 가 수 초 블록 가능 → 스피너 페인트 후(rAF 2회 양보) 실행 + 중복 클릭 방지.
  async function runExport(getTarget) {
    if (exporting) return;
    const target = getTarget();
    if (!target) { showToast(t('glb_error')); return; }
    exporting = true;
    chromaFaded = false;
    await tick();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const result = await exportGLB(target);
      if (result && result.overBudget) {
        showToast(t('glb_toobig'));
      } else if (result instanceof ArrayBuffer) {
        triggerDownload(result, filenameFor(target));
        showToast(t('glb_done'), 2200);
      } else {
        showToast(t('glb_error'));
      }
    } catch (err) {
      console.error('glb export failed', err);
      showToast(t('glb_error'));
    } finally {
      exporting = false;
    }
  }
  function exportVillage() { runExport(() => engine.village.exportRoot()); }
  function exportHouse() { runExport(() => engine.village.focusRoot()); }

  // 환경 적용 원자 연산(엔진 호출 + 오버라이드 표시). 수동 setter·오토로테이션이 공유.
  function applyTime(v) { engine.setTime(v); overrides.time = true; }
  function applySunsetLook(v) { engine.setSunsetLook(v); overrides.sunsetLook = true; }
  function applySeason(v) { engine.setSeason(v); overrides.season = true; }
  function applyWeather(v) { engine.setWeather(v); overrides.weather = true; }

  // 수동 조작(다이얼 드래그·리롤은 onTime/onSeason/onWeather 로 이 경로를 탄다) → 타이머만 리셋,
  // 모드는 유지(흐르는 중이면 다음 전진까지 다시 10초, 꺼져 있으면 무동작).
  function setTime(v) { applyTime(v); syncUrl(); scheduleFlowTick(); }
  function setSunsetLook(v) { applySunsetLook(v); syncUrl(); scheduleFlowTick(); }
  function setSeason(v) { applySeason(v); syncUrl(); scheduleFlowTick(); }
  function setWeather(v) { applyWeather(v); syncUrl(); scheduleFlowTick(); }

  // 흐름 클록(rAF 기반) — "실제 표시된" 프레임 간격만 적산해 interval 마다 정확히 한 칸 전진한다.
  // setTimeout 은 소프트웨어GL 초기 셰이더 컴파일이 메인스레드를 수 초 블록하는 동안에도 wall-clock
  // 이 흘러, 로드가 끝나기 전에 조기 전진(선행 전진)하고 케이던스가 불균일했다. rAF 는 프레임이
  // 그려질 때만 돌고, 스톨 프레임(dt>FLOW_STALL_S: 컴파일·탭 비활성 복귀)은 흐름 시간에서 제외하므로
  // 첫 전진은 앱이 실제 렌더를 시작한 뒤 정확히 interval 후 1회다. 게이트: 흐름 활성 + shot 아님 +
  // 히어로 미표시 + 탭 활성. 게이트 오프면 acc 리셋 → 재개 시 다시 온전한 interval(선행/누수 전진 없음).
  // 프레임당 최대 1회 전진(dt≤STALL≤간격 클램프로 acc 초과분<간격 보장) → 이중 전진 원천 차단.
  function flowFrame(now) {
    flowRaf = requestAnimationFrame(flowFrame);
    const dt = flowLast ? (now - flowLast) / 1000 : 0;
    flowLast = now;
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (!flowing || shot || heroVisible || hidden) { flowAcc = 0; return; }
    // 스톨 프레임(컴파일 히치·탭 복귀·저사양 <1fps)은 0 이 아니라 상한 FLOW_STALL_S 만큼만 기여 —
    // 탭 30초 비움이 여러 스텝을 몰아 당기진 않되, 지속 저fps 환경에서도 흐름은 멈추지 않는다.
    const step = Math.min(dt, FLOW_STALL_S, flowIntervalMs / 1000);
    if (dt > 0) flowAcc += step;
    if (flowAcc >= flowIntervalMs / 1000) { flowAcc = 0; advanceFlow(); }
  }
  // 흐름 클록 리셋 — 수동 개입(다이얼 드래그·리롤·토글은 onTime/onSeason/onWeather·reroll 로 이 경로를
  // 탄다) 시 호출. 누적을 0 으로 되돌려 다음 전진까지 다시 온전한 interval(타이머 리셋 의미론).
  function scheduleFlowTick() { flowAcc = 0; }
  // 한 틱 = 정확히 1스텝. 재진입 가드 + 권위 상태(engine.getState) 동기 조회로 반응성 지연·레이스 배제.
  // 시간대 다음 칸, night→dawn 랩이면 계절도 1칸 전진 + 눈 정리(비는 유지). 크로스페이드는 setTime 이
  // 자동 수행. acc 리셋은 flowFrame 이 호출 직전 수행하므로 여기선 상태 전이만 담당한다.
  function advanceFlow() {
    if (flowAdvancing) return;
    flowAdvancing = true;
    try {
      const st = engine.getState();
      const ni = (FLOW_TIME_CYCLE.indexOf(st.time) + 1) % FLOW_TIME_CYCLE.length;
      applyTime(FLOW_TIME_CYCLE[ni]);
      if (ni === 0) { // 하루 한 바퀴 완주(night→dawn) → 계절 한 칸 전진
        const nextSeason = FLOW_SEASON_CYCLE[(FLOW_SEASON_CYCLE.indexOf(st.season) + 1) % FLOW_SEASON_CYCLE.length];
        applySeason(nextSeason);
        if (!weatherOkForSeason(st.weather, nextSeason)) applyWeather('clear');
      }
      syncUrl();
    } finally {
      flowAdvancing = false;
    }
  }
  function toggleFlow() {
    if (shot) return;                 // shot 베이스라인 결정론 — 토글 자체를 무효화
    flowing = !flowing;
    syncUrl();
    scheduleFlowTick();               // 켜짐/꺼짐 모두 흐름 클록 리셋(재개 시 온전한 interval)
  }
  function setType(v) { engine.setType(v); overrides.preset = true; pullState(); syncUrl(); }
  function setExpansion(n) { engine.setExpansion(n); pullState(); syncUrl(); }
  function mergeNeighbor() { engine.merge(); pullState(); syncUrl(); }
  function setParam(k, v) { engine.setParam(k, v); }
  function closePanel() { engine.clearSelection(); }

  // ---------- 마을 모드 액션 ----------
  // 먹 안개 마스킹(#46): 오버레이가 화면을 완전히 덮은 뒤 동기 생성 fn 을 실행 → 생성 프리징 은닉,
  // 완료 후 페이드 아웃(마을이 안개에서 드러남 + 돌리인). 조작 직후 오버레이 페이드 인은 즉시 반응.
  async function withVeil(fn) {
    veilPending++;                              // #133 재진입 가드: 파라미터 연타로 withVeil 이 겹치면
    veil = true;
    await tick();
    // 오버레이 opacity 1 도달까지 대기(CSS 트랜지션) — 이후에 생성해야 프리징이 안 보인다.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 260));
    try { fn(); } finally {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (--veilPending === 0) veil = false;    // 마지막 호출 완료 시에만 베일 해제(앞 호출 finally 가 뒤 호출 재생성 프레임을 조기 노출하지 않게)
    }
  }
  function toggleMode(target) {
    if (waving) return;                       // 리롤 웨이브 중 배율 전환 잠금(#56)
    if (sceneVillage) {
      // #14: 마을에 들어온 뒤 보기 버튼의 뜻은 진입 경로와 무관하다. 집 보기=종가 focus,
      // 둘러보기=focus-out. ?village=1에서 집 보기가 레거시 단일건물 씬으로 이탈하던 이중 의미를 제거한다.
      if (target === 'house') engine.village.focusHero();
      else engine.village.return();
      return;
    }
    // 단일건물로 시작한 구 세션(?hero=0)은 둘러보기를 눌렀을 때만 마을로 진입한다.
    if (target === 'village') {
      // 사전 생성분이 준비됐으면 즉시 진입(프리징 없음), 아니면 먹 안개로 생성을 마스킹.
      if (engine.village.isReady({ ...villageOpts }, villageSeed)) engine.village.enter({ ...villageOpts }, villageSeed);
      else withVeil(() => engine.village.enter({ ...villageOpts }, villageSeed));
    }
  }
  // #144 규모 커밋 = 즉시 웨이브(구 마을 유지 → 중앙에서 방사형 조립). withVeil(헛번쩍) 폐기 — setOpts 가
  //   비동기(#123)라 베일이 아무것도 안 덮었다. pullVillage·syncUrl 은 완료 시 villageWave 'done'·villageMode 가 수행.
  // #151 웨이브 중 커밋 큐잉: 웨이브 애니(3.6s) 진행 중엔 setOpts 가 엔진에서 드롭된다(startVillageWave 가
  //   village.wave 잠금으로 null 반환) → 연타 커밋이 전부 유실돼 슬라이더 UI 와 마을이 desync 됐다(T5 8/8 드롭).
  //   이제 세터는 항상 villageOpts(소스오브트루스) 를 먼저 갱신해 UI 를 즉시 반영하고, waving 이면 커밋을 큐 1칸
  //   (pendingCommit) 에 표시만 해 뒀다가 웨이브 완료('villageWave' done) 에 자동 재커밋 → 마지막 값으로 수렴한다.
  //   큐 1칸이라 연타해도 연쇄 웨이브 1회로 끝난다(최신 승리·무한 연쇄 없음). villageZooming(집 focus 전환) 중엔
  //   마을 opts 커밋 자체가 무의미하므로 드롭 유지(패널 컨텍스트가 집 편집으로 모프된 상태).
  let pendingCommit = null;
  function commitVillageOpts() {
    if (villageZooming) return;
    if (waving) { pendingCommit = { ...villageOpts }; return; }   // 웨이브 중 → 최신 의도만 큐잉(덮어쓰기)
    engine.village.setOpts({ ...villageOpts }, { wave: true });
  }
  function setScale(s) {
    if (villageZooming) return;
    villageOpts.scale = s;
    // 궁은 도성 규모(capital·hanyang)만. hanyang 은 궁 기본 ON(도성=궁성), 그 외 도성 미만은 OFF.
    if (s === 'hanyang') villageOpts.includePalace = true;
    else if (s !== 'capital') villageOpts.includePalace = false;
    // 외딴집에는 성곽 문법이 없으므로 강제 ON을 auto로 정리한다. 초락 이상은 tier별 도로가 성문에 정렬된다.
    if (s === 'solo' && villageOpts.cityWall === true) villageOpts.cityWall = 'auto';
    // 집 없음(#114)은 외딴집 전용 구성 — 규모를 키우면 해제(보이지 않는 houses:0 잔존 방지).
    if (s !== 'solo' && villageOpts.houses != null) villageOpts.houses = null;
    commitVillageOpts();
  }
  // character(민촌/여염/반촌) 셀렉터는 폐지(사용자 지시) — UI 미노출, villageOpts.character 는 내부 기본값(yeoyeom) 유지.
  function togglePalace() {
    if (villageZooming) return;
    if (villageOpts.scale !== 'capital' && villageOpts.scale !== 'hanyang') return;
    villageOpts.includePalace = !villageOpts.includePalace;
    commitVillageOpts();
  }
  function toggleTemple() { if (villageZooming) return; villageOpts.includeTemple = !villageOpts.includeTemple; commitVillageOpts(); }
  // 마을 상세 파라미터(#91): 지형·구성·어휘 옵션 커밋 → 재생성(시드 유지). 규모·궁·절과 동일하게 웨이브 경로
  //   (#144) — 이 옵션들은 plan/populate 를 통째로 재유도(seed 동일이라도 layout 이 바뀜)라 전-마을 웨이브가
  //   의미상 맞다. 라이브 rAF 미요구(재생성 파라미터) — 슬라이더 onchange/토글 클릭에서만 호출.
  function setVillageOpt(key, value) {
    if (villageZooming) return;
    villageOpts[key] = value;
    commitVillageOpts();
  }

  // 집 편집(#48·#69): 편집값을 스키마(edit-schema)로 어댑터 rebuildParcel 계약에 라우팅. 라이브 전략은
  //   family 로 갈린다 — 정규 필지(가벼운 단일 집)는 드래그 중 rAF 병합 라이브(#69 즉각 변형),
  //   특수 컴파운드(종가·관아, buildParcel 통짜라 무거움)는 드래그 중 값 라벨만, 놓을 때 재생성(성능 규율).
  // focus 필지 컨텍스트/편집값 시드(#92·#93). editParams 는 focus 중 그 필지의 단일 진실원 —
  //   같은 필지의 재-emit(도착·리플레이·전환 중 편집)에선 재시드하지 않아야 편집이 보존된다. 재시드하면
  //   spec.params(기본값)로 덮여 "지오는 편집 상태인데 패널 숫자는 기본값 고정"(critic-focusv2 desync)이 난다.
  //   필지가 바뀔 때만(또는 최초) 기본값으로 시드. 특수 컴파운드(종가·관아·궁) 커밋 경로도 이 진실원을 공유.
  function seedEdit(p) {
    // 필지가 바뀔 때만 기본값으로 재시드(같은 필지 재-emit 에선 편집 보존). 단 리롤(#100)은 같은
    //   parcelId 라도 시드가 굴러 새 기본값이므로 p.reseed 로 강제 재시드(desync 방지).
    const changed = p.reseed || !villageEditing || villageEditing.parcelId !== p.parcelId;
    if (changed) liveEdit.cancel();
    villageEditing = { parcelId: p.parcelId, spec: p.spec };
    if (changed) editParams = { kind: p.spec.kind, ...(p.spec.params || {}) };
  }
  // 특수 컴파운드(종가·관아 hero + 궁 palace-compound)는 buildParcel/buildPalaceCompound 통짜라 무거워
  //   드래그 라이브 재생성 금지 — 값 라벨만 라이브, 놓을 때(commit) 재생성.
  const isSpecialCompound = (spec) => !!spec
    && (spec.hero || spec.family === 'palace-compound' || spec.family === 'temple');
  function pushRebuild({ refreshFlora = true } = {}) {
    if (!villageEditing) return;
    const rebuilt = engine.village.rebuild(
      villageEditing.parcelId,
      buildRebuildPayload(villageEditing.spec, editParams),
      { refreshFlora },
    );
    // Compound planners may change the valid controls and clamp ranges when a
    // variant changes. Refresh the declarative spec after the core accepts the
    // rebuild; Svelte still owns no THREE state.
    const nextSpec = rebuilt ? engine.village.getState().spec : null;
    if (nextSpec?.parcelId === villageEditing.parcelId) {
      villageEditing = { ...villageEditing, spec: nextSpec };
    }
  }
  // Geometry-backed range controls receive many more input events than useful
  // rendered frames. The reusable scheduler keeps the label immediate, merges
  // preview work latest-wins, adapts its cadence to measured rebuild cost, and
  // makes pointer release the only flora/pick-boundary commit (#3, #19).
  const liveEdit = createLiveEditScheduler({
    preview: () => pushRebuild({ refreshFlora: false }),
    commit: () => pushRebuild(),
  });
  function villageLive(k, v) {
    editParams[k] = v;
    if (isSpecialCompound(villageEditing?.spec)) return;   // 특수 컴파운드(종가·관아·궁): 값 라벨만 라이브, 놓을 때 재생성
    liveEdit.request();
  }
  function villageCommit(k, v) {
    // Switching a temple grammar is a semantic layout change, not a cosmetic
    // label swap. Seed the new variant's hall/monument defaults so the panel and
    // the planner's clamped result cannot drift (for example 7 halls displayed
    // while a compact precinct actually renders 2).
    const templeDefaults = villageEditing?.spec?.family === 'temple' && k === 'variant'
      ? villageEditing.spec.variantDefaults?.[v]
      : null;
    if (templeDefaults) editParams = { ...editParams, ...templeDefaults, variant: v };
    else editParams[k] = v;
    liveEdit.commit();
  }
  function villageSetType(kind) { villageCommit('kind', kind); }
  function closeVillageEdit() { liveEdit.cancel(); engine.village.return(); }
</script>

<div class="stage" bind:this={container}></div>

{#if heroVisible}
  <Hero onEnter={enterHero} leaving={heroLeaving} />
{/if}

<!-- 먹 안개 트랜지션(#46): 마을 생성 프리징을 가리는 수묵 크로스페이드 오버레이. -->
<div class="veil" class:on={veil} aria-hidden="true"></div>

{#if !cine.active}
  <!-- 히어로 랜딩 중 은닉(#118 U4) — chroma 와 동일 0.9s 페이드로 복원(하드 마운트 팝 방지). -->
  <div class="modewrap" class:hero={heroChrome}><ModeToggle {mode} onToggle={toggleMode} /></div>
{/if}

<!-- 시네마틱 데모 중엔 크롬을 페이드(감상 우선) — .chroma 3초 감상 페이드와 별개 게이트.
     히어로 랜딩(heroChrome) 동안에도 은닉(#118 U4), 랜딩 종료 시 자연 복원. -->
<div class="chroma" class:faded={chromaFaded || cine.active || heroChrome}>
  {#if !hideSeal}<SealLabel seed={ui.seed} onInfo={() => { refOpen = true; chromaFaded = false; }} />{/if}
  <EnvironmentDial
    time={ui.time} sunsetLook={ui.sunsetLook} season={ui.season} weather={ui.weather}
    shifted={ui.selected && !sheetLayout}
    flowing={flowing}
    onTime={setTime} onSunsetLook={setSunsetLook} onSeason={setSeason} onWeather={setWeather}
    onFlowToggle={toggleFlow}
  />
  {#if !hideActions}
    <ActionBar
      onReroll={sceneVillage ? null : reroll} onPostcard={postcard} onToggleAudio={toggleAudio}
      audioOn={audioOn} busy={rerollCooldown || waving}
      raised={sheetLayout && villageAerial}
      shifted={ui.selected && !sheetLayout}
      onDrone={cineButtons ? startDrone : null}
      onWalk={cineButtons && !device.perf ? startWalk : null}
    />
  {/if}
</div>

{#if sceneVillage}
  <!-- 단일 컨텍스트 패널(#92): 마을(부감)·집(근접) 섹션이 한 패널 안에서 focusMorph 로 crossfade.
       히어로 랜딩·시네마틱 중엔 숨김(연출). 브레드크럼 '마을' 클릭 = focus-out. -->
  <ContextPanel
    open={!heroLanding && !cine.active}
    morph={focusMorph}
    detent={null}
    scale={villageOpts.scale}
    includePalace={villageOpts.includePalace}
    includeTemple={villageOpts.includeTemple}
    houses={villageHouses}
    onScale={setScale}
    onPalace={togglePalace}
    onTemple={toggleTemple}
    onReroll={rerollVillage}
    villageParams={villageOpts}
    onVillageOpt={setVillageOpt}
    waving={waving}
    houseBusy={villageZooming || waving}
    spec={villageEditing?.spec}
    params={editParams}
    onType={villageSetType}
    onLive={villageLive}
    onCommit={villageCommit}
    onRerollHouse={rerollHouse}
    onBack={closeVillageEdit}
    onExportVillage={villageAerial ? exportVillage : null}
    onExportHouse={villageEditing && !villageZooming ? exportHouse : null}
    exporting={exporting}
  />
  <HoverLabel info={hoverInfo} />
{:else}
  <ParamPanel
    open={ui.selected}
    preset={ui.preset}
    expansion={ui.expansion}
    maxExpansion={ui.maxExpansion}
    canMerge={ui.canMerge}
    params={ui.params}
    onType={setType}
    onExpansion={setExpansion}
    onMerge={mergeNeighbor}
    onParam={setParam}
    onClose={closePanel}
  />
{/if}

<ReferenceModal open={refOpen} onClose={() => { refOpen = false; }} />

<!-- 시네마틱 데모 오버레이(#112): 종료 창구 + 현재 장면 라벨. -->
<CinematicOverlay active={cine.active} mode={cine.mode} pass={cine.pass} onExit={stopCine} />

<!-- 안내 토스트(#112): glb overBudget·완료·실패 문구. -->
{#if toast}
  <div class="toast" role="status" aria-live="polite">{toast}</div>
{/if}

<style>
  .stage { position: fixed; inset: 0; z-index: 0; }
  .chroma { transition: opacity 0.9s ease; }
  .chroma.faded { opacity: 0; pointer-events: none; }
  /* ModeToggle 은 chroma 감상 페이드에서 제외(상시 노출)하되, 히어로 랜딩(#118 U4) 동안만 은닉 —
     chroma 와 동일 0.9s 트랜지션으로 랜딩 종료 시 함께 복원(팝/깜빡임 방지). */
  .modewrap { transition: opacity 0.9s ease; }
  .modewrap.hero { opacity: 0; pointer-events: none; }

  /* 먹 안개 트랜지션(#46) — 한지 바탕 수묵 크로스페이드. 생성 프리징을 덮어 튐/프리즈를 은닉. */
  .veil {
    position: fixed; inset: 0; z-index: 400; pointer-events: none; opacity: 0;
    transition: opacity 0.24s ease;
    background-image:
      var(--hanji),
      radial-gradient(130% 110% at 50% 42%, #f4efe4 0%, #ece4d4 55%, #e0d5c2 100%);
  }
  .veil.on { opacity: 1; pointer-events: auto; }

  /* 안내 토스트(#112) — 하단 중앙 먹빛 캡슐(사진 캡처·glb 안내). */
  .toast {
    position: fixed; left: 50%; bottom: max(84px, calc(env(safe-area-inset-bottom) + 80px));
    transform: translateX(-50%); z-index: 300; max-width: min(88vw, 420px);
    padding: 11px 18px; border-radius: 8px; text-align: center;
    background: rgba(24, 20, 16, 0.86); color: rgba(244, 239, 228, 0.96);
    font-family: var(--serif); font-size: 13.5px; line-height: 1.4; font-weight: 600;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
    animation: toastin 0.3s ease both;
  }
  @keyframes toastin { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
</style>
