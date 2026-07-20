import * as THREE from 'three';
import { makeMaterials } from '../../builder/palette.js';
import { buildPavilion } from '../../builder/pavilion.js';
import { buildBridge } from '../../builder/bridge.js';
import { buildParcel } from '../../layout/parcel.js';
import { buildProp } from '../../props/index.js';
import { buildPalaceCompound } from '../../village/palace.js';
import { mergeStatic } from '../../village/instancing.js';
import * as G from '../../core/math/geom2.js';
import { buildFeaturePad, computePadY } from './pads.js';

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

function buildTempleCluster(temple, site) {
  const group = new THREE.Group();
  group.name = 'temple-cluster';
  const width = 30, depth = 30;
  const rotationY = G.facingY(temple.frontDir || { x: 0, z: 1 });
  // footprint의 오르막 끝까지 덮어 대웅전 뒷면 관통을 막되, 거대 옹벽이 되지 않게 규모 비례 cap을 둔다.
  const heightCap = Math.min(18, Math.max(5, (site.Hmax || 68) * 0.16));
  const { group: pad, padY } = buildFeaturePad(
    site, temple.x, temple.z, width + 3, depth + 3, rotationY, heightCap,
  );
  group.add(pad);
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
