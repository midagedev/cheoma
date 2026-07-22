import * as THREE from 'three';
import { createDoorMotionState, planDoorMotion } from './door-motion.js';

const uniqueNamed = (root, name) => {
  const found = [];
  root?.traverse((object) => { if (object.name === name) found.push(object); });
  return found.length === 1 ? found[0] : null;
};

function openingLocalURange(object, anchor) {
  const positions = object?.geometry?.attributes?.position;
  if (!positions) return null;
  object.updateWorldMatrix(true, false);
  anchor.updateWorldMatrix(true, false);
  const matrix = anchor.matrixWorld.clone().invert().multiply(object.matrixWorld);
  const point = new THREE.Vector3();
  let min = Infinity, max = -Infinity;
  for (let index = 0; index < positions.count; index++) {
    point.fromBufferAttribute(positions, index).applyMatrix4(matrix);
    min = Math.min(min, point.x);
    max = Math.max(max, point.x);
  }
  return Number.isFinite(min) && Number.isFinite(max)
    ? { min, max, width: max - min, center: (min + max) * 0.5 }
    : null;
}

function visibleToRay(object, root, raycaster) {
  let current = object;
  while (current) {
    if (current.visible === false || !current.layers.test(raycaster.layers)) return false;
    if (current === root) return true;
    current = current.parent;
  }
  return false;
}

export function createPrimaryDoorRuntime(root, options = {}) {
  const anchor = uniqueNamed(root, 'primary-opening-anchor');
  const panel = uniqueNamed(root, 'primary-opening-panel');
  const frame = uniqueNamed(root, 'opening-frame-details');
  const hardware = uniqueNamed(root, 'opening-hardware-details');
  const leafDetails = uniqueNamed(root, 'primary-opening-leaf-details');
  const lowerPanel = uniqueNamed(root, 'primary-opening-lower-panel');
  const openingPlan = anchor?.userData?.openingDetailPlan;
  if (!anchor || !panel || !frame || !hardware || !leafDetails || !openingPlan) return null;

  const motionPlan = planDoorMotion(openingPlan, options);
  root.updateWorldMatrix(true, true);
  const panelRange = openingLocalURange(panel, anchor);
  const lowerPanelRange = lowerPanel ? openingLocalURange(lowerPanel, anchor) : null;
  const recess = frame.userData.primaryDoorRecesses?.find((entry) => (
    entry.openingId === openingPlan.id
  )) || null;
  const rangeValid = panelRange
    && Math.abs(panelRange.width - motionPlan.leafWidth) < 1e-4
    && Math.abs(panelRange.center - motionPlan.leafCenterU) < 1e-4
    && (!lowerPanelRange || (
      Math.abs(lowerPanelRange.width - motionPlan.leafWidth) < 1e-4
        && Math.abs(lowerPanelRange.center - motionPlan.leafCenterU) < 1e-4
    ));
  if (!rangeValid) return null;
  const state = createDoorMotionState(motionPlan);
  // The selected FULL root owns visibility. A compound gate, wall, or wing in
  // front of the primary leaf must block interaction rather than becoming a
  // click-through shortcut to an occluded inner hall.
  const surfaceRoot = root;
  let pivot = uniqueNamed(root, 'primary-door-pivot');
  if (!pivot) {
    pivot = new THREE.Group();
    pivot.name = 'primary-door-pivot';
    anchor.add(pivot);
  }
  pivot.position.set(motionPlan.pivot.u, motionPlan.pivot.y, motionPlan.pivot.outward);
  pivot.rotation.set(0, 0, 0);
  pivot.userData.openingId = motionPlan.openingId;

  const movingObjects = [panel, lowerPanel, leafDetails, hardware].filter(Boolean);
  const originalOwners = movingObjects.map((object) => ({
    object,
    parent: object.parent,
    position: object.position.clone(),
    quaternion: object.quaternion.clone(),
    scale: object.scale.clone(),
    matrix: object.matrix.clone(),
    matrixAutoUpdate: object.matrixAutoUpdate,
  }));
  root.updateWorldMatrix(true, true);
  for (const object of movingObjects) if (object.parent !== pivot) pivot.attach(object);
  pivot.rotation.y = state.snapshot().angle;

  let disposed = false;
  const apply = () => { pivot.rotation.y = state.snapshot().angle; };
  const snapshot = () => ({
    ...state.snapshot(),
    valid: !disposed,
    leafWidth: motionPlan.leafWidth,
    panelWidth: panelRange.width,
    panelCenterU: panelRange.center,
    movingObjects: movingObjects.length,
    hasLowerPanel: !!lowerPanel,
    hasRecess: !!recess,
    recessDepth: recess?.recessDepth || 0,
  });

  return {
    root,
    anchor,
    panel,
    hardware,
    leafDetails,
    lowerPanel,
    pivot,
    snapshot,
    setOpen(open) { state.setOpen(open); apply(); return snapshot(); },
    toggle() { state.toggle(); apply(); return snapshot(); },
    seek(progress) { state.seek(progress); apply(); return snapshot(); },
    update(dt) { const changed = state.update(dt); if (changed) apply(); return changed; },
    raycast(raycaster) {
      if (disposed) return null;
      // Recursive Raycaster calls do not honor hidden ancestors and only test
      // the hit object's layer. Interaction follows the rendered owner chain.
      if (!visibleToRay(panel, surfaceRoot, raycaster)) return null;
      // A projected door must also be the first real surface under the pointer.
      // This prevents a rear/occluded leaf from becoming an invisible click target
      // after the user orbits around the focused building.
      const hits = raycaster.intersectObject(surfaceRoot, true);
      const hit = hits.find((candidate) => (
        visibleToRay(candidate.object, surfaceRoot, raycaster)
      )) || null;
      let object = hit?.object || null;
      while (object && object !== pivot) object = object.parent;
      if (object === pivot) return hit;

      // Once the leaf has vacated its bay, the empty active-leaf aperture is the
      // clear exterior close action. Intersect it analytically: no invisible mesh,
      // GPU resource, or whole-parcel proxy can steal selection from OrbitControls.
      const current = state.snapshot();
      if (!current.targetOpen && current.progress < 0.08) return null;
      const inverse = anchor.matrixWorld.clone().invert();
      const origin = raycaster.ray.origin.clone().applyMatrix4(inverse);
      const direction = raycaster.ray.direction.clone().transformDirection(inverse);
      if (Math.abs(direction.z) < 1e-7) return null;
      const distanceLocal = (motionPlan.pivot.outward - origin.z) / direction.z;
      if (distanceLocal < 0) return null;
      const localPoint = origin.addScaledVector(direction, distanceLocal);
      const halfWidth = motionPlan.leafWidth * 0.5;
      if (Math.abs(localPoint.x - motionPlan.leafCenterU) > halfWidth
          || localPoint.y < 0 || localPoint.y > openingPlan.height) return null;
      const point = anchor.localToWorld(localPoint.clone());
      const distance = raycaster.ray.origin.distanceTo(point);
      if (hit && hit.distance < distance - 1e-4) return null;
      return { distance, point, object: panel, opening: true };
    },
    worldCenter(target = new THREE.Vector3()) {
      if (disposed) return null;
      root.updateWorldMatrix(true, true);
      return new THREE.Box3().setFromObject(panel).getCenter(target);
    },
    worldFrame() {
      if (disposed) return null;
      root.updateWorldMatrix(true, true);
      const center = anchor.localToWorld(new THREE.Vector3(
        motionPlan.leafCenterU,
        openingPlan.height * 0.5,
        motionPlan.pivot.outward,
      ));
      return {
        center,
        right: new THREE.Vector3(1, 0, 0).transformDirection(anchor.matrixWorld),
        outward: new THREE.Vector3(0, 0, 1).transformDirection(anchor.matrixWorld),
      };
    },
    worldTargets() {
      if (disposed) return [];
      root.updateWorldMatrix(true, true);
      const positions = panel.geometry?.attributes?.position;
      const index = panel.geometry?.index;
      if (!positions) return [];
      const points = [];
      const current = state.snapshot();
      if (current.targetOpen || current.progress >= 0.08) {
        for (const uRatio of [0.2, 0.5, 0.8]) {
          for (const yRatio of [0.25, 0.5, 0.75]) {
            points.push(anchor.localToWorld(new THREE.Vector3(
              motionPlan.leafCenterU + (uRatio - 0.5) * motionPlan.leafWidth,
              openingPlan.height * yRatio,
              motionPlan.pivot.outward,
            )));
          }
        }
      }
      points.push(new THREE.Box3().setFromObject(panel).getCenter(new THREE.Vector3()));
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      const triangleCount = index ? index.count / 3 : positions.count / 3;
      for (let triangle = 0; triangle < triangleCount; triangle++) {
        const at = (corner, target) => target.fromBufferAttribute(
          positions,
          index ? index.getX(triangle * 3 + corner) : triangle * 3 + corner,
        );
        at(0, a); at(1, b); at(2, c);
        points.push(a.clone().add(b).add(c).multiplyScalar(1 / 3).applyMatrix4(panel.matrixWorld));
      }
      return points;
    },
    dispose() {
      if (disposed) return;
      state.dispose();
      pivot.rotation.y = 0;
      // This adapter owns no host resources or lasting hierarchy. Restoring each
      // original parent/local transform lets ordinary building disposal and a
      // later focus activation observe the exact builder-owned scene graph.
      for (const original of originalOwners) {
        original.parent?.add(original.object);
        original.object.position.copy(original.position);
        original.object.quaternion.copy(original.quaternion);
        original.object.scale.copy(original.scale);
        original.object.matrixAutoUpdate = original.matrixAutoUpdate;
        if (original.matrixAutoUpdate) original.object.updateMatrix();
        else original.object.matrix.copy(original.matrix);
      }
      pivot.removeFromParent();
      disposed = true;
    },
  };
}
