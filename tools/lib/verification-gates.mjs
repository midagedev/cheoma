export const VERIFICATION_GATES = Object.freeze({
  docs: Object.freeze({ script: 'check:docs', resource: 'cpu', tier: 'inner', description: 'Markdown local links and document map' }),
  'core-full': Object.freeze({ script: 'check', resource: 'cpu', tier: 'merge', description: 'All browser-free contracts' }),
  app: Object.freeze({ script: 'check:app', resource: 'browser', tier: 'checkpoint', description: 'Full application smoke' }),
  'ink-app': Object.freeze({ script: 'check:ink:app', resource: 'browser', tier: 'checkpoint', description: 'Ink mode application contract' }),
  petals: Object.freeze({ script: 'check:petals', resource: 'browser', tier: 'checkpoint', description: 'Seasonal particle and weather contract' }),
  'particle-geometry': Object.freeze({ script: 'check:particle-geometry', resource: 'browser', tier: 'checkpoint', description: 'Physical precipitation, close-detail particle, and hanji-light geometry' }),
  'instance-upload': Object.freeze({ script: 'check:instance-upload:browser', resource: 'browser', tier: 'checkpoint', description: 'Sparse parcel BufferAttribute GPU uploads' }),
  'building-lifecycle': Object.freeze({ script: 'check:building-lifecycle', resource: 'browser', tier: 'checkpoint', description: 'Public building GPU texture and shadow-depth lifecycle' }),
  'api-reuse': Object.freeze({ script: 'check:api-reuse', resource: 'browser', tier: 'checkpoint', description: 'Public building and sijeon API reuse, lifecycle, and product-camera proof' }),
  'yard-life': Object.freeze({ script: 'check:yard-life:browser', resource: 'browser', tier: 'checkpoint', description: 'Reusable and product seasonal yard-life rendering, LOD, wave, rebuild, and lifecycle' }),
  'winter-app': Object.freeze({ script: 'check:winter:app', resource: 'browser', tier: 'checkpoint', description: 'Winter application surface' }),
  worker: Object.freeze({ script: 'check:worker', resource: 'browser', tier: 'checkpoint', description: 'Sync, Worker, and fallback scene parity' }),
  audio: Object.freeze({ script: 'check:audio', resource: 'browser', tier: 'checkpoint', description: 'Audio lifecycle contract' }),
  'temple-browser': Object.freeze({ script: 'check:temple:browser', resource: 'browser', tier: 'checkpoint', description: 'Temple WebGL assembly and disposal' }),
  'mja-house-browser': Object.freeze({ script: 'check:mja-house:browser', resource: 'browser', tier: 'checkpoint', description: 'Opt-in enclosed-house visual, resource, and lifecycle contract' }),
  'dof-app': Object.freeze({ script: 'check:dof:app', resource: 'browser', tier: 'checkpoint', description: 'Product depth-of-field flow' }),
  'bokeh-fixture': Object.freeze({ script: 'shoot:bokeh:proof', resource: 'exclusive', tier: 'checkpoint', description: 'Controlled bokeh image, source-scatter resource proof, and hardware GPU query' }),
  rim: Object.freeze({ script: 'check:rim', resource: 'browser', tier: 'checkpoint', description: 'Physical rim shader contract' }),
  'lod-focus': Object.freeze({ script: 'check:lod:focus', resource: 'browser', tier: 'checkpoint', description: 'Focused LOD lifecycle' }),
  'lod-wave': Object.freeze({ script: 'check:wave:app', resource: 'browser', tier: 'checkpoint', description: 'Wave handoff lifecycle' }),
  'lod-app': Object.freeze({ script: 'check:lod:app', resource: 'browser', tier: 'checkpoint', description: 'Focus and wave in one browser boot' }),
  'parcel-rebuild-browser': Object.freeze({ script: 'check:parcel-rebuild:browser', resource: 'browser', tier: 'checkpoint', description: 'Focused parcel editing and rebuild' }),
  'surface-browser': Object.freeze({ script: 'check:surface:browser', resource: 'browser', tier: 'checkpoint', description: 'Procedural surface WebGL contract' }),
  'cinematic-app': Object.freeze({ script: 'check:cinematic:app', resource: 'browser', tier: 'checkpoint', description: 'Architectural reveal application flow' }),
  build: Object.freeze({ script: 'check:build', resource: 'cpu', tier: 'merge', description: 'Clean production build' }),
});

export const ALL_PROFILE = Object.freeze([
  'docs', 'core-full', 'app', 'ink-app', 'petals', 'particle-geometry', 'instance-upload', 'building-lifecycle', 'api-reuse',
  'yard-life', 'winter-app', 'worker', 'audio',
  'temple-browser', 'mja-house-browser', 'parcel-rebuild-browser', 'surface-browser',
]);

export const FULL_PROFILE = Object.freeze([
  ...ALL_PROFILE, 'dof-app', 'rim', 'lod-app', 'cinematic-app', 'build',
]);

export function gateCommand(id) {
  const gate = VERIFICATION_GATES[id];
  if (!gate) throw new Error(`unknown verification gate: ${id}`);
  return { id, command: 'npm', args: ['run', gate.script], resource: gate.resource };
}
