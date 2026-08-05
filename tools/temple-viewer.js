import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  buildTempleCompound,
  disposeTempleCompound,
  normalizeTemplePlan,
  planTempleCompound,
  templeHallPlaquePlan,
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
// 산지 프로파일: 마을의 절이 실제로 쓰는 경로다(village/temple-plan.js 가 mountain 을
// 넘긴다). flat 만 띄우면 단(段)·막돌 석축이 렌더되지 않아 병합 콜 측정이 무의미하다.
const profile = query.get('profile') === 'mountain' ? 'mountain' : 'flat';
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

const authoredPlan = planTempleCompound({ variant, seed, entryProfile: profile });
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
// 현판: rendered geometry vs the plan-owned record. Measured on the unmerged
// compound so the merged budget run reports the same placement evidence.
const plaqueRecords = [];
compound.traverse((object) => {
  if (object.name === 'hall-plaque') plaqueRecords.push(object);
});
const plaques = plaqueRecords.map((group) => {
  const host = group.parent;
  const plan = group.userData.templePlaque;
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const board = group.getObjectByName('plaque-board');
  const rail = group.getObjectByName('plaque-molding-top');
  const hostMats = host.userData.materials;
  const front = new THREE.Vector3(0, 0, 1).applyQuaternion(host.getWorldQuaternion(new THREE.Quaternion()));
  const center = box.getCenter(new THREE.Vector3());
  const hostCenter = host.getWorldPosition(new THREE.Vector3());
  return {
    hostId: host.userData.templeId,
    hostRole: host.userData.templeRole,
    hostRank: host.userData.templeArchitecture?.architecturalRank,
    lettering: plan?.lettering || null,
    meshes: group.children.length,
    // Same-side test: the plaque must sit on the hall's front (south) face.
    frontDot: +front.dot(center.clone().sub(hostCenter)).toFixed(3),
    world: { width: +size.x.toFixed(3), height: +size.y.toFixed(3), depth: +size.z.toFixed(3) },
    plannedWorld: plan ? { width: +plan.world.width.toFixed(3), height: +plan.world.height.toFixed(3) } : null,
    // Local-space band, so the assertion is scale- and placement-independent.
    localTopY: plan ? +plan.topY.toFixed(3) : null,
    localBottomY: plan ? +plan.bottomY.toFixed(3) : null,
    bracketBaseY: plan ? +plan.band.bracketBaseY.toFixed(3) : null,
    columnTopY: plan ? +plan.band.columnTopY.toFixed(3) : null,
    eaveEdgeY: plan ? +plan.band.eaveEdgeY.toFixed(3) : null,
    borrowedBoard: !!hostMats && board?.material === hostMats.planwall,
    borrowedMolding: !!hostMats && rail?.material === hostMats.wood,
    ownTexture: !!board?.material?.map,
    // 환경맵 없는 처마 그늘에서 metalness는 디퓨즈 순손실이다 (2026-08-05 비전 FIX).
    boardMetalness: board?.material?.metalness ?? null,
    moldingMetalness: rail?.material?.metalness ?? null,
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
// `view=plaque`: close front elevation of the principal hall's 어칸 현판 band. The
// framing is derived from the plan record (not the built mesh) so a capture taken
// before the plaque exists uses the identical camera.
let viewTarget = null;
if (view === 'plaque') {
  const host = compound.getObjectByName(`temple-${plan.buildings.find(
    (building) => building.architecturalRank === 4,
  ).id}`);
  const record = templeHallPlaquePlan(plan.buildings.find(
    (building) => building.architecturalRank === 4,
  ));
  host.updateMatrixWorld(true);
  viewTarget = new THREE.Vector3(record.local.x, record.local.y, record.local.z)
    .applyMatrix4(host.matrixWorld);
  const front = new THREE.Vector3(0, 0, 1)
    .applyQuaternion(host.getWorldQuaternion(new THREE.Quaternion())).normalize();
  camera.fov = 22;
  camera.position.copy(viewTarget).addScaledVector(front, 15);
  camera.position.y = viewTarget.y + 1.1;
  camera.lookAt(viewTarget);
} else if (view === 'aerial') {
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
if (viewTarget) controls.target.copy(viewTarget);
else controls.target.set(0, 3, -plan.depth * 0.04);
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
// Exact screen rect of each plaque board, so a pixel probe can sample the board
// interior instead of guessing an inset from a diff bounding box.
camera.updateMatrixWorld(true);
for (const [index, group] of plaqueRecords.entries()) {
  const board = group.getObjectByName('plaque-board');
  board.updateMatrixWorld(true);
  const local = new THREE.Box3().setFromBufferAttribute(board.geometry.attributes.position);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const cx of [local.min.x, local.max.x]) {
    for (const cy of [local.min.y, local.max.y]) {
      for (const cz of [local.min.z, local.max.z]) {
        const point = new THREE.Vector3(cx, cy, cz).applyMatrix4(board.matrixWorld).project(camera);
        const px = (point.x * 0.5 + 0.5) * innerWidth;
        const py = (1 - (point.y * 0.5 + 0.5)) * innerHeight;
        x0 = Math.min(x0, px); x1 = Math.max(x1, px);
        y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }
    }
  }
  plaques[index].screen = {
    x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x1), y1: Math.round(y1),
    viewport: { width: innerWidth, height: innerHeight },
  };
}
window.__TEMPLE_DIAG = {
  variant,
  profile,
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
  terraces: plan.terraces ? {
    profile: plan.terraces.profile,
    rise: plan.terraces.rise,
    base: plan.terraces.base,
    tierCount: plan.terraces.tierCount,
    tiers: plan.terraces.tiers.map((tier) => ({
      id: tier.id, level: tier.level, elevation: tier.elevation,
      northZ: tier.northZ, southZ: tier.southZ, minX: tier.minX, maxX: tier.maxX,
      buildingIds: tier.buildingIds,
    })),
    risers: plan.terraces.risers.map((riser) => ({
      id: riser.id, level: riser.level, rise: riser.rise, z: riser.z,
      segments: riser.segments.length,
      topSpread: +(Math.max(...riser.segments.map((s) => s.topY))
        - Math.min(...riser.segments.map((s) => s.topY))).toFixed(4),
      stairOffset: riser.stair.offsetFromAxis,
    })),
  } : null,
  // 렌더된 단·석축이 실제로 존재하는지: 이름으로 찾는다(병합 뒤에는 사라지므로
  // raw 모드에서만 유효하다).
  renderedTerraceNodes: (() => {
    let tiers = 0, risers = 0;
    compound.traverse((node) => {
      if (/^terrace-\d+$/.test(node.name)) tiers++;
      if (node.name === 'terrace-risers') risers++;
    });
    return { tiers, risers };
  })(),
  buildingLifts: plan.buildings.map((building) => ({
    id: building.id, terraceLevel: building.terraceLevel ?? null,
    elevation: building.elevation ?? 0,
  })),
  enclosureShapes: plan.enclosures.map((enclosure) => ({
    id: enclosure.id, closed: enclosure.closed !== false,
    gateSeg: enclosure.gateSeg || 0, points: enclosure.polygon.length,
  })),
  architecture: hallBounds,
  plaques,
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
