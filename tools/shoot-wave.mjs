// 실제 Vite 앱에서 마을 scenery handoff를 고정 progress로 촬영한다.
// 사용자 dev server와 shots/를 건드리지 않고 OS 임시 폴더에 PNG를 남긴다.
//
//   node tools/shoot-wave.mjs
//   CHEOMA_WAVE_SCALES=village,capital node tools/shoot-wave.mjs
//   CHEOMA_WAVE_PHASES=0.35,0.499,0.5,0.501,0.65 node tools/shoot-wave.mjs
//   CHEOMA_WAVE_TIME=night CHEOMA_WAVE_SEASON=winter node tools/shoot-wave.mjs
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../app/node_modules/vite/dist/node/index.js';

const ROOT = resolve(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'app');
const cacheDir = await mkdtemp(join(tmpdir(), 'cheoma-wave-vite-'));
const outputDir = await mkdtemp(join(tmpdir(), 'cheoma-wave-shots-'));
const timeout = Number(process.env.CHEOMA_WAVE_TIMEOUT_MS) || 120_000;
const seedA = Number.parseInt(process.env.CHEOMA_WAVE_SEED_A || '20260716', 10) >>> 0;
const seedB = Number.parseInt(process.env.CHEOMA_WAVE_SEED_B || '777', 10) >>> 0;
const time = process.env.CHEOMA_WAVE_TIME || 'sunset';
const season = process.env.CHEOMA_WAVE_SEASON || 'autumn';
const weather = process.env.CHEOMA_WAVE_WEATHER || 'clear';
const scales = (process.env.CHEOMA_WAVE_SCALES || process.argv[2] || 'hamlet,village,capital,hanyang')
  .split(',').map((value) => value.trim()).filter(Boolean);
const phases = (process.env.CHEOMA_WAVE_PHASES || '0,0.35,0.499,0.5,0.501,0.65,1')
  .split(',').map(Number);
const validScales = new Set(['solo', 'hamlet', 'village', 'town', 'capital', 'hanyang']);

if (scales.some((scale) => !validScales.has(scale))) {
  throw new Error(`CHEOMA_WAVE_SCALES contains an invalid scale: ${scales.join(',')}`);
}
if (phases.some((phase) => !Number.isFinite(phase) || phase < 0 || phase > 1)) {
  throw new Error(`CHEOMA_WAVE_PHASES must contain numbers in [0,1]: ${phases.join(',')}`);
}

const server = await createServer({
  root: APP_ROOT,
  configFile: join(APP_ROOT, 'vite.config.js'),
  cacheDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});

let browser;
const runtimeErrors = [];
const reports = [];
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|404/i.test(message.text())) {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  for (const scale of scales) {
    const palace = scale === 'capital' || scale === 'hanyang' ? '&vpalace=1' : '';
    const url = `http://127.0.0.1:${port}/?hero=0&village=1&worker=0&shot=1`
      + `&seed=42&vseed=${seedA}&vscale=${scale}${palace}`
      + `&time=${time}&season=${season}&weather=${weather}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForFunction((expectedScale) => {
      const engine = window.__engine;
      return window.__SHOT_READY === true
        && engine?.village?.debugPlan?.()?.scale === expectedScale
        && !engine.village.isWaving();
    }, scale, { timeout });

    const baseShadowIntensity = await page.evaluate(() => {
      const sun = window.__engine.scene.children.find((object) => object.isDirectionalLight && object.castShadow);
      return sun?.shadow?.intensity ?? null;
    });
    const started = await page.evaluate((nextSeed) =>
      window.__engine.village.debugStartWave({ seed: nextSeed }), seedB);
    if (started !== seedB) throw new Error(`${scale}: deterministic wave did not start (${started})`);
    await page.waitForFunction(() => window.__engine.village.debugWave()?.active, null, { timeout });

    // Stabilize both generations before recording. The engine patches the incoming subtree at
    // wave start; this explicit full rescan also settles any old-root material that the normal
    // throttled post scan had not reached before SHOT_READY.
    await page.evaluate(() => window.__rim?.rescan());
    await page.evaluate(() => new Promise((resolveFrame) =>
      requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));

    // Central palaces can finish their short local rise before the screenshot phases below.
    // Sweep the real app wave without rendering to prove that the actual palace node (or one
    // of its structure ancestors) owns a non-identity transform at some assembly instant.
    const palaceWaveObserved = (scale === 'capital' || scale === 'hanyang')
      ? await page.evaluate(() => {
        const engine = window.__engine;
        const oldRoot = engine.village.exportRoot();
        const incomingRoot = engine.scene.children.find((child) =>
          /^village-(solo|hamlet|village|town|capital|hanyang)$/.test(child.name)
            && child !== oldRoot);
        const palace = incomingRoot?.getObjectByName('palace-merged')
          || incomingRoot?.getObjectByName('palace-core');
        let observed = null;
        for (let progress = 0.551; palace && progress < 0.76; progress += 0.002) {
          engine.village.debugSeekWave(progress);
          let node = palace;
          while (node && node !== incomingRoot) {
            const transformed = Math.abs(node.scale.x - 1) > 1e-3
              || Math.abs(node.scale.y - 1) > 1e-3
              || Math.abs(node.scale.z - 1) > 1e-3
              || node.position.lengthSq() > 1e-6;
            if (node.visible && transformed) {
              observed = { progress, carrier: node.name || '(anonymous)' };
              break;
            }
            node = node.parent;
          }
          if (observed) break;
        }
        engine.village.debugSeekWave(0);
        return observed;
      })
      : null;
    if ((scale === 'capital' || scale === 'hanyang') && !palaceWaveObserved) {
      throw new Error(`${scale}: actual palace root never joined the structure wave`);
    }

    // 양쪽 root의 정상 opaque 프로그램과 환경 패치를 먼저 한 번씩 렌더한다. 이후 delta는 wave가
    // 만든 변형만 뜻하며, 새 장면의 합법적인 첫-use 프로그램을 오탐하지 않는다.
    for (const progress of [0, 1, 0]) {
      await page.evaluate((value) => window.__engine.village.debugSeekWave(value), progress);
      await page.evaluate(() => new Promise((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    }
    const programBaseline = await page.evaluate(() => {
      const engine = window.__engine;
      const roots = engine.scene.children.filter((child) => /^village-(solo|hamlet|village|town|capital|hanyang)$/.test(child.name));
      const records = [];
      const staticNames = new Set([
        'village-terrain', 'village-stream', 'village-pads',
        'village-roads', 'village-paddies',
      ]);
      for (const root of roots) for (const child of root.children) {
        if (!staticNames.has(child.name)) continue;
        child.traverse((node) => {
          if (!node.material) return;
          const identity = node.material;
          const materials = Array.isArray(identity) ? identity : [identity];
          records.push({
            node,
            identity,
            states: materials.map((material) => ({
              material,
              opacity: material.opacity,
              transparent: material.transparent,
              depthWrite: material.depthWrite,
              version: material.version,
              programKey: material.customProgramCacheKey(),
            })),
          });
        });
      }
      window.__waveMaterialRecords = records;
      const programs = engine.renderer.info.programs || [];
      window.__waveProgramKeys = new Set(programs.map((program) => program.cacheKey));
      return { count: programs.length, keys: [...window.__waveProgramKeys] };
    });

    const baselineProgramKeys = new Set(programBaseline.keys);
    let maxPrograms = programBaseline.count;
    let minShadowWeight = 1;
    let maxVeil = 0;
    for (const phase of phases) {
      const seek = await page.evaluate((progress) =>
        window.__engine.village.debugSeekWave(progress), phase);
      if (!seek || Math.abs(seek.progress - phase) > 1e-9) {
        throw new Error(`${scale}: failed to freeze wave at ${phase}`);
      }
      await page.evaluate(() => new Promise((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));

      const report = await page.evaluate(() => {
        const engine = window.__engine;
        const wave = engine.village.debugWave();
        const oldRoot = engine.village.exportRoot();
        const roots = engine.scene.children.filter((child) => /^village-(solo|hamlet|village|town|capital|hanyang)$/.test(child.name));
        const incomingRoot = roots.find((root) => root !== oldRoot) || null;
        const sceneryNames = [
          'village-terrain', 'village-stream', 'edge-mist-ring', 'ridge-mist',
          'village-pads', 'village-roads', 'village-paddies', 'village-trees',
          'village-forest', 'village-flora', 'village-bloom',
        ];
        const sceneryState = (root) => Object.fromEntries(sceneryNames.map((name) => {
          const object = root?.getObjectByName(name);
          return [name, object ? object.visible === true : null];
        }));
        const palaceState = (root) => {
          const palace = root?.getObjectByName('palace-merged') || root?.getObjectByName('palace-core');
          if (!palace) return null;
          let node = palace, visible = true, animated = false, carrier = palace.name;
          const chain = [];
          while (node && node !== root) {
            visible &&= node.visible;
            const transformed = Math.abs(node.scale.x - 1) > 1e-3
              || Math.abs(node.scale.y - 1) > 1e-3
              || Math.abs(node.scale.z - 1) > 1e-3
              || node.position.lengthSq() > 1e-6;
            if (transformed) { animated = true; carrier = node.name || '(anonymous)'; }
            chain.push({
              name: node.name || '(anonymous)', visible: node.visible,
              position: [node.position.x, node.position.y, node.position.z],
              scale: [node.scale.x, node.scale.y, node.scale.z],
            });
            node = node.parent;
          }
          return {
            visible,
            animated,
            carrier,
            chain,
            scale: [palace.scale.x, palace.scale.y, palace.scale.z],
          };
        };
        let changedMaterials = 0;
        for (const record of window.__waveMaterialRecords || []) {
          if (record.node.material !== record.identity) { changedMaterials++; continue; }
          const current = Array.isArray(record.identity) ? record.identity : [record.identity];
          if (current.length !== record.states.length || current.some((material, index) => {
            const before = record.states[index];
            return material !== before.material
              || material.opacity !== before.opacity
              || material.transparent !== before.transparent
              || material.depthWrite !== before.depthWrite
              || material.version !== before.version
              || material.customProgramCacheKey() !== before.programKey;
          })) changedMaterials++;
        }
        const sun = engine.scene.children.find((object) => object.isDirectionalLight && object.castShadow);
        return {
          wave: wave.presentation,
          rootCount: roots.length,
          scenery: { old: sceneryState(oldRoot), incoming: sceneryState(incomingRoot) },
          palace: { old: palaceState(oldRoot), incoming: palaceState(incomingRoot) },
          changedMaterials,
          programs: engine.renderer.info.programs?.length ?? 0,
          programKeys: (engine.renderer.info.programs || []).map((program) => program.cacheKey),
          calls: engine.renderer.info.render.calls,
          shadowIntensity: sun?.shadow?.intensity ?? null,
        };
      });

      if (report.rootCount !== 2) throw new Error(`${scale}:${phase} expected two village roots`);
      const oldOwns = report.wave.sceneryOwner === 'old';
      for (const name of Object.keys(report.scenery.old)) {
        const oldVisible = report.scenery.old[name];
        const incomingVisible = report.scenery.incoming[name];
        if ((oldVisible === true && incomingVisible === true)
          || (!oldOwns && oldVisible === true) || (oldOwns && incomingVisible === true)) {
          throw new Error(`${scale}:${phase}:${name} scenery roots are not exclusive`
            + ` (${JSON.stringify({ oldVisible, incomingVisible })})`);
        }
      }
      if (report.scenery.old['village-terrain'] !== oldOwns
        || report.scenery.incoming['village-terrain'] === oldOwns) {
        throw new Error(`${scale}:${phase} terrain owner is missing`);
      }
      if (report.changedMaterials !== 0) {
        throw new Error(`${scale}:${phase} mutated ${report.changedMaterials} material assignments/states`);
      }
      const unexpectedProgramKeys = report.programKeys.filter((key) => !baselineProgramKeys.has(key));
      if (unexpectedProgramKeys.length) {
        throw new Error(`${scale}:${phase} added ${unexpectedProgramKeys.length} shader program key(s)`);
      }
      maxPrograms = Math.max(maxPrograms, report.programs);
      minShadowWeight = Math.min(minShadowWeight, report.wave.shadowWeight);
      maxVeil = Math.max(maxVeil, report.wave.veil);
      if (Math.abs(report.shadowIntensity - baseShadowIntensity * report.wave.shadowWeight) > 1e-6) {
        throw new Error(`${scale}:${phase} shadow presentation drifted`
          + ` (${report.shadowIntensity} vs ${baseShadowIntensity * report.wave.shadowWeight})`);
      }
      reports.push({ scale, phase, ...report });

      const tag = `t${String(Math.round(phase * 1000)).padStart(4, '0')}`;
      const path = join(outputDir, `${scale}-${tag}.png`);
      await page.screenshot({ path });
      console.log(`${scale} t=${phase.toFixed(3)} owner=${report.wave.sceneryOwner}`
        + ` veil=${report.wave.veil.toFixed(3)} shadow=${report.wave.shadowWeight.toFixed(3)}`
        + ` programs=${report.programs} calls=${report.calls} -> ${path}`);
    }

    if (maxPrograms > programBaseline.count) {
      throw new Error(`${scale}: wave added renderer programs (${programBaseline.count} -> ${maxPrograms})`);
    }
    if (maxVeil < 0.999 || minShadowWeight > 0.001) {
      throw new Error(`${scale}: veil/shadow did not cover the handoff peak`);
    }
    await page.evaluate(() => window.__engine.village.debugCancelWave());
    await page.waitForFunction(() => !window.__engine.village.isWaving(), null, { timeout });
    const restored = await page.evaluate(() => {
      const engine = window.__engine;
      const roots = engine.scene.children.filter((child) => /^village-(solo|hamlet|village|town|capital|hanyang)$/.test(child.name));
      const sun = engine.scene.children.find((object) => object.isDirectionalLight && object.castShadow);
      return { roots: roots.length, shadowIntensity: sun?.shadow?.intensity ?? null };
    });
    if (restored.roots !== 1 || Math.abs(restored.shadowIntensity - baseShadowIntensity) > 1e-9) {
      throw new Error(`${scale}: cancel did not restore one root and base shadow (${JSON.stringify(restored)})`);
    }
  }

  if (runtimeErrors.length) throw new Error(runtimeErrors.slice(0, 8).join('\n'));
  console.log(`WAVE VISUAL CAPTURE: PASS (${reports.length} frames)`);
  console.log(`output: ${outputDir}`);
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
