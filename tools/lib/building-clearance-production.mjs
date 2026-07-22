import * as THREE from 'three';
import { buildBuilding, disposeBuilding } from '../../src/builder/index.js';
import { PRESETS, computeLayout, giwaFootprint } from '../../src/params.js';
import { buildParcel } from '../../src/layout/parcel.js';
import { mergeOwnedGeometries } from '../../src/core/merge-owned-geometries.js';

const bounds = (object) => {
  const box = new THREE.Box3().setFromObject(object);
  return {
    min: { x: box.min.x, y: box.min.y, z: box.min.z },
    max: { x: box.max.x, y: box.max.y, z: box.max.z },
  };
};

function inspectOwnedMergeFailure() {
  const indexed = new THREE.BoxGeometry(1, 1, 1);
  const nonIndexed = new THREE.BoxGeometry(1, 1, 1);
  nonIndexed.setIndex(null);
  const disposed = [0, 0];
  indexed.addEventListener('dispose', () => { disposed[0]++; });
  nonIndexed.addEventListener('dispose', () => { disposed[1]++; });
  const originalError = console.error;
  let threw = false;
  console.error = () => {};
  try {
    mergeOwnedGeometries([indexed, nonIndexed], 'Intentional mismatch');
  } catch (error) {
    threw = /incompatible attributes/.test(error.message);
  } finally {
    console.error = originalError;
  }
  return { threw, disposed };
}

function testMaterials() {
  const data = new Uint8Array([255, 255, 255, 255]);
  const texture = new THREE.DataTexture(data, 1, 1);
  texture.needsUpdate = true;
  const materials = {};
  return new Proxy(materials, {
    get(target, key) {
      if (typeof key === 'symbol') return target[key];
      if (key === 'tileTex') return texture;
      if (!target[key]) {
        const material = new THREE.MeshStandardMaterial({ color: 0xffffff, map: texture });
        material.userData.role = key === 'door' || key === 'salchang' ? 'opening' : key;
        material.userData.paletteKey = String(key);
        if (['wood', 'woodDark', 'door', 'salchang', 'hanji'].includes(key)) {
          material.userData.lodEnvelope = true;
        }
        target[key] = material;
      }
      return target[key];
    },
  });
}

function rayHits(mesh, x, z) {
  mesh.updateWorldMatrix(true, false);
  const raycaster = new THREE.Raycaster(
    new THREE.Vector3(x, 10, z),
    new THREE.Vector3(0, -1, 0),
  );
  return raycaster.intersectObject(mesh, false).length;
}

const podiumLayerNames = [
  'podium-lower',
  'podium-upper',
  'podium-course-joint',
  'podium-cap',
  'podium-vertical-joints',
];

function inspectGiwaPodium(building, params) {
  const podium = building.getObjectByName('podium');
  const { a, b, w, c } = giwaFootprint(params);
  const wingProbe = { x: a - w * 0.5, z: b + c * 0.5 };
  const notchProbe = { x: (-a + a - w) * 0.5, z: b + c * 0.5 };
  return {
    podiumChildren: podium.children.length,
    layerCounts: Object.fromEntries(podiumLayerNames.map((name) => [
      name,
      podium.children.filter((child) => child.name === name).length,
    ])),
    layerHits: Object.fromEntries(podiumLayerNames.slice(0, 4).map((name) => {
      const layer = building.getObjectByName(name);
      return [name, {
        insideWing: rayHits(layer, wingProbe.x, wingProbe.z),
        emptyNotch: rayHits(layer, notchProbe.x, notchProbe.z),
      }];
    })),
  };
}

const HEARTH_NAMES = [
  'kitchen-opening',
  'kitchen-threshold',
  'kitchen-door',
  'hearth-pot',
  'agungiEmber',
  'agungiFire',
];

function inspectHearth(building, wallX) {
  const hearth = building.getObjectByName('agungi');
  const counts = Object.fromEntries(HEARTH_NAMES.map((name) => [name, 0]));
  hearth?.traverse((object) => {
    if (object.name in counts) counts[object.name]++;
  });
  return {
    wallX,
    counts,
    bounds: bounds(hearth),
    openingBounds: bounds(hearth.getObjectByName('kitchen-opening')),
    thresholdBounds: bounds(hearth.getObjectByName('kitchen-threshold')),
  };
}

function inspectPrimaryOpeningFace(panel, frame, anchor) {
  const plan = anchor?.userData?.openingDetailPlan;
  const panelPositions = panel?.geometry?.attributes?.position;
  const framePositions = frame?.geometry?.attributes?.position;
  if (!plan || !panelPositions || !framePositions) return null;
  panel.updateWorldMatrix(true, false);
  frame.updateWorldMatrix(true, false);
  anchor.updateWorldMatrix(true, false);
  const panelToOpening = new THREE.Matrix4()
    .copy(anchor.matrixWorld)
    .invert()
    .multiply(panel.matrixWorld);
  const frameToOpening = new THREE.Matrix4()
    .copy(anchor.matrixWorld)
    .invert()
    .multiply(frame.matrixWorld);
  const point = new THREE.Vector3();
  let panelFront = -Infinity;
  for (let index = 0; index < panelPositions.count; index++) {
    point.fromBufferAttribute(panelPositions, index).applyMatrix4(panelToOpening);
    panelFront = Math.max(panelFront, point.z);
  }
  let frameFront = -Infinity;
  const uLimit = plan.width * 0.5 + plan.frame.width;
  const yMin = plan.frame.width * 1.5;
  const yMax = plan.height + plan.frame.width;
  for (let index = 0; index < framePositions.count; index++) {
    point.fromBufferAttribute(framePositions, index).applyMatrix4(frameToOpening);
    if (Math.abs(point.x) <= uLimit && point.y >= yMin && point.y <= yMax) {
      frameFront = Math.max(frameFront, point.z);
    }
  }
  if (!Number.isFinite(panelFront) || !Number.isFinite(frameFront)) return null;
  return {
    panelFront,
    frameFront,
    clearance: frameFront - panelFront,
    expectedClearance: plan.reveal.faceClearance + plan.frame.depth,
  };
}

function inspectOpenings(building) {
  const counts = {
    frame: 0,
    hardware: 0,
    primaryAnchor: 0,
    primaryPanel: 0,
  };
  let frame = null;
  let hardware = null;
  let anchor = null;
  let primaryPanel = null;
  const triangles = (mesh) => {
    if (!mesh?.geometry) return 0;
    return mesh.geometry.index
      ? mesh.geometry.index.count / 3
      : (mesh.geometry.attributes?.position?.count || 0) / 3;
  };
  building.traverse((object) => {
    if (object.name === 'opening-frame-details') { counts.frame++; frame = object; }
    if (object.name === 'opening-hardware-details') { counts.hardware++; hardware = object; }
    if (object.name === 'primary-opening-anchor') { counts.primaryAnchor++; anchor = object; }
    if (object.name === 'primary-opening-panel') {
      counts.primaryPanel++;
      primaryPanel = object;
    }
  });
  return {
    counts,
    frameVertices: frame?.geometry?.attributes?.position?.count || 0,
    hardwareVertices: hardware?.geometry?.attributes?.position?.count || 0,
    frameTriangles: triangles(frame),
    hardwareTriangles: triangles(hardware),
    frameEnvelope: frame?.material?.userData?.lodEnvelope === true,
    hardwareEnvelope: hardware?.material?.userData?.lodEnvelope === true,
    hardwarePaletteKey: hardware?.material?.userData?.paletteKey || null,
    plan: anchor?.userData?.openingDetailPlan || null,
    primaryFace: inspectPrimaryOpeningFace(primaryPanel, frame, anchor),
  };
}

export function inspectBuildingClearance() {
  const giwaParams = { ...PRESETS.giwa, mats: testMaterials() };
  const giwa = buildBuilding(giwaParams);
  const podiumShape = inspectGiwaPodium(giwa, giwaParams);
  const lower = giwa.getObjectByName('podium-lower');
  const host = giwa.getObjectByName('plank-wall-window-bay');
  const opening = giwa.getObjectByName('plank-opening');
  const hostBounds = bounds(host);
  const openingBounds = bounds(opening);

  const foundations = {};
  const openings = {
    giwa: inspectOpenings(giwa),
  };
  const hearths = {
    giwa: inspectHearth(giwa, giwaFootprint(giwaParams).a),
  };
  let matbaeGableTucks = [];
  for (const style of ['korea', 'temple', 'choga']) {
    const building = buildBuilding({ ...PRESETS[style], mats: testMaterials() });
    foundations[style] = {
      bounds: bounds(building.getObjectByName('podium-tier-0')),
      expectedTop: PRESETS[style].podiumTierH,
    };
    if (style === 'temple') {
      const ridgeY = computeLayout(PRESETS.temple).ridgeY;
      const gables = [];
      building.traverse((object) => {
        if (object.name === 'matbae-gable-wall') gables.push(bounds(object));
      });
      matbaeGableTucks = gables.map((gable) => ridgeY - gable.max.y);
    }
    if (style === 'choga') {
      hearths.choga = inspectHearth(building, computeLayout(PRESETS.choga).xPos.at(-1));
    }
    openings[style] = inspectOpenings(building);
    disposeBuilding(building);
  }

  const parcel = buildParcel({ style: 'hanok', lanterns: false, materials: testMaterials() });
  openings.hanok = inspectOpenings(parcel);
  const giwaBoundaryShapes = [
    ['compact', { mainHalfW: 2.8, mainHalfD: 1.8, wingLen: 2.8, wingW: 1.8, podiumTierH: 0.3 }],
    ['wide', { mainHalfW: 5.2, mainHalfD: 2.8, wingLen: 4.6, wingW: 3.0, podiumTierH: 0.95 }],
    ['clamped', { mainHalfW: 2.0, mainHalfD: 1.2, wingLen: 2.0, wingW: 3.8, podiumTierH: 0.4 }],
  ].map(([name, overrides]) => {
    const params = { ...PRESETS.giwa, ...overrides, mats: testMaterials() };
    const building = buildBuilding(params);
    const shape = inspectGiwaPodium(building, params);
    disposeBuilding(building);
    return { name, ...shape };
  });
  const result = {
    ownedMergeFailure: inspectOwnedMergeFailure(),
    giwa: {
      ...podiumShape,
      lowerBounds: bounds(lower),
      openingFaceClearance: hostBounds.min.z - openingBounds.min.z,
    },
    giwaBoundaryShapes,
    foundations,
    hanokFoundation: bounds(parcel.getObjectByName('foundation-base')),
    courtyardY: parcel.getObjectByName('courtyard-ground').position.y,
    matbaeGableTucks,
    hearths,
    openings,
  };
  disposeBuilding(giwa);
  return result;
}
