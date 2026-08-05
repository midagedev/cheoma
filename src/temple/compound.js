import * as THREE from 'three';
import { PRESETS } from '../params.js';
import { buildBuilding } from '../builder/index.js';
import {
  canonicalizeSharedMaterials,
  makeDancheongVariant,
  makeMaterials,
} from '../builder/palette.js';
import {
  resolveDancheong,
  resolveTempleRoleDancheong,
} from '../builder/dancheong.js';
import { buildFence } from '../layout/fence.js';
import { buildGate } from '../layout/gate.js';
import { buildProp } from '../props/index.js';
import {
  addMaterialResource,
  collectObjectResources,
  disposeObjectResources,
} from '../core/three-resources.js';
import { normalizeTemplePlan, planTempleCompound } from './plan.js';
import { templeHallBuilderPreset, templeUpperStoreyPreset } from './role-hierarchy.js';
import { templeHallPlaquePlan } from './plaque-plan.js';

const lifecycle = new WeakMap();

function collectPaletteResources(palette) {
  const materials = new Set();
  const textures = new Set();
  for (const value of Object.values(palette || {})) {
    if (value?.isMaterial) addMaterialResource(value, materials, textures);
    else if (value?.isTexture) textures.add(value);
  }
  return { materials, textures };
}

function collectPalettesResources(palettes) {
  const resources = { materials: new Set(), textures: new Set() };
  for (const palette of palettes) {
    const current = collectPaletteResources(palette);
    for (const material of current.materials) resources.materials.add(material);
    for (const texture of current.textures) resources.textures.add(texture);
  }
  return resources;
}

function makeCourtMaterial(role) {
  return new THREE.MeshStandardMaterial({
    color: role === 'worship' ? 0xc2b69a : 0xb9ad91,
    roughness: 1,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
}

function polygonMesh(polygon, material, y, name) {
  const shape = new THREE.Shape();
  polygon.forEach((p, index) => {
    if (index) shape.lineTo(p.x, -p.z);
    else shape.moveTo(p.x, -p.z);
  });
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.position.y = y;
  mesh.receiveShadow = true;
  return mesh;
}

function hallPreset(spec, seed, mats) {
  const passUnder = spec.passUnder?.openLower
    ? {
      openLowerCorridor: true,
      passUnderWidth: spec.passUnder.corridorWidth,
      passUnderHeight: spec.passUnder.corridorHeight,
    }
    : null;
  return {
    // One owner for the preset composition (role-hierarchy.js): the pure plaque
    // planner resolves its layout landmarks from the same call.
    ...templeHallBuilderPreset(spec),
    seed,
    mats,
    // 누하: raised hall with an open lower corridor — no palace ornaments, same
    // temple palette, walls omitted so the processional axis walks through.
    ...(passUnder || {}),
  };
}

// 현판: 무자 바탕판 + 밝은 테두리 몰딩. Both materials are borrowed from the hall's
// own palette — no plaque-local material, texture, clone, or program family.
//   바탕 `planwall`(판벽, 0x4a3a28): 어두운 널 + **metalness 0**. 종전 `hardware`(창호 철물)는
//   병합 그룹이 늘지 않는 대신 metalness 0.42를 함께 차입했고, 환경맵이 없는 처마 그늘에서는
//   스페큘러 이득 0 · 디퓨즈 −42% 순손실이라 판 내부가 계조 없는 검은 클램프로 떨어졌다
//   (2026-08-05 비전 FIX: "현판이 아니라 구멍"). 판벽은 의미도 맞고 metalness도 0이므로
//   재질을 clone·변형하지 않고 교체만으로 닫힌다 — 대가는 병합 그룹 +1(§8.3).
//   몰딩 `wood`(백골): 주불전이 이미 그리는 재질이라 +0.
// Geometry only — no glyphs (see plaque-plan.js).
function buildHallPlaque(plaque, mats) {
  const { board, molding } = plaque;
  const group = new THREE.Group();
  group.name = 'hall-plaque';
  group.userData.templePlaque = plaque;
  const railDepth = board.thickness + molding.proud;
  const railZ = molding.proud / 2;
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(board.width, board.height, board.thickness),
    mats.planwall,
  );
  panel.name = 'plaque-board';
  group.add(panel);
  const innerHeight = Math.max(0.02, board.height - molding.rail * 2);
  const rails = [
    ['plaque-molding-top', board.width, molding.rail, 0, (board.height - molding.rail) / 2],
    ['plaque-molding-bottom', board.width, molding.rail, 0, -(board.height - molding.rail) / 2],
    ['plaque-molding-left', molding.rail, innerHeight, -(board.width - molding.rail) / 2, 0],
    ['plaque-molding-right', molding.rail, innerHeight, (board.width - molding.rail) / 2, 0],
  ];
  for (const [name, width, height, x, y] of rails) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(width, height, railDepth), mats.wood);
    rail.name = name;
    rail.position.set(x, y, railZ);
    group.add(rail);
  }
  for (const mesh of group.children) mesh.castShadow = true;
  group.position.set(plaque.local.x, plaque.local.y, plaque.local.z);
  return group;
}

function buildHall(spec, seed, mats) {
  const building = buildBuilding(hallPreset(spec, seed, mats));
  building.name = `temple-${spec.id}`;
  // Mountain entry may lift a pass-under one apron step; flat stays on grade so
  // the open lower corridor reads as a true walk-under volume.
  const lift = Number.isFinite(spec.elevation) ? spec.elevation : 0;
  building.position.set(spec.position.x, lift, spec.position.z);
  building.rotation.y = spec.yaw || 0;
  building.scale.setScalar(spec.scale || 1);
  building.userData.templeId = spec.id;
  building.userData.templeRole = spec.role;
  building.userData.templeArchitecture = {
    id: spec.architectureId,
    architecturalRank: spec.architecturalRank,
    roofGrammar: spec.roofGrammar,
    bracketGrammar: spec.bracketGrammar,
    eaveGrammar: spec.eaveGrammar,
  };
  // 중층(重層): 대찰 주불전만. 상층은 같은 칸 모듈을 칸수만 줄여 한 층 더 올린 것이고,
  // 앉힘 높이(`seatY`)와 제원은 전부 plan-owned 다 — 여기서 층고를 다시 풀지 않는다.
  // 팔레트를 하층과 공유하므로 새 재질군·프로그램 계열이 0 이다. 전각 그룹의 자식이라
  // yaw·scale·단 리프트를 함께 받는다.
  if (spec.upperStorey) {
    const upper = buildBuilding({ ...templeUpperStoreyPreset(spec), seed: (seed ^ 0x2b1f) >>> 0, mats });
    upper.name = 'upper-storey';
    upper.position.y = spec.upperStorey.seatY;
    upper.userData.templeUpperStorey = spec.upperStorey;
    building.add(upper);
    building.userData.templeStoreys = spec.storeys || 2;
  }
  // 현판은 주불전(유일한 rank-4 전각)에만. plan-owned 기하를 그대로 소비하고, 전각 그룹의
  // 자식이므로 yaw·scale·에이프런 리프트를 함께 받는다.
  const plaque = templeHallPlaquePlan(spec);
  if (plaque) {
    building.add(buildHallPlaque(plaque, mats));
    building.userData.templePlaque = plaque;
  }
  if (spec.passUnder?.openLower) {
    building.userData.templePassUnder = {
      openLower: true,
      corridorWidth: spec.passUnder.corridorWidth,
      corridorHeight: spec.passUnder.corridorHeight,
    };
  }
  return building;
}

function buildPaths(paths, material) {
  const group = new THREE.Group();
  group.name = 'temple-paths';
  for (const path of paths) {
    for (let index = 0; index < path.points.length - 1; index++) {
      const a = path.points[index], b = path.points[index + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length < 1e-4) continue;
      // 답도 높이는 plan.terraces 가 확정한 단 상면이다(terrace-plan.js).
      const ya = path.elevations?.[index] || 0;
      const yb = path.elevations?.[index + 1] || 0;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(length, 0.055, path.width),
        material,
      );
      mesh.name = `${path.id}-${index}`;
      mesh.position.set((a.x + b.x) * 0.5, 0.038 + (ya + yb) * 0.5, (a.z + b.z) * 0.5);
      mesh.rotation.y = Math.atan2(-dz, dx);
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  return group;
}

// 막돌 석축 (段 사이 옹벽) + 편심 계단.
//
// 사료 사진(마하연 1930)의 석축은 정연한 켜쌓기가 아니라 크기가 뒤섞인 막돌이고
// 상단이 지형에 맞춰 오르내린다. 그래서 텍스처가 아니라 **기하**로 만든다 —
// `mats.stone` 은 담 하부 화강암 인스턴스가 이미 그리는 재질이라 병합 그룹이 늘지 않고
// (드로우콜 +0), 텍스처 한 장으로는 막돌의 크기 편차를 만들 수 없다.
// 세그먼트별 상단 높이는 plan-owned(`riser.segments[].topY`)이며 여기서 추론하지 않는다.
function buildTerraceRisers(terraces, mats) {
  const group = new THREE.Group();
  group.name = 'temple-terraces';
  if (!terraces || terraces.tierCount < 2) return group;
  const positions = [], indices = [];
  const pushBox = (minX, maxX, minY, maxY, minZ, maxZ) => {
    const base = positions.length / 3;
    for (const [x, y, z] of [
      [minX, minY, minZ], [maxX, minY, minZ], [maxX, minY, maxZ], [minX, minY, maxZ],
      [minX, maxY, minZ], [maxX, maxY, minZ], [maxX, maxY, maxZ], [minX, maxY, maxZ],
    ]) positions.push(x, y, z);
    for (const triangle of [
      [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
      [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
    ]) indices.push(...triangle.map((corner) => base + corner));
  };
  // 막돌 한 켜의 두께를 좌표에서 흔든다(면이 한 판으로 읽히지 않게). 결정론이어야 하므로
  // rng 가 아니라 좌표의 소수부를 쓴다 — plan 이 이미 상단 요철을 소유하므로 두께는
  // 시각적 잡음일 뿐 계약값이 아니다.
  const jitterThickness = (coordinate) =>
    0.42 + (((coordinate * 7.13) % 1) + 1) % 1 * 0.16;
  for (const riser of terraces.risers) {
    for (const segment of riser.segments) {
      const thickness = jitterThickness(segment.x0);
      pushBox(
        segment.x0, segment.x1,
        // 아래 단 상면보다 조금 더 내려 묻는다 — 뜬 석축은 즉시 가짜로 읽힌다.
        riser.baseElevation - 0.35, segment.topY,
        segment.z - thickness, segment.z,
      );
    }
    // 마구리(동·서): 없으면 부감에서 단 상면이 측면 없는 종이 판으로 읽힌다.
    for (const flank of riser.flanks || []) {
      for (const segment of flank) {
        const thickness = jitterThickness(segment.z0);
        const inner = segment.x + thickness * segment.inward;
        pushBox(
          Math.min(segment.x, inner), Math.max(segment.x, inner),
          riser.baseElevation - 0.35, segment.topY,
          segment.z0, segment.z1,
        );
      }
    }
    const stair = riser.stair;
    if (!stair) continue;
    const rise = riser.rise / stair.steps;
    for (let step = 0; step < stair.steps; step++) {
      const y = riser.baseElevation + rise * step;
      const inset = stair.run * (stair.steps - step) / stair.steps;
      pushBox(
        stair.x - stair.width / 2, stair.x + stair.width / 2,
        y - 0.06, y + rise,
        stair.z, stair.z + inset,
      );
    }
  }
  if (!indices.length) return group;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, mats.stone);
  mesh.name = 'terrace-risers';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

function gateById(plan, id) {
  return plan.gates.find((gate) => gate.id === id) || null;
}

function buildEnclosures(plan, mats) {
  const group = new THREE.Group();
  group.name = 'temple-enclosures';
  for (const enclosure of plan.enclosures) {
    const gate = gateById(plan, enclosure.gateId);
    const openingWidth = gate
      ? (gate.type === 'soseuldaemun' ? Math.max(6.6, gate.width + 3.8) : gate.width + 0.5)
      : 0;
    const { group: fence } = buildFence({
      points: enclosure.polygon,
      // 산지 일곽의 외곽 담은 진입부만 감싸는 **열린** run 이다(terrace-plan.js
      // applyPrecinctWallReinterpretation). 위쪽 경계는 막돌 석축이 맡는다.
      closed: enclosure.closed !== false,
      height: enclosure.height,
      thickness: 0.46,
      seed: (plan.seed ^ enclosure.id.length * 0x91) >>> 0,
      mats,
      wallStyle: 'toseok',
      openings: gate
        ? [{ seg: enclosure.gateSeg || 0, center: 0.5, width: openingWidth }]
        : [],
    });
    fence.name = enclosure.id;
    group.add(fence);
  }
  for (const gateSpec of plan.gates) {
    const gate = buildGate(gateSpec.type, {
      mats,
      seed: (plan.seed ^ gateSpec.id.length * 0x271) >>> 0,
      width: gateSpec.width,
    });
    gate.name = `temple-${gateSpec.id}`;
    gate.position.set(gateSpec.position.x, gateSpec.elevation || 0, gateSpec.position.z);
    gate.rotation.y = gateSpec.yaw || 0;
    gate.userData.templeId = gateSpec.id;
    gate.userData.templeRole = gateSpec.role;
    group.add(gate);
  }
  return group;
}

/**
 * Assemble a renderer-independent TemplePlan into one local-space THREE group.
 * Caller-provided `mats` remain caller-owned; otherwise disposeTempleCompound()
 * releases the generated palette, derived materials, geometries, and textures.
 */
export function buildTempleCompound(planOrOptions = {}, { mats, dancheong } = {}) {
  const suppliedPlan = Object.hasOwn(planOrOptions || {}, 'schemaVersion')
    || Array.isArray(planOrOptions?.buildings);
  const sourcePlan = suppliedPlan ? planOrOptions : planTempleCompound(planOrOptions);
  const plan = normalizeTemplePlan(sourcePlan);
  const mainDancheong = resolveDancheong('temple', dancheong || mats?.dancheong || PRESETS.temple);
  const palette = mats || makeMaterials('temple', mainDancheong);
  const paletteByDancheong = new Map();
  const paletteKey = (config) => `${config.clarityBucket}:${config.splendorBucket}`;
  const paletteFor = (config) => {
    const key = paletteKey(config);
    if (!paletteByDancheong.has(key)) {
      const sameAsBase = palette.dancheong
        && paletteKey(palette.dancheong) === key;
      paletteByDancheong.set(key, sameAsBase ? palette : makeDancheongVariant(palette, config));
    }
    return paletteByDancheong.get(key);
  };
  const hallPalette = (spec) => paletteFor(resolveTempleRoleDancheong(mainDancheong, spec));
  const enclosurePalette = paletteFor(resolveTempleRoleDancheong(mainDancheong, {
    role: 'entry-gate', formality: 'domestic',
  }));
  const root = new THREE.Group();
  root.name = `temple-compound-${plan.variant}`;

  const courtMaterials = new Map();
  const courtMaterial = (role) => {
    if (!courtMaterials.has(role)) courtMaterials.set(role, makeCourtMaterial(role));
    return courtMaterials.get(role);
  };
  // 단이 둘 이상이면 예불 마당의 **바닥**은 단 상면이 소유한다. 마당 폴리곤은 여러
  // 단을 가로지르므로 한 높이로 깔면 상단 단을 관통한다(terrace-plan.js 주석 참조).
  const terraced = plan.terraces?.tierCount > 1;
  for (const court of plan.courtyards) {
    if (terraced && court.role === 'worship') continue;
    // 산지 진입부는 포장 마당이 아니라 지형이다. extended 의 `entry-court` 는 폭
    // `width - 5` × 남측 잔여 깊이의 큰 사각형이라, 부감에서 화면 하단 40%가 계조 없는
    // 크림색 평면으로 깔려 "주차장"으로 읽혔다(2026-08-05 실측 렌더 r7-temple-oblique).
    // 사료 사진의 절 앞은 다져지지 않은 흙·잔디 사면이고, 마을 쪽에서는 지형 pad 의
    // 에이프런 단(`buildTempleFeaturePad`)이 이미 그 면을 만든다. 답도만 남긴다.
    if (terraced && court.role === 'entry') continue;
    // Prefer plan-owned elevation (mountain apron tiers); fall back to level as
    // a coarse step only when elevation was never authored.
    const courtY = Number.isFinite(court.elevation)
      ? 0.018 + court.elevation
      : 0.018 + (court.level || 0) * 0.55;
    root.add(polygonMesh(court.polygon, courtMaterial(court.role), courtY, court.id));
  }
  if (terraced) {
    for (const tier of plan.terraces.tiers) {
      // 단 상면은 예불 마당의 흙바닥이므로 마당 재질을 그대로 쓴다 — 전용 재질을 두면
      // 병합 그룹이 늘어 콜이 +2 된다.
      root.add(polygonMesh(tier.polygon, courtMaterial('worship'), 0.018 + tier.elevation, tier.id));
    }
  }

  const pathMaterial = new THREE.MeshStandardMaterial({ color: 0xaaa08d, roughness: 1, metalness: 0 });
  root.add(buildPaths(plan.paths, pathMaterial));
  root.add(buildEnclosures(plan, enclosurePalette));
  root.add(buildTerraceRisers(plan.terraces, enclosurePalette));

  const buildings = new THREE.Group();
  buildings.name = 'temple-buildings';
  plan.buildings.forEach((spec, index) => {
    buildings.add(buildHall(spec, (plan.seed + 0x100 + index * 17) >>> 0, hallPalette(spec)));
  });
  root.add(buildings);

  const props = new THREE.Group();
  props.name = 'temple-props';
  plan.props.forEach((spec, index) => {
    const object = buildProp(spec.kind, {
      seed: (plan.seed + 0x700 + index * 31) >>> 0,
      scale: spec.scale,
      ...(spec.stories ? { stories: spec.stories } : {}),
    });
    object.name = `temple-${spec.id}`;
    object.position.set(spec.position.x, spec.elevation || 0, spec.position.z);
    object.rotation.y = spec.yaw || 0;
    object.userData.templeId = spec.id;
    object.userData.templeRole = spec.role;
    props.add(object);
  });
  root.add(props);

  // Consolidate visually identical clones before village-level static merging.
  // The conservative signature skips shader-patched materials.
  canonicalizeSharedMaterials(root);
  root.userData.mats = palette;
  root.userData.templeSchemaVersion = plan.schemaVersion;
  root.userData.parcelLike = { id: 'temple', style: 'temple', variant: plan.variant };
  root.userData.templeHandle = {
    seed: plan.seed,
    variant: plan.variant,
    width: plan.width,
    depth: plan.depth,
    plan,
    dancheong: mainDancheong,
  };
  root.userData.dancheongPaletteCount = paletteByDancheong.size;
  lifecycle.set(root, {
    disposed: false,
    ownsPalette: !mats,
    callerPaletteResources: mats ? collectPaletteResources(mats) : null,
    // `palette` may not be selected by a sparse/custom plan (for example an
    // enclosure-only harness), but an internally-created base palette is still
    // owned by this compound and must be released with its role variants.
    allPaletteResources: collectPalettesResources([palette, ...paletteByDancheong.values()]),
  });
  return root;
}

export function disposeTempleCompound(root) {
  const state = root && lifecycle.get(root);
  if (!state || state.disposed) return false;
  state.disposed = true;
  const resources = collectObjectResources(root);
  for (const material of state.allPaletteResources.materials) resources.materials.add(material);
  for (const texture of state.allPaletteResources.textures) resources.textures.add(texture);
  if (!state.ownsPalette) {
    for (const material of state.callerPaletteResources.materials) resources.materials.delete(material);
    for (const texture of state.callerPaletteResources.textures) resources.textures.delete(texture);
  }
  disposeObjectResources(resources);
  return true;
}
