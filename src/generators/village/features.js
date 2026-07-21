import * as THREE from 'three';
import { makeMaterials } from '../../builder/palette.js';
import { buildPavilion } from '../../builder/pavilion.js';
import { buildBridge } from '../../builder/bridge.js';
import { buildParcel } from '../../layout/parcel.js';
import { buildProp } from '../../props/index.js';
import { buildPalaceCompound } from '../../village/palace.js';
import { mergeStatic } from '../../village/instancing.js';
import * as G from '../../core/math/geom2.js';
import { terrainMeshHeightAt } from '../../village/terrain-grid.js';
import { TEMPLE_PATH_WIDTH, templeCompoundSize } from '../../village/temple-plan.js';
import {
  buildFeaturePad,
  buildTempleFeaturePad,
  computePadY,
  featurePadMaterials,
} from './pads.js';

function gableRoof(width, depth, height, material) {
  const halfWidth = width / 2, halfDepth = depth / 2;
  const positions = [
    -halfWidth, 0, -halfDepth, halfWidth, 0, -halfDepth,
    halfWidth, 0, halfDepth, -halfWidth, 0, halfDepth,
    -halfWidth, height, 0, halfWidth, height, 0,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex([3, 2, 5, 3, 5, 4, 1, 0, 4, 1, 4, 5, 0, 3, 4, 2, 1, 5]);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

export function buildSijeon(shops, site) {
  const materials = makeMaterials('giwa');
  const tileMaterial = materials.tileFlat.clone();
  tileMaterial.side = THREE.DoubleSide;
  const group = new THREE.Group();
  for (const shop of shops) {
    const unit = new THREE.Group();
    const width = shop.w * 0.96, depth = shop.d * 0.86, bodyHeight = 3;
    const body = new THREE.Mesh(new THREE.BoxGeometry(width, bodyHeight, depth), materials.plaster);
    body.position.y = bodyHeight / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    unit.add(body);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(width + 0.1, 0.4, depth + 0.1), materials.woodDark);
    beam.position.y = bodyHeight - 0.2;
    unit.add(beam);
    const roof = gableRoof(width + 1.4, depth + 1.6, 1.7, tileMaterial);
    roof.position.y = bodyHeight;
    roof.castShadow = true;
    roof.receiveShadow = true;
    unit.add(roof);
    unit.position.set(shop.center.x, site.heightAt(shop.center.x, shop.center.z), shop.center.z);
    unit.rotation.y = G.facingY(shop.frontDir);
    group.add(unit);
  }
  return mergeStatic([group], 'village-sijeon');
}

// 컴파운드 내부의 실제 door/hanji material set을 야간 패치 대상으로 모은다.
export function collectMaterialSets(root, target) {
  root.traverse((object) => {
    const materials = object.userData?.materials || object.userData?.mats;
    if (materials?.door && !target.includes(materials)) target.push(materials);
  });
}

export function buildPaddyFields(site, paddies) {
  const group = new THREE.Group();
  group.name = 'village-paddies';
  const fieldMaterials = new Map();
  const fieldMaterial = (tone) => {
    if (!fieldMaterials.has(tone)) {
      fieldMaterials.set(tone, new THREE.MeshStandardMaterial({
        color: tone, roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
      }));
    }
    return fieldMaterials.get(tone);
  };
  const isLargeSite = site.R > 300;
  const bundMaterial = isLargeSite
    ? new THREE.MeshStandardMaterial({ color: 0x94875a, roughness: 1, metalness: 0, side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial({ color: 0x7a7048, roughness: 1, metalness: 0 });
  const bundHeight = isLargeSite ? 0.34 : 0.22;

  for (const field of paddies) {
    const shape = new THREE.Shape();
    field.poly.forEach((point, index) => {
      if (index) shape.lineTo(point.x, -point.z);
      else shape.moveTo(point.x, -point.z);
    });
    shape.closePath();
    const fieldGeometry = new THREE.ShapeGeometry(shape);
    fieldGeometry.rotateX(-Math.PI / 2);
    const fieldMesh = new THREE.Mesh(fieldGeometry, fieldMaterial(field.tone || 0x6a7b3f));
    fieldMesh.position.y = field.y;
    fieldMesh.receiveShadow = true;
    group.add(fieldMesh);

    const ring = [...field.poly, field.poly[0]];
    const topY = field.y + bundHeight;
    const positions = [], indices = [];
    if (isLargeSite) {
      const center = { x: 0, z: 0 };
      for (const point of field.poly) { center.x += point.x; center.z += point.z; }
      center.x /= field.poly.length; center.z /= field.poly.length;
      for (const point of ring) {
        let dx = center.x - point.x, dz = center.z - point.z;
        const distance = Math.hypot(dx, dz) || 1;
        const inset = Math.min(1.1, distance * 0.45);
        dx = dx / distance * inset; dz = dz / distance * inset;
        positions.push(
          point.x, field.y, point.z,
          point.x, topY, point.z,
          point.x + dx, topY, point.z + dz,
        );
      }
      for (let i = 0; i < ring.length - 1; i++) {
        const a = i * 3, b = a + 3;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
        indices.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
      }
    } else {
      for (const point of ring) positions.push(point.x, field.y, point.z, point.x, topY, point.z);
      for (let i = 0; i < ring.length - 1; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        indices.push(a, c, b, b, c, d);
      }
    }
    const bundGeometry = new THREE.BufferGeometry();
    bundGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    bundGeometry.setIndex(indices);
    bundGeometry.computeVertexNormals();
    group.add(new THREE.Mesh(bundGeometry, bundMaterial));
  }
  return group;
}

export function buildHeroParcel(parcel, site) {
  const group = new THREE.Group();
  group.add(buildParcel({
    seed: parcel.seed || 7,
    style: parcel.heroStyle || 'hanok',
    plotW: parcel.plotW,
    plotD: parcel.plotD,
    lanterns: false,
  }));
  group.rotation.y = G.facingY(parcel.frontDir);
  group.position.set(
    parcel.center.x,
    parcel.baseY ?? computePadY(parcel, site),
    parcel.center.z,
  );
  group.userData.parcel = parcel;
  return group;
}

function buildTempleApproach(temple, site, surfaces) {
  const group = new THREE.Group();
  group.name = 'temple-approach';
  const path = temple.path || [];
  if (path.length < 2) return group;
  const width = temple.pathWidth || TEMPLE_PATH_WIDTH;
  const materials = featurePadMaterials();
  const heightAt = (point) => {
    let height = terrainMeshHeightAt(site, point.x, point.z) + 0.075;
    for (const surface of surfaces) {
      if (G.pointInPoly(point, surface.polygon)) height = Math.max(height, surface.y + 0.015);
    }
    return height;
  };
  const tangentAt = (index) => G.norm(G.sub(
    path[Math.min(path.length - 1, index + 1)],
    path[Math.max(0, index - 1)],
  ));

  const positions = [], indices = [], heights = [];
  for (let index = 0; index < path.length; index++) {
    const point = path[index], tangent = tangentAt(index), normal = G.perpR(tangent);
    const left = G.add(point, G.mul(normal, width * 0.5));
    const right = G.add(point, G.mul(normal, -width * 0.5));
    const leftY = heightAt(left), rightY = heightAt(right);
    positions.push(left.x, leftY, left.z, right.x, rightY, right.z);
    heights.push((leftY + rightY) * 0.5);
    if (!index) continue;
    const previous = (index - 1) * 2, current = index * 2;
    indices.push(previous, current, previous + 1, previous + 1, current, current + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const ribbon = new THREE.Mesh(geometry, materials.top);
  ribbon.name = 'temple-approach-ribbon';
  ribbon.receiveShadow = true;
  group.add(ribbon);

  const stepPositions = [], stepIndices = [];
  const emitStep = (point, tangent, y) => {
    const right = G.perpR(tangent);
    const halfWidth = width * 0.56, halfDepth = 0.24, halfHeight = 0.08;
    const base = stepPositions.length / 3;
    for (const [sx, sy, sz] of [
      [-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1],
      [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1],
    ]) {
      stepPositions.push(
        point.x + right.x * sx * halfWidth + tangent.x * sz * halfDepth,
        y + sy * halfHeight,
        point.z + right.z * sx * halfWidth + tangent.z * sz * halfDepth,
      );
    }
    for (const triangle of [
      [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
      [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
    ]) stepIndices.push(...triangle.map((index) => base + index));
  };
  for (let index = 0; index < path.length - 1; index++) {
    const distance = G.dist(path[index], path[index + 1]);
    if (distance < 1e-6) continue;
    const rise = Math.abs(heights[index + 1] - heights[index]);
    if (rise / distance < 0.16 && rise < 0.55) continue;
    emitStep(
      G.lerp(path[index], path[index + 1], 0.5),
      G.norm(G.sub(path[index + 1], path[index])),
      (heights[index] + heights[index + 1]) * 0.5 + 0.08,
    );
  }
  if (stepIndices.length) {
    const stepGeometry = new THREE.BufferGeometry();
    stepGeometry.setAttribute('position', new THREE.Float32BufferAttribute(stepPositions, 3));
    stepGeometry.setIndex(stepIndices);
    stepGeometry.computeVertexNormals();
    const steps = new THREE.Mesh(stepGeometry, materials.stone);
    steps.name = 'temple-approach-steps';
    steps.castShadow = true;
    steps.receiveShadow = true;
    group.add(steps);
    group.userData.stepCount = stepIndices.length / 36;
  } else group.userData.stepCount = 0;
  group.userData.drawCalls = group.children.length;
  return group;
}

function buildTempleCluster(temple, site) {
  const group = new THREE.Group();
  group.name = 'temple-cluster';
  const size = templeCompoundSize(temple);
  const width = size - 3, depth = size - 3;
  const rotationY = G.facingY(temple.frontDir || { x: 0, z: 1 });
  const { group: pad, padY, surfaces } = buildTempleFeaturePad(site, temple);
  group.add(pad);
  group.add(buildTempleApproach(temple, site, surfaces));
  const inner = new THREE.Group();
  inner.add(buildParcel({
    seed: temple.seed || 11,
    style: 'temple',
    plotW: width,
    plotD: depth,
    lanterns: false,
  }));
  inner.rotation.y = rotationY;
  inner.position.set(temple.x, padY, temple.z);
  group.add(inner);
  return group;
}

function buildPalaceCore(palace, site) {
  const group = new THREE.Group();
  group.name = 'palace-core';
  const width = palace.plotW || 40, depth = palace.plotD || 34;
  const rotationY = G.facingY(palace.frontDir || { x: 0, z: 1 });
  const { group: pad, padY } = buildFeaturePad(
    site, palace.x, palace.z, width + 4, depth + 4, rotationY,
  );
  group.add(pad);
  const inner = new THREE.Group();
  const compound = palace.tier
    ? buildPalaceCompound({
        w: width, d: depth, tier: palace.tier,
        variant: palace.variant || 'axial', seed: palace.seed || 5,
      })
    : buildParcel({
        seed: palace.seed || 5, style: 'palace',
        plotW: width, plotD: depth, lanterns: false,
      });
  inner.add(compound);
  inner.rotation.y = rotationY;
  inner.position.set(palace.x, padY, palace.z);
  group.add(inner);
  group.userData.palaceCompound = compound;
  return group;
}

export function buildFeatureObjects(plan, site) {
  const features = plan.features;
  const objects = [];
  if (features.pavilion) {
    const pavilion = buildPavilion({ sides: features.pavilion.sides || 6 });
    pavilion.position.set(
      features.pavilion.x,
      site.heightAt(features.pavilion.x, features.pavilion.z),
      features.pavilion.z,
    );
    pavilion.rotation.y = features.pavilion.rot || 0;
    objects.push(pavilion);
  }
  for (const bridgeSpec of features.bridges || []) {
    const bridge = buildBridge({
      type: bridgeSpec.type || 'slab',
      span: bridgeSpec.span || 5,
      width: bridgeSpec.width || 1.8,
    });
    const streamZ = site.streamZat(bridgeSpec.x);
    const bankHeight = Math.max(
      site.heightAt(bridgeSpec.x, streamZ - (site.streamHalf + 3)),
      site.heightAt(bridgeSpec.x, streamZ + (site.streamHalf + 3)),
    );
    const y = bridgeSpec.type === 'arch'
      ? site.streamY(bridgeSpec.x)
      : Math.max(site.streamY(bridgeSpec.x), bankHeight - 0.35);
    bridge.position.set(bridgeSpec.x, y, bridgeSpec.z);
    bridge.rotation.y = bridgeSpec.rot || 0;
    objects.push(bridge);
  }
  for (const propSpec of features.props || []) {
    const prop = buildProp(propSpec.name, { seed: propSpec.seed || 3, scale: propSpec.scale });
    prop.position.set(propSpec.x, site.heightAt(propSpec.x, propSpec.z), propSpec.z);
    prop.rotation.y = propSpec.rot || 0;
    objects.push(prop);
  }
  if (features.temple) objects.push(buildTempleCluster(features.temple, site));
  if (features.palace) objects.push(buildPalaceCore(features.palace, site));
  return objects;
}
