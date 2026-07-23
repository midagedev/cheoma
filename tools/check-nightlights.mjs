import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const requireApp = createRequire(join(ROOT, "app", "package.json"));
const esbuild = requireApp("esbuild");
const built = await esbuild.build({
  stdin: {
    contents: `
      export * as THREE from 'three';
      export { buildNightLights } from './src/village/nightlights.js';
      export { VILLAGE_LENS_SCALE_MAX } from './src/camera/optics.js';
      export {
        dofDepthMaterialForObject,
      } from './src/env/dof.js';
      export { houseMatrix } from './src/generators/shared/parcel-transform.js';
      export { planVillage } from './src/village/plan.js';
    `,
    resolveDir: ROOT,
    sourcefile: "nightlights-contract-entry.js",
  },
  alias: { three: join(ROOT, "app/node_modules/three/build/three.module.js") },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
  logLevel: "silent",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`;
const {
  THREE,
  VILLAGE_LENS_SCALE_MAX,
  buildNightLights,
  dofDepthMaterialForObject,
  houseMatrix,
  planVillage,
} = await import(moduleUrl);

const EPS = 1e-10;
const close = (actual, expected, message) => {
  assert(
    Math.abs(actual - expected) <= EPS,
    `${message}: ${actual} !== ${expected}`,
  );
};
const anchor = (openingId, position, outward, kind = "window") =>
  Object.freeze({
    openingId,
    kind,
    style: "giwa",
    primary: kind === "door",
    width: kind === "door" ? 1.6 : 1.1,
    height: kind === "door" ? 2 : 0.7,
    position: Object.freeze({ ...position }),
    outward: Object.freeze({ ...outward }),
  });
const bytes = (attribute) =>
  Buffer.from(
    attribute.array.buffer,
    attribute.array.byteOffset,
    attribute.array.byteLength,
  ).toString("hex");

const giwaAnchors = Object.freeze([
  anchor(
    "giwa-front-door",
    { x: 1.1, y: 1.35, z: 2.8 },
    { x: 0, y: 0, z: 1 },
    "door",
  ),
  anchor(
    "giwa-rear-window",
    { x: -1.8, y: 1.7, z: -2.7 },
    { x: 0, y: 0, z: -1 },
  ),
  anchor("giwa-side-window", { x: 3.2, y: 1.65, z: 0.4 }, { x: 1, y: 0, z: 0 }),
]);
const chogaAnchors = Object.freeze([
  anchor(
    "choga-front-window",
    { x: -0.7, y: 1.3, z: 2.1 },
    { x: 0, y: 0, z: 1 },
  ),
  anchor(
    "choga-rear-window",
    { x: 0.9, y: 1.25, z: -2 },
    { x: 0, y: 0, z: -1 },
  ),
]);
const heroAnchors = Object.freeze([
  anchor(
    "hero-authored-door",
    { x: 31, y: 2.2, z: 7 },
    { x: 0, y: 0, z: 1 },
    "door",
  ),
]);
const palaceAnchors = Object.freeze([
  anchor(
    "palace-authored-window",
    { x: -24, y: 4.1, z: 18 },
    { x: 0, y: 0, z: 1 },
  ),
]);

const regular = {
  id: "regular-giwa",
  kind: "giwa",
  seed: 117,
  wealth: 0.9,
  variant: 0,
  center: { x: 17.5, z: -8.25 },
  baseY: 1.75,
  frontDir: { x: 0.6, z: 0.8 },
  yaw: 0.13,
  houseLocal: { x: 1.2, z: -2.4 },
  sx: 1.1,
  sy: 0.95,
  sz: 0.85,
  plotW: 13,
  plotD: 12,
};
const choga = {
  id: "regular-choga",
  kind: "choga",
  seed: 311,
  wealth: 0.35,
  variant: 0,
  center: { x: -13, z: 5 },
  baseY: 0.6,
  frontDir: { x: -0.2, z: Math.sqrt(0.96) },
  yaw: -0.07,
  houseLocal: { x: -0.4, z: -1.7 },
  sx: 0.92,
  sy: 1.03,
  sz: 1.08,
  plotW: 10,
  plotD: 9,
};
const hero = {
  id: "hero-house",
  kind: "giwa",
  seed: 719,
  wealth: 1,
  variant: 0,
  hero: true,
  center: { x: 31, z: 7 },
  frontDir: { x: 0, z: 1 },
  plotW: 20,
  plotD: 18,
};
const plan = {
  parcels: [regular, choga, hero],
  features: {
    palace: { seed: 811 },
    temple: { seed: 812 },
    pavilion: { seed: 813 },
  },
};
const sources = {
  regular: {
    giwa: { variants: [giwaAnchors], variantAware: true },
    choga: { variants: [chogaAnchors], variantAware: true },
  },
  owners: new Map([
    [hero.id, heroAnchors],
    ["palace", palaceAnchors],
  ]),
};
const ownerIds = [regular.id, choga.id, hero.id, "palace"];

function snapshot(api) {
  const mesh = api.group.getObjectByName("nightlight-physical");
  const attributes = {};
  for (const name of [
    "position",
    "uv",
    "aAnchor",
    "aOutward",
    "aOpeningSize",
    "aPhase",
    "aLit",
    "aThreshold",
    "aWarm",
  ]) {
    attributes[name] = bytes(mesh.geometry.getAttribute(name));
  }
  return JSON.stringify({
    state: api.debugState(),
    owners: ownerIds.map((id) => api.debugOwner(id)),
    attributes,
    depthWrite: mesh.material.depthWrite,
  });
}

const p13Plan = planVillage({ scale: "village", seed: 20260716 });
const p13 = p13Plan.parcels.find((parcel) => parcel.id === "p13");
assert(p13 && !p13.hero, "production village fixture lost regular parcel p13");
const p13Local = anchor(
  "p13-production-sample",
  { x: 0.73, y: 1.62, z: 2.41 },
  { x: 0, y: 0, z: 1 },
);
const p13Variants = Array.from(
  { length: Math.max(1, (p13.variant | 0) + 1) },
  () => [p13Local],
);
const p13Sources = {
  regular: {
    [p13.kind === "giwa" ? "giwa" : "choga"]: {
      variants: p13Variants,
      variantAware: true,
    },
  },
};

function withRandomCounter(run) {
  const originalRandom = Math.random;
  let calls = 0;
  Math.random = () => {
    calls++;
    return ((calls * 2654435761) >>> 0) / 0x100000000;
  };
  try {
    return { result: run(), calls };
  } finally {
    Math.random = originalRandom;
  }
}

const baseline = withRandomCounter(() => {
  for (let index = 0; index < 3; index++) {
    const group = new THREE.Group();
    const geometry = new THREE.BufferGeometry();
    const material = new THREE.ShaderMaterial();
    const depthMaterial = new THREE.ShaderMaterial();
    group.add(new THREE.Points(geometry, material));
    geometry.dispose();
    material.dispose();
    depthMaterial.dispose();
  }
  return new THREE.Group();
});
let first;
let repeat;
let empty;
let p13Lights;
const generated = withRandomCounter(() => {
  first = buildNightLights(plan, null, sources);
  repeat = buildNightLights(plan, null, sources);
  empty = buildNightLights({ parcels: [], features: plan.features }, null, {
    owners: new Map(),
  });
  p13Lights = buildNightLights(
    { parcels: [p13], features: {} },
    null,
    p13Sources,
  );
});
assert.equal(
  generated.calls - baseline.calls,
  0,
  "nightlight policy consumed global Math.random beyond Three resource UUIDs",
);
assert.equal(
  snapshot(first),
  snapshot(repeat),
  "identical nightlight inputs are not byte-deterministic",
);

const mesh = first.group.getObjectByName("nightlight-physical");
assert(
  mesh?.isMesh && first.group.children.length === 1,
  "nightlights lost their single physical hanji owner",
);
const dofDepthMaterial = mesh.userData.dofDepthMaterial;
assert(
  dofDepthMaterial?.isShaderMaterial,
  "nightlights lost their explicit packed-depth material",
);
const drawableMaterials = new Set();
const drawableTextures = new Set();
first.group.traverse((object) => {
  const materials = Array.isArray(object.material)
    ? object.material
    : object.material
      ? [object.material]
      : [];
  for (const material of materials) {
    drawableMaterials.add(material);
    for (const value of Object.values(material)) {
      if (value?.isTexture) drawableTextures.add(value);
    }
    for (const uniform of Object.values(material.uniforms || {})) {
      if (uniform?.value?.isTexture) drawableTextures.add(uniform.value);
    }
  }
});
drawableMaterials.add(dofDepthMaterial);
assert.equal(
  drawableMaterials.size,
  2,
  "nightlights lost their color + packed-depth material pair",
);
assert.equal(drawableTextures.size, 0, "nightlights allocated a texture");
assert.equal(
  dofDepthMaterialForObject(mesh),
  dofDepthMaterial,
  "nightlight mesh did not publish its owned packed-depth material",
);
assert.equal(
  dofDepthMaterial.allowOverride,
  false,
  "nightlight packed-depth material can be replaced by the scene override",
);
assert.equal(
  dofDepthMaterial.depthWrite,
  true,
  "nightlight packed-depth material stopped writing packed depth",
);
assert.equal(
  dofDepthMaterial.uniforms,
  mesh.material.uniforms,
  "nightlight color and packed-depth materials stopped sharing uniform identity",
);
assert.equal(
  dofDepthMaterial.vertexShader,
  mesh.material.vertexShader,
  "nightlight color and packed-depth paths stopped sharing exact geometry/visibility",
);
assert(
  dofDepthMaterial.fragmentShader.includes("nightlightPaperProfile") &&
    dofDepthMaterial.fragmentShader.includes("paper * vIntensity * 0.72 <= 0.18") &&
    dofDepthMaterial.fragmentShader.includes("packDepthToRGBA(gl_FragCoord.z)"),
  "nightlight packed-depth fragment drifted from its visible hanji silhouette",
);
const resources = first.debugState();
assert.deepEqual(
  resources,
  {
    lightCount: 11,
    ownerCount: 4,
    drawCalls: 1,
    dofDepthDrawCalls: 1,
    triangles: 22,
    materials: 2,
    programs: 2,
    textures: 0,
    lights: 0,
    depthTest: true,
  },
  "nightlight resource budget changed",
);
assert.equal(
  mesh.material.depthTest,
  true,
  "nightlights no longer use scene depth",
);
assert.equal(
  mesh.material.depthWrite,
  false,
  "nightlights write into scene depth",
);
assert.equal(
  first.group.getObjectsByProperty("isLight", true).length,
  0,
  "nightlights allocated a scene light",
);
assert.equal(
  empty.debugState().lightCount,
  0,
  "features without authored anchors created free-floating lights",
);
assert.equal(
  empty.group.children.length,
  0,
  "empty authored sources allocated a drawable",
);
assert.equal(
  empty.debugOwner("palace"),
  null,
  "palace without authored anchors acquired an owner",
);
assert.equal(
  empty.debugOwner("temple"),
  null,
  "temple without authored anchors acquired an owner",
);
assert.equal(
  empty.debugOwner("pavilion"),
  null,
  "pavilion without authored anchors acquired an owner",
);

const capacities = Object.fromEntries(
  ownerIds.map((id) => [id, first.debugOwner(id).capacity]),
);
assert.deepEqual(
  capacities,
  {
    [regular.id]: 2,
    [choga.id]: 2,
    [hero.id]: 3,
    palace: 4,
  },
  "fixed owner capacity changed",
);
assert.equal(
  first.debugOwner("temple"),
  null,
  "temple inferred a light without an authored anchor",
);
assert.equal(
  first.debugOwner("pavilion"),
  null,
  "pavilion inferred a light without an authored anchor",
);

for (const [parcel, authored] of [
  [regular, giwaAnchors],
  [choga, chogaAnchors],
]) {
  const sourceById = new Map(authored.map((item) => [item.openingId, item]));
  const matrix = houseMatrix(parcel);
  const owner = first.debugOwner(parcel.id);
  assert(owner.selected.length > 0, `${parcel.id} selected no actual opening`);
  for (const selected of owner.selected) {
    const local = sourceById.get(selected.openingId);
    assert(local, `${parcel.id} invented opening ${selected.openingId}`);
    const expected = new THREE.Vector3(
      local.position.x,
      local.position.y,
      local.position.z,
    ).applyMatrix4(matrix);
    close(selected.x, expected.x, `${parcel.id}:${selected.openingId} x`);
    close(selected.y, expected.y, `${parcel.id}:${selected.openingId} y`);
    close(selected.z, expected.z, `${parcel.id}:${selected.openingId} z`);
  }
}
assert.deepEqual(
  first.debugOwner(hero.id).selected.map((item) => item.openingId),
  ["hero-authored-door"],
  "hero did not select its renderer-authored opening",
);
assert.deepEqual(
  first.debugOwner("palace").selected.map((item) => item.openingId),
  ["palace-authored-window"],
  "palace did not select its renderer-authored opening",
);

const p13Owner = p13Lights.debugOwner("p13");
const p13Expected = new THREE.Vector3(
  p13Local.position.x,
  p13Local.position.y,
  p13Local.position.z,
).applyMatrix4(houseMatrix(p13));
assert.deepEqual(
  p13Owner.selected.map((item) => item.openingId),
  [p13Local.openingId],
  "production p13 selected a non-authored opening",
);
close(p13Owner.selected[0].x, p13Expected.x, "production p13 x");
close(p13Owner.selected[0].y, p13Expected.y, "production p13 y");
close(p13Owner.selected[0].z, p13Expected.z, "production p13 z");

const baseOwner = JSON.stringify(first.debugOwner(regular.id));
const basePositionBytes = bytes(mesh.geometry.getAttribute("aAnchor"));
const geometry = mesh.geometry;
const material = mesh.material;
const positionAttribute = geometry.getAttribute("aAnchor");
const overlay = new THREE.Group();
overlay.position.set(-4, 2.5, 6);
overlay.rotation.y = -0.28;
overlay.userData.openingGlowAnchors = [
  anchor(
    "overlay-authored-window",
    { x: 0.4, y: 1.9, z: 2.6 },
    { x: 0, y: 0, z: 1 },
  ),
];
const villageRoot = new THREE.Group();
villageRoot.position.set(80, 3, -45);
villageRoot.rotation.y = 0.41;
villageRoot.add(first.group, overlay);

assert.equal(
  first.refreshOwner(regular.id, overlay),
  true,
  "overlay refresh rejected a known owner",
);
const overlayOwner = first.debugOwner(regular.id);
assert.deepEqual(
  overlayOwner.selected.map((item) => item.openingId),
  ["overlay-authored-window"],
  "overlay refresh did not use its renderer-authored opening",
);
const overlayExpected = new THREE.Vector3(0.4, 1.9, 2.6).applyMatrix4(
  overlay.matrix,
);
close(overlayOwner.selected[0].x, overlayExpected.x, "overlay village-local x");
close(overlayOwner.selected[0].y, overlayExpected.y, "overlay village-local y");
close(overlayOwner.selected[0].z, overlayExpected.z, "overlay village-local z");
assert.equal(
  first.debugState().lightCount,
  resources.lightCount,
  "overlay refresh changed light capacity",
);
assert.equal(mesh.geometry, geometry, "overlay refresh replaced geometry");
assert.equal(mesh.material, material, "overlay refresh replaced material");
assert.equal(
  mesh.geometry.getAttribute("aAnchor"),
  positionAttribute,
  "overlay refresh replaced the fixed position buffer",
);
assert.equal(
  first.refreshOwner(regular.id, null),
  true,
  "null overlay did not restore base anchors",
);
assert.equal(
  JSON.stringify(first.debugOwner(regular.id)),
  baseOwner,
  "null overlay restore changed base selection",
);
assert.equal(
  bytes(positionAttribute),
  basePositionBytes,
  "null overlay restore changed base position bytes",
);
assert.equal(
  first.refreshOwner("missing-owner", overlay),
  false,
  "unknown overlay owner was accepted",
);

const crossKindOverlay = new THREE.Group();
crossKindOverlay.userData.style = "giwa";
crossKindOverlay.userData.openingGlowAnchors = [
  anchor("cross-kind-front", { x: 0.1, y: 1.4, z: 2 }, { x: 0, y: 0, z: 1 }),
  anchor("cross-kind-rear", { x: -0.2, y: 1.5, z: -2 }, { x: 0, y: 0, z: -1 }),
];
assert.equal(
  first.debugOwner(choga.id).kind,
  "choga",
  "base choga profile lost its kind",
);
assert.equal(
  first.debugOwner(choga.id).desired,
  1,
  "base low-wealth choga light policy changed",
);
assert.equal(
  first.refreshOwner(choga.id, crossKindOverlay),
  true,
  "cross-kind overlay refresh rejected a known owner",
);
assert.equal(
  first.debugOwner(choga.id).kind,
  "giwa",
  "cross-kind overlay kept the original parcel light policy",
);
assert.equal(
  first.debugOwner(choga.id).desired,
  2,
  "edited giwa overlay did not acquire the giwa room-light policy",
);
assert.equal(
  first.refreshOwner(choga.id, null),
  true,
  "cross-kind null restore failed",
);
assert.equal(
  first.debugOwner(choga.id).kind,
  "choga",
  "cross-kind null restore did not recover the base parcel policy",
);

assert.equal(mesh.visible, false, "nightlights start visible during day");
first.setLevel(1);
assert.equal(
  mesh.visible,
  true,
  "nightlights did not become visible at night",
);
first.group.userData.waveFade.setWeight(0);
assert.equal(mesh.visible, false, "wave zero did not hide nightlights");
first.group.userData.waveFade.setWeight(0.5);
assert.equal(
  mesh.visible,
  true,
  "partial wave did not restore nightlight visibility",
);
assert.equal(
  material.uniforms.uWave.value,
  0.5,
  "wave weight did not reach the shader",
);
first.group.userData.waveFade.setWeight(Number.NaN);
assert.equal(mesh.visible, false, "invalid wave weight remained visible");
first.group.userData.waveFade.setWeight(1);
first.update(0, 1, Number.POSITIVE_INFINITY);
close(
  material.uniforms.uLensScale.value,
  1,
  "invalid nightlight lens scale did not fail to identity",
);
first.update(0, 1, VILLAGE_LENS_SCALE_MAX + 1);
close(
  material.uniforms.uLensScale.value,
  VILLAGE_LENS_SCALE_MAX,
  "nightlight projection clipped before the narrowest authored lens",
);
first.update(0.25, 1, 1.4);
assert.equal(
  material.uniforms.uTime.value,
  0.25,
  "visible update did not advance deterministic flicker time",
);
first.group.userData.waveFade.setWeight(0.65);

let geometryDisposals = 0;
let materialDisposals = 0;
let depthMaterialDisposals = 0;
geometry.addEventListener("dispose", () => {
  geometryDisposals++;
});
material.addEventListener("dispose", () => {
  materialDisposals++;
});
dofDepthMaterial.addEventListener("dispose", () => {
  depthMaterialDisposals++;
});
const beforeDisposeBytes = bytes(positionAttribute);
const beforeDisposeTime = material.uniforms.uTime.value;
const beforeDisposeNight = material.uniforms.uNight.value;
const beforeDisposeLensScale = material.uniforms.uLensScale.value;
const beforeDisposeWave = material.uniforms.uWave.value;
first.dispose();
first.dispose();
assert.equal(
  geometryDisposals,
  1,
  "nightlight geometry was not disposed exactly once",
);
assert.equal(
  materialDisposals,
  1,
  "nightlight material was not disposed exactly once",
);
assert.equal(
  depthMaterialDisposals,
  1,
  "nightlight packed-depth material was not disposed exactly once",
);
assert.equal(
  mesh.userData.dofDepthMaterial,
  undefined,
  "disposed nightlights retained their packed-depth material contract",
);
assert.equal(mesh.visible, false, "disposed nightlights remained visible");
assert.equal(
  first.refreshOwner(regular.id, overlay),
  false,
  "disposed owner accepted an overlay refresh",
);
first.setLevel(1);
first.setPixelRatio(3);
first.update(1, 1, 2);
first.setDepthTestForTest(false);
first.group.userData.waveFade.setWeight(0);
assert.equal(
  bytes(positionAttribute),
  beforeDisposeBytes,
  "disposed API mutated its position buffer",
);
assert.equal(
  material.uniforms.uTime.value,
  beforeDisposeTime,
  "disposed API advanced flicker time",
);
assert.equal(
  material.uniforms.uNight.value,
  beforeDisposeNight,
  "disposed API changed night level",
);
assert.equal(
  material.uniforms.uLensScale.value,
  beforeDisposeLensScale,
  "disposed API changed lens scale",
);
assert.equal(
  material.uniforms.uWave.value,
  beforeDisposeWave,
  "disposed API changed wave weight",
);
assert.equal(
  material.depthTest,
  true,
  "disposed API changed material depth state",
);
assert.equal(mesh.visible, false, "disposed API revived its drawable");

repeat.dispose();
empty.dispose();
p13Lights.dispose();
console.log(
  "NIGHTLIGHTS CONTRACT: PASS (deterministic, anchored, fixed-resource)",
);
