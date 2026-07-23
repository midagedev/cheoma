import { FAST_CHECK_PATHS } from './fast-checks.mjs';
import { gateCommand } from './verification-gates.mjs';
import { isApiReuseDependency } from './verification-impact.mjs';

const FULL_GATES = Object.freeze([
  'core', 'app', 'ink-app', 'petals', 'particle-geometry', 'instance-upload', 'building-lifecycle', 'api-reuse', 'winter-app', 'worker', 'audio',
  'temple-browser', 'dof-app', 'lod-focus', 'lod-wave', 'rim', 'parcel-rebuild-browser',
  'surface-browser', 'cinematic-app', 'build',
]);

const DOC_PATH = /^(?:docs\/|refs\/|README\.md$|AGENTS\.md$|CLAUDE\.md$|SANSA-HANDOFF\.md$|LICENSE(?:\.|$))/;
const ROOT_HTML = /^[^/]+\.html$/;

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
  if (FAST_CHECK_PATHS.includes(path) || path === 'tools/plan-contract.json') {
    select('browser-free contract changed; run it through impacted core routing', 'core');
    return { gates, reasons };
  }
  const browserToolGates = {
    'tools/check-app-smoke.mjs': ['app'],
    'tools/check-detail-particle-geometry.mjs': ['particle-geometry'],
    'tools/check-instance-upload-browser.mjs': ['instance-upload'],
    'tools/check-building-texture-lifecycle.mjs': ['building-lifecycle'],
    'tools/check-api-reuse-example.mjs': ['api-reuse'],
    'tools/check-ink-app.mjs': ['ink-app'],
    'tools/verify-petals.mjs': ['petals'],
    'tools/check-winter-app.mjs': ['winter-app'],
    'tools/check-worker-contract.mjs': ['worker'],
    'tools/check-audio.mjs': ['audio'],
    'tools/check-temple-browser.mjs': ['temple-browser'],
    'tools/check-parcel-rebuild-browser.mjs': ['parcel-rebuild-browser'],
    'tools/check-surface-materials-browser.mjs': ['surface-browser'],
    'tools/check-dof-app.mjs': ['dof-app'],
    'tools/shoot-bokeh-fixture.mjs': ['bokeh-fixture'],
    'tools/shoot-bokeh-scatter-proof.mjs': ['bokeh-fixture'],
    'tools/lib/bokeh-gpu-diagnostic.mjs': ['bokeh-fixture'],
    'tools/lib/bokeh-image-analysis.mjs': ['bokeh-fixture'],
    'tools/lib/bokeh-linear-sweep.mjs': ['bokeh-fixture'],
    'tools/lib/bokeh-optical-chart.mjs': ['bokeh-fixture'],
    'tools/lib/bokeh-scatter-proof.mjs': ['bokeh-fixture'],
    'tools/lib/bokeh-source-stress.mjs': ['bokeh-fixture'],
    'tools/check-rim-facing.mjs': ['rim'],
    'tools/shoot-wall-steps.mjs': ['app'],
    'tools/check-lod-app.mjs': ['lod-focus', 'lod-wave'],
    'tools/check-cinematic-reveal-app.mjs': ['cinematic-app'],
    'tools/check-app-build.mjs': ['build'],
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
    if (/^app\/src\/(?:App\.svelte|components\/RenderStyleToggle\.svelte|engine\/(?:engine|ink-mode-runtime|post-runtime|post-quality-runtime)\.js|lib\/(?:i18n\.svelte|url)\.js)$/.test(path)) {
      select('product ink mode integration changed', 'ink-app');
    }
    if (/^app\/src\/(?:components\/EnvironmentDial\.svelte|engine\/engine\.js|lib\/seed\.js)$/.test(path)) {
      select('winter environment integration changed', 'winter-app');
    }
    if (/^app\/src\/(?:App\.svelte|components\/ContextPanel\.svelte|engine\/engine\.js|lib\/live-edit-scheduler\.js)$/.test(path)) {
      select('focused rebuild surface changed', 'parcel-rebuild-browser');
    }
    if (path === 'app/src/engine/engine.js') {
      select('engine integration changed', 'dof-app', 'lod-focus', 'lod-wave');
    }
    if (/^app\/src\/engine\/(?:post-runtime|post-quality-runtime|scene-runtime)\.js$/.test(path)) {
      select('post/scene runtime changed', 'dof-app');
    }
    if (/^app\/src\/engine\/post(?:-quality)?-runtime\.js$/.test(path)) {
      select('adaptive camera quality changed', 'ink-app', 'lod-focus');
    }
    if (path === 'app/src/engine/directional-shadow-runtime.js') {
      select('focused directional shadow framing changed', 'rim', 'lod-focus');
    }
    if (/^app\/src\/engine\/(?:view-shift|village-camera-runtime)\.js$/.test(path)) {
      select('camera runtime changed', 'dof-app', 'lod-focus', 'lod-wave');
    }
    return { gates, reasons };
  }

  if (path.startsWith('src/env/') || path.startsWith('src/render/')) {
    select('environment/rendering changed', 'app');
    if (/^src\/render\/(?:ink|ink-state)\.js$/.test(path)) select('ink rendering changed', 'ink-app');
    if (/^src\/render\/(?:material-program-key|screen-door|lod-screen-door)\.js$/.test(path)) {
      select('shared screen-door shader contract changed',
        'ink-app', 'dof-app', 'lod-focus', 'winter-app', 'rim', 'building-lifecycle');
    }
    if (path === 'src/render/shadow-depth-texture-lifecycle.js') {
      select('building shadow texture lifecycle changed', 'building-lifecycle');
    }
    if (/^src\/env\/(?:index|mountains|paddies|seasons|sky|snow-material|terrain|trees|weather)\.js$/.test(path)) {
      select('winter surface or environment changed', 'winter-app');
    }
    if (/^src\/env\/(?:dof|post|post-quality-state|stable-bokeh-pass|circular-bokeh-shader|tree-occluder|inst-fade-shader|rim|present-gate)\.js$/.test(path)) {
      select('depth/post contract changed', 'dof-app');
    }
    if (/^src\/env\/(?:post-quality-state|stable-bokeh-pass|circular-bokeh-shader)\.js$/.test(path)) {
      select('adaptive post policy changed', 'ink-app', 'lod-focus');
    }
    if (/^src\/env\/(?:stable-bokeh-pass|circular-bokeh-shader|bokeh-highlight-prefilter|bokeh-source-contract|bokeh-source-scatter)\.js$/.test(path)) {
      select('compact-source bokeh changed', 'dof-app', 'ink-app', 'lod-focus', 'bokeh-fixture');
    }
    if (/^src\/env\/(?:rim|clouds|snow-material)\.js$/.test(path)) {
      select('physical rim inputs changed', 'rim');
    }
    if (/^src\/env\/(?:petals|weather|seasons)\.js$/.test(path)) {
      select('seasonal particle/weather contract changed', 'petals');
    }
    if (/^src\/env\/(?:detail-particle-geometry|motes|petals|seasons|weather|weather-particle-state|weather-physical-geometry)\.js$/.test(path)) {
      select('physical particle representation changed', 'particle-geometry');
    }
    if (path === 'src/env/petals.js') select('focus particle LOD changed', 'lod-focus');
    if (/^src\/env\/(?:weather|seasons)\.js$/.test(path)) {
      select('wave environment synchronization changed', 'lod-wave');
    }
    if (/^src\/env\/(?:focus|animals|critters|grass|lantern-sway|motes|smoke|wind)\.js$/.test(path)) {
      select('near-detail and wave-owned LOD changed', 'lod-focus', 'lod-wave');
    }
    if (/^src\/env\/(?:clouds|edge-mist-view)\.js$/.test(path)) {
      select('village atmospheric view ownership changed', 'lod-focus', 'lod-wave');
    }
    if (path === 'src/env/night-glow.js') select('wave-owned lighting changed', 'lod-wave');
    return { gates, reasons };
  }

  if (path.startsWith('src/camera/') || path.startsWith('src/cinematic/')) {
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
    select('village generation changed', 'app', 'worker');
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

  if (/^src\/(?:builder|layout|props|anim|core|export|share)\//.test(path)
    || path === 'src/params.js' || path === 'src/rng.js') {
    select('shared generated scene content changed', 'app');
    if (!/^src\/(?:export|share)\//.test(path)) select('worker scene graph may change', 'worker');
    if (path.startsWith('src/builder/')) {
      select('public building resource lifecycle changed', 'building-lifecycle');
    }
    if (path === 'src/core/three-resources.js') {
      select('public building disposal primitive changed', 'building-lifecycle');
    }
    if (path === 'src/core/buffer-update-range.js') {
      select('BufferAttribute upload range ownership changed', 'instance-upload', 'lod-wave');
    }
    if (path === 'src/builder/palette.js') {
      select('roof snow and rim material roles changed', 'winter-app', 'rim');
    }
    return { gates, reasons };
  }

  if (path.startsWith('src/surfaces/')) {
    select('procedural surface source or adapter changed', 'app', 'worker', 'surface-browser');
    return { gates, reasons };
  }

  if (path.startsWith('src/api/')) {
    if (path === 'src/api/ink.js' || path === 'src/api/render-style.js') {
      select('public ink rendering API changed', 'app', 'ink-app');
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
      select('pure adaptive post API changed', 'app', 'ink-app', 'dof-app', 'lod-focus');
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
    if (normalizedNewPaths.has(path) && !DOC_PATH.test(path)) {
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
  if (has('app')) commands.push(gateCommand('app'));
  if (has('ink-app')) commands.push(gateCommand('ink-app'));
  if (has('dof-app')) commands.push(gateCommand('dof-app'));
  if (has('bokeh-fixture')) commands.push(gateCommand('bokeh-fixture'));
  if (has('rim')) commands.push(gateCommand('rim'));
  if (has('petals')) commands.push(gateCommand('petals'));
  if (has('particle-geometry')) commands.push(gateCommand('particle-geometry'));
  if (has('instance-upload')) commands.push(gateCommand('instance-upload'));
  if (has('building-lifecycle')) commands.push(gateCommand('building-lifecycle'));
  if (has('api-reuse')) commands.push(gateCommand('api-reuse'));
  if (has('winter-app')) commands.push(gateCommand('winter-app'));
  if (has('worker')) commands.push(gateCommand('worker'));
  if (has('audio')) commands.push(gateCommand('audio'));
  if (has('temple-browser')) commands.push(gateCommand('temple-browser'));
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
