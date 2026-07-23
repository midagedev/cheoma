// Renderer-free contracts for issue #96's precipitation A/B prototype.
// Run directly: node tools/check-weather-geometry.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'cheoma-weather-geometry-check-'));
const bundle = join(scratch, 'weather-physical-geometry.mjs');
const esbuild = join(ROOT, 'app/node_modules/.bin/esbuild');
const three = join(ROOT, 'app/node_modules/three/build/three.module.js');

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise(output);
      else reject(new Error(`${command} exited ${code}\n${output}`));
    });
  });
}

function typedArrays(record) {
  return Object.entries(record).filter(([, value]) => ArrayBuffer.isView(value));
}

function assertStateEqual(actual, expected, label) {
  assert.deepEqual(
    typedArrays(actual).map(([name]) => name).sort(),
    typedArrays(expected).map(([name]) => name).sort(),
    `${label}: typed-array fields changed`,
  );
  for (const [name, array] of typedArrays(actual)) {
    assert.equal(
      Buffer.compare(Buffer.from(array.buffer), Buffer.from(expected[name].buffer)),
      0,
      `${label}: ${name} is not byte deterministic`,
    );
  }
}

function disposalCounter(resource) {
  let count = 0;
  resource.addEventListener('dispose', () => { count++; });
  return () => count;
}

function makeLegacyRng(seed) {
  let value = seed >>> 0;
  return () => {
    value |= 0;
    value = (value + 0x6D2B79F5) | 0;
    let next = Math.imul(value ^ (value >>> 15), 1 | value);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

try {
  await run(esbuild, [
    'src/env/weather-physical-geometry.js',
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--alias:three=${three}`,
    `--outfile=${bundle}`,
    '--log-level=error',
  ]);
  const weather = await import(bundle);

  const snowA = weather.createSnowPrecipitationState({ count: 96, top: 18 });
  const snowB = weather.createSnowPrecipitationState({ count: 96, top: 18 });
  const rainA = weather.createRainPrecipitationState({ count: 96, top: 18 });
  const rainB = weather.createRainPrecipitationState({ count: 96, top: 18 });
  assertStateEqual(snowA, snowB, 'snow initial state');
  assertStateEqual(rainA, rainB, 'rain initial state');

  const snowLegacyRng = makeLegacyRng(weather.WEATHER_PARTICLE_SEED ^ 0x1111);
  const rainLegacyRng = makeLegacyRng(weather.WEATHER_PARTICLE_SEED ^ 0x2222);
  for (let index = 0; index < 96; index++) {
    const offset = index * 3;
    const snowX = (snowLegacyRng() * 2 - 1) * snowA.half;
    const snowZ = (snowLegacyRng() * 2 - 1) * snowA.half;
    const snowY = snowA.bottom + snowLegacyRng() * snowA.height;
    const snowSpeed = 2.4 + (6 - 2.4) * snowLegacyRng();
    const snowPhase = Math.PI * 2 * snowLegacyRng();
    const snowSway = 0.3 + (1.1 - 0.3) * snowLegacyRng();
    const snowSize = 1.1 + (2.7 - 1.1) * snowLegacyRng();
    const snowOpacity = 0.45 + (1 - 0.45) * snowLegacyRng();
    assert.equal(snowA.positions[offset], Math.fround(snowX), 'snow legacy x moved');
    assert.equal(snowA.positions[offset + 1], Math.fround(snowY), 'snow legacy y moved');
    assert.equal(snowA.positions[offset + 2], Math.fround(snowZ), 'snow legacy z moved');
    assert.equal(snowA.speeds[index], Math.fround(snowSpeed), 'snow legacy speed moved');
    assert.equal(snowA.phases[index], Math.fround(snowPhase), 'snow legacy phase moved');
    assert.equal(snowA.sways[index], Math.fround(snowSway), 'snow legacy sway moved');
    assert.equal(snowA.sizes[index], Math.fround(snowSize), 'snow legacy size moved');
    assert.equal(snowA.opacities[index], Math.fround(snowOpacity), 'snow legacy opacity moved');

    const rainX = (rainLegacyRng() * 2 - 1) * rainA.half;
    const rainZ = (rainLegacyRng() * 2 - 1) * rainA.half;
    const rainY = rainA.bottom + rainLegacyRng() * rainA.height;
    const rainSpeed = 30 + (46 - 30) * rainLegacyRng();
    const rainLength = 1.4 + (2.6 - 1.4) * rainLegacyRng();
    assert.equal(rainA.positions[offset], Math.fround(rainX), 'rain legacy x moved');
    assert.equal(rainA.positions[offset + 1], Math.fround(rainY), 'rain legacy y moved');
    assert.equal(rainA.positions[offset + 2], Math.fround(rainZ), 'rain legacy z moved');
    assert.equal(rainA.speeds[index], Math.fround(rainSpeed), 'rain legacy speed moved');
    assert.equal(rainA.lengths[index], Math.fround(rainLength), 'rain legacy length moved');
  }

  // Force repeated roof respawns. The global RNG is deliberately made unusable:
  // every respawn must come from index + per-particle generation.
  const roof = [{
    min: { x: -50, y: 0, z: -50 },
    max: { x: 50, y: 17, z: 50 },
  }];
  const originalRandom = Math.random;
  Math.random = () => { throw new Error('precipitation touched global Math.random'); };
  try {
    for (let frame = 0; frame < 180; frame++) {
      const step = {
        dt: 1 / 30,
        time: frame / 30,
        wind: {
          dirX: Math.sin(frame * 0.03),
          dirZ: Math.cos(frame * 0.03),
          speed: 0.5 + (frame % 9) * 0.06,
          gust: (frame % 13) / 13,
        },
        centerX: 3,
        centerZ: -2,
        roofColliders: roof,
        collide: true,
        top: 18,
      };
      weather.advanceSnowPrecipitation(snowA, step);
      weather.advanceSnowPrecipitation(snowB, step);
      weather.advanceRainPrecipitation(rainA, step);
      weather.advanceRainPrecipitation(rainB, step);
    }
  } finally {
    Math.random = originalRandom;
  }
  assertStateEqual(snowA, snowB, 'snow stepped state');
  assertStateEqual(rainA, rainB, 'rain stepped state');
  assert.ok(snowA.generations.some((value) => value > 0), 'snow respawn path was not exercised');
  assert.ok(rainA.generations.some((value) => value > 0), 'rain respawn path was not exercised');

  const snowFull = weather.createPhysicalSnowRepresentation(snowA);
  const rainFull = weather.createPhysicalRainRepresentation(rainA);
  for (const [representation, positions] of [
    [snowFull, snowA.positions],
    [rainFull, rainA.positions],
  ]) {
    assert.strictEqual(
      representation.sourcePositions,
      positions,
      `${representation.kind} copied the simulation positions`,
    );
  }
  assert.strictEqual(
    snowFull.object.geometry.getAttribute('aCenter').array,
    snowA.positions,
    'physical snow instance centers are not the owner positions',
  );
  assert.strictEqual(
    rainFull.object.geometry.getAttribute('aCenter').array,
    rainA.positions,
    'physical rain instance centers are not the owner positions',
  );
  for (const representation of [snowFull, rainFull]) {
    representation.setCenterSpread(2.25);
    assert.equal(representation.centerSpread, 2.25,
      `${representation.kind} lost view-owned field coverage`);
  }
  assert.ok(
    snowFull.object.isMesh && snowFull.object.geometry.isInstancedBufferGeometry,
    'snow FULL is not instanced world geometry',
  );
  assert.ok(
    rainFull.object.isMesh && rainFull.object.geometry.isInstancedBufferGeometry,
    'rain FULL is not instanced world geometry',
  );
  assert.equal(snowFull.triangles, snowA.count * 6, 'snow FULL triangle accounting drifted');
  assert.equal(rainFull.triangles, rainA.count * 12, 'rain FULL triangle accounting drifted');
  assert.ok(
    !/gl_PointSize|gl_PointCoord|cameraPosition/.test(snowFull.object.material.vertexShader),
    'snow FULL regressed to a point or camera billboard',
  );
  assert.ok(
    !/gl_PointSize|gl_PointCoord|cameraPosition/.test(rainFull.object.material.vertexShader),
    'rain FULL regressed to a point or camera billboard',
  );

  for (const full of [snowFull, rainFull]) {
    const depth = full.object.userData.dofDepthMaterial;
    assert.ok(depth?.depthWrite && depth.allowOverride === false, `${full.kind} lost explicit DoF depth`);
    full.sync({ level: 0.5, time: 1 });
    assert.equal(depth.uniforms.uFade.value, 0.5, `${full.kind} depth fade is not shared with color`);
    assert.match(
      depth.fragmentShader,
      /weatherDepthHash[\s\S]*clamp\(uFade/,
      `${full.kind} fade writes one opaque DoF plate instead of matching coverage`,
    );
    full.sync({ level: 1, time: 1 });
    assert.equal(depth.uniforms.uFade.value, 1, `${full.kind} stable depth does not activate`);
  }

  const stateBytes = {
    snow: weather.precipitationStateBytes(snowA),
    rain: weather.precipitationStateBytes(rainA),
  };
  const attributeBytes = Object.fromEntries(
    [snowFull, rainFull]
      .map((representation) => [
        representation.kind,
        weather.representationAttributeBytes(representation),
      ]),
  );
  assert.ok(attributeBytes['snow-physical'] < 3000,
    'snow geometry allocated per-instance transforms or viewport data');
  assert.ok(attributeBytes['rain-physical'] < 2600,
    'rain geometry allocated per-instance transforms or viewport data');

  for (const representation of [snowFull, rainFull]) {
    const geometryDisposed = disposalCounter(representation.object.geometry);
    const materialDisposed = disposalCounter(representation.object.material);
    const depth = representation.object.userData.dofDepthMaterial;
    const depthDisposed = depth ? disposalCounter(depth) : null;
    representation.dispose();
    representation.dispose();
    assert.equal(geometryDisposed(), 1, `${representation.kind} geometry disposal is not idempotent`);
    assert.equal(materialDisposed(), 1, `${representation.kind} material disposal is not idempotent`);
    if (depthDisposed) assert.equal(depthDisposed(), 1, `${representation.kind} depth disposal is not idempotent`);
  }

  // Repeated ownership cycles should be structurally constant. WebGL renderer memory is
  // measured by the visual harness; this catches accidental resources before upload.
  for (let cycle = 0; cycle < 12; cycle++) {
    const state = weather.createSnowPrecipitationState({ count: 32 });
    const full = weather.createPhysicalSnowRepresentation(state);
    assert.equal(full.object.geometry.attributes.aCenter.array, state.positions);
    full.dispose();
  }

  console.log('weather physical geometry contracts: PASS');
  console.log(JSON.stringify({
    counts: { snow: snowA.count, rain: rainA.count },
    respawns: {
      snow: snowA.generations.reduce((sum, value) => sum + value, 0),
      rain: rainA.generations.reduce((sum, value) => sum + value, 0),
    },
    stateBytes,
    attributeBytes,
    triangles: { snow: snowFull.triangles, rain: rainFull.triangles },
  }, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
