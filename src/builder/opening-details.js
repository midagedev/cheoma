import * as THREE from 'three';
import { mergeOwnedGeometries } from '../core/merge-owned-geometries.js';

// Three assembler for the pure opening-detail-plan. Every opening contributes
// geometry to two building-wide batches: frame/threshold reuse the existing
// envelope wood material, while small ironwork uses one FULL-only material.

const UP = new THREE.Vector3(0, 1, 0);

function placementBasis(placement) {
  const tangent = placement.tangent || { x: 1, z: 0 };
  const outward = placement.outward || { x: 0, z: 1 };
  const tangentLength = Math.hypot(tangent.x, tangent.z) || 1;
  const outwardLength = Math.hypot(outward.x, outward.z) || 1;
  const x = new THREE.Vector3(tangent.x / tangentLength, 0, tangent.z / tangentLength);
  const z = new THREE.Vector3(outward.x / outwardLength, 0, outward.z / outwardLength);
  const basis = new THREE.Matrix4().makeBasis(x, UP, z);
  basis.setPosition(placement.center.x, placement.bottomY || 0, placement.center.z);
  return basis;
}

function transformGeometry(geometry, part, basis) {
  geometry.translate(part.u || 0, part.y || 0, part.outward || 0);
  geometry.applyMatrix4(basis);
  return geometry;
}

function partGeometry(part, basis) {
  if (part.shape === 'torus') {
    return transformGeometry(
      new THREE.TorusGeometry(part.radius, part.tube, 5, 12),
      part,
      basis,
    );
  }
  if (part.shape === 'cylinder') {
    const geometry = new THREE.CylinderGeometry(part.radius, part.radius, part.depth, 8);
    geometry.rotateX(Math.PI * 0.5);
    return transformGeometry(geometry, part, basis);
  }
  return transformGeometry(
    new THREE.BoxGeometry(part.width, part.height, part.depth),
    part,
    basis,
  );
}

export function createOpeningDetailAssembler(target, materials) {
  const frameGeometries = [];
  const hardwareGeometries = [];
  let finished = false;

  function add(plan, placement, owner = null) {
    if (finished) throw new Error('Opening detail assembler is already finished');
    const basis = placementBasis(placement);
    for (const part of plan.frame.parts) frameGeometries.push(partGeometry(part, basis));
    if (plan.threshold) frameGeometries.push(partGeometry(plan.threshold, basis));
    for (const part of plan.hardware) hardwareGeometries.push(partGeometry(part, basis));

    if (plan.primary) {
      const marker = new THREE.Group();
      marker.name = 'primary-opening-anchor';
      marker.applyMatrix4(basis);
      marker.userData.openingDetailPlan = plan;
      target.add(marker);
      if (owner) {
        owner.name = 'primary-opening-panel';
        owner.userData.openingDetailId = plan.id;
      }
    }
    return plan;
  }

  function finish() {
    if (finished) return;
    finished = true;
    if (frameGeometries.length) {
      const mesh = new THREE.Mesh(
        mergeOwnedGeometries(frameGeometries, 'Opening frame geometries'),
        materials.frame,
      );
      mesh.name = 'opening-frame-details';
      mesh.userData.openingDetailTier = 'envelope';
      mesh.receiveShadow = false;
      target.add(mesh);
    }
    if (hardwareGeometries.length) {
      const mesh = new THREE.Mesh(
        mergeOwnedGeometries(hardwareGeometries, 'Opening hardware geometries'),
        materials.hardware,
      );
      mesh.name = 'opening-hardware-details';
      mesh.userData.openingDetailTier = 'full';
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      target.add(mesh);
    }
  }

  return { add, finish };
}
