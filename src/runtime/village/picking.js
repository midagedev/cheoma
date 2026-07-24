import * as THREE from 'three';
import { planParcelFocus } from '../../generators/shared/parcel-spatial.js';
import {
  createFocusVisibilityIndex,
  sampleFocusSubjectSurface,
  selectSafeFocusEndpoint,
  VILLAGE_FOCUS_CAMERA_CLEARANCE,
  VILLAGE_FOCUS_TERRAIN_CLEARANCE,
} from '../../camera/focus-visibility.js';
import {
  VILLAGE_FOCUS_ELEVATION,
  VILLAGE_LENS,
  dollyDistanceForFov,
} from '../../camera/optics.js';
import * as G from '../../core/math/geom2.js';
import {
  focusPlanningBlockers,
  parcelFocusBlocker,
} from '../../village/focus-blockers.js';
import { terrainWarpInner } from '../../village/terrain-surface.js';
import {
  terrainMeshFocusCutaway,
  terrainGridStep,
  terrainMeshCameraSafeScale,
} from '../../village/terrain-grid.js';
import { buildParcelSpec } from './parcel-edit.js';

const DEG = Math.PI / 180;

function parcelCameraFraming(worldCenter, focus) {
  const target = new THREE.Vector3(worldCenter.x, worldCenter.y + focus.targetLift, worldCenter.z);
  const position = new THREE.Vector3(focus.cameraX, target.y + focus.cameraLift, focus.cameraZ);
  return { position, target, fov: focus.fov, referenceFov: focus.referenceFov };
}

function threeCameraFraming(framing) {
  return {
    position: new THREE.Vector3(framing.position.x, framing.position.y, framing.position.z),
    target: new THREE.Vector3(framing.target.x, framing.target.y, framing.target.z),
    fov: framing.fov,
    referenceFov: framing.referenceFov,
  };
}

function threeBounds(bounds) {
  return new THREE.Box3(
    new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
    new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
  );
}

function heroCameraFraming(proxy) {
  const target = proxy.baseCameraFraming.target;
  const direction = proxy.baseCameraFraming.position.clone().sub(target).normalize();
  const maxDim = Math.max(proxy.dims.x, proxy.dims.y, proxy.dims.z);
  const distance = dollyDistanceForFov(
    1.85,
    VILLAGE_LENS.hero.referenceFov,
    VILLAGE_LENS.hero.fov,
  ) * maxDim;
  // Keep the authored 24° approach even if a stale base framing arrives from an
  // older snapshot. The safe selector scales both axes together after this.
  const horizontal = Math.cos(VILLAGE_FOCUS_ELEVATION) * distance;
  const horizontalDirection = direction.setY(0).normalize();
  return {
    position: {
      x: target.x + horizontalDirection.x * horizontal,
      y: target.y + Math.sin(VILLAGE_FOCUS_ELEVATION) * distance,
      z: target.z + horizontalDirection.z * horizontal,
    },
    target: { x: target.x, y: target.y, z: target.z },
    fov: VILLAGE_LENS.hero.fov,
    referenceFov: VILLAGE_LENS.hero.referenceFov,
  };
}

function visibilityDescriptor(result) {
  return {
    azimuth: result.azimuth,
    baseAzimuth: result.baseAzimuth,
    scale: result.scale,
    requestedScale: result.requestedScale,
    terrainScale: result.terrainScale,
    terrainLimited: result.terrainLimited,
    telephotoPreserved: result.telephotoPreserved,
    terrainMinClearance: result.terrainMinClearance,
    terrainEndpointClearance: result.terrainEndpointClearance,
    terrainCutaway: result.terrainCutaway
      ? structuredClone(result.terrainCutaway)
      : null,
    visibleRatio: result.visibleRatio,
    occlusionRatio: result.occlusionRatio,
    baseVisibleRatio: result.baseVisibleRatio,
    baseOcclusionRatio: result.baseOcclusionRatio,
    blockers: result.blockers,
    baseBlockers: result.baseBlockers,
    candidates: result.candidates,
  };
}

const FOCUS_TERRAIN_CUTAWAY_CACHE = new WeakMap();

function focusTerrainCutaway(proxy, site, safeTerrainRadius, framing) {
  const samples = sampleFocusSubjectSurface(
    framing.position,
    proxy.focusBounds,
    proxy.focusVolume,
  );
  return terrainMeshFocusCutaway(
    site,
    framing.position,
    framing.target,
    samples,
    { maxRadius: safeTerrainRadius },
  );
}

function focusSafeTerrainRadius(plan, site) {
  return plan && site
    ? Math.max(1, terrainWarpInner(plan, site) - terrainGridStep(site))
    : Infinity;
}

function focusCameraSafeScale(site, maxRadius, framing) {
  return terrainMeshCameraSafeScale(
    site,
    framing.target,
    framing.position,
    {
      clearance: VILLAGE_FOCUS_TERRAIN_CLEARANCE,
      endpointClearance: VILLAGE_FOCUS_CAMERA_CLEARANCE,
      maxRadius,
    },
  );
}

export function focusTerrainCutawayForProxy(proxy, plan, site, framing) {
  if (!proxy?.focusBounds || !framing?.position || !framing?.target || !site) {
    return null;
  }
  const cached = FOCUS_TERRAIN_CUTAWAY_CACHE.get(proxy);
  if (cached
    && cached.site === site
    && cached.bounds === proxy.focusBounds
    && cached.volume === proxy.focusVolume
    && cached.px === framing.position.x
    && cached.py === framing.position.y
    && cached.pz === framing.position.z
    && cached.tx === framing.target.x
    && cached.ty === framing.target.y
    && cached.tz === framing.target.z) {
    return cached.result;
  }
  const safeTerrainRadius = focusSafeTerrainRadius(plan, site);
  const cutaway = focusTerrainCutaway(
    proxy,
    site,
    safeTerrainRadius,
    framing,
  );
  const safety = cutaway.active && !cutaway.available
    ? focusCameraSafeScale(site, safeTerrainRadius, framing)
    : null;
  const result = {
    ...cutaway,
    safeScale: safety?.scale ?? 1,
  };
  FOCUS_TERRAIN_CUTAWAY_CACHE.set(proxy, {
    site,
    bounds: proxy.focusBounds,
    volume: proxy.focusVolume,
    px: framing.position.x,
    py: framing.position.y,
    pz: framing.position.z,
    tx: framing.target.x,
    ty: framing.target.y,
    tz: framing.target.z,
    result,
  });
  return result;
}

function solveTerrainAwareFocus(proxy, options, framing, site, safeTerrainRadius) {
  // Object visibility chooses the authored south-opening angle first. Terrain is
  // then presented through one camera near plane, preserving the original
  // distance, FOV and telephoto perspective. Only a cutaway that would reach the
  // house itself falls back to the former safe dolly.
  const authored = selectSafeFocusEndpoint({ ...options, framing });
  const cutaway = focusTerrainCutaway(
    proxy,
    site,
    safeTerrainRadius,
    authored.framing,
  );
  if (!cutaway.active || cutaway.available) {
    return {
      ...authored,
      terrainScale: 1,
      terrainLimited: cutaway.active,
      telephotoPreserved: true,
      terrainMinClearance: cutaway.minClearance,
      terrainEndpointClearance: cutaway.cameraClearance,
      terrainCutaway: cutaway,
    };
  }
  const fallback = selectSafeFocusEndpoint({
    ...options,
    framing,
    constrainEndpoint: (candidate) => focusCameraSafeScale(
      site,
      safeTerrainRadius,
      candidate,
    ),
  });
  const finalCutaway = focusTerrainCutaway(
    proxy,
    site,
    safeTerrainRadius,
    fallback.framing,
  );
  return {
    ...fallback,
    terrainCutaway: finalCutaway,
  };
}

function applySafeParcelFramings(proxies, featureBlockers = [], plan = null, site = null) {
  const residential = proxies.filter((proxy) => (
    proxy.baseCameraFraming && proxy.focusSafety && proxy.focusBounds && proxy.focusVolume
  ));
  const index = createFocusVisibilityIndex([
    ...residential.map((proxy) => ({
      id: proxy.parcelId,
      bounds: proxy.focusBounds,
      volume: proxy.focusVolume,
    })),
    ...featureBlockers,
  ]);
  const safeTerrainRadius = focusSafeTerrainRadius(plan, site);
  const heroParcels = plan?.parcels?.filter((parcel) => parcel.hero) || [];
  const primaryHero = heroParcels.find((parcel) => parcel.heroStyle === 'hanok')
    || heroParcels[0]
    || null;
  for (const proxy of residential) {
    const options = {
      subjectId: proxy.parcelId,
      subjectBounds: proxy.focusBounds,
      subjectVolume: proxy.focusVolume,
      index,
      axisYaw: proxy.focusSafety.axisYaw,
      azimuthMin: proxy.focusSafety.azimuthMin,
      azimuthMax: proxy.focusSafety.azimuthMax,
    };
    const result = site
      ? solveTerrainAwareFocus(
        proxy,
        options,
        proxy.baseCameraFraming,
        site,
        safeTerrainRadius,
      )
      : selectSafeFocusEndpoint({ ...options, framing: proxy.baseCameraFraming });
    proxy.cameraFraming = threeCameraFraming(result.framing);
    proxy.cameraVisibility = visibilityDescriptor(result);

    if (proxy.parcelId === primaryHero?.id) {
      proxy.baseHeroCameraFraming = threeCameraFraming(heroCameraFraming(proxy));
      const heroResult = site
        ? solveTerrainAwareFocus(
          proxy,
          options,
          proxy.baseHeroCameraFraming,
          site,
          safeTerrainRadius,
        )
        : selectSafeFocusEndpoint({
          ...options,
          framing: proxy.baseHeroCameraFraming,
        });
      proxy.heroCameraFraming = threeCameraFraming(heroResult.framing);
      proxy.heroCameraVisibility = visibilityDescriptor(heroResult);
    } else {
      proxy.baseHeroCameraFraming = null;
      proxy.heroCameraFraming = null;
      proxy.heroCameraVisibility = null;
    }
  }
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
    const baseCameraFraming = parcelCameraFraming(worldCenter, focus);
    const focusBlocker = parcelFocusBlocker(parcel, site);
    proxies.push({
      parcelId: parcel.id,
      mesh,
      bbox: new THREE.Box3().setFromObject(mesh),
      worldCenter,
      dims: new THREE.Vector3(width, height, depth),
      rotY: rotationY,
      buildingSpec: buildParcelSpec(parcel),
      baseCameraFraming,
      cameraFraming: cloneCameraFraming(baseCameraFraming),
      focusSafety: {
        axisYaw: rotationY,
        azimuthMin: focus.azimuthMin,
        azimuthMax: focus.azimuthMax,
      },
      focusBounds: focusBlocker ? threeBounds(focusBlocker.bounds) : new THREE.Box3().setFromObject(mesh),
      focusVolume: focusBlocker?.volume || {
          center: { x: worldX, y: baseY + height / 2, z: worldZ },
          half: { x: width / 2, y: height / 2, z: depth / 2 },
          rotationY,
        },
    });
  }
  applySafeParcelFramings(proxies, focusPlanningBlockers(plan, site), plan, site);
  return proxies;
}

export function refreshParcelPickProxy(
  proxy,
  parcel,
  site,
  buildingSpec = null,
  peers = null,
  plan = null,
) {
  if (!proxy || !parcel) return null;
  const focusParcel = buildingSpec?.kind && buildingSpec.kind !== parcel.kind
    ? { ...parcel, kind: buildingSpec.kind }
    : parcel;
  const baseY = parcel.baseY ?? site.heightAt(parcel.center.x, parcel.center.z);
  const focus = planParcelFocus(focusParcel);
  const { width, depth, height, rotationY, worldX, worldZ } = focus;
  proxy.mesh.geometry?.dispose?.();
  proxy.mesh.geometry = new THREE.BoxGeometry(width, height, depth);
  proxy.mesh.position.set(worldX, baseY + height / 2, worldZ);
  proxy.mesh.rotation.y = rotationY;
  proxy.mesh.updateMatrixWorld(true);
  proxy.bbox.setFromObject(proxy.mesh);
  proxy.worldCenter.set(worldX, baseY, worldZ);
  proxy.dims.set(width, height, depth);
  proxy.rotY = rotationY;
  proxy.baseCameraFraming = parcelCameraFraming(proxy.worldCenter, focus);
  proxy.cameraFraming = cloneCameraFraming(proxy.baseCameraFraming);
  proxy.baseHeroCameraFraming = null;
  proxy.heroCameraFraming = null;
  proxy.focusSafety = {
    axisYaw: rotationY,
    azimuthMin: focus.azimuthMin,
    azimuthMax: focus.azimuthMax,
  };
  const focusBlocker = parcelFocusBlocker(focusParcel, site);
  proxy.focusBounds = focusBlocker ? threeBounds(focusBlocker.bounds) : proxy.bbox.clone();
  proxy.focusVolume = focusBlocker?.volume || {
      center: { x: worldX, y: baseY + height / 2, z: worldZ },
      half: { x: width / 2, y: height / 2, z: depth / 2 },
      rotationY,
    };
  proxy.cameraVisibility = null;
  proxy.heroCameraVisibility = null;
  if (buildingSpec) proxy.buildingSpec = buildingSpec;
  applySafeParcelFramings(peers || [proxy], focusPlanningBlockers(plan, site), plan, site);
  return proxy;
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
    lens: VILLAGE_LENS.palace, azimuth: 40, elevation: 20, targetY: 3.2, fit: 1.12, padding: 0.12,
  });
}

export function templeCameraFraming(worldCenter, rotationY, width, depth) {
  return landmarkCameraFraming(worldCenter, rotationY, width, depth, {
    lens: VILLAGE_LENS.temple, azimuth: 24, elevation: 17, targetY: 3, fit: 1.16, padding: 0.14,
  });
}

/** Build non-residential focus proxies after palace metadata is available. */
export function buildLandmarkPickProxies(plan, site, {
  palaceHandle, palaceInner, palaceSpec,
  templeHandle, templeInner, templeSpec,
}) {
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
    const rotY = templeInner?.rotation.y ?? G.facingY(feature.frontDir || { x: 0, z: 1 });
    const groundY = templeInner?.position.y ?? feature.baseY ?? site?.heightAt?.(feature.x, feature.z) ?? 0;
    const width = (templeHandle?.width || feature.compoundWidth || feature.compoundSize || 33) + 2;
    const depth = (templeHandle?.depth || feature.compoundDepth || feature.compoundSize || 33) + 2;
    const height = 18;
    const worldCenter = new THREE.Vector3(feature.x, groundY, feature.z);
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
      buildingSpec: templeSpec ? templeSpec() : {
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
