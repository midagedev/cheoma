import * as THREE from 'three';
import { parcelRotY } from '../../generators/shared/parcel-transform.js';
import * as G from '../../core/math/geom2.js';
import { buildParcelSpec } from './parcel-edit.js';

const DEG = Math.PI / 180;

function parcelBounds(parcel) {
  const points = parcel.shape?.pts;
  if (!points || points.length < 3) {
    return { width: parcel.plotW, depth: parcel.plotD, centerX: 0, centerZ: 0 };
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  }
  return {
    width: maxX - minX,
    depth: maxZ - minZ,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
  };
}

function parcelCameraFraming(worldCenter, rotationY, maxDimension, height) {
  const azimuth = 38 * DEG;
  const elevation = 7 * DEG;
  const radius = 2.25 * maxDimension;
  const offset = new THREE.Vector3(
    radius * Math.cos(elevation) * Math.sin(azimuth),
    radius * Math.sin(elevation),
    radius * Math.cos(elevation) * Math.cos(azimuth),
  );
  offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotationY);
  const target = new THREE.Vector3(worldCenter.x, worldCenter.y + height * 0.42, worldCenter.z);
  return { position: target.clone().add(offset), target, fov: 23 };
}

export function buildParcelPickProxies(plan, site) {
  const proxies = [];
  for (const parcel of plan.parcels) {
    const baseY = parcel.baseY ?? site.heightAt(parcel.center.x, parcel.center.z);
    const height = parcel.hero ? 14 : (parcel.kind === 'giwa' ? 9 : 6.5);
    const bounds = parcelBounds(parcel);
    const width = bounds.width * 1.08;
    const depth = bounds.depth * 1.08;
    const rotationY = parcelRotY(parcel);
    const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
    const worldX = parcel.center.x + bounds.centerX * cos + bounds.centerZ * sin;
    const worldZ = parcel.center.z - bounds.centerX * sin + bounds.centerZ * cos;
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
      cameraFraming: parcelCameraFraming(worldCenter, rotationY, Math.max(width, depth, height), height),
    });
  }
  return proxies;
}

export function cloneCameraFraming(framing) {
  return { position: framing.position.clone(), target: framing.target.clone(), fov: framing.fov };
}

function landmarkCameraFraming(worldCenter, rotationY, width, depth, { fov, azimuth, elevation, targetY, fit, padding }) {
  const extent = Math.max(width, depth);
  const radius = (extent * 0.5) / Math.tan(fov * 0.5 * DEG) * fit + extent * padding;
  const offset = new THREE.Vector3(
    radius * Math.cos(elevation * DEG) * Math.sin(azimuth * DEG),
    radius * Math.sin(elevation * DEG),
    radius * Math.cos(elevation * DEG) * Math.cos(azimuth * DEG),
  );
  offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotationY);
  const target = new THREE.Vector3(worldCenter.x, worldCenter.y + targetY, worldCenter.z);
  return { position: target.clone().add(offset), target, fov };
}

export function palaceCameraFraming(worldCenter, rotationY, width, depth) {
  return landmarkCameraFraming(worldCenter, rotationY, width, depth, {
    fov: 32, azimuth: 40, elevation: 20, targetY: 6, fit: 1.12, padding: 0.12,
  });
}

export function templeCameraFraming(worldCenter, rotationY, width, depth) {
  return landmarkCameraFraming(worldCenter, rotationY, width, depth, {
    fov: 34, azimuth: 24, elevation: 17, targetY: 4, fit: 1.16, padding: 0.14,
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
    const groundY = site?.heightAt?.(feature.x, feature.z) ?? 0;
    const width = 36;
    const depth = 36;
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
