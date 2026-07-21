import * as THREE from 'three';
import { planParcelFocus } from '../../generators/shared/parcel-spatial.js';
import { VILLAGE_LENS, dollyDistanceForFov } from '../../camera/optics.js';
import * as G from '../../core/math/geom2.js';
import { buildParcelSpec } from './parcel-edit.js';

const DEG = Math.PI / 180;

function parcelCameraFraming(worldCenter, focus) {
  const target = new THREE.Vector3(worldCenter.x, worldCenter.y + focus.height * 0.42, worldCenter.z);
  const position = new THREE.Vector3(focus.cameraX, target.y + focus.cameraLift, focus.cameraZ);
  return { position, target, fov: focus.fov, referenceFov: focus.referenceFov };
}

export function buildParcelPickProxies(plan, site) {
  const proxies = [];
  for (const parcel of plan.parcels) {
    const baseY = parcel.baseY ?? site.heightAt(parcel.center.x, parcel.center.z);
    const focus = planParcelFocus(parcel);
    const { width, depth, height, rotationY, worldX, worldZ } = focus;
    const worldCenter = new THREE.Vector3(worldX, baseY, worldZ);

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth));
    mesh.position.set(worldX, baseY + height / 2, worldZ);
    mesh.rotation.y = rotationY;
    mesh.userData.parcelId = parcel.id;
    mesh.updateMatrixWorld(true);
    proxies.push({
      parcelId: parcel.id,
      mesh,
      bbox: new THREE.Box3().setFromObject(mesh),
      worldCenter,
      dims: new THREE.Vector3(width, height, depth),
      rotY: rotationY,
      buildingSpec: buildParcelSpec(parcel),
      cameraFraming: parcelCameraFraming(worldCenter, focus),
    });
  }
  return proxies;
}

export function cloneCameraFraming(framing) {
  return {
    position: framing.position.clone(),
    target: framing.target.clone(),
    fov: framing.fov,
    referenceFov: framing.referenceFov,
  };
}

function landmarkCameraFraming(
  worldCenter,
  rotationY,
  width,
  depth,
  { lens, azimuth, elevation, targetY, fit, padding },
) {
  const extent = Math.max(width, depth);
  // First reproduce the established composition at its reference lens, including
  // padding, then dolly the whole radius. Scaling only the fit term subtly enlarges
  // monumental compounds when switching to the telephoto profile.
  const referenceRadius = (extent * 0.5) / Math.tan(lens.referenceFov * 0.5 * DEG) * fit
    + extent * padding;
  const radius = dollyDistanceForFov(referenceRadius, lens.referenceFov, lens.fov);
  const offset = new THREE.Vector3(
    radius * Math.cos(elevation * DEG) * Math.sin(azimuth * DEG),
    radius * Math.sin(elevation * DEG),
    radius * Math.cos(elevation * DEG) * Math.cos(azimuth * DEG),
  );
  offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotationY);
  const target = new THREE.Vector3(worldCenter.x, worldCenter.y + targetY, worldCenter.z);
  return {
    position: target.clone().add(offset),
    target,
    fov: lens.fov,
    referenceFov: lens.referenceFov,
  };
}

export function palaceCameraFraming(worldCenter, rotationY, width, depth) {
  return landmarkCameraFraming(worldCenter, rotationY, width, depth, {
    lens: VILLAGE_LENS.palace, azimuth: 40, elevation: 20, targetY: 6, fit: 1.12, padding: 0.12,
  });
}

export function templeCameraFraming(worldCenter, rotationY, width, depth) {
  return landmarkCameraFraming(worldCenter, rotationY, width, depth, {
    lens: VILLAGE_LENS.temple, azimuth: 24, elevation: 17, targetY: 4, fit: 1.16, padding: 0.14,
  });
}

/** Build non-residential focus proxies after palace metadata is available. */
export function buildLandmarkPickProxies(plan, site, { palaceHandle, palaceInner, palaceSpec }) {
  const proxies = [];
  if (plan.features?.palace) {
    const feature = plan.features.palace;
    const width = (palaceHandle ? palaceHandle.regionW : feature.plotW) || 60;
    const depth = (palaceHandle ? palaceHandle.regionD : feature.plotD) || 90;
    const rotY = palaceInner ? palaceInner.rotation.y : G.facingY(feature.frontDir || { x: 0, z: 1 });
    const baseY = palaceInner ? palaceInner.position.y : site?.heightAt?.(feature.x, feature.z) ?? 0;
    const height = 20;
    const worldCenter = new THREE.Vector3(feature.x, baseY, feature.z);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth));
    mesh.position.set(feature.x, baseY + height / 2, feature.z);
    mesh.rotation.y = rotY;
    mesh.userData.parcelId = 'palace';
    mesh.updateMatrixWorld(true);
    proxies.push({
      parcelId: 'palace',
      mesh,
      bbox: new THREE.Box3().setFromObject(mesh),
      worldCenter,
      dims: new THREE.Vector3(width, height, depth),
      rotY,
      buildingSpec: palaceSpec(),
      cameraFraming: palaceCameraFraming(worldCenter, rotY, width, depth),
    });
  }

  if (plan.features?.temple) {
    const feature = plan.features.temple;
    const rotY = G.facingY(feature.frontDir || { x: 0, z: 1 });
    const groundY = feature.baseY ?? site?.heightAt?.(feature.x, feature.z) ?? 0;
    const width = (feature.compoundSize || 33) + 3;
    const depth = width;
    const height = 30;
    const worldCenter = new THREE.Vector3(feature.x, groundY + 9, feature.z);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth));
    mesh.position.set(feature.x, groundY + height / 2, feature.z);
    mesh.rotation.y = rotY;
    mesh.userData.parcelId = 'temple';
    mesh.updateMatrixWorld(true);
    proxies.push({
      parcelId: 'temple',
      mesh,
      bbox: new THREE.Box3().setFromObject(mesh),
      worldCenter,
      dims: new THREE.Vector3(width, height, depth),
      rotY,
      buildingSpec: {
        parcelId: 'temple', family: 'temple', style: 'temple', editable: false, landmark: true,
      },
      cameraFraming: templeCameraFraming(worldCenter, rotY, width, depth),
    });
  }
  return proxies;
}

export function createParcelHighlight() {
  const group = new THREE.Group();
  group.name = 'village-highlight';
  const box = new THREE.BoxGeometry(1, 1, 1);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box),
    new THREE.LineBasicMaterial({ color: 0x2e2a28, transparent: true, opacity: 0.85 }));
  const glow = new THREE.Mesh(box.clone(), new THREE.MeshBasicMaterial({
    color: 0xffe6b0,
    transparent: true,
    opacity: 0.10,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  group.add(edges, glow);
  const scale = new THREE.Vector3();
  return {
    group,
    set(worldCenter, dimensions, rotationY) {
      group.position.set(worldCenter.x, worldCenter.y + dimensions.y / 2, worldCenter.z);
      group.rotation.y = rotationY;
      scale.copy(dimensions).multiplyScalar(1.01);
      edges.scale.copy(scale);
      glow.scale.copy(scale);
    },
  };
}
