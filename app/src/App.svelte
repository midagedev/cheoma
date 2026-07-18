<script>
  import { onMount, tick } from 'svelte';
  import { PRESETS } from '../../src/params.js';
  import { createEngine } from './engine/engine.js';
  import { configFromSeed, paramsFor, newSeed, FLAGSHIP_TIME } from './lib/seed.js';
  import { readUrl, writeUrl } from './lib/url.js';
  import { buildRebuildPayload } from './lib/edit-schema.js';
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

  let container;
  let engine = null;

  let ui = $state({
    seed: 0, preset: 'korea', time: 'day', season: 'summer', weather: 'clear',
    expansion: 1, selected: false, canMerge: false, params: {}, maxExpansion: 3,
  });
  let overrides = $state({ preset: false, time: false, season: false, weather: false });
  let heroVisible = $state(false);
  let heroLeaving = $state(false);
  let chromaFaded = $state(false);
  let refOpen = $state(false);                 // 참고 자료 모달
  let audioOn = $state(false);
  let rerollCooldown = false;

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
  //   villageHome: 이 세션이 "마을 우선(#62)"으로 부팅됐는가 — 그러면 모드 토글 '집'='종가 클로즈업 돌리',
  //     '마을'='부감 복귀'로 카메라 배율만 오간다(별도 씬 아님). false(?hero=0·?village=1·?shot)면 구 씬 스왑 유지.
  //   mode(파생): 마을 홈은 클로즈업=집/부감=마을, 그 외는 씬 기준.
  let sceneVillage = $state(false);
  let villageHome = $state(false);
  let villageOpts = $state({ scale: 'village', character: 'yeoyeom', includePalace: false, includeTemple: false });
  let villageSeed = $state(0);
  let villageHouses = $state(0);               // 현재 마을 호수(패널 표시)
  // focus 연속체(#92): villageEditing = 현재 focus 필지 { parcelId, spec }(focus-in START 에 설정,
  //   focus-out 완료(villageReturnDone)에 null). focusMorph(0=마을·1=집)는 카메라 focus 트윈 진행을
  //   engine 이 흘려준다 → 단일 컨텍스트 패널이 카메라와 한 클록으로 crossfade(원칙 2·3).
  let villageEditing = $state(null);           // { parcelId, spec } — focus 중 필지
  let villageZooming = $state(false);          // focus 전환(돌리) 진행 중 — 크롬 숨김 판단
  let focusMorph = $state(0);                  // 0=마을(부감)·1=집(근접) 패널 컨텍스트 모프
  let heroLanding = $state(false);             // 부팅 종가 랜딩 중(패널 숨김 — 히어로 연출)
  let waving = $state(false);                  // 리롤 웨이브 진행 중(#56 — 입력·버튼 잠금)
  let editParams = $state({});                 // { kind, frontBays, sideBays, roofPitch, eaveOverhang }
  let hoverInfo = $state(null);                // 호버 미니라벨 { spec, x, y }
  let veil = $state(false);                    // 먹 안개 트랜지션 오버레이(#46) — 마을 생성 프리징 마스킹

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
    ui.preset = s.preset; ui.time = s.time; ui.season = s.season;
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
  // 모드(파생): 마을 홈은 클로즈업(편집/줌 중)=집·부감=마을, 그 외 세션은 씬 기준(단일건물=집·마을=마을).
  let mode = $derived(
    villageHome
      ? ((villageEditing || villageZooming) ? 'house' : 'village')
      : (sceneVillage ? 'village' : 'house')
  );
  // 마을 부감: 하단 peek 옵션 시트 위로 액션바를 올림.
  let villageAerial = $derived(sceneVillage && !villageEditing && !villageZooming);
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
      if (!on) { villageEditing = null; hoverInfo = null; villageHome = false; focusMorph = 0; villageZooming = false; waving = false; }
      else pullVillage();
      syncUrl();
    });
    engine.on('villageHover', (h) => { hoverInfo = h; });
    // focus-in START(클릭·줌 연속체·토글·리플레이·랜딩) — 스펙 선전달(#92)로 패널이 돌리 중 집 컨텍스트로
    //   모프하기 시작한다(도착 대기 없음). editParams 를 즉시 시드해 슬라이더가 렌더값에서 출발.
    engine.on('villageSelectStart', (p) => {
      hoverInfo = null; villageZooming = true;
      if (p && p.spec) { seedEdit(p); }
      chromaFaded = false;
    });
    // 카메라 focus 트윈 진행 → 패널 컨텍스트 모프(같은 클록, 원칙 3).
    engine.on('villageFocusMorph', (k) => { focusMorph = k; });
    engine.on('villageSelect', (p) => {
      villageZooming = false; heroLanding = false; focusMorph = 1;
      seedEdit(p);
      chromaFaded = false;
    });
    // focus-out START — 패널은 집 컨텍스트를 유지한 채 모프가 역행(villageFocusMorph 가 1→0).
    engine.on('villageReturn', () => { villageZooming = true; hoverInfo = null; });
    // focus-out 완료(부감 도착) — 집 컨텍스트 해제, 마을 섹션만.
    engine.on('villageReturnDone', () => { villageEditing = null; villageZooming = false; focusMorph = 0; });
    // 리롤 웨이브(#56): 진행 중 입력·버튼 잠금, 완료 시 호수·URL 갱신.
    engine.on('villageWave', (w) => { waving = w.phase === 'start'; if (w.phase === 'done') { pullVillage(); syncUrl(); chromaFaded = false; } });
    engine.on('villageSeed', (s) => { villageSeed = s; pullVillage(); syncUrl(); });

    // 초기 설정: seed 기반 + URL 명시 오버라이드.
    const cfg = configFromSeed(url.seed);
    if (!url.hasSeed && !url.time) cfg.time = FLAGSHIP_TIME;
    if (url.preset && PRESETS[url.preset]) { cfg.preset = url.preset; cfg.params = paramsFor(url.preset); overrides.preset = true; }
    if (url.time) { cfg.time = url.time; overrides.time = true; }
    if (url.season) { cfg.season = url.season; overrides.season = true; }
    if (url.weather) { cfg.weather = url.weather; overrides.weather = true; }
    ui.seed = url.seed;

    // 오토로테이션 복원: shot 에서는 항상 비활성(결정론). flowsec 은 검증용 간격 오버라이드.
    shot = url.shot;
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
    // 랜딩. villageHome 세션은 모드 토글이 종가 클로즈업↔부감 배율만 오간다. ?shot·?hero=0·?village=1
    // 은 기존 계약(단일건물 부팅·직행 부감) 그대로 — villageHome 아님.
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
      engine?.dispose();
    };
  });

  function onKey(e) {
    if (e.key !== 'Escape') return;
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
    const onDone = () => { scheduleFlowTick(); };
    if (villageHome) { heroLanding = true; engine.village.enterHero({ ...villageOpts }, villageSeed, { onDone }); }
    else engine.hero.enter({ onDone });
    setTimeout(() => { heroVisible = false; }, 900);
  }
  // 리플레이(#59·#92 일반화): 현재 focus 중인 필지를 다시 조립. 액션바 再 도장에서 호출(focus 중일 때만 노출).
  function replayFocus() { if (sceneVillage && villageEditing) { engine.village.replay(); chromaFaded = false; scheduleFlowTick(); } }
  function reroll() {
    if (rerollCooldown || waving) return;
    rerollCooldown = true;
    setTimeout(() => (rerollCooldown = false), 500);
    // 마을: 리롤 웨이브(#56) — 부감 유지·연출 재구성. focus 중이면 웨이브가 focus-out 후 진행하도록 먼저 복귀.
    if (sceneVillage) { rerollVillage(); return; }
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

  // 환경 적용 원자 연산(엔진 호출 + 오버라이드 표시). 수동 setter·오토로테이션이 공유.
  function applyTime(v) { engine.setTime(v); overrides.time = true; }
  function applySeason(v) { engine.setSeason(v); overrides.season = true; }
  function applyWeather(v) { engine.setWeather(v); overrides.weather = true; }

  // 수동 조작(다이얼 드래그·리롤은 onTime/onSeason/onWeather 로 이 경로를 탄다) → 타이머만 리셋,
  // 모드는 유지(흐르는 중이면 다음 전진까지 다시 10초, 꺼져 있으면 무동작).
  function setTime(v) { applyTime(v); syncUrl(); scheduleFlowTick(); }
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
    veil = true;
    await tick();
    // 오버레이 opacity 1 도달까지 대기(CSS 트랜지션) — 이후에 생성해야 프리징이 안 보인다.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 260));
    try { fn(); } finally {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      veil = false;
    }
  }
  function toggleMode(target) {
    if (waving) return;                       // 리롤 웨이브 중 배율 전환 잠금(#56)
    if (villageHome) {
      // 마을 홈(#59): 별도 씬이 아니라 카메라 배율만 오간다. '집'=종가 클로즈업 돌리, '마을'=부감 복귀.
      if (target === 'house') engine.village.focusHero();
      else engine.village.return();
      return;
    }
    // 구 세션(?hero=0 단일건물 홈·?village=1): 마을 진입/이탈 씬 스왑. 마을 안 클로즈업 중 '마을'=부감 복귀.
    if (target === 'village') {
      if (sceneVillage) { engine.village.return(); return; }
      // 사전 생성분이 준비됐으면 즉시 진입(프리징 없음), 아니면 먹 안개로 생성을 마스킹.
      if (engine.village.isReady({ ...villageOpts }, villageSeed)) engine.village.enter({ ...villageOpts }, villageSeed);
      else withVeil(() => engine.village.enter({ ...villageOpts }, villageSeed));
    } else if (sceneVillage) engine.village.exit();
  }
  function setScale(s) {
    villageOpts.scale = s;
    // 궁은 도성 규모(capital·hanyang)만. hanyang 은 궁 기본 ON(도성=궁성), 그 외 도성 미만은 OFF.
    if (s === 'hanyang') villageOpts.includePalace = true;
    else if (s !== 'capital') villageOpts.includePalace = false;
    withVeil(() => { engine.village.setOpts({ ...villageOpts }); pullVillage(); syncUrl(); });
  }
  // character(민촌/여염/반촌) 셀렉터는 폐지(사용자 지시) — UI 미노출, villageOpts.character 는 내부 기본값(yeoyeom) 유지.
  function togglePalace() {
    if (villageOpts.scale !== 'capital' && villageOpts.scale !== 'hanyang') return;
    villageOpts.includePalace = !villageOpts.includePalace;
    withVeil(() => { engine.village.setOpts({ ...villageOpts }); pullVillage(); syncUrl(); });
  }
  function toggleTemple() { villageOpts.includeTemple = !villageOpts.includeTemple; withVeil(() => { engine.village.setOpts({ ...villageOpts }); pullVillage(); syncUrl(); }); }

  // 집 편집(#48·#69): 편집값을 스키마(edit-schema)로 어댑터 rebuildParcel 계약에 라우팅. 라이브 전략은
  //   family 로 갈린다 — 정규 필지(가벼운 단일 집)는 드래그 중 rAF 병합 라이브(#69 즉각 변형),
  //   특수 컴파운드(종가·관아, buildParcel 통짜라 무거움)는 드래그 중 값 라벨만, 놓을 때 재생성(성능 규율).
  // focus 필지 컨텍스트/편집값 시드(#92·#93). editParams 는 focus 중 그 필지의 단일 진실원 —
  //   같은 필지의 재-emit(도착·리플레이·전환 중 편집)에선 재시드하지 않아야 편집이 보존된다. 재시드하면
  //   spec.params(기본값)로 덮여 "지오는 편집 상태인데 패널 숫자는 기본값 고정"(critic-focusv2 desync)이 난다.
  //   필지가 바뀔 때만(또는 최초) 기본값으로 시드. 특수 컴파운드(종가·관아·궁) 커밋 경로도 이 진실원을 공유.
  function seedEdit(p) {
    const changed = !villageEditing || villageEditing.parcelId !== p.parcelId;
    villageEditing = { parcelId: p.parcelId, spec: p.spec };
    if (changed) editParams = { kind: p.spec.kind, ...(p.spec.params || {}) };
  }
  // 특수 컴파운드(종가·관아 hero + 궁 palace-compound)는 buildParcel/buildPalaceCompound 통짜라 무거워
  //   드래그 라이브 재생성 금지 — 값 라벨만 라이브, 놓을 때(commit) 재생성.
  const isSpecialCompound = (spec) => !!spec && (spec.hero || spec.family === 'palace-compound');
  let liveRaf = null, liveLast = 0;
  // 라이브 재생성 최소 간격 — 재생성(~12ms)을 매 프레임 태우면 focus 뷰 후처리(rim/bloom/DoF/flare)
  //   렌더와 합쳐 프레임이 눌린다. 재생성 케이던스를 렌더에서 분리(~22Hz)해 사이 프레임은 렌더만 —
  //   변형은 여전히 라이브로 읽히되 파이프라인이 숨을 쉰다(#69 부드러움). 값 라벨은 항상 즉시.
  const LIVE_MIN_MS = 45;
  function pushRebuild() {
    if (!villageEditing) return;
    engine.village.rebuild(villageEditing.parcelId, buildRebuildPayload(villageEditing.spec, editParams));
  }
  function scheduleLive() {
    if (liveRaf != null) return;                   // rAF 1회 병합(드래그 이벤트 폭주 흡수)
    liveRaf = requestAnimationFrame(() => {
      liveRaf = null;
      if (performance.now() - liveLast < LIVE_MIN_MS) { scheduleLive(); return; }  // 아직 이르면 다음 프레임(값은 최신 editParams)
      liveLast = performance.now();
      pushRebuild();
    });
  }
  function villageLive(k, v) {
    editParams[k] = v;
    if (isSpecialCompound(villageEditing?.spec)) return;   // 특수 컴파운드(종가·관아·궁): 값 라벨만 라이브, 놓을 때 재생성
    scheduleLive();
  }
  function villageCommit(k, v) {
    editParams[k] = v;
    if (liveRaf != null) { cancelAnimationFrame(liveRaf); liveRaf = null; }
    pushRebuild();
  }
  function villageSetType(kind) { villageCommit('kind', kind); }
  function closeVillageEdit() { engine.village.return(); }
</script>

<div class="stage" bind:this={container}></div>

{#if heroVisible}
  <Hero onEnter={enterHero} leaving={heroLeaving} />
{/if}

<!-- 먹 안개 트랜지션(#46): 마을 생성 프리징을 가리는 수묵 크로스페이드 오버레이. -->
<div class="veil" class:on={veil} aria-hidden="true"></div>

<ModeToggle {mode} onToggle={toggleMode} />

<div class="chroma" class:faded={chromaFaded && !heroVisible}>
  {#if !hideSeal}<SealLabel seed={ui.seed} onInfo={() => { refOpen = true; chromaFaded = false; }} />{/if}
  <EnvironmentDial
    time={ui.time} season={ui.season} weather={ui.weather}
    shifted={ui.selected && !sheetLayout}
    flowing={flowing}
    onTime={setTime} onSeason={setSeason} onWeather={setWeather}
    onFlowToggle={toggleFlow}
  />
  {#if !hideActions}
    <ActionBar
      onReroll={reroll} onPostcard={postcard} onToggleAudio={toggleAudio}
      onReplay={sceneVillage && villageEditing ? replayFocus : null}
      audioOn={audioOn} busy={rerollCooldown || waving}
      raised={sheetLayout && villageAerial}
      shifted={ui.selected && !sheetLayout}
    />
  {/if}
</div>

{#if sceneVillage}
  <!-- 단일 컨텍스트 패널(#92): 마을(부감)·집(근접) 섹션이 한 패널 안에서 focusMorph 로 crossfade.
       히어로 랜딩 중엔 숨김(연출). 브레드크럼 '마을' 클릭 = focus-out. -->
  <ContextPanel
    open={!heroLanding}
    morph={focusMorph}
    detent={focusMorph >= 0.5 ? 'half' : 'peek'}
    scale={villageOpts.scale}
    includePalace={villageOpts.includePalace}
    includeTemple={villageOpts.includeTemple}
    houses={villageHouses}
    onScale={setScale}
    onPalace={togglePalace}
    onTemple={toggleTemple}
    onReroll={rerollVillage}
    waving={waving}
    spec={villageEditing?.spec}
    params={editParams}
    onType={villageSetType}
    onLive={villageLive}
    onCommit={villageCommit}
    onBack={closeVillageEdit}
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

<style>
  .stage { position: fixed; inset: 0; z-index: 0; }
  .chroma { transition: opacity 0.9s ease; }
  .chroma.faded { opacity: 0; pointer-events: none; }

  /* 먹 안개 트랜지션(#46) — 한지 바탕 수묵 크로스페이드. 생성 프리징을 덮어 튐/프리즈를 은닉. */
  .veil {
    position: fixed; inset: 0; z-index: 400; pointer-events: none; opacity: 0;
    transition: opacity 0.24s ease;
    background-image:
      var(--hanji),
      radial-gradient(130% 110% at 50% 42%, #f4efe4 0%, #ece4d4 55%, #e0d5c2 100%);
  }
  .veil.on { opacity: 1; pointer-events: auto; }
</style>
