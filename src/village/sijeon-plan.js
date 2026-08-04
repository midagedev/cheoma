import * as G from '../core/math/geom2.js';
import { hashString } from '../rng.js';

// Renderer-free sijeon (licensed-market row) contract.
//
// Placement keeps the legacy pitch/depth/setback/runCap number path and inserts
// product-owned row breaks so long arterial façades do not read as one infinite
// copy-paste roof (GitHub #218, scope (a) 줄 분절). The facade plan uses local
// coordinates centred on the planned shop:
//   +x = along the row, +z = road/front, +y = up.
// Renderers may merge shop records, but must not build solid mass for `kind:
// 'break'` footprints, infer a second footprint, or move solid storage/wall mass
// into the road-side corridor. Break polygons stay in the plan so residential
// parcels cannot fill the reserved market corridor.

export const SIJEON_PLACEMENT = Object.freeze({
  pitch: 6.2,
  depth: 8.5,
  setback: 1.4,
  runCap: 26,
  // Product segmentation (#218a). Interval is not a measured historical bay
  // count: sources confirm long arterial rows and kan-unit use, not a universal
  // roof-break period. One pitch of empty reserved footprint separates blocks so
  // eaves (body + 1.4 m) no longer bridge across the gap.
  segmentShops: 5,
  segmentGapPitches: 1,
});

// v3 (#54): 계획이 벽체(배면·측면·박공·전면 상벽)까지 소유한다. v2 렌더러는 개방 골조만 그리므로
// 같은 데이터로 닫힌 행랑을 만들 수 없다 — 소비자 계약이 바뀌었으니 버전을 올린다(docs/sijeon.md §3.1).
export const SIJEON_FACADE_SCHEMA_VERSION = 3;
export const SIJEON_FACADE_BAYS = 2;

// Product sparseness for decorative marker boards — not a historical frequency.
export const SIJEON_SIGN_POLICY = Object.freeze({
  maxShare: 0.28,
  maxPerShop: 1,
  emissive: false,
  materialRole: 'frame',
  silhouettes: Object.freeze(['tablet', 'plank']),
});
export const SIJEON_KIND_SHOP = 'shop';
export const SIJEON_KIND_BREAK = 'break';

const BODY_HEIGHT = 3;
const MIN_WIDTH = 4.4;
const MIN_DEPTH = 5.6;
const SIGN_HANG_GAP = 0.05;
const SIGN_THICKNESS = 0.05;
// 지붕 슬래브 여유(#54). renderer 는 지붕면을 두께 있는 판으로 만들 수 있으므로 벽·박공 mass 는
// 지붕면보다 이만큼 낮게 멈춘다. 미감 수치가 아니라 부재 관통 방지용 구조 여유다(현 renderer
// 슬래브 0.14 → 최대 수직 여유 0.079m 를 덮는다).
const ROOF_SLAB_ALLOWANCE = 0.12;

function finiteDimension(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`sijeon ${name} must be finite`);
  if (value <= 0) throw new RangeError(`sijeon ${name} must be positive`);
  return value;
}

function box(role, x, y, z, width, height, depth, extra = {}) {
  return {
    role,
    center: { x, y, z },
    size: { width, height, depth },
    ...extra,
  };
}

/** True when the record owns a rendered two-bay shop mass. */
export function isSijeonShop(record) {
  return !!record && record.kind !== SIJEON_KIND_BREAK;
}

function footprintRecord(base, tan, inward, pitch, depth, id, kind) {
  const poly = G.frontageParcel(base, tan, inward, pitch * 0.5, depth, 0);
  return {
    id,
    kind,
    poly,
    center: G.polyCentroid(poly),
    frontDir: G.norm(G.mul(inward, -1)),
    x: base.x,
    z: base.z,
    w: pitch,
    d: depth,
  };
}

function annotateSegment(members, segmentId) {
  const length = members.length;
  if (!length) return;
  for (let index = 0; index < length; index++) {
    const role = length === 1 ? 'solo'
      : index === 0 ? 'start'
        : index === length - 1 ? 'end'
          : 'mid';
    members[index].segment = Object.freeze({
      id: segmentId,
      index,
      length,
      role,
    });
  }
}

/**
 * Place market-row footprints along arterial (daero) façades.
 *
 * Continuous shop runs are capped into product blocks of `segmentShops` units,
 * separated by `segmentGapPitches` reserved empty footprints (`kind: 'break'`).
 * Breaks stay in the returned array so village planning can keep them as parcel
 * blockers without drawing shop mass.
 *
 * `char01` remains in the signature because the village planner already passes
 * it, although placement never consumes it. Keeping that no-op input avoids
 * changing callers or the downstream random stream.
 */
// reach(pt) → 그 지점에 행랑을 이어붙일 수 있는가. 기본은 분지 반경 컷(종전 동작 정확 재현)이고,
//   성곽이 있는 도성은 호출부가 "성벽 안쪽 + 문전 마당 밖"을 넘긴다: docs/joseon-city.md §시전행랑 은
//   행랑 구간을 "종루~남대문, 종묘~동대문"으로 명시하므로 행랑은 성문까지 이어져야 한다. 분지 0.9R
//   컷은 그 구간을 성문에서 100~300m 앞에서 끊고 있었다.
// runCap → (도로, 면)당 **점포** 상한. 기본값은 legacy `SIJEON_PLACEMENT.runCap` 이고, 성곽 도성은
//   호출부가 Infinity 를 넘겨 "간선 파사드 전체를 reach 가 정한다"로 바꾼다. 상한은 프리픽스 컷이라
//   유한값에서는 도로 시작부만 채워지므로(실측 2026-08-04: hanyang 51레코드 전부 daero-001 시작
//   151m = 도로의 22.1%), 문서 조항의 "성문에 닿는 연속 파사드"와 양립하지 않는다.
//   예약 공백(kind:'break')은 상한을 먹지 않는다 — 빈 footprint 가 점포 슬롯을 훔치면 같은 상한이
//   분절 주기에 따라 실효 점포 수를 바꾼다(26슬롯 → 점포 22채).
export function planSijeon(roadsResult, site, _char01 = 0.5, { reach, runCap: runCapOption } = {}) {
  const shops = [];
  const arterials = (roadsResult?.roads || []).filter((road) => road.level === 'daero');
  const {
    pitch,
    depth,
    setback,
    segmentShops,
    segmentGapPitches,
  } = SIJEON_PLACEMENT;
  const runCap = runCapOption === undefined ? SIJEON_PLACEMENT.runCap : runCapOption;
  if (typeof runCap !== 'number' || Number.isNaN(runCap) || runCap <= 0) {
    throw new RangeError('sijeon runCap must be a positive number or Infinity');
  }
  const bowlR = site.bowlR;
  const others = (road) => arterials.filter((candidate) => candidate !== road);
  let sid = 0;
  let segmentSerial = 0;

  for (const road of arterials) {
    const fine = G.resample(road.pts, pitch);
    if (fine.length < 8) continue;
    const halfRoadWidth = road.width / 2;
    const crossingArterials = others(road);
    for (let side = 1; side >= -1; side -= 2) {
      let run = 0;
      let consecutiveShops = 0;
      let openSegment = [];
      let pendingBreakPitches = 0;

      const flushSegment = () => {
        if (!openSegment.length) return;
        annotateSegment(openSegment, `seg${segmentSerial++}`);
        openSegment = [];
      };

      for (let i = 3; i < fine.length - 3 && run < runCap; i++) {
        const sample = fine[i];
        const withinReach = reach
          ? reach(sample.pt)
          : G.dist(sample.pt, site.center) <= bowlR * 0.9;
        if (!withinReach) {
          // Natural hole in the bowl — close the current block without inventing a break.
          flushSegment();
          consecutiveShops = 0;
          pendingBreakPitches = 0;
          continue;
        }
        const inward = G.mul(G.perpL(sample.tan), side);
        const base = G.add(sample.pt, G.mul(inward, halfRoadWidth + setback));
        let clashes = false;
        for (const other of crossingArterials) {
          if (G.distToPolyline(base, other.pts).d < other.width / 2 + depth) {
            clashes = true;
            break;
          }
        }
        if (clashes) {
          // Crossing-arterial clearance already opens a large gap; start a new block after it.
          flushSegment();
          consecutiveShops = 0;
          pendingBreakPitches = 0;
          continue;
        }

        if (pendingBreakPitches > 0) {
          shops.push(footprintRecord(
            base,
            sample.tan,
            inward,
            pitch,
            depth,
            `s${sid++}`,
            SIJEON_KIND_BREAK,
          ));
          pendingBreakPitches--;
          continue;
        }

        const shop = footprintRecord(
          base,
          sample.tan,
          inward,
          pitch,
          depth,
          `s${sid++}`,
          SIJEON_KIND_SHOP,
        );
        shops.push(shop);
        openSegment.push(shop);
        consecutiveShops++;
        run++;

        if (consecutiveShops >= segmentShops) {
          flushSegment();
          consecutiveShops = 0;
          pendingBreakPitches = segmentGapPitches;
        }
      }
      flushSegment();
    }
  }
  return shops;
}

/**
 * Derive a restrained two-bay shop facade from one placement record.
 *
 * The output is plain serializable data. It describes only physical members;
 * materials, textures, Three.js objects, merge strategy, and LOD remain renderer
 * concerns. Eaves are the sole planned solid allowed beyond `streetEdgeZ`.
 * Break footprints have no facade — callers must filter with `isSijeonShop`.
 */

function planSparseSigns(shop, { bayWidth, lintels, frontZ }) {
  const id = shop?.id;
  if (id == null || id === '') return [];
  const h = hashString(`sijeon-sign|${String(id)}`);
  const unit = ((h >>> 8) & 0xffffff) / 0x1000000;
  if (unit >= SIJEON_SIGN_POLICY.maxShare) return [];
  const bay = h & 1;
  const silhouette = SIJEON_SIGN_POLICY.silhouettes[(h >>> 1) & 1];
  const lintel = lintels[bay];
  if (!lintel) return [];
  const lintelBottom = lintel.center.y - lintel.size.height / 2;
  const centerZ = frontZ - SIGN_THICKNESS / 2;
  const centerX = lintel.center.x;
  if (silhouette === 'plank') {
    const width = Math.min(bayWidth * 0.42, lintel.size.width * 0.55);
    const height = 0.16;
    const centerY = lintelBottom - SIGN_HANG_GAP - height / 2;
    return [box('marker-board', centerX, centerY, centerZ, width, height, SIGN_THICKNESS, {
      bay, silhouette: 'plank', mount: 'lintel-hang', decorative: true, emissive: false,
    })];
  }
  const width = 0.3;
  const height = 0.58;
  const centerY = lintelBottom - SIGN_HANG_GAP - height / 2;
  return [box('marker-board', centerX, centerY, centerZ, width, height, SIGN_THICKNESS, {
    bay, silhouette: 'tablet', mount: 'lintel-hang', decorative: true, emissive: false,
  })];
}

export function planSijeonFacade(shop) {
  if (shop?.kind === SIJEON_KIND_BREAK) {
    throw new RangeError('sijeon break footprints have no facade mass');
  }
  const lotWidth = finiteDimension(shop?.w, 'width');
  const lotDepth = finiteDimension(shop?.d, 'depth');
  if (lotWidth < MIN_WIDTH) {
    throw new RangeError(`sijeon width must be at least ${MIN_WIDTH}m for two bays`);
  }
  if (lotDepth < MIN_DEPTH) {
    throw new RangeError(`sijeon depth must be at least ${MIN_DEPTH}m`);
  }

  // Preserve the former visible mass while replacing its blank front wall.
  const width = lotWidth * 0.96;
  const depth = lotDepth * 0.86;
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const streetEdgeZ = lotDepth / 2;
  const frontZ = halfDepth;
  const backZ = -halfDepth;
  const bayWidth = width / SIJEON_FACADE_BAYS;

  const columnWidth = Math.min(0.26, bayWidth * 0.1);
  const columnDepth = 0.26;
  const columnHeight = BODY_HEIGHT - 0.22;
  const columnZ = frontZ - columnDepth / 2;
  const columnInset = columnWidth / 2;
  const columns = [-halfWidth + columnInset, 0, halfWidth - columnInset]
    .map((x, index) => box(
      'front-column',
      x,
      columnHeight / 2,
      columnZ,
      columnWidth,
      columnHeight,
      columnDepth,
      { index },
    ));

  const lintelHeight = 0.28;
  const lintelDepth = 0.3;
  const lintelWidth = bayWidth - columnWidth;
  const lintelY = columnHeight - lintelHeight / 2;
  const lintels = [-bayWidth / 2, bayWidth / 2].map((x, bay) => box(
    'front-lintel',
    x,
    lintelY,
    frontZ - lintelDepth / 2,
    lintelWidth,
    lintelHeight,
    lintelDepth,
    { bay },
  ));

  const openingRecess = 0.46;
  const openingDepth = 0.12;
  const openingWidth = bayWidth - columnWidth * 1.55;
  const openingSill = 0.22;
  const openingTop = lintelY - lintelHeight / 2 - 0.08;
  const openingHeight = openingTop - openingSill;
  // 판문(plank shutter): 개구 한 짝을 밖으로 접어 세운 널문. 발굴이 확인한 것은 기둥·마룻장과 함께
  //   "문짝"을 갖춘 목조건축이므로(서울역사박물관 청진동 유구), 개구를 빈 공동으로 남기면 사료가
  //   확인한 부재를 지우고 현대 쇼윈도·동굴로 읽힌다(docs/sijeon.md §3.2-4, architectural-
  //   authenticity.md §7.5 W2-3). 기둥 뒷면과 후퇴 배면 사이에 한 장 서므로 가로 진입로(streetEdgeZ)
  //   밖으로 나가지 않고, 남은 개구 폭으로는 배면 목재 면이 그대로 보인다.
  //   좌우 칸은 각각 바깥쪽으로 접혀 결정론적이다 — 칸별 난수 없음.
  const panelThickness = 0.07;
  const panelZ = frontZ - columnDepth - 0.04;
  const panelWidth = openingWidth * 0.44;
  const openings = [-bayWidth / 2, bayWidth / 2].map((x, bay) => box(
    'recessed-opening',
    x,
    openingSill + openingHeight / 2,
    frontZ - openingRecess - openingDepth / 2,
    openingWidth,
    openingHeight,
    openingDepth,
    {
      bay,
      recessed: true,
      panel: box(
        'plank-shutter',
        x + (bay === 0 ? -1 : 1) * (openingWidth - panelWidth) / 2,
        openingSill + openingHeight / 2,
        panelZ,
        panelWidth,
        openingHeight,
        panelThickness,
        { bay, side: bay === 0 ? -1 : 1 },
      ),
    },
  ));

  const benchHeight = 0.58;
  const benchDepth = Math.min(0.62, lotDepth * 0.075);
  const benchWidth = openingWidth * 0.88;
  const benchFrontZ = Math.min(streetEdgeZ, frontZ + benchDepth * 0.48);
  const benches = [-bayWidth / 2, bayWidth / 2].map((x, bay) => box(
    'display-bench',
    x,
    benchHeight / 2,
    benchFrontZ - benchDepth / 2,
    benchWidth,
    benchHeight,
    benchDepth,
    { bay },
  ));

  // 벽 두께는 개구가 정한다: 측벽 안쪽 면이 바깥 칸 개구의 바깥 변을 넘으면 계획된 개방 전면을
  //   덮는다(= 발굴 사료가 확인한 어휘를 지우는 것). 그 상한을 그대로 두께로 쓴다 —
  //   결과는 0.775×columnWidth(폭 6.2m 점포에서 0.20m)이고 미감 선택이 아니다.
  const wallThickness = halfWidth - (bayWidth + openingWidth) / 2;

  const storageDepth = Math.min(2.5, depth * 0.34);
  const storageClearance = 0.16;
  const storage = box(
    'rear-storage',
    0,
    (BODY_HEIGHT - 0.22) / 2,
    backZ + wallThickness + storageDepth / 2,
    width - (storageClearance + wallThickness) * 2,
    BODY_HEIGHT - 0.22,
    storageDepth,
  );

  const roofWidth = width + 1.4;
  const roofDepth = depth + 1.6;
  const roof = {
    role: 'gable-roof',
    center: { x: 0, y: BODY_HEIGHT, z: 0 },
    width: roofWidth,
    depth: roofDepth,
    rise: 1.7,
    eaveProjection: {
      side: (roofWidth - width) / 2,
      front: Math.max(0, roofDepth / 2 - streetEdgeZ),
      rear: Math.max(0, roofDepth / 2 - lotDepth / 2),
    },
  };

  // 벽체 완결(#54). v2 계획은 전면 골조·후면 저장 박스·박공지붕만 소유해서 측면·배면·박공이
  //   열려 있었다: 가장 높은 부재가 y=2.78 인데 지붕 처마 밑면이 y=BODY_HEIGHT 라, 어느 사선에서든
  //   지붕판이 벽 없이 떠 보이고 밑면이 노출됐다(성문 접근로 망원·가로 시점 실측 2026-08-04).
  //   계획이 배면벽·측벽·박공벽·전면 상벽을 소유해 지붕이 벽체 질량 위에 앉는다. 전면 개방 점포
  //   (기둥·인방·판문·좌판)는 사료 근거 어휘이므로 축소하지 않는다(docs/sijeon.md §1.4, §3.2-4).
  const halfRoofDepth = roofDepth / 2;
  const ridgeY = BODY_HEIGHT + roof.rise;
  // 지붕은 처마(z=±halfRoofDepth, y=BODY_HEIGHT)에서 용마루로 오르므로 건물 앞·뒷벽 위에는 그
  //   상승분만큼 열린 띠가 남는다. closure 부재는 그 띠를 지붕면 아래까지 닫는다.
  const roofPlaneAtWall = BODY_HEIGHT + roof.rise * (1 - halfDepth / halfRoofDepth);
  const closureTopY = Math.max(BODY_HEIGHT, roofPlaneAtWall - ROOF_SLAB_ALLOWANCE);

  const rearWall = box(
    'rear-wall',
    0,
    closureTopY / 2,
    backZ + wallThickness / 2,
    width,
    closureTopY,
    wallThickness,
  );
  const sideWalls = [-1, 1].map((side) => box(
    'side-wall',
    side * (halfWidth - wallThickness / 2),
    BODY_HEIGHT / 2,
    0,
    wallThickness,
    BODY_HEIGHT,
    depth,
    { side },
  ));
  // 포벽 자리의 얇은 상벽: 인방 상단부터 지붕면까지. 이 띠가 열려 있으면 정면 사선에서 지붕
  //   안쪽이 보인다. 기둥·인방·개구 아래는 그대로 열려 있다.
  const frontHeader = box(
    'front-header',
    0,
    (columnHeight + closureTopY) / 2,
    frontZ - wallThickness / 2,
    width,
    closureTopY - columnHeight,
    wallThickness,
  );

  // 박공벽: 측벽 위에서 맞배 지붕 단면을 채운다. `profile` 은 로컬 (z, y) 볼록 다각형이고
  //   renderer 가 `thickness` 만큼 x 축으로 압출한다 — 새 재질·텍스처 없이 병합되는 프리즘 하나.
  //   깊은 lot 에서는 벽 평면의 지붕 상승분이 슬래브 여유보다 작아지므로 어깨 없는 삼각형이 된다.
  const gableApexY = ridgeY - ROOF_SLAB_ALLOWANCE;
  const gableProfile = closureTopY > BODY_HEIGHT + 1e-6
    ? [
      { z: backZ, y: BODY_HEIGHT },
      { z: backZ, y: closureTopY },
      { z: 0, y: gableApexY },
      { z: frontZ, y: closureTopY },
      { z: frontZ, y: BODY_HEIGHT },
    ]
    : [
      { z: backZ, y: BODY_HEIGHT },
      { z: 0, y: gableApexY },
      { z: frontZ, y: BODY_HEIGHT },
    ];
  const gables = sideWalls.map((wall) => ({
    role: 'gable-wall',
    side: wall.side,
    x: wall.center.x,
    thickness: wallThickness,
    profile: gableProfile.map((point) => ({ z: point.z, y: point.y })),
  }));

  const signs = planSparseSigns(shop, { bayWidth, lintels, frontZ });

  return {
    schemaVersion: SIJEON_FACADE_SCHEMA_VERSION,
    bayCount: SIJEON_FACADE_BAYS,
    axis: { front: { x: 0, z: 1 } },
    lot: {
      width: lotWidth,
      depth: lotDepth,
      bounds: {
        minX: -lotWidth / 2,
        maxX: lotWidth / 2,
        minZ: -lotDepth / 2,
        maxZ: streetEdgeZ,
      },
    },
    building: {
      width,
      depth,
      height: BODY_HEIGHT,
      bounds: {
        minX: -halfWidth,
        maxX: halfWidth,
        minZ: backZ,
        maxZ: frontZ,
      },
    },
    corridor: {
      streetEdgeZ,
      maxNonEaveZ: streetEdgeZ,
      maxEaveZ: roofDepth / 2,
    },
    // 벽 위에서 지붕면까지의 높이 계약. closure 부재는 본체 높이 상한(building.height)이 아니라
    // 이 상한을 쓴다 — 그게 "지붕이 벽체 위에 앉는다"의 수치 표현이다.
    roofline: {
      wallTopY: BODY_HEIGHT,
      closureTopY,
      ridgeY,
      slabAllowance: ROOF_SLAB_ALLOWANCE,
    },
    columns,
    lintels,
    openings,
    benches,
    walls: [rearWall, ...sideWalls, frontHeader],
    gables,
    storage,
    roof,
    signs,
    // Optional placement context — present when the shop came from planSijeon.
    segment: shop?.segment ?? null,
  };
}
