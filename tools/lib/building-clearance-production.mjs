import * as THREE from 'three';
import { buildBuilding, disposeBuilding } from '../../src/builder/index.js';
import { PRESETS, computeLayout, giwaFootprint } from '../../src/params.js';
import { buildParcel } from '../../src/layout/parcel.js';

const bounds = (object) => {
  const box = new THREE.Box3().setFromObject(object);
  return {
    min: { x: box.min.x, y: box.min.y, z: box.min.z },
    max: { x: box.max.x, y: box.max.y, z: box.max.z },
  };
};

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
    disposeBuilding(building);
  }

  const parcel = buildParcel({ style: 'hanok', lanterns: false, materials: testMaterials() });
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
  };
  disposeBuilding(giwa);
  return result;
}
