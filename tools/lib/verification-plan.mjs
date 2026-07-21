const FULL_GATES = Object.freeze([
  'core', 'app', 'petals', 'worker', 'audio', 'dof-app', 'lod-focus', 'lod-wave', 'build',
]);

const DOC_PATH = /^(?:docs\/|refs\/|README\.md$|AGENTS\.md$|CLAUDE\.md$|SANSA-HANDOFF\.md$|LICENSE(?:\.|$)|\.gitignore$)/;
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

  if (DOC_PATH.test(path)) return { gates, reasons: ['documentation only'] };

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
  if (path.startsWith('tools/')) {
    return { full: true, reasons: ['verification implementation changed'] };
  }

  if (path === 'app/index.html' || path.startsWith('app/src/') || path.startsWith('app/public/')) {
    select('application surface changed', 'app', 'build');
    if (path === 'app/src/engine/engine.js') {
      select('engine integration changed', 'dof-app', 'lod-focus', 'lod-wave');
    }
    if (/^app\/src\/engine\/(?:post-runtime|scene-runtime)\.js$/.test(path)) {
      select('post/scene runtime changed', 'dof-app');
    }
    if (/^app\/src\/engine\/(?:view-shift|village-camera-runtime)\.js$/.test(path)) {
      select('camera runtime changed', 'dof-app', 'lod-focus', 'lod-wave');
    }
    return { gates, reasons };
  }

  if (path.startsWith('src/env/') || path.startsWith('src/render/')) {
    select('environment/rendering changed', 'app');
    if (/^src\/env\/(?:dof|post|stable-bokeh-pass|circular-bokeh-shader|tree-occluder|inst-fade-shader|rim|present-gate)\.js$/.test(path)) {
      select('depth/post contract changed', 'dof-app');
    }
    if (/^src\/env\/(?:petals|weather|seasons)\.js$/.test(path)) {
      select('seasonal particle/weather contract changed', 'petals');
    }
    if (path === 'src/env/petals.js') select('focus particle LOD changed', 'lod-focus');
    if (/^src\/env\/(?:weather|seasons)\.js$/.test(path)) {
      select('wave environment synchronization changed', 'lod-wave');
    }
    if (/^src\/env\/(?:focus|animals|critters|grass|motes|smoke|wind)\.js$/.test(path)) {
      select('near-detail and wave-owned LOD changed', 'lod-focus', 'lod-wave');
    }
    if (path === 'src/env/night-glow.js') select('wave-owned lighting changed', 'lod-wave');
    return { gates, reasons };
  }

  if (path.startsWith('src/camera/') || path.startsWith('src/cinematic/')) {
    select('camera/cinematic behavior changed', 'app');
    if (path === 'src/camera/optics.js') {
      select('optical transition changed', 'dof-app', 'lod-focus', 'lod-wave');
    }
    return { gates, reasons };
  }

  if (path === 'src/village/wave.js') {
    select('exclusive scenery handoff changed', 'app', 'lod-wave');
    return { gates, reasons };
  }

  if (path.startsWith('src/village/') || path.startsWith('src/generators/')) {
    select('village generation changed', 'app', 'worker');
    if (/^src\/village\/(?:chunks|instancing|impostor-spec|lod-policy)\.js$/.test(path)
      || path === 'src/generators/village/houses.js') {
      select('parcel representation changed', 'lod-focus', 'lod-wave');
    }
    if (path === 'src/village/nightlights.js') select('wave-owned village lighting changed', 'lod-wave');
    if (path === 'src/village/populate.js') select('population lifecycle changed', 'lod-focus', 'lod-wave');
    return { gates, reasons };
  }

  if (path.startsWith('src/runtime/village/')) {
    select('village runtime changed', 'app', 'worker');
    if (/^src\/runtime\/village\/(?:detail-lod|fauna|parcel-representation|ambient-field)\.js$/.test(path)) {
      select('runtime detail and wave ownership changed', 'lod-focus', 'lod-wave');
    }
    if (/^src\/runtime\/village\/(?:lighting|night-glow|snow)\.js$/.test(path)) {
      select('runtime wave presentation changed', 'lod-wave');
    }
    if (path === 'src/runtime/village/create.js') select('async handle lifecycle changed', 'lod-wave');
    if (path === 'src/runtime/village/handle.js') select('village handle changed', 'lod-focus', 'lod-wave');
    return { gates, reasons };
  }

  if (/^src\/(?:builder|layout|props|anim|core|export|share)\//.test(path)
    || path === 'src/params.js' || path === 'src/rng.js') {
    select('shared generated scene content changed', 'app');
    if (!/^src\/(?:export|share)\//.test(path)) select('worker scene graph may change', 'worker');
    return { gates, reasons };
  }

  if (path.startsWith('src/api/')) {
    if (path === 'src/api/environment.js') {
      select('environment API changed', 'app', 'dof-app', 'petals', 'lod-wave');
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
    if (/^src\/api\/(?:building|cinematic|export|props)\.js$/.test(path)) {
      select('public feature API changed', 'app');
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

export function planVerification(paths, { forceFullReason = null, newPaths = [] } = {}) {
  const files = [...new Set(paths.map(normalizeVerificationPath))].sort();
  const fileSet = new Set(files);
  const normalizedNewPaths = new Set(
    newPaths.map(normalizeVerificationPath).filter((path) => fileSet.has(path)),
  );
  const gates = new Set(['core']);
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
    routes,
  };
}

export function verificationCommands(plan) {
  if (plan.full) return [{ id: 'full', command: 'npm', args: ['run', 'check:full'] }];

  const commands = [{ id: 'core', command: 'npm', args: ['run', 'check'] }];
  const has = (gate) => plan.gates.includes(gate);
  if (has('app')) commands.push({ id: 'app', command: 'npm', args: ['run', 'check:app'] });
  if (has('dof-app')) commands.push({ id: 'dof-app', command: 'npm', args: ['run', 'check:dof:app'] });
  if (has('petals')) commands.push({ id: 'petals', command: 'npm', args: ['run', 'check:petals'] });
  if (has('worker')) commands.push({ id: 'worker', command: 'npm', args: ['run', 'check:worker'] });
  if (has('audio')) commands.push({ id: 'audio', command: 'npm', args: ['run', 'check:audio'] });
  if (has('lod-focus')) {
    commands.push({ id: 'lod-focus', command: 'npm', args: ['run', 'check:lod:focus'] });
  }
  if (has('lod-wave')) {
    commands.push({ id: 'lod-wave', command: 'npm', args: ['run', 'check:wave:app'] });
  }
  if (has('build')) commands.push({ id: 'build', command: 'npm', args: ['run', 'check:build'] });
  return commands;
}

export { FULL_GATES };
