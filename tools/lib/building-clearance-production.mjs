import * as THREE from 'three';
import { buildBuilding, disposeBuilding } from '../../src/builder/index.js';
import { PRESETS, computeLayout, giwaFootprint } from '../../src/params.js';
import {
  createThatchRoofProfile,
  thatchRoofSurfaceHeightAt,
} from '../../src/builder/thatch-profile.js';
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
import { createPrimaryDoorRuntime } from '../../src/interaction/primary-door.js';
import { CHOGA_VARIANTS } from '../../src/village/variants.js';

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

const CHOGA_FRAME_PREFIXES = Object.freeze({
  changbang: 'choga-changbang-',
  jangyeo: 'choga-jangyeo-',
  dori: 'choga-dori-',
});

function inspectChogaFrame(name, overrides) {
  const params = { ...PRESETS.choga, ...overrides, mats: testMaterials() };
  const building = buildBuilding(params);
  const profile = createThatchRoofProfile(params, building.userData.layout);
  const members = Object.fromEntries(
    Object.keys(CHOGA_FRAME_PREFIXES).map((member) => [
      member,
      { count: 0, vertexCount: 0, minClearance: Infinity, minVertex: null },
    ]),
  );
  const point = new THREE.Vector3();
  building.updateWorldMatrix(true, true);
  building.traverse((object) => {
    const entry = Object.entries(CHOGA_FRAME_PREFIXES)
      .find(([, prefix]) => object.name.startsWith(prefix));
    const positions = object.geometry?.attributes?.position;
    if (!entry || !positions) return;
    const [member] = entry;
    const report = members[member];
    report.count++;
    for (let index = 0; index < positions.count; index++) {
      point.fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld);
      const clearance = thatchRoofSurfaceHeightAt(profile, point.x, point.z) - point.y;
      report.vertexCount++;
      if (clearance < report.minClearance) {
        report.minClearance = clearance;
        report.minVertex = point.toArray();
      }
    }
  });
  disposeBuilding(building);
  return { name, members };
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

function resourceCounts(root) {
  const geometries = new Set();
  const materials = new Set();
  root.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const list = Array.isArray(object.material) ? object.material : (object.material ? [object.material] : []);
    for (const material of list) materials.add(material);
  });
  return { geometries: geometries.size, materials: materials.size };
}

const matrixError = (a, b) => Math.max(...a.elements.map((value, index) => Math.abs(value - b.elements[index])));

function worldMetric(matrix) {
  const x = new THREE.Vector3().setFromMatrixColumn(matrix, 0);
  const y = new THREE.Vector3().setFromMatrixColumn(matrix, 1);
  const z = new THREE.Vector3().setFromMatrixColumn(matrix, 2);
  return [
    x.dot(x), y.dot(y), z.dot(z),
    x.dot(y), x.dot(z), y.dot(z),
  ];
}

const metricError = (a, b) => Math.max(...a.map((value, index) => Math.abs(value - b[index])));

function orthonormalError(matrix) {
  return metricError(worldMetric(matrix), [1, 1, 1, 0, 0, 0]);
}

function firstRenderedHit(raycaster, root) {
  return raycaster.intersectObject(root, true).find((hit) => {
    let current = hit.object;
    while (current) {
      if (current.visible === false || !current.layers.test(raycaster.layers)) return false;
      if (current === root) return true;
      current = current.parent;
    }
    return false;
  }) || null;
}

function inspectDoorRuntime(building) {
  // Exercise the production runtime below a reflected, non-uniform ancestor.
  // A rotated opening below this transform is the case where a normal child
  // pivot changes world hinge radius unless the runtime owns an orthonormal
  // compensation frame. Restore the caller's hierarchy exactly before return.
  const originalHost = {
    parent: building.parent,
    position: building.position.clone(),
    quaternion: building.quaternion.clone(),
    scale: building.scale.clone(),
    matrix: building.matrix.clone(),
    matrixAutoUpdate: building.matrixAutoUpdate,
  };
  const affineParent = new THREE.Group();
  affineParent.position.set(17, 2.5, -11);
  affineParent.rotation.y = 0.37;
  // Keep the visible recess above the pre-existing 3cm product threshold while
  // retaining enough X/Z anisotropy to expose the old shrinking-leaf defect.
  affineParent.scale.set(-1.43, 1.16, 1.05);
  affineParent.add(building);
  const restoreHost = () => {
    building.removeFromParent();
    originalHost.parent?.add(building);
    building.position.copy(originalHost.position);
    building.quaternion.copy(originalHost.quaternion);
    building.scale.copy(originalHost.scale);
    building.matrixAutoUpdate = originalHost.matrixAutoUpdate;
    if (originalHost.matrixAutoUpdate) building.updateMatrix();
    else building.matrix.copy(originalHost.matrix);
    building.updateWorldMatrix(true, true);
  };

  const beforeResources = resourceCounts(building);
  building.updateWorldMatrix(true, true);
  const prePanel = building.getObjectByName('primary-opening-panel');
  const prePanelWorld = prePanel?.matrixWorld.clone() || null;
  const runtime = createPrimaryDoorRuntime(building);
  if (!runtime) {
    restoreHost();
    return null;
  }
  building.updateWorldMatrix(true, true);
  const closed = {
    frame: building.getObjectByName('opening-frame-details').matrixWorld.clone(),
    panel: runtime.panel.matrixWorld.clone(),
    hardware: runtime.hardware.matrixWorld.clone(),
    leaf: runtime.leafDetails.matrixWorld.clone(),
  };
  const relative = (object) => runtime.panel.matrixWorld.clone().invert().multiply(object.matrixWorld);
  const closedHardwareRelative = relative(runtime.hardware);
  const closedLeafRelative = relative(runtime.leafDetails);
  const moving = [runtime.panel, runtime.hardware, runtime.leafDetails, runtime.lowerPanel].filter(Boolean);
  const closedMetrics = moving.map((object) => worldMetric(object.matrixWorld));
  const plan = runtime.anchor.userData.openingDetailPlan;
  const pivotPlan = plan.anchors.pivot;
  const hingeLocal = new THREE.Vector3(pivotPlan.u, pivotPlan.y, pivotPlan.outward);
  const freeLocal = new THREE.Vector3(
    pivotPlan.leafCenterU * 2 - pivotPlan.u,
    plan.height * 0.5,
    pivotPlan.outward,
  );
  const hingeClosed = runtime.anchor.localToWorld(hingeLocal.clone());
  const freeClosed = runtime.anchor.localToWorld(freeLocal.clone());
  const freePanelLocal = runtime.panel.worldToLocal(freeClosed.clone());
  const closedRadius = hingeClosed.distanceTo(freeClosed);
  const center = runtime.worldCenter();
  const outward = runtime.worldFrame().outward;
  const raycaster = new THREE.Raycaster(
    center.clone().addScaledVector(outward, 3),
    outward.clone().multiplyScalar(-1),
  );
  const closedSurfaceName = firstRenderedHit(raycaster, building)?.object?.name || null;
  const pickedClosed = !!runtime.raycast(raycaster);
  runtime.panel.visible = false;
  const hiddenPanelRejected = runtime.raycast(raycaster) == null;
  runtime.panel.visible = true;
  runtime.pivot.visible = false;
  const hiddenAncestorRejected = runtime.raycast(raycaster) == null;
  runtime.pivot.visible = true;
  const pivotLayerMask = runtime.pivot.layers.mask;
  runtime.pivot.layers.set(1);
  const ownerLayerRejected = runtime.raycast(raycaster) == null;
  runtime.pivot.layers.mask = pivotLayerMask;
  building.visible = false;
  const hiddenRootRejected = runtime.raycast(raycaster) == null;
  building.visible = true;
  runtime.seek(0.5);
  building.updateWorldMatrix(true, true);
  const mid = runtime.snapshot();
  const hingeMid = runtime.anchor.localToWorld(hingeLocal.clone());
  const freeMid = freePanelLocal.clone().applyMatrix4(runtime.panel.matrixWorld);
  const midRadius = hingeMid.distanceTo(freeMid);
  const midMetrics = moving.map((object) => worldMetric(object.matrixWorld));
  const midScaleError = Math.max(...midMetrics.map((metric, index) => (
    metricError(closedMetrics[index], metric)
  )));
  const midInward = freeMid.clone().sub(freeClosed).dot(outward);
  const pivotBasisError = orthonormalError(runtime.pivot.matrixWorld);
  const apertureCenter = runtime.anchor.localToWorld(new THREE.Vector3(
    mid.panelCenterU,
    runtime.anchor.userData.openingDetailPlan.height * 0.5,
    0,
  ));
  const apertureRay = new THREE.Raycaster(
    apertureCenter.clone().addScaledVector(outward, 3),
    outward.clone().multiplyScalar(-1),
  );
  const pickedMidAction = !!runtime.raycast(apertureRay);
  const result = {
    pickedClosed,
    closedSurfaceName,
    hiddenPanelRejected,
    hiddenAncestorRejected,
    ownerLayerRejected,
    hiddenRootRejected,
    pickedMidAction,
    midAngle: mid.angle,
    leafWidth: mid.leafWidth,
    panelWidth: mid.panelWidth,
    panelCenterError: Math.abs(
      mid.panelCenterU - runtime.anchor.userData.openingDetailPlan.anchors.pivot.leafCenterU,
    ),
    hingeEdgeError: Math.abs(
      Math.abs(runtime.anchor.userData.openingDetailPlan.anchors.pivot.u)
        - runtime.anchor.userData.openingDetailPlan.width * 0.5,
    ),
    freeEdgeInward: midInward,
    worldHingeRadiusError: Math.abs(midRadius - closedRadius),
    worldScaleError: midScaleError,
    pivotBasisError,
    closedPoseError: prePanelWorld ? matrixError(prePanelWorld, closed.panel) : Infinity,
    mirroredParent: runtime.anchor.matrixWorld.determinant() < 0,
    nonUniformParent: Math.abs(affineParent.scale.x) !== affineParent.scale.z,
    inward: midInward < -1e-3
      && mid.angle * runtime.anchor.userData.openingDetailPlan.anchors.pivot.hingeSide < 0,
    frameFixed: matrixError(closed.frame, building.getObjectByName('opening-frame-details').matrixWorld) < 1e-9,
    panelMoved: matrixError(closed.panel, runtime.panel.matrixWorld) > 1e-4,
    hardwareMoved: matrixError(closed.hardware, runtime.hardware.matrixWorld) > 1e-4,
    leafMoved: matrixError(closed.leaf, runtime.leafDetails.matrixWorld) > 1e-4,
    hardwareRigid: matrixError(closedHardwareRelative, relative(runtime.hardware)) < 1e-6,
    leafRigid: matrixError(closedLeafRelative, relative(runtime.leafDetails)) < 1e-6,
    sameFrameMaterial: runtime.leafDetails.material
      === building.getObjectByName('opening-frame-details').material,
    resources: [beforeResources, resourceCounts(building)],
    activePivotCount: (() => {
      let count = 0;
      building.traverse((object) => { if (object.name === 'primary-door-pivot') count++; });
      return count;
    })(),
    movingObjects: mid.movingObjects,
    hasLowerPanel: mid.hasLowerPanel,
  };
  runtime.seek(1);
  building.updateWorldMatrix(true, true);
  const hingeOpen = runtime.anchor.localToWorld(hingeLocal.clone());
  const freeOpen = freePanelLocal.clone().applyMatrix4(runtime.panel.matrixWorld);
  const openRadius = hingeOpen.distanceTo(freeOpen);
  const openMetrics = moving.map((object) => worldMetric(object.matrixWorld));
  const openScaleError = Math.max(...openMetrics.map((metric, index) => (
    metricError(closedMetrics[index], metric)
  )));
  result.worldHingeRadiusError = Math.max(
    result.worldHingeRadiusError,
    Math.abs(openRadius - closedRadius),
  );
  result.worldScaleError = Math.max(result.worldScaleError, openScaleError);
  // Preserve the historical assertion key while making it an actual world-space
  // rigidity contract rather than an identity derived from sin²+cos².
  result.sweepRadiusError = Math.max(
    result.worldHingeRadiusError,
    result.worldScaleError,
    result.pivotBasisError,
    result.closedPoseError,
  );
  const openAction = runtime.raycast(apertureRay);
  const openSurface = firstRenderedHit(apertureRay, building);
  result.pickedOpenAction = !!openAction;
  result.openSurfaceName = openSurface?.object?.name || null;
  result.apertureDepth = openAction && openSurface
    ? openSurface.distance - openAction.distance : null;
  result.recessDepth = runtime.snapshot().recessDepth;
  result.hasRecess = runtime.snapshot().hasRecess;
  runtime.dispose();
  building.updateWorldMatrix(true, true);
  result.closedOnDispose = Math.abs(runtime.snapshot().angle) < 1e-9;
  result.pivotRemoved = runtime.pivot.parent == null;
  result.hostRestored = [runtime.panel, runtime.hardware, runtime.leafDetails, runtime.lowerPanel]
    .filter(Boolean).every((object) => object.parent !== runtime.pivot);
  result.restoredWorldError = prePanelWorld
    ? matrixError(prePanelWorld, runtime.panel.matrixWorld) : Infinity;
  result.sweepRadiusError = Math.max(result.sweepRadiusError, result.restoredWorldError);
  result.resources.push(resourceCounts(building));
  restoreHost();
  return result;
}

function inspectOpenings(building) {
  const doorRuntime = inspectDoorRuntime(building);
  const counts = {
    frame: 0,
    leaf: 0,
    hardware: 0,
    thresholdLife: 0,
    primaryAnchor: 0,
    primaryPanel: 0,
    fixedPanels: 0,
    recess: 0,
    doorPivot: 0,
  };
  let frame = null;
  let leaf = null;
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
    if (object.name === 'opening-frame-details') {
      counts.frame++;
      counts.recess += object.userData.primaryDoorRecesses?.length || 0;
      frame = object;
    }
    if (object.name === 'primary-opening-leaf-details') { counts.leaf++; leaf = object; }
    if (object.name === 'opening-hardware-details') { counts.hardware++; hardware = object; }
    if (object.name === 'threshold-life-detail') counts.thresholdLife++;
    if (object.name === 'primary-opening-anchor') { counts.primaryAnchor++; anchor = object; }
    if (object.name === 'primary-door-pivot') counts.doorPivot++;
    if (object.name === 'primary-opening-fixed-panels') counts.fixedPanels++;
    if (object.name === 'primary-opening-panel') {
      counts.primaryPanel++;
      primaryPanel = object;
    }
  });
  return {
    counts,
    frameVertices: frame?.geometry?.attributes?.position?.count || 0,
    leafVertices: leaf?.geometry?.attributes?.position?.count || 0,
    hardwareVertices: hardware?.geometry?.attributes?.position?.count || 0,
    frameTriangles: triangles(frame),
    leafTriangles: triangles(leaf),
    hardwareTriangles: triangles(hardware),
    frameEnvelope: frame?.material?.userData?.lodEnvelope === true,
    leafEnvelope: leaf?.material?.userData?.lodEnvelope === true,
    leafSharesFrameMaterial: leaf?.material === frame?.material,
    hardwareEnvelope: hardware?.material?.userData?.lodEnvelope === true,
    hardwarePaletteKey: hardware?.material?.userData?.paletteKey || null,
    recessPaletteKey: counts.recess ? frame?.material?.userData?.paletteKey || null : null,
    plan: anchor?.userData?.openingDetailPlan || null,
    primaryFace: inspectPrimaryOpeningFace(primaryPanel, frame, anchor),
    doorRuntime,
  };
}

function inspectResidentialOpenings(building) {
  const plans = [];
  const panelOwners = [];
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
      const panelBounds = bounds(object);
      panelOwners.push({
        object,
        detail,
        id: opening.id,
        kind: opening.kind,
        facade: opening.facade,
        primary: opening.primary,
        plannedWidth: opening.width,
        plannedHeightK: opening.heightK,
        detailHeight: detail?.height ?? null,
        detailLeafCount: detail?.leafCount ?? null,
        textureRepeatX: object.material?.map?.repeat?.x ?? null,
        spanZ: { min: panelBounds.min.z, max: panelBounds.max.z },
      });
    }
  });
  building.updateWorldMatrix(true, true);
  const panels = panelOwners.map(({ object, detail, ...panel }) => {
    const anchor = building.getObjectsByProperty('name', 'primary-opening-anchor')
      .find((candidate) => candidate.userData?.openingDetailPlan?.id === detail?.id);
    if (!panel.primary || !anchor) {
      const alongX = Math.abs(
        object.userData.residentialOpening.tangent.x,
      ) >= Math.abs(object.userData.residentialOpening.tangent.z);
      return {
        ...panel,
        activeWidth: null,
        renderedWidth: object.userData.residentialOpening.style === 'choga'
          ? object.geometry?.parameters?.width ?? null
          : alongX
          ? object.geometry?.parameters?.width ?? null
          : object.geometry?.parameters?.depth ?? null,
        renderedHeight: object.geometry?.parameters?.height ?? null,
      };
    }
    anchor.updateWorldMatrix(true, false);
    const inverse = anchor.matrixWorld.clone().invert();
    const point = new THREE.Vector3();
    const range = (candidate) => {
      candidate.updateWorldMatrix(true, false);
      const positions = candidate.geometry?.attributes?.position;
      let min = Infinity, max = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let index = 0; positions && index < positions.count; index++) {
        point.fromBufferAttribute(positions, index)
          .applyMatrix4(candidate.matrixWorld)
          .applyMatrix4(inverse);
        min = Math.min(min, point.x);
        max = Math.max(max, point.x);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
      }
      return { min, max, minY, maxY };
    };
    const active = range(object);
    let min = active.min, max = active.max, minY = active.minY, maxY = active.maxY;
    building.traverse((candidate) => {
      if (!candidate.isMesh || candidate.userData?.openingDetailId !== detail.id) return;
      const candidateRange = range(candidate);
      min = Math.min(min, candidateRange.min);
      max = Math.max(max, candidateRange.max);
      minY = Math.min(minY, candidateRange.minY);
      maxY = Math.max(maxY, candidateRange.maxY);
    });
    return {
      ...panel,
      activeWidth: active.max - active.min,
      renderedWidth: max - min,
      renderedHeight: maxY - minY,
    };
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
      doorHeightK: 0.9, windowHeightK: 0.8,
    }],
    ['choga-max', {
      ...PRESETS.choga,
      frontBays: 5, doorCount: 99, windowCount: 99, doorWidthK: 0.72, windowWidthK: 0.62,
      doorHeightK: 1.08, windowHeightK: 1.2,
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
      doorHeightK: 1.05, windowHeightK: 1.25,
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
      ['min', capabilities.doorWidthK.min, capabilities.doorHeightK.min, capabilities.doorCount.min],
      ['default', capabilities.doorWidthK.default, capabilities.doorHeightK.default, capabilities.doorCount.default],
      ['max', capabilities.doorWidthK.max, capabilities.doorHeightK.max, capabilities.doorCount.max],
    ];
    return [...primarySideSeeds(shapeParams)].flatMap(([side, seed]) => (
      profiles.map(([profile, doorWidthK, doorHeightK, doorCount]) => {
        const params = { ...shapeParams, seed, doorWidthK, doorHeightK, doorCount };
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
    chogaFrames: CHOGA_VARIANTS.map((variant) => (
      inspectChogaFrame(variant.name, variant.ov)
    )),
  };
  disposeBuilding(giwa);
  return result;
}
