import * as THREE from 'three';
import { buildBuilding, disposeBuilding } from '../../src/builder/index.js';
import { PRESETS, computeLayout, giwaFootprint } from '../../src/params.js';
import { buildParcel } from '../../src/layout/parcel.js';
import { mergeOwnedGeometries } from '../../src/core/merge-owned-geometries.js';
import { planThresholdLife } from '../../src/props/threshold-life-plan.js';
import {
  createThresholdLifeMaterial,
  createThresholdLifeMesh,
} from '../../src/props/threshold-life.js';
import {
  planResidentialOpenings,
  residentialOpeningCapabilities,
} from '../../src/layout/residential-openings.js';

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
  const openingBounds = bounds(hearth.getObjectByName('kitchen-opening'));
  const counts = Object.fromEntries(HEARTH_NAMES.map((name) => [name, 0]));
  hearth?.traverse((object) => {
    if (object.name in counts) counts[object.name]++;
  });
  return {
    wallX,
    counts,
    bounds: bounds(hearth),
    openingBounds,
    openingSpanZ: { min: openingBounds.min.z, max: openingBounds.max.z },
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
    thresholdLife: 0,
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
    if (object.name === 'threshold-life-detail') counts.thresholdLife++;
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

function inspectResidentialOpenings(building) {
  const plans = [];
  const panels = [];
  const materials = new Set();
  let meshes = 0;
  building.traverse((object) => {
    if (object.isMesh) {
      meshes++;
      const owned = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of owned) if (material) materials.add(material);
    }
    if (object.userData.residentialOpeningPlan) plans.push(object.userData.residentialOpeningPlan);
    if (object.userData.residentialOpening) {
      const opening = object.userData.residentialOpening;
      const detail = object.userData.residentialOpeningDetail;
      const alongX = Math.abs(opening.tangent.x) >= Math.abs(opening.tangent.z);
      const panelBounds = bounds(object);
      panels.push({
        id: opening.id,
        kind: opening.kind,
        facade: opening.facade,
        primary: opening.primary,
        plannedWidth: opening.width,
        detailLeafCount: detail?.leafCount ?? null,
        textureRepeatX: object.material?.map?.repeat?.x ?? null,
        spanZ: { min: panelBounds.min.z, max: panelBounds.max.z },
        renderedWidth: opening.style === 'choga'
          ? object.geometry?.parameters?.width ?? null
          : alongX
          ? object.geometry?.parameters?.width ?? null
          : object.geometry?.parameters?.depth ?? null,
      });
    }
  });
  const kitchenFrame = building.getObjectByName('kitchen-opening-frame');
  const kitchenFrameBounds = bounds(kitchenFrame);
  return {
    planCount: plans.length,
    plan: plans[0] || null,
    panels,
    meshes,
    materials: materials.size,
    details: inspectOpenings(building),
    kitchenCount: HEARTH_NAMES.every((name) => building.getObjectByName(name)) ? 1 : 0,
    kitchenFrameSpanZ: { min: kitchenFrameBounds.min.z, max: kitchenFrameBounds.max.z },
  };
}

function primarySideSeeds(params) {
  const bySide = new Map();
  for (let seed = 0; seed < 256 && bySide.size < 2; seed++) {
    const primary = planResidentialOpenings('giwa', params, seed)
      .openings.find((opening) => opening.primary);
    const side = primary?.landing?.clearSide;
    if ((side === -1 || side === 1) && !bySide.has(side)) bySide.set(side, seed);
  }
  if (bySide.size !== 2) throw new Error('Giwa fixture cannot select both daecheong landing sides');
  return bySide;
}

function inspectThresholdLanding(building) {
  building.updateWorldMatrix(true, true);
  const anchors = [];
  const returnRailings = [];
  building.traverse((object) => {
    if (object.name === 'primary-opening-anchor') anchors.push(object);
    if (object.name === 'toenmaru-return-railing') returnRailings.push(object);
  });
  const anchor = anchors[0];
  const opening = anchor?.userData?.openingDetailPlan;
  const plan = planThresholdLife({ opening, condition: 'dry', seed: 17 });
  const repeat = planThresholdLife({ opening, condition: 'dry', seed: 17 });
  const material = createThresholdLifeMaterial();
  const mesh = createThresholdLifeMesh(plan, anchor.matrixWorld, material);
  const shoeBox = new THREE.Box3().setFromObject(mesh);
  const deckBox = new THREE.Box3().setFromObject(building.getObjectByName('toenmaru'));
  const daecheongBox = new THREE.Box3().setFromObject(building.getObjectByName('daecheong-floor'));
  const railBoxes = returnRailings.map((railing) => new THREE.Box3().setFromObject(railing));
  const result = {
    anchorCount: anchors.length,
    openingSide: opening?.anchors?.footwear?.clearSide ?? null,
    placementSide: plan?.clearance?.placementSide ?? null,
    thresholdClearance: plan?.clearance?.threshold ?? null,
    approachClearance: plan?.clearance?.approach ?? null,
    jambClearance: plan?.clearance?.jamb ?? null,
    signatureStable: plan?.placement?.signature === repeat?.placement?.signature
      && JSON.stringify(plan) === JSON.stringify(repeat),
    deckContains: shoeBox.min.x >= deckBox.min.x - 1e-6
      && shoeBox.max.x <= deckBox.max.x + 1e-6
      && shoeBox.min.z >= deckBox.min.z - 1e-6
      && shoeBox.max.z <= deckBox.max.z + 1e-6,
    returnRailingOverlaps: railBoxes.filter((box) => box.intersectsBox(shoeBox)).length,
    daecheongOverlap: daecheongBox.intersectsBox(shoeBox),
    shoeBounds: {
      min: shoeBox.min.toArray(),
      max: shoeBox.max.toArray(),
    },
    deckBounds: {
      min: deckBox.min.toArray(),
      max: deckBox.max.toArray(),
    },
  };
  mesh.geometry.dispose();
  material.dispose();
  return result;
}

function inspectThresholdAdapter(opening, condition) {
  const plan = planThresholdLife({ opening: opening.plan, condition, seed: 17 });
  const material = createThresholdLifeMaterial();
  const mesh = createThresholdLifeMesh(plan, new THREE.Matrix4(), material);
  const box = new THREE.Box3().setFromObject(mesh);
  const metricSize = box.getSize(new THREE.Vector3());
  const anisotropicMaterial = createThresholdLifeMaterial();
  const anisotropicMesh = createThresholdLifeMesh(
    plan,
    new THREE.Matrix4().makeScale(-1.4, 0.7, 1.25),
    anisotropicMaterial,
  );
  const anisotropicBox = new THREE.Box3().setFromObject(anisotropicMesh);
  const anisotropicSize = anisotropicBox.getSize(new THREE.Vector3());
  let geometryDisposed = 0;
  let materialDisposed = 0;
  mesh.geometry.addEventListener('dispose', () => { geometryDisposed++; });
  material.addEventListener('dispose', () => { materialDisposed++; });
  const result = {
    kind: plan.kind,
    tier: mesh.userData.openingDetailTier,
    triangles: mesh.geometry.attributes.position.count / 3,
    contactY: box.min.y,
    expectedY: plan.items[0].y,
    metricSize: metricSize.toArray(),
    anisotropicSize: anisotropicSize.toArray(),
    anisotropicContactY: anisotropicBox.min.y,
    anisotropicExpectedY: plan.items[0].y * 0.7,
    anisotropicSourceScale: anisotropicMesh.userData.thresholdLifeSourceScale,
    vertexColors: material.vertexColors === true && !!mesh.geometry.attributes.color,
    transparent: material.transparent === true,
    envelope: material.userData.lodEnvelope === true,
  };
  mesh.geometry.dispose();
  material.dispose();
  anisotropicMesh.geometry.dispose();
  anisotropicMaterial.dispose();
  result.disposed = [geometryDisposed, materialDisposed];
  return result;
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

  // This exact invalid shape used to let the pure planner fall back while the
  // production bay loop received Infinity/NaN. Building it here is the hang and
  // finite-geometry regression probe for the shared choga shape frame.
  const chogaNonfiniteParams = {
    ...PRESETS.choga,
    frontBays: Infinity,
    sideBays: -Infinity,
    centerBayW: NaN,
    middleBayW: Infinity,
    endBayW: -Infinity,
    centerBayD: Infinity,
    endBayD: NaN,
    columnRadius: Infinity,
    mats: testMaterials(),
  };
  const chogaNonfinite = buildBuilding(chogaNonfiniteParams);
  const chogaNonfiniteLayout = chogaNonfinite.userData.layout;
  const chogaNonfiniteProbe = {
    W: chogaNonfiniteLayout.W,
    D: chogaNonfiniteLayout.D,
    xCount: chogaNonfiniteLayout.xPos.length,
    zCount: chogaNonfiniteLayout.zPos.length,
    bounds: bounds(chogaNonfinite),
  };
  disposeBuilding(chogaNonfinite);

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
  const residentialFixtures = [
    ['choga-default', { ...PRESETS.choga }],
    ['choga-min', {
      ...PRESETS.choga,
      doorCount: 1, windowCount: 1, doorWidthK: 0.32, windowWidthK: 0.18,
    }],
    ['choga-max', {
      ...PRESETS.choga,
      frontBays: 5, doorCount: 99, windowCount: 99, doorWidthK: 0.72, windowWidthK: 0.62,
    }],
    ['choga-tight-kitchen', {
      ...PRESETS.choga,
      frontBays: 3, sideBays: 2,
      centerBayW: 3, middleBayW: 2.6, endBayW: 2.6,
      centerBayD: 1.4, endBayD: 1.4, columnRadius: 0.12,
      windowCount: 99, windowWidthK: 0.62,
    }],
    ['giwa-leaf-one', { ...PRESETS.giwa, doorWidthK: 0.6 }],
    ['giwa-single', { ...PRESETS.giwa, planShape: 'single' }],
    ['giwa-l', { ...PRESETS.giwa, planShape: 'l' }],
    ['giwa-u-max', {
      ...PRESETS.giwa,
      planShape: 'u', bays: 4, mainHalfW: 5,
      doorCount: 99, windowCount: 99, doorWidthK: 0.94, windowWidthK: 0.78,
    }],
  ].map(([name, params]) => {
    const building = buildBuilding({ ...params, mats: testMaterials() });
    const report = inspectResidentialOpenings(building);
    disposeBuilding(building);
    return { name, ...report };
  });
  const thresholdLandingShapes = [
    ['single', { ...PRESETS.giwa, planShape: 'single', mainHalfW: 3.3 }],
    ['l', { ...PRESETS.giwa }],
    ['u', {
      ...PRESETS.giwa,
      planShape: 'u', bays: 4, mainHalfW: 5, wingW: 2.15, wingLen: 3.4,
    }],
  ];
  const thresholdLandingFixtures = thresholdLandingShapes.flatMap(([shape, shapeParams]) => {
    const capabilities = residentialOpeningCapabilities('giwa', shapeParams);
    const profiles = [
      ['min', capabilities.doorWidthK.min, capabilities.doorCount.min],
      ['default', capabilities.doorWidthK.default, capabilities.doorCount.default],
      ['max', capabilities.doorWidthK.max, capabilities.doorCount.max],
    ];
    return [...primarySideSeeds(shapeParams)].flatMap(([side, seed]) => (
      profiles.map(([profile, doorWidthK, doorCount]) => {
        const params = { ...shapeParams, seed, doorWidthK, doorCount };
        const primary = planResidentialOpenings('giwa', params, seed).openings
          .find((opening) => opening.primary);
        const building = buildBuilding({ ...params, mats: testMaterials() });
        // Exercise the same reflection used by the focused ㄱ variant while
        // retaining both local landing directions across the full matrix.
        const mirrorX = side < 0 ? -1 : 1;
        building.scale.x = mirrorX;
        const landing = inspectThresholdLanding(building);
        disposeBuilding(building);
        return {
          name: `${shape}-${side > 0 ? 'left' : 'right'}-${profile}`,
          shape,
          profile,
          seed,
          side,
          mirrorX,
          primarySide: primary.landing?.clearSide ?? null,
          ...landing,
        };
      })
    ));
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
    residentialFixtures,
    thresholdLandingFixtures,
    chogaNonfinite: chogaNonfiniteProbe,
    thresholdAdapters: {
      dry: inspectThresholdAdapter(openings.choga, 'dry'),
      wet: inspectThresholdAdapter(openings.giwa, 'wet'),
    },
  };
  disposeBuilding(giwa);
  return result;
}
