// 같은 부팅 A/B 표준 하네스 (#38). 판정 게이트가 아니라 증거 수집기다.
//
// 왜 "같은 부팅"이 계약인가: 부감 프레이밍 트윈이 멎기 전에 찍으면 같은 규모·같은 시드라도
// 카메라→피사체 거리가 230~625m 로 흔들린다(2026-08-01 실측). 그 상태의 두 PNG 는 변인이 아니라
// 포즈가 다른 그림이므로 픽셀 비교가 성립하지 않는다. 그래서 이 도구는
//   한 부팅 → 포즈 정착 대기 → 엔진 정지 → A 캡처 → 변인만 교체 → B 캡처
// 만 한다. 실행 간 비교는 이 도구의 계약이 아니다.
//
// 변인 교체 두 방식:
//   (a) hook    — 페이지 훅 호출(검증 전용 uniform 쓰기). 셰이더 재컴파일이 없어 가장 싸고 안전하다.
//                 예: window.__rim.setMaster(0). 프로그램 수가 변하면 안 된다.
//   (b) overlay — 지정 소스 모듈을 다른 내용으로 서빙해 셰이더 코드 자체를 바꾼다.
//                 **three 프로그램 캐시 함정**: customProgramCacheKey 가 같으면 three 는 캐시된
//                 프로그램을 재사용하고 onBeforeCompile 을 다시 부르지 않는다. 그러면 교체가
//                 적용되지 않은 채 A/B 가 바이트 동일이 되어 "차이 없음"이라는 틀린 결론이 나온다.
//                 (scratchpad/rim-inversion/shoot-ab.mjs 가 이 함정을 만나 해결한 방식을 승계한다:
//                  변형 폼에서 캐시 키에 접미사를 붙여 재컴파일을 강제하고, 실제로 GLSL 이 바뀐
//                  재질 수를 세어 0 이면 던진다.)
//
// 사용:
//   node tools/run-browser-locked.mjs -- node tools/shoot-ab.mjs
//   node tools/run-browser-locked.mjs -- node tools/shoot-ab.mjs --variant rim-shader-off --scenario aerial
//   CHEOMA_AB_OUT 으로 출력 디렉터리 변경.
//
// 산출물: <out>/<scenario>-A-<form>.png · B-*.png, MANIFEST.md(카메라 수치·프로그램 수·적용 재질 수),
//         diff.json(tools/lib/pixel-stats.mjs 로 뽑은 차분·색 통계).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { launchVerificationBrowser, reportWebGLRenderer } from './lib/verification-browser.mjs';
import { band, diffStats, hueHistogram, hueStats, readPng, terciles } from './lib/pixel-stats.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const OUT = process.env.CHEOMA_AB_OUT
  || '/private/tmp/claude-501/-Users-hckim-orca-workspaces-asiahouse-starfish/ab438db7-9318-4b2b-9d67-2426f5d51f63/scratchpad/shoot-ab';
const timeout = Number(process.env.CHEOMA_AB_TIMEOUT_MS) || 180_000;

// ---------------------------------------------------------------------------
// 시나리오 — 기존 세 하네스가 실제로 쓴 프레이밍을 그대로 승계한다.
//   aerial: scratchpad/rim-inversion/shoot-ab.mjs · tools/shoot-rim-aerial.mjs 의 마을 부감 sunset
//   hero  : 같은 스크립트의 히어로 필지 focus(부감에서 focus 로 내려간 뒤 다시 정착 대기)
// ---------------------------------------------------------------------------
const SCENARIOS = {
  aerial: {
    id: 'aerial-village-sunset',
    query: 'hero=0&village=1&worker=0&seed=20260718&vseed=20260716'
      + '&vscale=village&vpalace=0&vtemple=0&time=sunset&weather=clear&season=summer&lang=ko&post=1',
    async arrive() { /* 부감이 기본 진입 프레임이다 */ },
  },
  hero: {
    id: 'hero-focus-sunset',
    query: 'hero=0&village=1&worker=0&seed=20260718&vseed=20260716'
      + '&vscale=village&vpalace=0&vtemple=0&time=sunset&weather=clear&season=summer&lang=ko&post=1',
    async arrive(page) {
      const parcelId = await page.evaluate(() => {
        const parcels = window.__engine.village.debugParcels();
        const hero = parcels.find((p) => p.hero) || parcels.find((p) => p.editable) || parcels[0];
        window.__engine.village.focus(hero.parcelId);
        return hero.parcelId;
      });
      await page.waitForTimeout(4000);
      return { parcelId };
    },
  },
};

// ---------------------------------------------------------------------------
// 변인 — A 는 항상 제품 기준(baseline), B 가 바뀐 쪽이다.
// ---------------------------------------------------------------------------
const VARIANTS = {
  // (a) hook: 유니폼만 쓴다. 프로그램 수가 변하지 않아야 하고, MANIFEST 가 그 수를 남긴다.
  'rim-master': {
    id: 'rim-master',
    mode: 'hook',
    a: { form: 'master-product', expr: 'window.__rim.setMaster(window.__abProductMaster)' },
    b: { form: 'master-0', expr: 'window.__rim.setMaster(0)' },
    async prepare(page) {
      // 제품 마스터는 컨텍스트(부감 0.75 / focus 1.0)마다 다르므로 살아 있는 값을 baseline 으로 쓴다.
      const master = await page.evaluate(() => {
        window.__abProductMaster = window.__rim.master;
        return window.__rim.master;
      });
      return { productMaster: master };
    },
  },
  // (b) overlay: 셰이더 코드를 바꾼다. rim-master 와 같은 결과(림 제거)를 셰이더 경로로 만들어
  //     "차이가 유니폼에서 왔는가 셰이더에서 왔는가"를 가르는 대조군이기도 하다.
  'rim-shader-off': {
    id: 'rim-shader-off',
    mode: 'overlay',
    module: 'src/env/rim.js',
    route: '**/src/env/rim.js*',
    // 등록 앵커: 패치된 재질을 전부 모아야 교체를 다시 걸 수 있다.
    registerAnchor: 'addMaterialProgramKey(mat, MATERIAL_PROGRAM_PATCH.PHYSICAL_RIM);',
    // GLSL 치환쌍. 원본에 없으면 스펙이 낡은 것이므로 시작 전에 던진다.
    swaps: [[
      '* _df * _dofDamp * uRimStrength * uRimScale * uRimTileMul;',
      '* _df * _dofDamp * uRimStrength * 0.0 * uRimTileMul;',
    ]],
    a: { form: 'shader-product' },
    b: { form: 'shader-rim-zero' },
  },
};

// 오버레이 프리루드 — scratchpad/rim-inversion/shoot-ab.mjs 의 훅을 치환쌍으로 일반화한 것.
// 변형 폼에서만 onBeforeCompile 을 감싸고 캐시 키에 접미사를 붙인다(위 프로그램 캐시 함정 참조).
function overlayPrelude(swaps) {
  return `
const __abMats = new Set();
if (typeof window !== 'undefined') {
  window.__abApplied = 0;
  window.__abSwap = (form) => {
    window.__abApplied = 0;
    for (const m of __abMats) {
      if (!m.__abBase) {
        m.__abBase = m.onBeforeCompile;
        m.__abBaseKey = m.customProgramCacheKey;
      }
      const base = m.__abBase;
      const baseKey = m.__abBaseKey;
      m.onBeforeCompile = form === 'variant'
        ? (s, r) => {
            base(s, r);
            const before = s.fragmentShader;
            let out = before;
            for (const [from, to] of ${JSON.stringify(swaps)}) out = out.split(from).join(to);
            s.fragmentShader = out;
            if (out !== before) window.__abApplied += 1;
          }
        : base;
      // three 는 캐시 키가 같으면 캐시된 프로그램을 재사용해 onBeforeCompile 을 다시 부르지 않는다.
      // 변형 폼은 자기 키를 가져야 실제로 다시 링크된다.
      m.customProgramCacheKey = form === 'variant'
        ? function () { return baseKey.call(this) + '|ab-variant'; }
        : baseKey;
      m.needsUpdate = true;
    }
    return { form, materials: __abMats.size };
  };
}
`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { variant: 'rim-master', scenarios: ['aerial', 'hero'] };
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split('=');
    const value = inline ?? argv[++i];
    if (key === '--variant') out.variant = value;
    else if (key === '--scenario') out.scenarios = value.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === '--out') out.out = value;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const outDir = args.out || OUT;
const variant = VARIANTS[args.variant];
if (!variant) throw new Error(`unknown variant ${args.variant} (have ${Object.keys(VARIANTS).join(', ')})`);
for (const name of args.scenarios) {
  if (!SCENARIOS[name]) throw new Error(`unknown scenario ${name} (have ${Object.keys(SCENARIOS).join(', ')})`);
}

// 오버레이 스펙의 앵커가 현재 소스에 살아 있는지 먼저 확인한다. 낡은 치환쌍으로 조용히
// "아무것도 안 바뀐 A/B" 를 만드는 것이 이 하네스가 가장 피해야 할 실패다.
let overlaySource = null;
if (variant.mode === 'overlay') {
  overlaySource = await readFile(join(ROOT, variant.module), 'utf8');
  for (const [from] of variant.swaps) {
    if (!overlaySource.includes(from)) {
      throw new Error(`variant ${variant.id}: swap anchor is stale in ${variant.module}\n  ${from}`);
    }
  }
  if (!overlaySource.includes(variant.registerAnchor)) {
    throw new Error(`variant ${variant.id}: register anchor is stale in ${variant.module}`);
  }
}

await mkdir(outDir, { recursive: true });

const notes = [];
const rows = [];
const diffs = {};

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir: join(outDir, '.vite-cache'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
const started = Date.now();
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await launchVerificationBrowser();

  for (const name of args.scenarios) {
    const scenario = SCENARIOS[name];
    console.log(`\n=== ${scenario.id} · variant ${variant.id} ===`);
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(timeout);
    page.on('pageerror', (e) => notes.push(`${name}: pageerror ${e.message.split('\n')[0]}`));

    try {
      if (variant.mode === 'overlay') {
        const prelude = overlayPrelude(variant.swaps);
        await page.route(variant.route, async (route) => {
          const response = await route.fetch();
          const body = await response.text();
          // vite 가 import 를 재작성한 뒤의 텍스트에 삽입한다(원본 텍스트가 아니다).
          if (!body.includes(variant.registerAnchor)) {
            throw new Error(`transformed ${variant.module} lost the register anchor`);
          }
          const registered = body.replace(
            variant.registerAnchor, `__abMats.add(mat);\n    ${variant.registerAnchor}`,
          );
          await route.fulfill({
            status: 200, contentType: 'text/javascript', body: `${prelude}\n${registered}`,
          });
        });
      }

      const url = `http://127.0.0.1:${port}/?${scenario.query}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      await page.waitForFunction(
        () => window.__SHOT_READY === true && window.__engine?.village?.getState()?.active === true,
        null, { timeout },
      );
      await reportWebGLRenderer(page, scenario.id);
      // .chroma 는 3초 유휴 후 페이드하고 캔버스가 클릭을 가로챈다 — 캡처에서는 강제로 숨긴다.
      await page.addStyleTag({ content: '.chroma { visibility: hidden !important; }' });

      const arrival = (await scenario.arrive(page)) || {};

      // 포즈 정착: 엔진이 매 프레임 publish 하는 카메라→피사체 거리가 멎을 때까지 기다린다.
      const settled = await page.waitForFunction(() => {
        const d = window.__rim?.viewDistance;
        if (!Number.isFinite(d) || d <= 0) return false;
        const log = (window.__abSettle ||= []);
        log.push(d);
        if (log.length < 14) return false;
        const recent = log.slice(-14);
        return Math.max(...recent) - Math.min(...recent) < 0.5;
      }, null, { timeout: Math.min(timeout, 90_000), polling: 120 }).then(() => true).catch(() => false);
      await page.evaluate(() => { delete window.__abSettle; });
      if (!settled) notes.push(`${name}: 포즈가 정착하지 않음 — A/B 가 통제되지 않았을 수 있다`);

      let prepared = {};
      if (variant.prepare) prepared = await variant.prepare(page) || {};

      if (variant.mode === 'overlay') {
        const hook = await page.evaluate(() => (typeof window.__abSwap === 'function'
          ? window.__abSwap('base') : null));
        if (!hook || !hook.materials) {
          throw new Error(`overlay hook not installed (${JSON.stringify(hook)})`);
        }
        console.log(`  overlay hook on ${hook.materials} materials`);
        notes.push(`${name}: overlay registered ${hook.materials} materials`);
      }

      // 엔진 정지 후에만 캡처한다 — 두 프레임 사이에 시간이 흐르면 그건 변인이 아니다.
      await page.evaluate(() => window.__engine.debugSetPaused(true));

      const shots = {};
      for (const slot of ['a', 'b']) {
        const spec = variant[slot];
        const info = await page.evaluate(([mode, expr, form]) => {
          if (mode === 'hook') {
            // eslint 없는 저장소라 검증 전용 식은 그대로 평가한다(하네스 인자, 사용자 입력 아님).
            (0, eval)(expr);
          } else {
            window.__abSwap(form === 'b' ? 'variant' : 'base');
          }
          const engine = window.__engine;
          engine.debugRenderDofFrame(0);
          engine.debugRenderDofFrame(0);
          const rim = window.__rim || {};
          return {
            applied: window.__abApplied ?? null,
            camera: engine.cine.debugCam(),
            programs: engine.debugPostResolution?.().programs ?? null,
            rim: {
              master: rim.master, scale: rim.scale, strength: rim.strength,
              near: rim.near, far: rim.far, viewDistance: rim.viewDistance,
              patched: rim.patched,
            },
          };
        }, [variant.mode, spec.expr || '', slot]);

        const file = `${scenario.id}-${slot.toUpperCase()}-${spec.form}.png`;
        await page.screenshot({ path: join(outDir, file) });
        shots[slot] = { file, slot, form: spec.form, ...info };
        rows.push({ scenario: scenario.id, variant: variant.id, ...shots[slot] });
      }

      // 변형이 실제로 적용됐는가. overlay 에서 0 이면 프로그램 캐시가 재사용된 것이므로
      // A/B 는 통제된 비교가 아니라 같은 그림 두 장이다 — 조용히 넘기지 않고 던진다.
      if (variant.mode === 'overlay' && !shots.b.applied) {
        throw new Error(`${name}: the variant shader never recompiled (applied=${shots.b.applied}) `
          + '— customProgramCacheKey collision, the A/B is not controlled');
      }

      const camA = JSON.stringify(shots.a.camera);
      const camB = JSON.stringify(shots.b.camera);
      if (camA !== camB) notes.push(`${name}: 카메라가 A/B 에서 달랐다 — ${camA} vs ${camB}`);
      else notes.push(`${name}: 카메라 동일 — ${camB}`);
      if (shots.a.programs !== shots.b.programs) {
        notes.push(`${name}: 프로그램 수 ${shots.a.programs} → ${shots.b.programs}`
          + (variant.mode === 'hook' ? ' (hook 모드인데 재컴파일이 일어났다)' : ' (overlay 재링크)'));
      }

      // 기준 폼으로 되돌리고 재생을 재개한다(다음 시나리오가 오염되지 않게).
      await page.evaluate(([mode, expr]) => {
        if (mode === 'hook') (0, eval)(expr);
        else window.__abSwap('base');
        window.__engine.debugSetPaused(false);
      }, [variant.mode, variant.a.expr || '']);

      // ---- 순수 픽셀 분석 (락 밖에서 다시 할 수 있게 diff.json 으로 남긴다) ----
      const A = readPng(join(outDir, shots.a.file));
      const B = readPng(join(outDir, shots.b.file));
      const BANDS = {
        'sky-far': band(0.00, 0.26),
        'ridge-edge': band(0.26, 0.45),
        'village-mid': band(0.45, 0.70),
        'foreground': band(0.70, 1.00),
      };
      const frameStats = (img) => {
        const h = hueHistogram(img);
        const t = terciles(img);
        return {
          meanSat: h.meanSat,
          chromaticShare: h.chromaticShare,
          roseShare: h.roseShare,
          greenShare: h.greenShare,
          peak60: h.peak60,
          hueSpreadDeg: hueStats(img).spreadDeg,
          darkSat: t.dark.sat, darkHue: t.dark.hue,
          brightSat: t.bright.sat, brightHue: t.bright.hue,
        };
      };
      const entry = {
        scenario: scenario.id,
        variant: variant.id,
        a: { file: shots.a.file, form: shots.a.form, ...frameStats(A) },
        b: { file: shots.b.file, form: shots.b.form, ...frameStats(B) },
        diff: diffStats(A, B),
        bands: Object.fromEntries(Object.entries(BANDS).map(
          ([label, region]) => [label, diffStats(A, B, { region })],
        )),
        arrival, prepared,
        settled,
        programs: { a: shots.a.programs, b: shots.b.programs },
        appliedMaterials: shots.b.applied,
      };
      diffs[scenario.id] = entry;
      console.log(`  changed ${(entry.diff.changedRatio * 100).toFixed(2)}% `
        + `meanAbs ${entry.diff.meanAbs.toFixed(2)} maxAbs ${entry.diff.maxAbs} at ${entry.diff.maxAt.join(',')} `
        + `lumaDelta ${entry.diff.meanLumaDelta.toFixed(3)}`);
    } catch (error) {
      notes.push(`${name}: 중단 — ${error.message.split('\n')[0]}`);
      console.log(`  ${name} 중단: ${error.message.split('\n')[0]}`);
    } finally {
      await page.close();
    }
  }

  const n = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
  await writeFile(join(outDir, 'MANIFEST.md'), [
    `# same-boot A/B · variant ${variant.id} (${variant.mode})`,
    '',
    `- generated ${new Date().toISOString()} (${((Date.now() - started) / 1000).toFixed(0)}s)`,
    `- source commit: ${process.env.CHEOMA_AB_COMMIT || '(working tree)'}`,
    '- A = 제품 기준(baseline), B = 변인 적용. **한 부팅·한 포즈**에서만 비교가 성립한다.',
    variant.mode === 'overlay'
      ? '- overlay: 변형 폼은 customProgramCacheKey 접미사로 재링크를 강제하고, 실제 GLSL 이 바뀐 재질 수가 0 이면 실패로 던진다.'
      : '- hook: 유니폼만 쓰므로 프로그램 수는 A/B 에서 같아야 한다.',
    '',
    '| png | scenario | slot | form | programs | applied mats | rim master | viewDist(m) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.file} | ${r.scenario} | ${r.slot.toUpperCase()} | ${r.form} `
      + `| ${r.programs ?? 'n/a'} | ${r.applied ?? 'n/a'} | ${n(r.rim?.master)} | ${n(r.rim?.viewDistance, 1)} |`),
    '',
    '## pixel diff (tools/lib/pixel-stats.mjs)',
    '',
    '| scenario | changed% | meanAbs | maxAbs | maxAt | meanLumaDelta | hueSpread A→B | darkSat A→B |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...Object.values(diffs).map((d) => `| ${d.scenario} | ${(d.diff.changedRatio * 100).toFixed(2)} `
      + `| ${n(d.diff.meanAbs, 2)} | ${d.diff.maxAbs} | ${d.diff.maxAt.join(',')} `
      + `| ${n(d.diff.meanLumaDelta)} | ${n(d.a.hueSpreadDeg, 1)}→${n(d.b.hueSpreadDeg, 1)} `
      + `| ${n(d.a.darkSat)}→${n(d.b.darkSat)} |`),
    '',
    '## notes',
    ...notes.map((x) => `- ${x}`),
  ].join('\n') + '\n', 'utf8');

  await writeFile(join(outDir, 'diff.json'), `${JSON.stringify({
    variant: variant.id, mode: variant.mode, generated: new Date().toISOString(), notes, diffs,
  }, null, 2)}\n`, 'utf8');

  console.log(`\nout: ${outDir}`);
  for (const x of notes) console.log(`  ${x}`);
  if (!Object.keys(diffs).length) throw new Error('no scenario produced an A/B pair');
} finally {
  if (browser) await browser.close();
  await server.close();
}
