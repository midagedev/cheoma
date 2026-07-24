import * as THREE from 'three';
import { buildBuilding, disposeBuilding } from '../builder/index.js';
import { makeMaterials } from '../builder/palette.js';
import { validateMjaHousePlan } from './mja-house-plan.js';
import {
  addMaterialResource,
  collectObjectResources,
  disposeObjectResources,
} from '../core/three-resources.js';

const lifecycle = new WeakMap();

const PRIMARY_RUNTIME_NAMES = new Set([
  'opening-frame-details',
  'opening-hardware-details',
  'primary-opening-anchor',
  'primary-opening-panel',
  'primary-opening-leaf-details',
  'primary-opening-lower-panel',
  'primary-opening-fixed-lower-panels',
  'primary-door-rigid-frame',
  'primary-door-pivot',
]);

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`MJA ${label} must be finite`);
  return number;
}

function pointXZ(value, label) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`MJA ${label} must be an {x,z} point`);
  }
  return {
    x: finite(value.x, `${label}.x`),
    z: finite(value.z, `${label}.z`),
  };
}

function collectPaletteResources(palette) {
  const resources = { materials: new Set(), textures: new Set() };
  for (const value of Object.values(palette || {})) {
    if (value?.isMaterial) {
      addMaterialResource(value, resources.materials, resources.textures);
    } else if (value?.isTexture) {
      resources.textures.add(value);
    }
  }
  return resources;
}

function disposeBorrowingTree(root, paletteResources) {
  const resources = collectObjectResources(root);
  for (const material of paletteResources.materials) resources.materials.delete(material);
  for (const texture of paletteResources.textures) resources.textures.delete(texture);
  disposeObjectResources(resources);
}

function courtyardGeometry(polygon) {
  const shape = new THREE.Shape();
  polygon.forEach((point, index) => {
    if (index === 0) shape.moveTo(point.x, -point.z);
    else shape.lineTo(point.x, -point.z);
  });
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function buildCourtyard(plan, mats) {
  const mesh = new THREE.Mesh(courtyardGeometry(plan.courtyard.polygon), mats.ground);
  mesh.name = 'mja-inner-courtyard';
  mesh.position.y = Number.isFinite(plan.courtyard.y) ? plan.courtyard.y : 0.012;
  mesh.receiveShadow = true;
  return mesh;
}

function gateYaw(gate) {
  if (Number.isFinite(gate.yaw)) return gate.yaw;
  if (Number.isFinite(gate.rotationY)) return gate.rotationY;
  const outward = gate.outward && pointXZ(gate.outward, 'gate.outward');
  return outward ? Math.atan2(outward.x, outward.z) : 0;
}

function gateMesh(geometry, material, name, castShadow = true) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  return mesh;
}

// A restrained 솟을대문-like entrance assembled only from the supplied giwa
// palette. The open leaves preserve a real camera/person passage; no alpha cutout
// or facade impostor is used for the compound's authoritative south entrance.
function buildSouthGate(gatePlan, mats) {
  const root = new THREE.Group();
  root.name = 'mja-south-gate';
  const center = pointXZ(gatePlan.center || gatePlan.position, 'gate.center');
  const width = finite(gatePlan.width, 'gate.width');
  const clearHeight = finite(gatePlan.height, 'gate.height');
  const roofPlan = gatePlan.roof || {};
  const baseY = Number.isFinite(gatePlan.center?.y)
    ? gatePlan.center.y
    : (Number.isFinite(gatePlan.y) ? gatePlan.y : 0);
  const depth = Math.max(
    1.25,
    Math.min(2.4, Number(gatePlan.depth) || Number(roofPlan.depth) || width * 0.55),
  );
  const post = Math.max(0.18, Math.min(0.28, width * 0.085));
  const postX = width * 0.5 + post * 0.5;
  const postHeight = Number.isFinite(gatePlan.postHeight)
    ? Math.max(clearHeight, gatePlan.postHeight)
    : clearHeight + 0.34;

  for (const xSign of [-1, 1]) {
    for (const zSign of [-1, 1]) {
      const column = gateMesh(
        new THREE.BoxGeometry(post, postHeight, post),
        mats.wood,
        'mja-gate-column',
      );
      column.position.set(xSign * postX, postHeight * 0.5, zSign * depth * 0.36);
      root.add(column);
    }
  }

  for (const zSign of [-1, 1]) {
    const lintel = gateMesh(
      new THREE.BoxGeometry(width + post * 2.8, 0.22, 0.2),
      mats.woodDark,
      'mja-gate-lintel',
    );
    lintel.position.set(0, clearHeight + 0.08, zSign * depth * 0.36);
    root.add(lintel);
  }

  const sill = gateMesh(
    new THREE.BoxGeometry(width + post * 0.8, 0.11, depth * 0.82),
    mats.stoneDark,
    'mja-gate-sill',
    false,
  );
  sill.position.y = 0.055;
  root.add(sill);

  const leafGap = 0.08;
  const leafWidth = (width - leafGap) * 0.5;
  const leafHeight = Math.max(1.65, clearHeight - 0.2);
  for (const sign of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.name = 'mja-gate-open-leaf-hinge';
    hinge.position.set(sign * width * 0.5, 0.12, depth * 0.34 + 0.035);
    hinge.rotation.y = sign * 1.12;
    const leaf = gateMesh(
      new THREE.BoxGeometry(leafWidth, leafHeight, 0.075),
      mats.woodBoard,
      'mja-gate-open-leaf',
    );
    leaf.position.set(-sign * leafWidth * 0.5, leafHeight * 0.5, 0);
    hinge.add(leaf);
    root.add(hinge);
  }

  finite(roofPlan.overhang, 'gate.roof.overhang');
  // width/depth are the already-expanded authoritative roof envelope; the
  // stored overhang documents how it was derived and must not be added twice.
  const roofWidth = finite(roofPlan.width, 'gate.roof.width');
  const roofRun = finite(roofPlan.depth, 'gate.roof.depth') * 0.5;
  const roofEaveY = finite(roofPlan.eaveY, 'gate.roof.eaveY') - baseY;
  const roofRidgeY = finite(roofPlan.ridgeY, 'gate.roof.ridgeY') - baseY;
  const roofRise = roofRidgeY - roofEaveY;
  if (!(roofRise > 0)) throw new RangeError('MJA gate roof ridge must be above its eave');
  const roofSlope = Math.hypot(roofRun, roofRise);
  const pitch = Math.atan2(roofRise, roofRun);
  for (const sign of [-1, 1]) {
    const roof = gateMesh(
      new THREE.BoxGeometry(roofWidth, 0.13, roofSlope),
      mats.tileFlat,
      'mja-gate-roof-slope',
    );
    roof.position.set(0, roofEaveY + roofRise * 0.5, sign * roofRun * 0.5);
    roof.rotation.x = sign * pitch;
    root.add(roof);
  }
  const rollCount = Math.max(7, Math.round((roofWidth - 0.18) / 0.34));
  const rollGeometry = new THREE.CylinderGeometry(0.042, 0.042, roofSlope * 1.01, 8);
  const rolls = new THREE.InstancedMesh(rollGeometry, mats.tileConvex, rollCount * 2);
  rolls.name = 'mja-gate-roof-tile-rolls';
  const up = new THREE.Vector3(0, 1, 0);
  const direction = new THREE.Vector3();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3(1, 1, 1);
  let instance = 0;
  for (const sign of [-1, 1]) {
    direction.set(0, -roofRise, sign * roofRun).normalize();
    quaternion.setFromUnitVectors(up, direction);
    for (let index = 0; index < rollCount; index++) {
      const t = rollCount === 1 ? 0.5 : index / (rollCount - 1);
      position.set(
        -roofWidth * 0.5 + 0.1 + (roofWidth - 0.2) * t,
        roofEaveY + roofRise * 0.5 + 0.075,
        sign * roofRun * 0.5,
      );
      matrix.compose(position, quaternion, scale);
      rolls.setMatrixAt(instance++, matrix);
    }
  }
  rolls.instanceMatrix.needsUpdate = true;
  rolls.castShadow = true;
  root.add(rolls);

  const gableGeometry = new THREE.BufferGeometry();
  gableGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -roofWidth * 0.5, roofEaveY, -roofRun,
    -roofWidth * 0.5, roofEaveY, roofRun,
    -roofWidth * 0.5, roofRidgeY, 0,
    roofWidth * 0.5, roofEaveY, roofRun,
    roofWidth * 0.5, roofEaveY, -roofRun,
    roofWidth * 0.5, roofRidgeY, 0,
  ], 3));
  gableGeometry.setIndex([0, 1, 2, 3, 4, 5]);
  gableGeometry.computeVertexNormals();
  root.add(gateMesh(gableGeometry, mats.plaster, 'mja-gate-gable-ends'));

  const ridge = gateMesh(
    new THREE.CylinderGeometry(0.1, 0.1, roofWidth + 0.12, 10),
    mats.tileRidge,
    'mja-gate-roof-ridge',
  );
  ridge.rotation.z = Math.PI * 0.5;
  ridge.position.y = roofRidgeY + 0.06;
  root.add(ridge);

  root.position.set(center.x, baseY, center.z);
  root.rotation.y = gateYaw(gatePlan);
  root.userData.mjaGate = {
    id: gatePlan.id || 'south-gate',
    width,
    height: clearHeight,
    outward: gatePlan.outward || { x: 0, z: 1 },
  };
  return root;
}

function primaryWingId(plan) {
  return plan.openings.find((opening) => opening.id === plan.primaryOpeningId).wingId;
}

function namespaceWingOpeningRuntime(building, wingId) {
  building.traverse((object) => {
    if (!PRIMARY_RUNTIME_NAMES.has(object.name)) return;
    object.userData.mjaOriginalName = object.name;
    object.name = `mja-${wingId}-${object.name}`;
  });
}

function buildWing(wing, mats) {
  const building = buildBuilding({
    ...wing.building,
    mats,
  });
  building.name = `mja-wing-${wing.id}`;
  building.position.set(wing.center.x, Number(wing.center.y) || 0, wing.center.z);
  building.rotation.y = wing.yaw;
  building.userData.mjaWing = {
    id: wing.id,
    role: wing.role,
    footprint: wing.footprint,
    roofFootprint: wing.roofFootprint,
  };
  namespaceWingOpeningRuntime(building, wing.id);
  return building;
}

function createCompoundPrimaryAnchor(plan, authoritativeWingId) {
  const opening = plan.openings.find((candidate) => candidate.id === plan.primaryOpeningId);
  if (!opening) {
    throw new RangeError(`MJA primary opening not found: ${String(plan.primaryOpeningId)}`);
  }
  const center = opening.center;
  const tangent = opening.tangent;
  const outward = opening.outward;
  const x = new THREE.Vector3(tangent.x, 0, tangent.z).normalize();
  const y = new THREE.Vector3(0, 1, 0);
  const z = new THREE.Vector3(outward.x, 0, outward.z).normalize();
  const basis = new THREE.Matrix4().makeBasis(x, y, z);
  basis.setPosition(center.x, center.y, center.z);
  const anchor = new THREE.Group();
  anchor.name = 'primary-opening-anchor';
  anchor.applyMatrix4(basis);
  // Product DoF consumes this immutable focus centre. MJA door motion remains
  // intentionally static until an authored compound leaf can be isolated
  // without treating one standalone-wing leaf as the whole compound entrance.
  anchor.userData.openingDetailPlan = Object.freeze({
    id: opening.id,
    kind: opening.kind,
    style: 'giwa',
    primary: true,
    width: opening.width,
    height: opening.height,
    anchors: Object.freeze({
      focus: Object.freeze({ u: 0, y: 0, outward: 0 }),
    }),
    mjaStatic: true,
  });
  anchor.userData.mjaOpeningId = opening.id;
  anchor.userData.mjaWingId = authoritativeWingId;
  return anchor;
}

function ensureSinglePrimaryAnchor(root) {
  const anchors = [];
  root.traverse((object) => {
    if (object.name === 'primary-opening-anchor') anchors.push(object);
  });
  if (anchors.length !== 1) {
    throw new Error(`MJA compound must expose exactly one primary-opening-anchor, found ${anchors.length}`);
  }
  return anchors[0];
}

/**
 * Assemble one renderer-free MJA plan into reusable local-space Three geometry.
 * A caller-supplied giwa palette remains caller-owned. When omitted, the root
 * owns one shared palette and disposeMjaHouse() releases it after every wing.
 */
export function buildMjaHouse(planInput, { mats } = {}) {
  const plan = validateMjaHousePlan(planInput);
  const palette = mats || makeMaterials('giwa');
  const paletteResources = collectPaletteResources(palette);
  const root = new THREE.Group();
  root.name = 'mja-house';
  const details = new THREE.Group();
  details.name = 'mja-house-details';
  const buildings = [];

  try {
    details.add(buildCourtyard(plan, palette));
    details.add(buildSouthGate(plan.gate, palette));
    root.add(details);

    const authoritativeWingId = primaryWingId(plan);
    for (const wing of plan.wings) {
      const building = buildWing(wing, palette);
      buildings.push(building);
      root.add(building);
    }

    root.add(createCompoundPrimaryAnchor(plan, authoritativeWingId));
    ensureSinglePrimaryAnchor(root);
    root.userData.mjaHouseHandle = {
      schema: plan.schema,
      kind: plan.kind,
      plan,
      primaryOpeningId: plan.primaryOpeningId,
      primaryWingId: authoritativeWingId,
      doorMotion: 'static',
    };
    root.userData.mjaDoorMotionExcluded = true;
    root.userData.materials = palette;
    lifecycle.set(root, {
      disposed: false,
      buildings,
      details,
      paletteResources,
      ownsPalette: !mats,
    });
    return root;
  } catch (error) {
    for (const building of buildings) disposeBuilding(building);
    disposeBorrowingTree(details, paletteResources);
    if (!mats) {
      disposeObjectResources({
        geometries: new Set(),
        materials: paletteResources.materials,
        textures: paletteResources.textures,
      });
    }
    throw error;
  }
}

export function disposeMjaHouse(root) {
  const state = root && lifecycle.get(root);
  if (!state || state.disposed) return false;
  state.disposed = true;
  for (const building of state.buildings) disposeBuilding(building);
  disposeBorrowingTree(state.details, state.paletteResources);
  if (state.ownsPalette) {
    disposeObjectResources({
      geometries: new Set(),
      materials: state.paletteResources.materials,
      textures: state.paletteResources.textures,
    });
  }
  return true;
}
