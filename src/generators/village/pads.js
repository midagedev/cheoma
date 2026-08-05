import * as THREE from 'three';
import * as G from '../../core/math/geom2.js';
import { markSharedResource } from '../../core/three-resources.js';
import { parcelWorldPoint } from '../../village/parcel-contract.js';
import {
  VILLAGE_PAD,
  computePadY,
  planPadSkirtSegments,
} from '../../village/pad-landing-plan.js';
import {
  TEMPLE_PAD_LIFT,
  templeCompoundDepth,
  templeCompoundWidth,
  templeFootprint,
} from '../../village/temple-plan.js';
import {
  featureGroundJunctionBudget,
  planFeatureGroundJunctions,
} from '../../village/feature-junction-plan.js';
import { GROUND_JUNCTION } from '../../village/ground-junction-plan.js';

// Re-export the pure padY helper so existing consumers of this module keep
// working without importing the Three-free plan directly.
export { computePadY };

const PAD_LIFT = VILLAGE_PAD.lift;

// 필지·랜드마크 패드는 같은 두 재질을 공유해 draw call과 material 수를 고정한다.
// skirt 와 선택 축대 course 는 동일 stone family (VILLAGE_PAD.materialRole).
// R2.2: urban 전용 top 재질(동일 MeshStandardMaterial 계열) — 공유 rural 재질은 mutate 금지.
const padTopMaterial = markSharedResource(
  new THREE.MeshStandardMaterial({ color: 0x8a7f66, roughness: 1, metalness: 0 }),
);
const padTopMaterialUrban = markSharedResource(
  // R2.3: 도성 지면 절반 환원(terrain urban cCourt 와 동일).
  new THREE.MeshStandardMaterial({ color: 0x807560, roughness: 1, metalness: 0 }),
);
// vertexColors carries the #56 석축 course dressing (per-stone value, joint shadow,
// crown highlight, 갓돌). It is still ONE material and one program family: plain pad
// skirts write neutral white, so their look is byte-for-byte the previous one.
const padStoneMaterial = markSharedResource(
  new THREE.MeshStandardMaterial({
    color: 0x8d857a, roughness: 1, metalness: 0, vertexColors: true,
  }),
);
padStoneMaterial.userData.materialRole = VILLAGE_PAD.materialRole;

function isUrbanScale(site) {
  return site?.scale === 'capital' || site?.scale === 'hanyang';
}

function padTopForSite(site) {
  return isUrbanScale(site) ? padTopMaterialUrban : padTopMaterial;
}

export function featurePadMaterials(site) {
  return { top: padTopForSite(site), stone: padStoneMaterial };
}

function makeBufferMesh(positions, indices, material, name, colors = null) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  // padStoneMaterial carries vertexColors, so EVERY mesh drawn with it must supply a
  // colour attribute. Plain pad skirts write neutral white and therefore look exactly
  // as they did before the #56 dressing landed.
  if (colors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function pushNeutral(colors, vertexCount) {
  for (let index = 0; index < vertexCount; index++) colors.push(1, 1, 1);
}

function emitPad(polygon, padY, site, topPositions, topIndices, skirtPositions, skirtIndices,
  skirtColors) {
  const pad = G.offsetPoly(G.ensureCCW(polygon), VILLAGE_PAD.margin);
  const topBase = topPositions.length / 3;
  for (const corner of pad) topPositions.push(corner.x, padY, corner.z);
  for (let i = 1; i < pad.length - 1; i++) topIndices.push(topBase, topBase + i + 1, topBase + i);

  // Pure skirt plan owns segment split / sink / stepMin so wall-foot coherence
  // can be asserted without rebuilding geometry. Renderer only tessellates.
  const segments = planPadSkirtSegments(polygon, padY, site);
  for (const segment of segments) {
    const base = skirtPositions.length / 3;
    skirtPositions.push(
      segment.a.x, segment.topY, segment.a.z,
      segment.a.x, segment.bottom0, segment.a.z,
      segment.b.x, segment.topY, segment.b.z,
      segment.b.x, segment.bottom1, segment.b.z,
    );
    if (skirtColors) pushNeutral(skirtColors, 4);
    skirtIndices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
}

// One quad per junction COURSE. Every course bottom stays at or below the chord's
// exact rendered-terrain minimum, so closure is unaffected by the dressing.
//
// The face is 석축, not a slab: courses stack, the face batters (each course sits
// slightly further out as it goes down), a 갓돌 capstone laps over the top with its
// own ledge, and stone value varies per block. All of that rides VERTEX COLOURS on
// the existing pad-stone material — jointShade darkens each course's bottom edge and
// crownLift lifts its top, which is what makes the horizontal joints read.
function emitJunctionSegments(segments, skirtPositions, skirtIndices, skirtColors) {
  const { jointShade, crownLift } = GROUND_JUNCTION;
  for (const segment of segments) {
    const nx = segment.normal?.x ?? 0;
    const nz = segment.normal?.z ?? 0;
    for (const course of segment.courses) {
      const topOut = course.outsetTop, bottomOut = course.outsetBottom;
      const ax0 = segment.a.x + nx * topOut, az0 = segment.a.z + nz * topOut;
      const bx0 = segment.b.x + nx * topOut, bz0 = segment.b.z + nz * topOut;
      const ax1 = segment.a.x + nx * bottomOut, az1 = segment.a.z + nz * bottomOut;
      const bx1 = segment.b.x + nx * bottomOut, bz1 = segment.b.z + nz * bottomOut;
      const base = skirtPositions.length / 3;
      skirtPositions.push(
        ax0, course.topY, az0,
        ax1, course.bottomY, az1,
        bx0, course.topY, bz0,
        bx1, course.bottomY, bz1,
      );
      const top = course.tone * (1 + crownLift);
      const bottom = course.tone * (1 - jointShade);
      skirtColors.push(top, top, top, bottom, bottom, bottom, top, top, top, bottom, bottom, bottom);
      skirtIndices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);

      // The capstone laps outward, so its top face is exposed: close that ledge or
      // the eye looks straight down into the backfaces of the courses below.
      // The vertical quads inherit the shipped pad-skirt winding, but this ledge is
      // horizontal, so its winding must be chosen explicitly or it faces the ground.
      if (course.role === 'capstone' && topOut > 0) {
        const ledge = skirtPositions.length / 3;
        skirtPositions.push(
          segment.a.x, course.topY, segment.a.z,
          ax0, course.topY, az0,
          segment.b.x, course.topY, segment.b.z,
          bx0, course.topY, bz0,
        );
        const lit = course.tone * (1 + crownLift);
        for (let vertex = 0; vertex < 4; vertex++) skirtColors.push(lit, lit, lit);
        // (n × d)_y decides which way (ring_a, out_a, ring_b) faces.
        const dx = segment.b.x - segment.a.x, dz = segment.b.z - segment.a.z;
        if (nz * dx - nx * dz > 0) {
          skirtIndices.push(ledge, ledge + 1, ledge + 2, ledge + 2, ledge + 1, ledge + 3);
        } else {
          skirtIndices.push(ledge, ledge + 2, ledge + 1, ledge + 2, ledge + 3, ledge + 1);
        }
      }
    }
  }
}

export function buildParcelPads(parcels, site, plan = null) {
  const group = new THREE.Group();
  group.name = 'village-pads';
  const topPositions = [], topIndices = [], skirtPositions = [], skirtIndices = [];
  const skirtColors = [];
  for (const parcel of parcels) {
    if (!parcel.poly) continue;
    emitPad(
      parcel.poly,
      parcel.baseY ?? computePadY(parcel, site),
      site,
      topPositions,
      topIndices,
      skirtPositions,
      skirtIndices,
      skirtColors,
    );
  }
  // #56 접지면: 패드를 갖지 않는 구조물(시전 행랑·정자 기단·보호수 돌단)의 석축 면을 같은
  //   pad-skirt 버퍼에 넣는다. 재질·드로우콜 델타 0 — 새 재질군을 만들면 병합이 갈라진다.
  //   배치·기단 높이는 계획(feature-junction-plan)이 소유하고 여기서는 삼각형만 만든다.
  let junctionBudget = null;
  // Index where the parcel skirt ends and the feature junctions begin. Lets a
  // same-boot A/B capture isolate the junction face with setDrawRange instead of
  // shipping a runtime feature flag, and lets an audit assert the fold.
  const parcelSkirtIndexCount = skirtIndices.length;
  if (plan) {
    const junctions = planFeatureGroundJunctions(plan, site);
    for (const entry of junctions) {
      emitJunctionSegments(entry.junction.segments, skirtPositions, skirtIndices, skirtColors);
    }
    junctionBudget = featureGroundJunctionBudget(junctions);
  }
  if (topIndices.length) group.add(makeBufferMesh(topPositions, topIndices, padTopForSite(site), 'pad-top'));
  // pad-skirt is the single downhill 축대 course face; same stone material role.
  if (skirtIndices.length) {
    group.add(makeBufferMesh(skirtPositions, skirtIndices, padStoneMaterial, 'pad-skirt', skirtColors));
  }
  if (junctionBudget) {
    group.userData.groundJunction = {
      ...junctionBudget,
      parcelSkirtIndexCount,
      totalSkirtIndexCount: skirtIndices.length,
    };
  }
  return group;
}

// poly가 없는 절·궁 feature를 회전 사각 footprint의 석축 terrace에 앉힌다.
export function buildFeaturePad(site, centerX, centerZ, width, depth, rotationY = 0, heightCap = 3.2) {
  const halfWidth = width / 2, halfDepth = depth / 2;
  const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
  const polygon = [
    [-halfWidth, -halfDepth], [halfWidth, -halfDepth],
    [halfWidth, halfDepth], [-halfWidth, halfDepth],
  ].map(([x, z]) => ({
    x: centerX + x * cos + z * sin,
    z: centerZ - x * sin + z * cos,
  }));
  let padY = site.heightAt(centerX, centerZ);
  let minimum = padY;
  for (const corner of polygon) {
    const height = site.heightAt(corner.x, corner.z);
    padY = Math.max(padY, height);
    minimum = Math.min(minimum, height);
  }
  padY = Math.min(padY, minimum + heightCap) + PAD_LIFT;

  const group = new THREE.Group();
  group.name = 'feature-pad';
  const topPositions = [], topIndices = [], skirtPositions = [], skirtIndices = [];
  const skirtColors = [];
  emitPad(polygon, padY, site, topPositions, topIndices, skirtPositions, skirtIndices, skirtColors);
  if (topIndices.length) group.add(makeBufferMesh(topPositions, topIndices, padTopForSite(site), 'feat-pad-top'));
  if (skirtIndices.length) {
    group.add(makeBufferMesh(skirtPositions, skirtIndices, padStoneMaterial, 'feat-pad-skirt', skirtColors));
  }
  return { group, padY };
}

function localRectPolygon(frame, minX, maxX, minZ, maxZ) {
  return [
    { x: maxX, z: maxZ }, { x: minX, z: maxZ },
    { x: minX, z: minZ }, { x: maxX, z: minZ },
  ].map((point) => parcelWorldPoint(frame, point));
}

function samplePolygonRange(site, frame, width, depth, divisions = 4) {
  const halfWidth = width * 0.5;
  const halfDepth = depth * 0.5;
  let min = Infinity, max = -Infinity;
  for (let row = 0; row <= divisions; row++) for (let column = 0; column <= divisions; column++) {
    const point = parcelWorldPoint(frame, {
      x: -halfWidth + width * column / divisions,
      z: -halfDepth + depth * row / divisions,
    });
    const height = site.heightAt(point.x, point.z);
    min = Math.min(min, height);
    max = Math.max(max, height);
  }
  return { min, max, drop: max - min };
}

function polygonMaxHeight(site, polygon) {
  let maximum = -Infinity;
  for (const point of polygon) maximum = Math.max(maximum, site.heightAt(point.x, point.z));
  const center = G.polyCentroid(polygon);
  return Math.max(maximum, site.heightAt(center.x, center.z));
}

// A sloped temple site cannot use the generic capped single shelf: lowering it
// buries the rear hall, while raising it produces one enormous front wall. Keep
// the precinct at the real rotated-footprint maximum and, only when needed, cover
// the downhill face with narrow apron terraces. All tiers share two aggregate
// buffers, so terrain adaptation does not add draw calls.
export function buildTempleFeaturePad(site, temple) {
  const frame = {
    center: { x: temple.x, z: temple.z },
    frontDir: temple.frontDir || { x: 0, z: 1 },
  };
  const width = templeCompoundWidth(temple);
  const depth = templeCompoundDepth(temple);
  const upper = templeFootprint(temple);
  const relief = samplePolygonRange(site, frame, width, depth);
  const reliefCap = temple.placement?.reliefCap
    || Math.min(8, Math.max(4, (site.Hmax || 68) * 0.08));
  // Above roughly one human storey, split the downhill face so even a compact
  // precinct reads as low retaining terraces rather than a single plinth.
  const terraceRiseCap = Math.min(2.4, reliefCap);
  const tierCount = Math.max(1, Math.min(3, Math.ceil(relief.drop / Math.max(1, terraceRiseCap))));
  const padY = Number.isFinite(temple.baseY) ? temple.baseY : relief.max + TEMPLE_PAD_LIFT;
  const surfaces = [{ polygon: upper, y: padY, role: 'court' }];

  const halfWidth = width * 0.5;
  const halfDepth = depth * 0.5;
  const apronDepth = 5.2;
  const overlap = 0.9;
  for (let tier = 1; tier < tierCount; tier++) {
    const back = halfDepth - overlap + (tier - 1) * (apronDepth - overlap);
    const front = back + apronDepth;
    const apronHalfWidth = halfWidth + 0.7 - tier * 0.35;
    const polygon = localRectPolygon(frame, -apronHalfWidth, apronHalfWidth, back, front);
    const desired = padY - relief.drop * tier / tierCount;
    const y = Math.max(desired, polygonMaxHeight(site, polygon) + PAD_LIFT);
    surfaces.push({ polygon, y, role: 'apron' });
  }

  const group = new THREE.Group();
  group.name = 'feature-pad';
  const topPositions = [], topIndices = [], skirtPositions = [], skirtIndices = [];
  const skirtColors = [];
  for (const surface of surfaces) {
    emitPad(
      surface.polygon,
      surface.y,
      site,
      topPositions,
      topIndices,
      skirtPositions,
      skirtIndices,
      skirtColors,
    );
  }
  if (topIndices.length) group.add(makeBufferMesh(topPositions, topIndices, padTopForSite(site), 'feat-pad-top'));
  if (skirtIndices.length) {
    group.add(makeBufferMesh(skirtPositions, skirtIndices, padStoneMaterial, 'feat-pad-skirt', skirtColors));
  }
  group.userData.terraceCount = tierCount;
  return { group, padY, surfaces, relief, reliefCap, tierCount };
}
