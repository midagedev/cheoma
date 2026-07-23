import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  buildTempleCompound,
  disposeTempleCompound,
  normalizeTemplePlan,
  planTempleCompound,
  templePlanIssues,
} from '../src/api/temple.js';
import { templeCameraFraming } from '../src/runtime/village/picking.js';
import { mergeStatic } from '../src/village/instancing.js';

const query = new URLSearchParams(location.search);
const variant = ['compact', 'courtyard', 'extended'].includes(query.get('variant'))
  ? query.get('variant') : 'courtyard';
const seed = Number.parseInt(query.get('seed') || '20260716', 10) >>> 0;
const shot = query.get('shot') === '1';
const debug = query.get('debug') === '1';
const lifecycleProbe = query.get('probe') === '1';
const merged = query.get('merged') === '1';
const inputSchemaVersion = query.get('schema') === '1' ? 1 : 2;
if (shot) document.body.classList.add('shot');
for (const link of document.querySelectorAll('[data-variant]')) {
  link.classList.toggle('on', link.dataset.variant === variant);
}

// Keep harness output byte-stable even for legacy builders that still sample the
// global RNG while constructing minor fence details.
let randomState = (seed ^ 0x51f15e) >>> 0;
Math.random = () => {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  randomState >>>= 0;
  return randomState / 0x100000000;
};

const authoredPlan = planTempleCompound({ variant, seed });
const inputPlan = JSON.parse(JSON.stringify(authoredPlan));
if (inputSchemaVersion === 1) {
  inputPlan.schemaVersion = 1;
  for (const building of inputPlan.buildings) {
    for (const field of [
      'architecturalRank', 'architectureId', 'roofGrammar', 'bracketGrammar',
      'eaveGrammar', 'massingGrammar', 'eaveFootprint',
    ]) delete building[field];
    building.footprint = { width: 1, depth: 1 };
  }
}
const plan = normalizeTemplePlan(inputPlan);
const compound = buildTempleCompound(inputPlan);
compound.updateMatrixWorld(true);
const hallBounds = plan.buildings.map((spec) => {
  const hall = compound.getObjectByName(`temple-${spec.id}`);
  const roof = hall?.getObjectByName('roof');
  const size = roof
    ? new THREE.Box3().setFromObject(roof).getSize(new THREE.Vector3())
    : new THREE.Vector3();
  return {
    id: spec.id,
    role: spec.role,
    architectureId: spec.architectureId,
    architecturalRank: spec.architecturalRank,
    roof: spec.roofGrammar.type,
    bracket: spec.bracketGrammar.family,
    eave: {
      plannedWidth: spec.eaveFootprint.width,
      plannedDepth: spec.eaveFootprint.depth,
      renderedWidth: +size.x.toFixed(3),
      renderedDepth: +size.z.toFixed(3),
    },
  };
});
const renderRoot = merged ? mergeStatic([compound], 'temple-viewer-merged') : compound;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc7d1d7);
scene.fog = new THREE.Fog(0xc7d1d7, plan.depth * 1.45, plan.depth * 4.8);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('app').appendChild(renderer.domElement);

renderRoot.traverse((object) => {
  if (object.isMesh || object.isInstancedMesh) {
    object.castShadow = true;
    object.receiveShadow = true;
  }
});
scene.add(renderRoot);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(Math.max(plan.width, plan.depth) * 1.35, 96),
  new THREE.MeshStandardMaterial({ color: 0x9d9a75, roughness: 1, metalness: 0 }),
);
ground.name = 'temple-viewer-ground';
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.035;
ground.receiveShadow = true;
scene.add(ground);

// Winter-safe southern sun. If the semantic lane is clear, the main hall front
// and court receive light while shadows fall toward the northern backdrop.
const sun = new THREE.DirectionalLight(0xffd3a0, 3.25);
sun.position.set(plan.width * 0.42, 46, plan.depth * 1.25);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const shadowExtent = Math.max(plan.width, plan.depth) * 0.75;
Object.assign(sun.shadow.camera, {
  left: -shadowExtent, right: shadowExtent, top: shadowExtent, bottom: -shadowExtent,
  near: 1, far: 170,
});
sun.shadow.bias = -0.00025;
sun.shadow.normalBias = 0.045;
scene.add(sun, new THREE.HemisphereLight(0xd9e4ed, 0x655a47, 1.18));

if (debug && plan.solarAccess) {
  const laneDepth = plan.solarAccess.southZ - plan.solarAccess.origin.z;
  const lane = new THREE.Mesh(
    new THREE.PlaneGeometry(plan.solarAccess.halfWidth * 2, laneDepth),
    new THREE.MeshBasicMaterial({ color: 0xffd769, transparent: true, opacity: 0.24, depthWrite: false }),
  );
  lane.name = 'solar-access-debug';
  lane.rotation.x = -Math.PI / 2;
  lane.position.set(plan.solarAccess.origin.x, 0.095, plan.solarAccess.origin.z + laneDepth / 2);
  scene.add(lane);
}

const camera = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.1, 500);
const view = query.get('view') || 'focus';
if (view === 'aerial') {
  camera.fov = 40;
  camera.position.set(plan.width * 0.58, plan.depth * 0.92, plan.depth * 0.88);
  camera.lookAt(0, 2.6, -plan.depth * 0.05);
} else {
  const framing = templeCameraFraming(new THREE.Vector3(), 0, plan.width, plan.depth);
  camera.fov = framing.fov;
  camera.position.copy(framing.position);
  camera.lookAt(framing.target);
}
camera.updateProjectionMatrix();
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 3, -plan.depth * 0.04);
controls.update();

const bounds = new THREE.Box3().setFromObject(renderRoot);
const size = bounds.getSize(new THREE.Vector3());
let lifecycle = null;
if (lifecycleProbe) {
  const callerMaterial = compound.userData.mats.wood;
  let callerMaterialDisposed = 0;
  callerMaterial?.addEventListener('dispose', () => { callerMaterialDisposed++; });
  const sharedProbe = buildTempleCompound(plan, { mats: compound.userData.mats });
  const sharedGeometry = sharedProbe.getObjectByProperty('isMesh', true)?.geometry;
  let sharedGeometryDisposed = 0;
  sharedGeometry?.addEventListener('dispose', () => { sharedGeometryDisposed++; });
  const first = disposeTempleCompound(sharedProbe);
  const second = disposeTempleCompound(sharedProbe);

  const ownedProbe = buildTempleCompound(plan);
  let ownedMaterialDisposed = 0;
  const ownedMaterial = ownedProbe.userData.mats.wood;
  ownedMaterial?.addEventListener('dispose', () => { ownedMaterialDisposed++; });
  const owned = disposeTempleCompound(ownedProbe);
  lifecycle = {
    first, second, owned,
    sharedGeometryDisposed,
    callerMaterialDisposed,
    ownedMaterialDisposed,
  };
}

// Render once synchronously so a throttled background tab still completes the
// automated contract. The animation loop below exists only for manual orbiting.
controls.update();
renderer.render(scene, camera);
const materials = new Set();
let palaceOrnaments = 0;
renderRoot.traverse((object) => {
  const current = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of current) if (material?.isMaterial) materials.add(material);
  if (object.name === 'palace-japsang' || object.name === 'palace-chwidu') palaceOrnaments++;
});
window.__TEMPLE_DIAG = {
  variant,
  merged,
  inputSchemaVersion,
  schemaVersion: compound.userData.templeSchemaVersion,
  size: { width: plan.width, depth: plan.depth },
  renderedBounds: { x: +size.x.toFixed(3), y: +size.y.toFixed(3), z: +size.z.toFixed(3) },
  counts: {
    buildings: plan.buildings.length,
    courtyards: plan.courtyards.length,
    enclosures: plan.enclosures.length,
    gates: plan.gates.length,
    props: plan.props.length,
  },
  roles: plan.buildings.map((building) => building.role),
  architecture: hallBounds,
  issues: templePlanIssues(plan),
  camera: {
    fov: camera.fov,
    southOffset: +(camera.position.z - controls.target.z).toFixed(3),
  },
  render: {
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    programs: renderer.info.programs?.length || 0,
    materials: materials.size,
    palaceOrnaments,
  },
  lifecycle,
};
window.__TEMPLE_READY = true;
document.documentElement.dataset.templeReady = 'true';
document.getElementById('app').dataset.templeDiag = JSON.stringify(window.__TEMPLE_DIAG);
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
