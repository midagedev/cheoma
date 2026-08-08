import { FAST_CHECK_PATHS } from './fast-checks.mjs';
import { gateCommand } from './verification-gates.mjs';
import { isApiReuseDependency } from './verification-impact.mjs';

const FULL_GATES = Object.freeze([
  'core', 'app', 'ui-shell', 'entry', 'petals', 'particle-geometry', 'instance-upload', 'building-lifecycle', 'api-reuse', 'yard-life', 'winter-app', 'worker', 'audio',
  'temple-browser', 'dof-app', 'aa', 'lod-focus', 'lod-wave', 'rim', 'cloud-fade', 'parcel-rebuild-browser',
  'mja-house-browser', 'surface-browser', 'cinematic-app', 'build',
]);

const DOC_PATH = /^(?:docs\/|refs\/|README\.md$|AGENTS\.md$|CLAUDE\.md$|SANSA-HANDOFF\.md$|LICENSE(?:\.|$))/;
const ROOT_HTML = /^[^/]+\.html$/;
// New code normally fails closed. These paths are the reviewed exception for
// #107–#108, #113–#114, #128, and #131: the platform adapters, portable semantic
// state, first-scene guide, keyboard navigation, sijeon, and yard-life boundaries have
// dedicated contracts below.
const REVIEWED_NEW_PATHS = new Set([
  'app/src/components/SceneGuide.svelte',
  // #158 three-axis UI: the breadcrumb succeeds ModeToggle and the shell gate
  // owns the geometry contract that let P1–P5 survive to release.
  'app/src/components/Breadcrumb.svelte',
  // #216 focus exterior glossary: pure layout anchors + DOM overlay (no WebGL draws).
  'app/src/components/GlossaryOverlay.svelte',
  'src/layout/glossary-plan.js',
  'src/api/glossary-plan.js',
  'tools/check-glossary-plan.mjs',
  'tools/check-ui-shell.mjs',
  'app/src/lib/scene-snapshot.js',
  'app/src/lib/scene-guide.js',
  'app/src/lib/building-navigation.js',
  'app/src/lib/share-scene.js',
  'app/src/lib/standalone-param-spec.js',
  'app/src/engine/semantic-view-runtime.js',
  'src/api/environment-state.js',
  // 오디오 순수 정책 경계(#BGM): 트랙 선택·진입 뮤트 복원은 브라우저 없이 판정되고
  // tools/check-audio-policy.mjs 가 core 게이트에서, 실 컨텍스트 게인은 audio 게이트가 소유한다.
  // 위치성 SFX 앵커(개울·풍경) 산술도 같은 pure 게이트가 소유한다.
  'src/audio/track-policy.js',
  'src/audio/intro-policy.js',
  'src/audio/anchors.js',
  'tools/check-audio-policy.mjs',
  // #150-M: Three-free explore/focus/hop/focusOut/wave/exit reducer + event trace
  // before any large engine.js split. Zoom distance stays orthogonal (optics).
  'src/camera/view-lifecycle.js',
  'tools/check-view-lifecycle.mjs',
  // #31 마을 대기(fog) 거리 밴드. 카메라 거리 파생 순수 산술이라 브라우저 없이 판정되고
  //   tools/check-village-fog-band.mjs 가 core 게이트에서 소유한다(REACH 회귀 픽스처 포함).
  'src/env/village-fog-band.js',
  'tools/check-village-fog-band.mjs',
  'src/env/msaa-render-pass.js',
  'src/env/bokeh-coc-contract.js',
  'src/env/bokeh-coc-pass.js',
  'src/env/bokeh-coc-shaders.js',
  // #219 / look-audit U4: pure seasonal ground carpet plan + InstancedMesh litter renderer.
  // Core gate owns placement/budget; petals/particle-geometry own falling particles; shoot:seasons is visual.
  'src/env/season-ground-plan.js',
  'src/env/season-ground-carpet.js',
  'tools/check-season-ground-contract.mjs',
  'tools/shoot-seasons.mjs',
  'tools/check-aa.mjs',
  'tools/shoot-aa.mjs',
  'tools/shoot-dpr.mjs',
  'tools/shoot-dof-layers.mjs',
  'src/api/auxiliary-building.js',
  'src/api/auxiliary-building-plan.js',
  'src/api/drainage.js',
  'src/api/drainage-plan.js',
  'src/api/dangsan.js',
  'src/api/dangsan-plan.js',
  'src/api/mud-wall.js',
  'src/api/mud-wall-plan.js',
  'src/api/mja-house.js',
  'src/api/mja-house-plan.js',
  'src/api/sijeon.js',
  'src/api/sijeon-plan.js',
  'src/api/yard-life.js',
  'src/api/yard-life-plan.js',
  'src/api/village-options.js',
  'src/generators/village/sijeon.js',
  'src/generators/village/yard-life.js',
  'src/generators/village/yard-life-geometry.js',
  'src/generators/village/yard-life-product.js',
  'src/builder/choga-frame-plan.js',
  'src/builder/giwa-middle-gate.js',
  // #150 C pure roof rank / palace-ornament policy for magistracy·city-gate·giwa.
  'src/builder/roof-rank.js',
  'tools/check-roof-rank-contract.mjs',
  // 용마루 형태 계약(2026-08-05): 팔작 ridge 유도 + 궁 부속 소채 맞배 위계. FAST_CHECKS 순수.
  'tools/check-roof-ridge.mjs',
  'src/runtime/village/yard-life.js',
  'src/layout/giwa-roof-envelope.js',
  'src/layout/giwa-through-passage.js',
  'src/village/sijeon-plan.js',
  'src/village/auxiliary-building-geometry.js',
  'src/village/auxiliary-building-plan.js',
  'src/village/drainage-plan.js',
  'src/village/drainage-geometry.js',
  'src/village/dangsan-plan.js',
  'src/village/dangsan-geometry.js',
  'src/village/mud-wall-geometry.js',
  'src/village/mud-wall-surface-plan.js',
  'src/village/mja-house-geometry.js',
  'src/village/mja-house-plan-contract.js',
  'src/village/mja-house-plan-core.js',
  'src/village/mja-house-plan.js',
  'src/village/yard-life-plan.js',
  'src/village/yard-life-record-contract.js',
  'src/village/options.js',
  'tools/check-scene-snapshot.mjs',
  'tools/check-auxiliary-building-geometry.mjs',
  'tools/check-auxiliary-building-plan.mjs',
  'tools/check-drainage-plan.mjs',
  // #20 R4: 개천 관류·종로 불침범·수문(오간수문) 순수 계약. FAST_CHECKS 소속이라 어떤
  // 라우팅에서도 함께 돌고, 브라우저를 쓰지 않는다(성곽 형상 캡처는 shoot:hanyang 이 소유).
  'tools/check-creek.mjs',
  // Phase B 호안: 계획은 위와 같은 순수 계약이 보고, **형상 조립**은 재질 주입으로 노드에서 돈다
  // (props 캔버스 텍스처를 만들지 않는다). 지오메트리 null 속성 회귀는 순수 plan 게이트가 못 잡는다.
  'src/village/creek-bank-plan.js',
  'src/village/creek-bank-geometry.js',
  'src/api/creek-bank-plan.js',
  'src/api/creek-bank.js',
  'tools/check-creek-bank-geometry.mjs',
  'tools/check-dangsan-plan.mjs',
  'tools/check-surface-browser-suite.mjs',
  'tools/check-mud-wall-contract.mjs',
  // #150 F: pure padY / skirt / wall-foot / gateLanding coherence. FAST_CHECKS
  // owns the assertion; no browser gate required.
  'src/village/pad-landing-plan.js',
  'tools/check-pad-landing.mjs',
  'tools/check-mja-house-integration.mjs',
  'tools/check-mja-house-plan.mjs',
  'tools/check-scene-guide.mjs',
  'tools/check-api-reuse-suite.mjs',
  'tools/check-sijeon-contract.mjs',
  // #54 시전 행랑 성문 도달·간선 커버리지·문전 마당: 순수 노드 계약. FAST_CHECKS 소속이라
  // sijeon-plan/roads/plan 정적 import 폐쇄로 라우팅되고, 브라우저는 쓰지 않는다.
  'tools/check-sijeon-approach.mjs',
  'tools/check-yard-life-contract.mjs',
  // #150 item K: credits catalog metadata (id/topic/scope) + pure parse + Reference chips.
  // Browser-free; FAST_CHECKS + check:docs keep docs-only and core paths covered.
  'app/src/lib/credits-parse.js',
  'tools/check-credits-catalog.mjs',
  // 마당 소품이 실제 필지 폴리곤에 앉는다는 순수 계약. FAST_CHECKS 소속이라 어떤 라우팅에서도
  // 함께 돌고, 브라우저를 쓰지 않으므로 새 경로 실패마감 예외로 검토됐다.
  'tools/check-yard-polygon-contract.mjs',
  'tools/check-yard-proportion-contract.mjs',
  // #150-G 고샅 topology: measure-only neighbour gap analysis + FAST_CHECKS 게이트.
  // 배치를 바꾸지 않으므로 worker 골든 불필요. parcels.js 임계값 드리프트만 소스 가드.
  'src/village/gosat-topology.js',
  'tools/check-gosat-topology.mjs',
  // #20 마을 인접 수관 감쇠(부감 담장선): Three-free 순수 수식 + FAST_CHECKS 게이트.
  // forest-crunch 가 소비하고 worker 해시에 반영된다. 브라우저는 불필요.
  'src/village/forest-canopy-atten.js',
  'tools/check-forest-canopy-atten.mjs',
  // #222 scatter instanceColor 값 층화: forest 와 공유하는 Three-free 농담 축 + scatter 조립 계약.
  // 드로우콜·밀도 불변. scene 해시는 instanceColor 버퍼만큼 움직이므로 worker 재기준 대상.
  'src/village/foliage-value-stratify.js',
  'tools/check-scatter-tree-color.mjs',
  // #150 N: instance/merge scratch Matrix4 재사용 후 geometry digest·material order 불변.
  // browser-free FAST_CHECKS 게이트; 시각/export 의미 불변.
  'tools/check-instance-merge-immutability.mjs',
  // #150 L palette canvas/RNG provider: Three-free context + FAST_CHECKS gate.
  // Product path keeps browser defaults; node injects stub canvas + fixed RNG.
  'src/builder/palette-context.js',
  'tools/check-palette-provider.mjs',
  // P0 packaging (2026-08-08): plain Node loads building/plan via root three +
  // shared recording canvas stub. FAST_CHECKS owns the assertion; probe is
  // evidence-only (exit 0 always) and must not fail closed to check:full alone.
  'tools/check-node-core.mjs',
  'tools/lib/node-canvas-stub.mjs',
  'tools/probe-node-glb.mjs',
  // P1 packaging (2026-08-08): plan JSON schema doc inventory + cheoma CLI
  // (plan/inspect/validate). FAST_CHECKS pure; bin is CLI only (no browser).
  'tools/check-plan-schema-doc.mjs',
  'tools/check-cli.mjs',
  'bin/cheoma.mjs',
  'bin/lib/plan-cli.mjs',
  'docs/plan-schema.md',
// #150-J: first-person gate-aware walk solids (pure + FAST_CHECKS, no mesh-bvh).
  'src/cinematic/walk-solids.js',
  'tools/check-walk-solids.mjs',  'tools/check-building-navigation.mjs',
// #150 E temple entry sequence: pure gate|stair-apron|pass-under|court records
  // under src/temple/, owned by check:temple + temple-browser (same as plan/compound).
  'src/temple/entry-sequence.js',
  'tools/check-building-navigation.mjs',
  // Perf campaign: pure live-edit geometry/yard signatures + thatch-only path.
  // FAST_CHECKS; browser not required.
  'tools/check-live-edit-signatures.mjs',
  // #26 고쳐짓기: pure seeded morph plan/evaluator over the edit schema. The plan
  // module drives the existing live-edit rebuild path, so its browser owner is the
  // parcel-rebuild gate (routed below); the contract itself is FAST_CHECKS-pure.
  'app/src/lib/rebuild-morph.js',
  'tools/check-rebuild-morph.mjs',
  // Perf campaign product-path measure (post ON orbit/rebuild budgets). Optional
  // bench, not a merge gate — reviewed so it does not force check:full alone.
  'tools/bench-product-path.mjs',
  'tools/check-render-budget-contract.mjs',
  'tools/check-share.mjs',
  'tools/shoot-sijeon.mjs',
  'tools/shoot-sijeon-app.mjs',
  'tools/shoot-thatch.mjs',
  'tools/shoot-yard-life.mjs',
  'tools/shoot-yard-life-app.mjs',
  'tools/mud-wall-surface-harness.html',
  'tools/shoot-mud-wall.mjs',
  'tools/shoot-mja-house.mjs',
  'tools/shoot-drainage.mjs',
  'tools/shoot-brush-fence.mjs',
  'tools/lib/render-budget-contract.mjs',
  // #253–#261 viral clip stages: pure preset contract + OS-recording capture.
  'src/share/clip-stage.js',
  'src/api/clip-stage.js',
  'tools/check-clip-stage.mjs',
  'tools/shoot-clip-stages.mjs',
  'docs/clip-stages.md',
  // #22 카메라 전환 연속성: 뷰 시프트 스프링·줌 범위 핸드오프의 순수 계약. 대상 런타임
  // (view-shift / village-camera-runtime)은 이미 'camera runtime changed' 로 라우팅된다.
  'tools/check-camera-continuity.mjs',
  // #30 감상 모드(드론·도보) 캡처 하네스 — 판정 없는 프레임·수치 수집 전용, 게이트 아님
  // (shoot-clip-stages 와 같은 캡처-온리 라우팅).
  'tools/shoot-cine.mjs',
  // #35-1 부감·시네마틱 역광 림 마스터/거리 밴드. 정책 분리와 밴드 산술은 브라우저 없이
  //   판정되고 tools/check-rim-master.mjs 가 core 게이트에서 소유한다(실측 부감 거리 픽스처 포함).
  //   shoot-rim-aerial 은 살아 있는 유니폼·프로그램 델타·OFF/ON 프레임을 남기는 캡처-온리다.
  'tools/check-rim-master.mjs',
  'tools/shoot-rim-aerial.mjs',
  // #35-R2 대기 워시·부감 돔 구배 계약. fog 의 선형 mix 와 돔 알파 램프는 해석적으로 재현되므로
  //   브라우저 없이 판정되고 tools/check-fog-wash.mjs 가 core 게이트에서 소유한다
  //   (네 노을 프로필 전부를 회귀 픽스처로 들고 있다).
  'tools/check-fog-wash.mjs',
  // #53 천체 계약(S1 태양 원반·S2 달 위상·S3 별·은하수·SUN_BAND 밤 배율). celestial.js 는
  //   Three/DOM 무의존이라 tools/check-celestial.mjs 가 core 게이트에서 소유한다. sky.js 배선
  //   정합과 atmosphere-profiles 시간대 페이드도 같은 순수 게이트가 읽는다.
  'src/env/celestial.js',
  'tools/check-celestial.mjs',
  // #53 S6 구름 실루엣 다양성(위상·비유사도·미러·위계·wisp·예산). 게이트가 esbuild 로
  //   clouds.js 를 즉석 번들해 브라우저 없이 판정하므로 tools/check-cloud-silhouette.mjs 가
  //   core 게이트에서 소유한다(정적 import 폐쇄에 잡히지 않아 EXACT_IMPACT 가 병행).
  'tools/check-cloud-silhouette.mjs',
  // #53 구름 부감 페이드 HDR 림 잔존("펜선") — 브라우저 게이트. browserToolGates 가
  //   cloud-fade 를 소유하고, clouds.js 변경은 아래 env 라우팅으로 같은 게이트를 끈다.
  'tools/check-cloud-fade-residue.mjs',
  // #38 픽셀 분석 공용 라이브러리와 같은 부팅 A/B 하네스. 라이브러리는 node 내장 zlib 만 쓰는
  //   순수 코드라 tools/check-pixel-stats.mjs 가 core 게이트에서 소유하고(합성 픽스처 왕복 단언),
  //   shoot-ab 는 판정 없는 캡처-온리다(shoot-cine·shoot-rim-aerial 과 같은 라우팅).
  'tools/lib/pixel-stats.mjs',
  'tools/check-pixel-stats.mjs',
  'tools/shoot-ab.mjs',
  // #36 드론 투어 셰이더 링크 히치: 투어 시작 warm 이후 투어 전 구간 프로그램 증가 0 을
  //   단언하는 브라우저 게이트. cinematic-app 그룹이 소유한다(warm 경로는 engine.js 소유).
  'tools/check-cine-warm.mjs',
  // #21 R5 궁·관아 위계: 광장·축선·궁장·관아 슬롯의 순수 계획 계약 — core 가 소유한다.
  'tools/check-palace-precinct.mjs',
]);

function add(gates, ...items) {
  for (const item of items) gates.add(item);
}

function routePath(path) {
  const gates = new Set();
  const reasons = [];
  const select = (reason, ...items) => {
    add(gates, ...items);
    reasons.push(reason);
  };

  if (isApiReuseDependency(path) || path.startsWith('examples/api-building/')) {
    select('standalone public building dependency changed', 'api-reuse');
  }

  if (DOC_PATH.test(path)) {
    select('documentation only', 'docs');
    return { gates, reasons };
  }

  if (path === '.gitignore') {
    select('change-discovery and worktree hygiene changed', 'core');
    return { gates, reasons };
  }

  if (/^(?:package(?:-lock)?\.json|app\/package(?:-lock)?\.json|app\/vite\.config\.js)$/.test(path)) {
    return { full: true, reasons: ['dependency or build configuration changed'] };
  }
  if (path === 'src/api/index.js') {
    return { full: true, reasons: ['public aggregate API changed'] };
  }
  if (path === 'audio.html' || path.startsWith('src/audio/') || path === 'src/api/audio.js') {
    select('audio boundary changed', 'app', 'audio');
    return { gates, reasons };
  }
  if (path === 'src/main.js' || ROOT_HTML.test(path)) {
    return { full: true, reasons: ['standalone entrypoint requires the full matrix'] };
  }
  if (path === 'tools/check-share.mjs' || path === 'tools/check-scene-snapshot.mjs') {
    select('scene-share pure contract changed', 'share');
    return { gates, reasons };
  }
  // #38 픽셀 통계 공용 라이브러리. 브라우저를 쓰지 않고, 소유 계약이 core 의 fast check 이므로
  //   `tools/` 폐쇄 낙하(full 승격) 대신 그 계약만 다시 돌린다.
  if (path === 'tools/lib/pixel-stats.mjs') {
    select('shared pure pixel-statistics library changed; its contract is a core fast check', 'core');
    return { gates, reasons };
  }
  if (FAST_CHECK_PATHS.includes(path) || path === 'tools/plan-contract.json') {
    select('browser-free contract changed; run it through impacted core routing', 'core');
    return { gates, reasons };
  }
  const browserToolGates = {
    'tools/check-app-smoke.mjs': ['app'],
    'tools/check-ui-shell.mjs': ['ui-shell'],
    'tools/check-entry-responsiveness.mjs': ['entry'],
    'tools/check-detail-particle-geometry.mjs': ['particle-geometry'],
    'tools/check-instance-upload-browser.mjs': ['instance-upload'],
    'tools/check-building-texture-lifecycle.mjs': ['building-lifecycle'],
    'tools/check-api-reuse-example.mjs': ['api-reuse'],
    'tools/check-api-reuse-suite.mjs': ['api-reuse'],
    'tools/verify-petals.mjs': ['petals'],
    'tools/shoot-seasons.mjs': ['petals'],
    'tools/check-winter-app.mjs': ['winter-app'],
    'tools/check-worker-contract.mjs': ['worker'],
    'tools/check-audio.mjs': ['audio'],
    'tools/check-temple-browser.mjs': ['temple-browser'],
    'tools/shoot-mja-house.mjs': ['mja-house-browser'],
    'tools/check-parcel-rebuild-browser.mjs': ['parcel-rebuild-browser'],
    'tools/check-surface-materials-browser.mjs': ['surface-browser'],
    'tools/check-dof-app.mjs': ['dof-app'],
    'tools/check-aa.mjs': ['aa'],
    'tools/shoot-aa.mjs': ['aa'],
    'tools/shoot-dpr.mjs': ['aa'],
    'tools/shoot-bokeh-fixture.mjs': ['bokeh-fixture'],
    'tools/shoot-bokeh-scatter-proof.mjs': ['bokeh-fixture'],
    'tools/lib/bokeh-gpu-diagnostic.mjs': ['bokeh-fixture'],
    'tools/lib/bokeh-image-analysis.mjs': ['bokeh-fixture'],
    'tools/lib/bokeh-linear-sweep.mjs': ['bokeh-fixture'],
    'tools/lib/bokeh-optical-chart.mjs': ['bokeh-fixture'],
    'tools/lib/bokeh-scatter-proof.mjs': ['bokeh-fixture'],
    'tools/lib/bokeh-source-stress.mjs': ['bokeh-fixture'],
    'tools/check-rim-facing.mjs': ['rim'],
    'tools/check-cloud-fade-residue.mjs': ['cloud-fade'],
    'tools/check-surface-browser-suite.mjs': ['surface-browser'],
    'tools/shoot-hanyang.mjs': ['app'],
    'tools/shoot-wall-steps.mjs': ['app'],
    'tools/mud-wall-surface-harness.html': ['surface-browser'],
    'tools/shoot-mud-wall.mjs': ['app', 'surface-browser'],
    'tools/shoot-drainage.mjs': ['app', 'surface-browser'],
    'tools/shoot-brush-fence.mjs': ['surface-browser'],
    'tools/shoot-sijeon.mjs': ['app', 'api-reuse'],
    'tools/shoot-sijeon-app.mjs': ['app', 'api-reuse'],
    'tools/shoot-yard-life.mjs': ['yard-life'],
    'tools/shoot-yard-life-app.mjs': ['app', 'yard-life'],
    'tools/shoot-thatch.mjs': ['app'],
    'tools/check-lod-app.mjs': ['lod-focus', 'lod-wave'],
    'tools/lib/render-budget-contract.mjs': ['lod-focus'],
    'tools/check-cinematic-reveal-app.mjs': ['cinematic-app'],
    'tools/check-cine-warm.mjs': ['cinematic-app'],
    'tools/check-app-build.mjs': ['build'],
    // #30 감상 모드 캡처 하네스 — 판정 없는 프레임·수치 수집 전용이라 소유 게이트가 없다
    // (빈 배열이라도 이 맵에 있어야 아래 tools/ 폐쇄 낙하를 타지 않는다).
    'tools/shoot-cine.mjs': [],
    // #35-1 부감 역광 림 증거 수집기 — 같은 캡처-온리 라우팅(수치 계약은 check-rim-master).
    'tools/shoot-rim-aerial.mjs': [],
    // #38 같은 부팅 A/B 표준 하네스 — 판정하지 않고 A/B 쌍·MANIFEST·차분 통계만 남긴다.
    'tools/shoot-ab.mjs': [],
  };
  if (browserToolGates[path]) {
    select('existing browser contract changed; run its owning gate', ...browserToolGates[path]);
    return { gates, reasons };
  }
  if (path.startsWith('tools/')) {
    return { full: true, reasons: ['verification implementation changed'] };
  }

  if (path.startsWith('examples/api-building/')) {
    return { gates, reasons };
  }

  if (path === 'app/index.html' || path.startsWith('app/src/') || path.startsWith('app/public/')) {
    select('application surface changed', 'app', 'build');
    // #158: the three-axis chrome owns its own geometry/reachability contract.
    // Route only the paths that can move a chrome box, not the engine runtimes.
    if (path === 'app/src/App.svelte'
      || path.startsWith('app/src/components/')
      || path.startsWith('app/src/styles/')
      || /^app\/src\/lib\/(?:device\.svelte|edit-schema|building-navigation|i18n\.svelte|scene-guide)\.js$/.test(path)) {
      select('UI shell layout surface changed', 'ui-shell');
    }
    // #16: the hero title is the first interactive surface and had no coverage at all.
    // Its owners are the title itself, the App action that starts the entry, and the
    // engine call that used to build the village inside the click handler.
    if (path === 'app/src/App.svelte'
      || path === 'app/src/components/Hero.svelte'
      || path === 'app/src/engine/engine.js') {
      select('hero entry responsiveness surface changed', 'entry');
    }
    if (/^app\/src\/lib\/(?:scene-snapshot|share-scene|standalone-param-spec|url)\.js$/.test(path)
      || path === 'app/src/engine/semantic-view-runtime.js') {
      select('scene-share canonical URL or platform adapter changed', 'share');
    }
    if (/^app\/src\/(?:components\/EnvironmentDial\.svelte|engine\/engine\.js|lib\/seed\.js)$/.test(path)) {
      select('winter environment integration changed', 'winter-app');
    }
    if (/^app\/src\/(?:App\.svelte|components\/ContextPanel\.svelte|engine\/engine\.js|lib\/(?:live-edit-scheduler|rebuild-morph)\.js)$/.test(path)) {
      select('focused rebuild surface changed', 'parcel-rebuild-browser');
    }
    if (path === 'app/src/engine/engine.js') {
      select('engine integration changed', 'dof-app', 'lod-focus', 'lod-wave');
    }
    if (/^app\/src\/engine\/(?:post-runtime|post-quality-runtime|scene-runtime)\.js$/.test(path)) {
      select('post/scene runtime changed', 'dof-app');
    }
    // pixelRatio 상한과 MSAA 샘플 프로파일이 여기서 정해진다 — AA 축을 함께 돌린다.
    if (/^app\/src\/engine\/(?:engine|post-runtime|scene-runtime)\.js$/.test(path)) {
      select('composer anti-aliasing or pixel-ratio profile changed', 'aa');
    }
    if (/^app\/src\/engine\/post(?:-quality)?-runtime\.js$/.test(path)) {
      select('adaptive camera quality changed', 'lod-focus');
    }
    if (path === 'app/src/engine/directional-shadow-runtime.js') {
      select('focused directional shadow framing changed', 'rim', 'lod-focus');
    }
    if (/^app\/src\/engine\/(?:semantic-view-runtime|view-shift|village-camera-runtime)\.js$/.test(path)) {
      select('camera runtime changed', 'dof-app', 'lod-focus', 'lod-wave');
    }
    return { gates, reasons };
  }

  if (path.startsWith('src/env/') || path.startsWith('src/render/')) {
    select('environment/rendering changed', 'app');
    if (/^src\/render\/(?:material-program-key|screen-door|lod-screen-door)\.js$/.test(path)) {
      select('shared screen-door shader contract changed',
        'dof-app', 'lod-focus', 'winter-app', 'rim', 'building-lifecycle');
    }
    if (path === 'src/render/shadow-depth-texture-lifecycle.js') {
      select('building shadow texture lifecycle changed', 'building-lifecycle');
    }
    if (/^src\/env\/(?:index|mountains|paddies|seasons|sky|snow-material|terrain|trees|weather)\.js$/.test(path)) {
      select('winter surface or environment changed', 'winter-app');
    }
    if (/^src\/env\/(?:dof|post|post-quality-state|msaa-render-pass|stable-bokeh-pass|circular-bokeh-shader|bokeh-coc-contract|bokeh-coc-pass|bokeh-coc-shaders|tree-occluder|inst-fade-shader|rim|present-gate)\.js$/.test(path)) {
      select('depth/post contract changed', 'dof-app');
    }
    if (/^src\/env\/(?:post|msaa-render-pass)\.js$/.test(path)) {
      select('composer anti-aliasing changed', 'aa');
    }
    if (/^src\/env\/(?:post-quality-state|stable-bokeh-pass|circular-bokeh-shader|bokeh-coc-pass|bokeh-coc-shaders)\.js$/.test(path)) {
      select('adaptive post policy changed', 'lod-focus');
    }
    if (/^src\/env\/(?:stable-bokeh-pass|circular-bokeh-shader|bokeh-highlight-prefilter|bokeh-source-contract|bokeh-source-scatter|bokeh-coc-contract|bokeh-coc-pass|bokeh-coc-shaders)\.js$/.test(path)) {
      select('compact-source bokeh changed', 'dof-app', 'lod-focus', 'bokeh-fixture');
    }
    if (/^src\/env\/(?:rim|clouds|snow-material)\.js$/.test(path)) {
      select('physical rim inputs changed', 'rim');
    }
    if (path === 'src/env/clouds.js') {
      select('cloud overhead fade HDR residue', 'cloud-fade');
    }
    if (/^src\/env\/(?:petals|weather|seasons|season-ground-plan|season-ground-carpet)\.js$/.test(path)) {
      select('seasonal particle/weather contract changed', 'petals');
    }
    if (/^src\/env\/(?:detail-particle-geometry|motes|petals|seasons|season-ground-carpet|weather|weather-particle-state|weather-physical-geometry)\.js$/.test(path)) {
      select('physical particle representation changed', 'particle-geometry');
    }
    if (path === 'src/env/petals.js') select('focus particle LOD changed', 'lod-focus');
    if (/^src\/env\/(?:weather|seasons|season-ground-plan|season-ground-carpet)\.js$/.test(path)) {
      select('wave environment synchronization changed', 'lod-wave');
    }
    if (/^src\/env\/(?:focus|animals|critters|critter-plan|grass|lantern-sway|motes|smoke|wind|season-ground-plan|season-ground-carpet)\.js$/.test(path)) {
      select('near-detail and wave-owned LOD changed', 'lod-focus', 'lod-wave');
    }
    if (/^src\/env\/(?:clouds|edge-mist-view)\.js$/.test(path)) {
      select('village atmospheric view ownership changed', 'lod-focus', 'lod-wave');
    }
    // #31 마을 fog 밴드는 카메라 거리 파생이라 부감·근접·웨이브 프레이밍이 모두 이 식을 읽는다.
    if (path === 'src/env/village-fog-band.js') {
      select('village atmospheric depth band changed', 'lod-focus', 'lod-wave', 'dof-app');
    }
    if (path === 'src/env/night-glow.js') select('wave-owned lighting changed', 'lod-wave');
    return { gates, reasons };
  }

  if (path.startsWith('src/camera/') || path.startsWith('src/cinematic/')) {
    // #150-M pure transition table: Node contract only; engine dispatch hooks live in app/.
    if (path === 'src/camera/view-lifecycle.js') {
      select('view lifecycle transition table changed');
      return { gates, reasons };
    }
    select('camera/cinematic behavior changed', 'app');
    if (path.startsWith('src/cinematic/')) select('cinematic product path changed', 'cinematic-app');
    if (path === 'src/camera/optics.js') {
      select('optical transition and pick-proxy framing changed',
        'dof-app', 'lod-focus', 'lod-wave', 'worker', 'rim', 'cinematic-app');
    }
    if (path === 'src/camera/directional-shadow-anchor.js') {
      select('focused directional shadow framing changed', 'rim', 'lod-focus');
    }
    return { gates, reasons };
  }

  if (path === 'src/village/wave.js') {
    select('exclusive scenery handoff changed', 'app', 'instance-upload', 'lod-wave');
    return { gates, reasons };
  }

  if (path.startsWith('src/village/') || path.startsWith('src/generators/')) {
    if (path === 'src/village/auxiliary-building-plan.js'
      || path === 'src/village/auxiliary-building-geometry.js') {
      select(
        'independent auxiliary placement, geometry, LOD, edit, and export ownership changed',
        'parcel-rebuild-browser', 'lod-focus', 'lod-wave',
      );
    }
    if (path === 'src/village/forest-canopy-atten.js') {
      // #20 pure canopy atten: worker/scene hashes move with forest-crunch consumers; no browser gate.
      select('village-adjacent canopy attenuation changed', 'app', 'worker');
      return { gates, reasons };
    }
    if (path === 'src/village/foliage-value-stratify.js') {
      // #222 shared value-stratify axes: forest instanceColor + scatter multiply tint.
      // Pure math; worker scene hashes move when consumers change colors.
      select('foliage value stratification axes changed', 'app', 'worker');
      return { gates, reasons };
    }
    if (path === 'src/village/mud-wall-surface-plan.js') {
      select('renderer-free bounded mud-wall surface planning changed');
      return { gates, reasons };
    }
    if (path === 'src/village/pad-landing-plan.js') {
      // #150 F: pure padY/skirt/wall-foot/gateLanding coherence. FAST_CHECKS
      // (check-pad-landing) owns the assertion; no browser gate required.
      select('renderer-free pad/skirt/gate-landing coherence contract changed');
      return { gates, reasons };
    }
    if (path === 'src/village/critter-station-plan.js') {
      // 소동물 자리는 담·대문 계약에서 파생하는 순수 계획이고, 소비자는 wave/LOD 소유의
      // post-gen 소동물 레이어 하나뿐이다(마을 생성 해시와 무관).
      select('renderer-free critter station planning changed', 'app', 'lod-focus', 'lod-wave');
      return { gates, reasons };
    }
    if (path === 'src/village/mja-house-plan.js'
      || path === 'src/village/mja-house-plan-core.js'
      || path === 'src/village/mja-house-plan-contract.js'
      || path === 'src/village/mja-house-geometry.js') {
      select(
        'opt-in enclosed-house plan, rendering, or lifecycle changed',
        'app', 'worker', 'mja-house-browser',
      );
      return { gates, reasons };
    }
    select('village generation changed', 'app', 'worker');
    if (path === 'src/village/drainage-plan.js'
      || path === 'src/village/drainage-geometry.js') {
      select('roadside drainage plan or physical surface changed', 'surface-browser');
    }
    if (path === 'src/village/dangsan-plan.js'
      || path === 'src/village/dangsan-geometry.js') {
      select('optional dangsan cultural-landscape plan or thin render changed', 'app', 'worker');
    }
    if (path === 'src/village/walls.js' || path === 'src/village/mud-wall-geometry.js') {
      select('physical packed-earth wall surface changed', 'surface-browser');
    }
    if (path === 'src/generators/village/sijeon.js') {
      select(
        'reusable sijeon rendering, material lifecycle, snow, rim, and wave contracts changed',
        'api-reuse', 'winter-app', 'rim', 'lod-wave',
      );
    }
    if (path === 'src/generators/village/yard-life.js'
      || path === 'src/generators/village/yard-life-geometry.js'
      || path === 'src/generators/village/yard-life-product.js') {
      select(
        'reusable yard-life rendering, seasonal transition, LOD, wave, and lifecycle contracts changed',
        'yard-life', 'winter-app', 'lod-focus', 'lod-wave',
      );
    }
    if (path === 'src/village/yard-life-plan.js'
      || path === 'src/village/yard-life-record-contract.js') {
      select('renderer-free yard-life planning and collision contract changed', 'yard-life');
    }
    if (path === 'src/village/yard-layout.js') {
      select('shared yard-life slot and hard-object geometry changed', 'yard-life');
    }
    if (path === 'src/village/options.js' || path === 'src/village/site.js') {
      select('portable village option meaning changed', 'share');
    }
    if (path === 'src/generators/village/roads.js') {
      select('packed-earth road rendering changed', 'surface-browser');
    }
    if (/^src\/village\/(?:parcel-rebuild|vegetation-spatial|gardens|populate)\.js$/.test(path)) {
      select('parcel rebuild planning or flora changed', 'parcel-rebuild-browser');
    }
    if (/^src\/village\/(?:chunks|instancing|impostor-spec|lod-policy)\.js$/.test(path)
      || path === 'src/generators/village/houses.js') {
      select('parcel representation changed', 'lod-focus', 'lod-wave');
    }
    if (path === 'src/village/instancing.js') {
      select('sparse parcel GPU buffers changed', 'instance-upload');
    }
    if (path === 'src/village/instancing.js') select('impostor snow surface changed', 'winter-app');
    if (/^src\/village\/(?:nightlight-physical-geometry|nightlights)\.js$/.test(path)) {
      select('physical hanji-light representation changed', 'particle-geometry', 'instance-upload');
    }
    if (path === 'src/village/nightlights.js') {
      select('wave-owned, source-depth village lighting changed', 'dof-app', 'lod-wave');
    }
    if (path === 'src/village/populate.js') select('population lifecycle changed', 'lod-focus', 'lod-wave');
    return { gates, reasons };
  }

  if (path.startsWith('src/runtime/village/')) {
    select('village runtime changed', 'app', 'worker');
    if (/^src\/runtime\/village\/(?:handle|parcel-edit|picking|fauna|ambient-field)\.js$/.test(path)) {
      select('parcel rebuild runtime changed', 'parcel-rebuild-browser');
    }
    if (/^src\/runtime\/village\/(?:detail-lod|fauna|parcel-representation|ambient-field)\.js$/.test(path)) {
      select('runtime detail and wave ownership changed', 'lod-focus', 'lod-wave');
    }
    if (/^src\/runtime\/village\/(?:lighting|night-glow|snow)\.js$/.test(path)) {
      select('runtime wave presentation changed', 'lod-wave');
    }
    if (path === 'src/runtime/village/snow.js') select('village snow controller changed', 'winter-app');
    if (path === 'src/runtime/village/create.js') select('async handle lifecycle changed', 'lod-wave');
    if (path === 'src/runtime/village/handle.js') select('village handle changed', 'lod-focus', 'lod-wave');
    if (path === 'src/runtime/village/yard-life.js') {
      select('yard-life product runtime and shared detail LOD changed', 'yard-life', 'lod-focus', 'lod-wave');
    }
    return { gates, reasons };
  }

  if (path.startsWith('src/temple/')) {
    select('reusable temple plan or assembly changed', 'app', 'worker', 'temple-browser', 'lod-focus');
    return { gates, reasons };
  }

  if (path.startsWith('src/interaction/')
    || /^src\/api\/(?:door-motion|opening-detail|residential-openings|threshold-life)\.js$/.test(path)) {
    select('residential interaction or opening contract changed', 'app', 'dof-app', 'parcel-rebuild-browser');
    return { gates, reasons };
  }

  // #216: pure focus glossary anchors — browser-free core + UI shell when the overlay surface moves.
  if (path === 'src/layout/glossary-plan.js' || path === 'src/api/glossary-plan.js'
    || path === 'tools/check-glossary-plan.mjs') {
    select('focus exterior glossary plan contract changed');
    return { gates, reasons };
  }

  // #253–#261: viral clip stage presets (pure + app boot; OS recording only).
  if (path === 'src/share/clip-stage.js' || path === 'src/api/clip-stage.js'
    || path === 'tools/check-clip-stage.mjs') {
    select('viral clip stage contract changed', 'app', 'cinematic-app');
    return { gates, reasons };
  }
  if (path === 'tools/shoot-clip-stages.mjs') {
    select('clip stage visual capture harness changed');
    return { gates, reasons };
  }

  if (/^src\/(?:builder|layout|props|anim|core|export|share)\//.test(path)
    || path === 'src/params.js' || path === 'src/rng.js') {
    select('shared generated scene content changed', 'app');
    if (!/^src\/(?:export|share)\//.test(path)) select('worker scene graph may change', 'worker');
    if (path === 'src/builder/giwa-middle-gate.js'
      || path === 'src/layout/giwa-roof-envelope.js'
      || path === 'src/layout/giwa-through-passage.js') {
      select(
        'shared giwa roof or integrated passage contract changed',
        'building-lifecycle', 'mja-house-browser',
      );
    }
    if (path.startsWith('src/builder/')) {
      select('public building resource lifecycle changed', 'building-lifecycle');
    }
    if (path === 'src/core/three-resources.js') {
      select('public building disposal primitive changed', 'building-lifecycle');
    }
    if (path === 'src/core/buffer-update-range.js') {
      select('BufferAttribute upload range ownership changed', 'instance-upload', 'lod-wave');
    }
    if (path === 'src/builder/palette.js'
      || path === 'src/builder/palette-context.js') {
      select('roof snow and rim material roles changed', 'winter-app', 'rim');
    }
    return { gates, reasons };
  }

  if (path.startsWith('src/surfaces/')) {
    select('procedural surface source or adapter changed', 'app', 'worker', 'surface-browser');
    return { gates, reasons };
  }

  if (path.startsWith('src/api/')) {
    if (path === 'src/api/glossary-plan.js') {
      select('public renderer-free focus glossary planning API changed');
      return { gates, reasons };
    }
    if (path === 'src/api/auxiliary-building-plan.js'
      || path === 'src/api/auxiliary-building.js') {
      select(
        'public auxiliary planning or borrowed-material renderer API changed',
        'app', 'worker', 'parcel-rebuild-browser', 'lod-focus', 'lod-wave',
      );
      return { gates, reasons };
    }
    if (path === 'src/api/mja-house-plan.js'
      || path === 'src/api/mja-house.js') {
      select(
        'public opt-in enclosed-house planning or renderer API changed',
        'app', 'worker', 'mja-house-browser',
      );
      return { gates, reasons };
    }
    if (path === 'src/api/drainage-plan.js') {
      select('public renderer-free roadside drainage planning API changed',
        'app', 'worker', 'surface-browser');
      return { gates, reasons };
    }
    if (path === 'src/api/drainage.js') {
      select('public physical roadside drainage renderer API changed',
        'app', 'worker', 'surface-browser');
      return { gates, reasons };
    }
    if (path === 'src/api/dangsan-plan.js') {
      select('public renderer-free dangsan planning API changed', 'app', 'worker');
      return { gates, reasons };
    }
    if (path === 'src/api/dangsan.js') {
      select('public dangsan thin renderer API changed', 'app', 'worker');
      return { gates, reasons };
    }
    if (path === 'src/api/mud-wall-plan.js') {
      select('public renderer-free mud-wall planning API changed');
      return { gates, reasons };
    }
    if (path === 'src/api/mud-wall.js') {
      select('public borrowed-material mud-wall geometry API changed',
        'app', 'surface-browser');
      return { gates, reasons };
    }
    if (path === 'src/api/sijeon.js') {
      select(
        'public sijeon renderer and lifecycle API changed',
        'app', 'api-reuse', 'winter-app', 'worker', 'rim', 'lod-wave',
      );
      return { gates, reasons };
    }
    if (path === 'src/api/sijeon-plan.js') {
      select('public renderer-free sijeon planning API changed', 'app', 'api-reuse', 'worker');
      return { gates, reasons };
    }
    if (path === 'src/api/yard-life.js') {
      select(
        'public yard-life renderer and lifecycle API changed',
        'app', 'yard-life', 'winter-app', 'worker', 'lod-focus', 'lod-wave',
      );
      return { gates, reasons };
    }
    if (path === 'src/api/yard-life-plan.js') {
      select('public renderer-free yard-life planning API changed', 'app', 'yard-life', 'worker');
      return { gates, reasons };
    }
    if (path === 'src/api/environment-state.js') {
      select('portable environment state boundary changed', 'share');
      return { gates, reasons };
    }
    if (path === 'src/api/village-options.js') {
      select('portable village option boundary changed', 'share', 'app', 'worker');
      return { gates, reasons };
    }
    if (path === 'src/api/environment.js') {
      select('environment API changed', 'app', 'dof-app', 'petals', 'winter-app', 'lod-wave');
      return { gates, reasons };
    }
    if (path === 'src/api/particles.js') {
      select('physical particle API changed', 'app', 'particle-geometry');
      return { gates, reasons };
    }
    if (path === 'src/api/particle-state.js') {
      select('pure precipitation state API changed', 'particle-geometry');
      return { gates, reasons };
    }
    if (path === 'src/api/lighting.js') {
      select('physical lighting API changed', 'app', 'particle-geometry');
      return { gates, reasons };
    }
    if (path === 'src/api/post-quality.js') {
      select('pure adaptive post API changed', 'app', 'dof-app', 'lod-focus');
      return { gates, reasons };
    }
    if (path === 'src/api/village.js') {
      select('village API changed', 'app', 'worker', 'lod-focus', 'lod-wave');
      return { gates, reasons };
    }
    if (path === 'src/api/village-plan.js') {
      select('village plan API changed', 'app', 'worker');
      return { gates, reasons };
    }
    if (path === 'src/api/temple.js' || path === 'src/api/temple-plan.js') {
      select('public temple API changed', 'app', 'worker', 'temple-browser', 'lod-focus');
      return { gates, reasons };
    }
    if (path === 'src/api/shadow-framing.js') {
      select('directional shadow framing API changed', 'app', 'rim', 'lod-focus');
      return { gates, reasons };
    }
    if (/^src\/api\/(?:building|cinematic|export|props|rendering)\.js$/.test(path)) {
      select('public feature API changed', 'app');
      if (path === 'src/api/building.js') {
        select('public building lifecycle changed', 'building-lifecycle');
      }
      return { gates, reasons };
    }
    if (/^src\/api\/surface-material(?:-plan|s)\.js$/.test(path)) {
      select('public procedural surface API changed', 'app', 'worker', 'surface-browser');
      return { gates, reasons };
    }
  }

  return { full: true, reasons: ['unmapped path fails closed'] };
}

export function normalizeVerificationPath(value) {
  if (typeof value !== 'string') throw new TypeError('verification path must be a string');
  const path = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!path || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`unsafe verification path: ${JSON.stringify(value)}`);
  }
  return path;
}

export function planVerification(paths, {
  forceFullReason = null,
  newPaths = [],
  pureChecks = ['./check-architecture.mjs'],
} = {}) {
  const files = [...new Set(paths.map(normalizeVerificationPath))].sort();
  const fileSet = new Set(files);
  const normalizedNewPaths = new Set(
    newPaths.map(normalizeVerificationPath).filter((path) => fileSet.has(path)),
  );
  const documentationOnly = files.length > 0 && files.every((path) => DOC_PATH.test(path));
  const gates = new Set(documentationOnly ? ['docs'] : ['core']);
  const routes = [];
  let fullReason = forceFullReason;

  for (const path of files) {
    const route = routePath(path);
    if (normalizedNewPaths.has(path) && !DOC_PATH.test(path) && !REVIEWED_NEW_PATHS.has(path)) {
      route.full = true;
      route.reasons.unshift('new path fails closed until its verification boundary is reviewed');
    }
    routes.push({
      path,
      full: !!route.full,
      gates: [...(route.gates || [])].sort(),
      reasons: route.reasons,
    });
    if (route.full && !fullReason) fullReason = `${path}: ${route.reasons.join(', ')}`;
    add(gates, ...(route.gates || []));
  }

  if (fullReason) {
    gates.clear();
    add(gates, ...FULL_GATES);
  }

  return {
    files,
    newPaths: [...normalizedNewPaths].sort(),
    full: !!fullReason,
    fullReason,
    gates: [...gates],
    pureChecks: documentationOnly ? [] : [...new Set(pureChecks)].sort(),
    routes,
  };
}

export function verificationCommands(plan) {
  if (plan.full) return [{ id: 'full', command: 'npm', args: ['run', 'check:full'] }];

  const commands = [];
  const has = (gate) => plan.gates.includes(gate);
  if (has('docs')) commands.push(gateCommand('docs'));
  if (has('core')) commands.push({
    id: 'core',
    command: process.execPath,
    args: ['tools/check-selected.mjs', ...(plan.pureChecks || ['./check-architecture.mjs'])],
    resource: 'cpu',
  });
  if (has('share')) commands.push({
    id: 'share',
    command: 'npm',
    args: ['run', 'check:share'],
    resource: 'cpu',
  });
  if (has('app')) commands.push(gateCommand('app'));
  if (has('ui-shell')) commands.push(gateCommand('ui-shell'));
  if (has('entry')) commands.push(gateCommand('entry'));
  if (has('dof-app')) commands.push(gateCommand('dof-app'));
  if (has('aa')) commands.push(gateCommand('aa'));
  if (has('bokeh-fixture')) commands.push(gateCommand('bokeh-fixture'));
  if (has('rim')) commands.push(gateCommand('rim'));
  if (has('cloud-fade')) commands.push(gateCommand('cloud-fade'));
  if (has('petals')) commands.push(gateCommand('petals'));
  if (has('particle-geometry')) commands.push(gateCommand('particle-geometry'));
  if (has('instance-upload')) commands.push(gateCommand('instance-upload'));
  if (has('building-lifecycle')) commands.push(gateCommand('building-lifecycle'));
  if (has('api-reuse')) commands.push(gateCommand('api-reuse'));
  if (has('yard-life')) commands.push(gateCommand('yard-life'));
  if (has('winter-app')) commands.push(gateCommand('winter-app'));
  if (has('worker')) commands.push(gateCommand('worker'));
  if (has('audio')) commands.push(gateCommand('audio'));
  if (has('temple-browser')) commands.push(gateCommand('temple-browser'));
  if (has('mja-house-browser')) commands.push(gateCommand('mja-house-browser'));
  if (has('lod-focus') && has('lod-wave')) {
    commands.push(gateCommand('lod-app'));
  } else if (has('lod-focus')) {
    commands.push(gateCommand('lod-focus'));
  } else if (has('lod-wave')) {
    commands.push(gateCommand('lod-wave'));
  }
  if (has('parcel-rebuild-browser')) {
    commands.push(gateCommand('parcel-rebuild-browser'));
  }
  if (has('surface-browser')) commands.push(gateCommand('surface-browser'));
  if (has('cinematic-app')) commands.push(gateCommand('cinematic-app'));
  if (has('build')) commands.push(gateCommand('build'));
  return commands;
}

export { FULL_GATES };
