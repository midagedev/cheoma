import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildSkeletonRoof } from '../layout/roof-skeleton.js';
import { giwaFootprint, giwaFootprintPolygon } from '../params.js';
import { giwaFrontRange } from '../layout/giwa-footprint.js';
import { planGiwaKitchenOpening } from '../layout/kitchen-opening-spatial.js';
import * as G from '../core/math/geom2.js';
import {
  OPENING_FACE_CLEARANCE,
  overlayCenterOffset,
  sunkPrism,
} from '../core/surface-clearance.js';
import { buildRecessedKitchenHearth } from './kitchen-hearth.js';
import { planOpeningDetail } from './opening-detail-plan.js';
import { createOpeningDetailAssembler } from './opening-details.js';

// 기와집(ㅡ/ㄱ/ㄷ 반가 안채): 공유 풋프린트 위에 스켈레톤 기와지붕 + 백골 목재 심벽 몸체.
// 몸체(기둥·심벽 회벽/판벽·띠살 분합문·대청·낮은 장대석 기단)를 이 경로에서 직접 만든다.
// 지붕은 buildSkeletonRoof(동결 API)로 만들고, 기와 밀도·적새·망와·와구토는 이 파일에서 후처리한다.

// 배흘림 기둥 프로파일
function colGeom(r, h, entasis) {
  const pts = [];
  const N = 8;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const bulge = 1 + entasis * 0.22 * Math.sin(Math.PI * Math.min(1, t / 0.66));
    const taper = 1 - 0.1 * t;
    pts.push(new THREE.Vector2(r * bulge * taper, h * t));
  }
  return new THREE.LatheGeometry(pts, 12);
}

// 평면별 변 인덱스가 달라도 의미는 좌표에서 파생한다: 안마당 면=분합문, 북측 후면=판벽,
// 바깥 측면=회벽. 이 분류를 쓰면 ㅡ/ㄱ/ㄷ이 동일한 벽체 루프를 공유한다.
function edgeRole(A, B, { planShape, a, b, w, c }) {
  const near = (x, y) => Math.abs(x - y) < 1e-7;
  const horizontal = near(A.z, B.z);
  const vertical = near(A.x, B.x);
  if (horizontal && near(A.z, -b)) return 'plank';
  if (horizontal && near(A.z, b)) return 'door';
  if (planShape !== 'single' && vertical
    && Math.min(A.z, B.z) >= b - 1e-7 && Math.max(A.z, B.z) <= b + c + 1e-7
    && (near(A.x, a - w) || near(A.x, -a + w))) return 'door';
  return 'wall';
}

function extrudeFootprint(points, bottom, top) {
  const shape = new THREE.Shape();
  points.forEach((point, index) => {
    if (index === 0) shape.moveTo(point.x, -point.z);
    else shape.lineTo(point.x, -point.z);
  });
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: top - bottom,
    bevelEnabled: false,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, bottom, 0);
  return geometry;
}

function addPodiumLayer(group, footprint, bottom, top, material, name, castShadow = true) {
  const mesh = new THREE.Mesh(extrudeFootprint(footprint, bottom, top), material);
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function addVerticalPodiumJoints(group, footprint, height, material) {
  const geometries = [];
  const spacing = 1.6;
  for (let i = 0; i < footprint.length; i++) {
    const a = footprint[i], b = footprint[(i + 1) % footprint.length];
    const edge = G.sub(b, a);
    const length = G.len(edge);
    const direction = G.norm(edge);
    const outward = G.perpL(direction); // footprint is CCW
    const rotation = -Math.atan2(direction.z, direction.x);
    for (let along = spacing; along < length - 0.2; along += spacing) {
      const geometry = new THREE.BoxGeometry(0.04, height * 0.9, 0.06);
      geometry.rotateY(rotation);
      geometry.translate(
        a.x + direction.x * along + outward.x * 0.005,
        height * 0.5,
        a.z + direction.z * along + outward.z * 0.005,
      );
      geometries.push(geometry);
    }
  }
  if (!geometries.length) return;
  const merged = mergeGeometries(geometries, false);
  for (const geometry of geometries) geometry.dispose();
  const joints = new THREE.Mesh(merged, material);
  joints.name = 'podium-vertical-joints';
  joints.receiveShadow = true;
  group.add(joints);
}

export function buildGiwa(P, M) {
  const root = new THREE.Group();
  root.name = 'building';
  const footprint = giwaFootprint(P);
  const { a, b, w, c } = footprint;
  // 정규 풋프린트(기둥/벽 중심선): ㅡ/ㄱ/ㄷ 모두 같은 순수 생성기를 쓴다.
  // buildSkeletonRoof는 CW 감김에서 바깥 법선(윗면)이 나오도록 검증됨.
  const foot = giwaFootprintPolygon(P);
  const n = foot.length;
  const cen = foot.reduce((s, p) => ({ x: s.x + p.x, z: s.z + p.z }), { x: 0, z: 0 });
  cen.x /= n; cen.z /= n;

  const podH = P.podiumTierH;
  const colH = P.columnHeight, colR = footprint.columnRadius;
  const podTopY = podH, colTopY = podTopY + colH, eaveY = colTopY + 0.35;

  // ── 기단 (단일 ㄱ자 솔리드, 낮은 장대석 + 줄눈) ──
  const podium = new THREE.Group(); podium.name = 'podium';
  const jointMat = new THREE.MeshStandardMaterial({ color: 0x6e675a, roughness: 1.0 });
  // 두 직사각형을 겹치면 교차부의 상면·줄눈·갑석이 정확히 중복된다. 같은 외곽을 한 번만
  // 압출해 깊이 소유자를 하나로 만들고, 최하단은 성토면 아래로 묻어 접지선도 안정시킨다.
  const podiumFoot = G.ensureCCW(foot);
  const lowerFoot = G.offsetPoly(podiumFoot, 0.70);
  const h0 = podH * 0.54, h1 = podH - h0 - 0.02;
  const foundation = sunkPrism(h0);
  addPodiumLayer(podium, lowerFoot, foundation.bottom, foundation.top, M.stone, 'podium-lower');
  addPodiumLayer(
    podium, G.offsetPoly(podiumFoot, 0.65), h0 + 0.02, h0 + 0.02 + h1,
    M.stone, 'podium-upper',
  );
  addPodiumLayer(
    podium, G.offsetPoly(podiumFoot, 0.70 + OPENING_FACE_CLEARANCE), h0 - 0.025, h0 + 0.025,
    jointMat, 'podium-course-joint', false,
  );
  addPodiumLayer(
    podium, G.offsetPoly(podiumFoot, 0.73), podH - 0.1, podH,
    M.stoneDark, 'podium-cap', false,
  );
  addVerticalPodiumJoints(podium, lowerFoot, h0, jointMat);
  root.add(podium);

  // ── 기둥 · 심벽 벽체 · 인방/창방 ──
  const colGeo = colGeom(colR, colH, P.entasis || 0.25);
  const columns = new THREE.Group(); columns.name = 'columns';
  const walls = new THREE.Group(); walls.name = 'walls';
  const T = 0.13, y0 = podTopY + 0.02;
  const yTopWall = colTopY - 0.06;        // 창방 밑 = 벽 상단
  const yLintel = y0 + 2.05;              // 상인방(분합문 상단)
  const yMid = y0 + 1.12;                 // 중인방
  const lowerPanelTop = y0 + 0.42;         // 문짝 하부 청판 상단
  const winBot = y0 + 1.30, winTop = y0 + 1.92;  // 살창

  // 목재 톤: 창방·기둥은 밝은 백골(M.wood), 인방 트림은 살짝 짙게 정의감 부여
  const woodTrim = M.wood.clone(); woodTrim.color = M.wood.color.clone().multiplyScalar(0.78);
  const openingDetails = createOpeningDetailAssembler(walls, {
    frame: woodTrim,
    hardware: M.hardware,
  });

  const seen = new Set();
  const addCol = (x, z) => {
    const k = `${x.toFixed(2)},${z.toFixed(2)}`;
    if (seen.has(k)) return; seen.add(k);
    const m = new THREE.Mesh(colGeo, M.wood);
    m.position.set(x, podTopY, z);
    m.castShadow = m.receiveShadow = true; columns.add(m);
  };

  // 축 정렬 슬래브(벽 패널). alongX=true → x방향으로 뻗음(±z 면), false → z방향(±x 면).
  const slab = (cx, cz, len, yb, yt, mat, alongX, thick = T) => {
    const g = alongX ? new THREE.BoxGeometry(len, yt - yb, thick)
                     : new THREE.BoxGeometry(thick, yt - yb, len);
    const m = new THREE.Mesh(g, mat);
    m.position.set(cx, (yb + yt) / 2, cz);
    // 깊은 처마의 캐스트 그림자가 상부 회벽을 어두운 띠로 덮던 문제 → 벽면은 그림자 미수신.
    m.receiveShadow = false;
    walls.add(m);
    return m;
  };
  // 수평 인방/창방 목재 (변 전체 길이)
  const hbeam = (cx, cz, len, yc, alongX, mat, h = 0.13, thick = 0.17) => {
    const g = alongX ? new THREE.BoxGeometry(len, h, thick) : new THREE.BoxGeometry(thick, h, len);
    const m = new THREE.Mesh(g, mat);
    m.position.set(cx, yc, cz);
    m.castShadow = true; columns.add(m);
  };

  // 세로널 판벽(밝은 목재) 재질: 폭에 맞춰 널 반복 (그늘서도 검게 안 죽게 미량 emissive)
  const plankMat = (len) => {
    const m = M.pungpan.clone();
    m.map = M.pungpan.map.clone();
    m.map.repeat.set(Math.max(1, Math.round(len / 1.2)), 1); m.map.needsUpdate = true;
    m.emissive = new THREE.Color(0x231a0e);
    return m;
  };
  // 문짝 하부 청판: 따뜻한 목재 + 미량 emissive
  const lowerPanelMat = M.woodBoard.clone();
  lowerPanelMat.color = new THREE.Color(0x6b4e30); lowerPanelMat.emissive = new THREE.Color(0x1a1207);
  // 살창(측벽 창): 실내가 완전 검게 죽지 않도록 미량 emissive
  const salMat = M.salchang.clone(); salMat.emissive = new THREE.Color(0x14100a);
  // 띠살 분합문 재질: 폭에 맞춰 문짝 수(짝) 반복
  const doorMat = (bw) => {
    const leaves = bw > 3.0 ? 4 : bw > 1.9 ? 3 : 2;
    const m = M.door.clone();
    m.map = M.door.map.clone(); m.map.repeat.set(leaves, 1);
    m.map.wrapS = THREE.RepeatWrapping; m.map.needsUpdate = true;
    return m;
  };

  // 회벽 + 창을 뚫은 심벽 한 칸(살창 주위에 회벽 띠). alongX 축을 따라 좌우 회벽을 배치.
  const wallWithWindow = (cx, cz, bw, alongX, placement, seed) => {
    const ww = Math.min(bw * 0.5, 1.1), side = (bw - ww) / 2;
    const ax = alongX ? 1 : 0, az = alongX ? 0 : 1;
    slab(cx, cz, bw, y0, winBot, M.plaster, alongX);            // 창 아래 회벽
    slab(cx, cz, bw, winTop, yTopWall, M.plaster, alongX);      // 창 위 회벽(상부 공백 채움)
    const off = ww / 2 + side / 2;
    slab(cx - ax * off, cz - az * off, side, winBot, winTop, M.plaster, alongX); // 좌 회벽
    slab(cx + ax * off, cz + az * off, side, winBot, winTop, M.plaster, alongX); // 우 회벽
    const panel = slab(cx, cz, ww, winBot, winTop, salMat, alongX, 0.10); // 살창
    openingDetails.add(planOpeningDetail({
      kind: 'window', style: 'giwa', seed,
      width: ww, height: winTop - winBot, wallThickness: T,
    }), { ...placement, center: { x: cx, z: cz }, bottomY: winBot }, panel);
  };

  const centerBayOf = (nb) => Math.floor(nb / 2);
  const bay = footprint.bay;

  for (let i = 0; i < n; i++) {
    const A = foot[i], B = foot[(i + 1) % n];
    const len = Math.hypot(B.x - A.x, B.z - A.z);
    const nb = Math.max(1, Math.round(len / bay));
    const alongX = Math.abs(B.x - A.x) > Math.abs(B.z - A.z);
    const role = edgeRole(A, B, footprint);
    const edgeDirection = G.norm(G.sub(B, A));
    const exterior = G.perpR(edgeDirection); // foot is CW
    const cxE = (A.x + B.x) / 2, czE = (A.z + B.z) / 2;
    const cbay = centerBayOf(nb);
    const primaryDoorBay = nb >= 3 ? Math.max(0, cbay - 1) : cbay;

    // 기둥
    for (let k = 0; k <= nb; k++) {
      const t = k / nb; addCol(A.x + (B.x - A.x) * t, A.z + (B.z - A.z) * t);
    }

    // 칸별 벽 채움
    for (let k = 0; k < nb; k++) {
      const tm = (k + 0.5) / nb;
      const cx = A.x + (B.x - A.x) * tm, cz = A.z + (B.z - A.z) * tm;
      const bw = len / nb - colR * 1.8;
      // 대청: 안마당을 향한 본채 정면 중앙 칸은 개방 (아래 대청 블록에서 처리)
      const mainFront = alongX && Math.abs(A.z - b) < 1e-7 && Math.abs(B.z - b) < 1e-7;
      if (mainFront && k === cbay && nb >= 3) continue;

      if (role === 'door') {
        slab(cx, cz, bw, y0, lowerPanelTop, lowerPanelMat, alongX);     // 문짝 하부 청판
        const panel = slab(cx, cz, bw, lowerPanelTop, yLintel, doorMat(bw), alongX, 0.10); // 띠살 분합문
        const primary = mainFront && k === primaryDoorBay;
        openingDetails.add(planOpeningDetail({
          kind: 'door', style: 'giwa', seed: `giwa:${P.seed ?? 0}:${i}:${k}`,
          width: bw, height: yLintel - y0, wallThickness: T,
          lowerPanelHeight: lowerPanelTop - y0, primary,
          footwear: primary ? {
            y: podTopY + 0.42 - y0,
            outward: 0.78,
            surface: 'toenmaru',
          } : null,
        }), {
          center: { x: cx, z: cz }, bottomY: y0,
          tangent: edgeDirection, outward: exterior,
        }, panel);
        slab(cx, cz, bw, yLintel + 0.10, yTopWall, M.plaster, alongX);  // 상인방 위 회벽
      } else if (role === 'plank') {
        const plank = slab(cx, cz, bw, y0, yTopWall, plankMat(bw), alongX); // 세로널 판벽
        if (k === 1) {
          plank.name = 'plank-wall-window-bay';
          const openingT = 0.10;
          const faceOffset = overlayCenterOffset(T, openingT);
          const openingCx = cx + exterior.x * faceOffset;
          const openingCz = cz + exterior.z * faceOffset;
          const opening = slab(
            openingCx,
            openingCz,
            Math.min(bw * 0.4, 0.7),
            winTop,
            winTop + 0.5,
            salMat,
            alongX,
            openingT,
          );
          opening.name = 'plank-opening';
          openingDetails.add(planOpeningDetail({
            kind: 'window', style: 'giwa', seed: `giwa:${P.seed ?? 0}:${i}:${k}:plank`,
            width: Math.min(bw * 0.4, 0.7), height: 0.5, wallThickness: openingT,
          }), {
            center: { x: openingCx, z: openingCz }, bottomY: winTop,
            tangent: edgeDirection, outward: exterior,
          }, opening);
        }
      } else { // wall
        if (k === cbay) wallWithWindow(cx, cz, bw, alongX, {
          tangent: edgeDirection, outward: exterior,
        }, `giwa:${P.seed ?? 0}:${i}:${k}:wall`);                        // 회벽 + 살창
        else slab(cx, cz, bw, y0, yTopWall, M.plaster, alongX);         // 회벽만
      }
    }

    // 인방/창방 목재 프레임 (심벽: 목재가 회벽을 상하로 구획)
    hbeam(cxE, czE, len + 0.1, y0 + 0.07, alongX, woodTrim, 0.12, 0.16);          // 하인방
    if (role === 'door') hbeam(cxE, czE, len + 0.1, yLintel + 0.05, alongX, woodTrim, 0.13, 0.18); // 상인방
    else hbeam(cxE, czE, len + 0.1, yMid, alongX, woodTrim, 0.11, 0.16);          // 중인방
    hbeam(cxE, czE, len + 0.2, colTopY + 0.11, alongX, M.wood, 0.22, 0.18);       // 창방
  }
  openingDetails.finish();
  root.add(columns); root.add(walls);

  // ── 대청·툇마루 (밝은 우물마루 + 세로널 판벽 뒷벽 + 계자난간) ──
  const mfloorY = podTopY + 0.42;   // 걸터앉는 마루 높이
  const dep = 1.25;                 // 툇마루 내밀기
  const front = giwaFrontRange(P);
  const mX0 = front.x0, mX1 = front.x1;
  const mW = mX1 - mX0, mcx = (mX0 + mX1) / 2, frontZ = front.z;
  const maruMat = () => { const m = M.maru.clone(); m.map = M.maru.map.clone(); m.map.repeat.set(4, 2); m.map.needsUpdate = true; return m; };

  // 툇마루(전면 걸터앉는 마루)
  const maru = new THREE.Mesh(new THREE.BoxGeometry(mW, 0.12, dep), maruMat());
  maru.position.set(mcx, mfloorY, frontZ + dep / 2);
  maru.castShadow = maru.receiveShadow = true; root.add(maru);
  const dh = mfloorY - podTopY;
  for (let x = mX0 + 0.6; x <= mX1 - 0.4; x += 1.5) {
    const dong = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, dh, 8), M.wood);
    dong.position.set(x, podTopY + dh / 2, frontZ + dep - 0.18);
    dong.castShadow = true; root.add(dong);
  }

  // 대청: 중앙 개방칸 안쪽 우물마루 + 밝은 세로널 판벽 뒷벽(emissive로 실내 어둠 완화)
  const hallW = Math.min(2.2, Math.max(1.4, mW * 0.34));
  const hallCx = mcx;                  // 평면마다 달라지는 안마당 정면의 중앙 개방칸
  const hallFloorMat = M.maru.clone();
  hallFloorMat.map = M.maru.map.clone(); hallFloorMat.map.repeat.set(2, 3); hallFloorMat.map.needsUpdate = true;
  hallFloorMat.emissive = new THREE.Color(0x1c140b);   // 안쪽이 검게 죽지 않게 미량 자발광
  const hall = new THREE.Mesh(new THREE.BoxGeometry(hallW, 0.12, 2 * b - 0.3), hallFloorMat);
  hall.position.set(hallCx, mfloorY, 0);
  hall.castShadow = hall.receiveShadow = true; root.add(hall);
  // 대청 뒷벽(세로널 판벽) — 밝은 목재 + emissive
  const backMat = M.pungpan.clone();
  backMat.map = M.pungpan.map.clone(); backMat.map.repeat.set(3, 2); backMat.map.needsUpdate = true;
  backMat.emissive = new THREE.Color(0x3a2c18);
  const planwall = new THREE.Mesh(new THREE.BoxGeometry(hallW, colH - 0.2, 0.1), backMat);
  planwall.position.set(hallCx, podTopY + (colH - 0.2) / 2, -b + 0.12);
  planwall.receiveShadow = true; root.add(planwall);
  // 대청 좌우 판벽(개방칸 옆면) — 공간감
  for (const sx of [-1, 1]) {
    const sw = new THREE.Mesh(new THREE.BoxGeometry(0.1, colH - 0.4, 2 * b - 0.4), plankMat(2 * b));
    sw.position.set(hallCx + sx * hallW / 2, podTopY + (colH - 0.4) / 2, 0);
    sw.receiveShadow = true; root.add(sw);
  }
  // 대청 개방칸 상부 인방벽(상인방~창방 공백 채움) — 정면 개구부가 액자처럼 읽히게
  const transom = new THREE.Mesh(new THREE.BoxGeometry(hallW, yTopWall - (yLintel + 0.1), 0.1), M.plaster);
  transom.position.set(hallCx, (yLintel + 0.1 + yTopWall) / 2, frontZ - 0.02);
  transom.receiveShadow = true; root.add(transom);
  const lintelBeam = new THREE.Mesh(new THREE.BoxGeometry(hallW + 0.1, 0.16, 0.2), woodTrim);
  lintelBeam.position.set(hallCx, yLintel + 0.05, frontZ - 0.02);
  lintelBeam.castShadow = true; root.add(lintelBeam);

  // 계자난간: 툇마루 앞·옆 테두리 (난간대 + 동자기둥 + 치마널). 대청 앞은 비워 진입 확보.
  const railTopY = mfloorY + 0.52, railBotY = mfloorY + 0.08;
  const rz = frontZ + dep - 0.06;
  const railMat = M.wood, apronMat = woodTrim;
  const postGeo = new THREE.BoxGeometry(0.07, 0.5, 0.07);
  // 전면 난간(대청 앞 gap 제외) — 좌/우 두 구간
  const gapHalf = hallW / 2 + 0.2;
  const addFrontRail = (fx0, fx1) => {
    if (fx1 - fx0 < 0.12) return;
    const top = new THREE.Mesh(new THREE.BoxGeometry(fx1 - fx0, 0.08, 0.1), railMat);
    top.position.set((fx0 + fx1) / 2, railTopY, rz); top.castShadow = true; root.add(top);
    const apron = new THREE.Mesh(new THREE.BoxGeometry(fx1 - fx0, 0.16, 0.05), apronMat);
    apron.position.set((fx0 + fx1) / 2, railBotY + 0.12, rz); root.add(apron);
    for (let x = fx0 + 0.1; x <= fx1 - 0.05; x += 0.5) {
      const p = new THREE.Mesh(postGeo, railMat);
      p.position.set(x, mfloorY + 0.27, rz); p.castShadow = true; root.add(p);
    }
  };
  addFrontRail(mX0 + 0.1, hallCx - gapHalf);
  addFrontRail(hallCx + gapHalf, mX1 - 0.1);
  // 좌우 짧은 리턴 난간
  for (const [zx, zz] of [[mX0 + 0.1, 'L'], [mX1 - 0.1, 'R']]) {
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, dep - 0.1), railMat);
    top.position.set(zx, railTopY, frontZ + dep / 2); top.castShadow = true; root.add(top);
    for (let z = frontZ + 0.2; z <= frontZ + dep - 0.1; z += 0.5) {
      const p = new THREE.Mesh(postGeo, railMat);
      p.position.set(zx, mfloorY + 0.27, z); p.castShadow = true; root.add(p);
    }
  }

  // ── 지붕 (스켈레톤 L자 기와) ──
  const roof = buildSkeletonRoof(foot, {
    eaveY, eaveOverhang: P.eaveOverhang, riseScale: P.riseScale,
    profileCurve: P.profileCurve, cornerLift: P.cornerLift, planCurve: P.planCurve,
    ridgeH: P.ridgeH, mats: M, tileBump: 0.7,
    sugiwaRolls: true, rafters: true, junctionCaps: true,
  });
  roof.name = 'roof';
  const sk = roof.userData.skeleton;

  // 기와면 밀도 교정 + 자기그림자 회피 + 용마루 적새 re-skin.
  // roof-skeleton UV가 이미 (width/0.34)·(slopeLen/0.9)를 담고 tileSurfaceMaterial이 또
  // 같은 값으로 repeat 하여 밀도가 제곱으로 과반복 → 회색 뭉갬. repeat=(1,1)로 되돌려
  // 궁·절과 동일한 0.34m 기왓골 밀도를 복원한다.
  roof.traverse((o) => {
    if (!o.isMesh) return;
    const mat = o.material;
    if (mat && mat.map) {
      mat.map.repeat.set(1, 1); mat.map.needsUpdate = true;
      o.receiveShadow = false;  // 곡면 자기그림자(shadow acne) 방지 — 기존 동작 유지
    } else if (o.geometry && o.geometry.type === 'BoxGeometry' && mat === M.tileRidge) {
      // 용마루: 검은 각진 박스 → 적새(암키와 켜) 텍스처
      const len = o.geometry.parameters.depth;
      const jm = M.jeoksae.clone();
      jm.map = M.jeoksae.map.clone();
      jm.map.repeat.set(Math.max(2, Math.round(len / 0.5)), 1); jm.map.needsUpdate = true;
      o.material = jm;
    }
  });
  root.add(roof);
  // 조립 애니: 지붕은 시맨틱 청크(서까래→기와 통덩어리) 단위로 오른다. 아래 망와·와구토
  // 트림도 roof 그룹에 담아(root 직속이 아니라) 지붕 통덩어리와 한 몸으로 뜨게 한다.
  roof.userData.asmChunked = true;

  // 용마루 끝 망와(둥근 끝막이 + 와당). 다른 마루와 안 만나는 용마루 끝점에만.
  const yOf = (h) => eaveY + h * P.riseScale;
  const ridgeCyOf = (h) => yOf(h) + P.ridgeH * 0.5;
  const endCount = new Map();
  const rkey = (p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`;
  for (const s of sk.ridges) for (const p of [s.a, s.b]) {
    const k = rkey(p); endCount.set(k, (endCount.get(k) || 0) + 1);
  }
  for (const s of sk.ridges) {
    for (const [p, other] of [[s.a, s.b], [s.b, s.a]]) {
      if (endCount.get(rkey(p)) !== 1) continue;   // 내부 절점(마루 교차)엔 안 붙임
      const dx = p.x - other.x, dz = p.z - other.z;
      const dl = Math.hypot(dx, dz) || 1; const ux = dx / dl, uz = dz / dl;
      const cy = ridgeCyOf(p.h);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 10), M.tileRidge);
      dome.scale.set(0.9, 0.82, 1.0);
      dome.position.set(p.x + ux * 0.04, cy, p.z + uz * 0.04);
      dome.castShadow = true; roof.add(dome);
      const wa = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.05, 16), M.wadang);
      // 원반 면이 바깥(마루 방향)을 향하도록 축을 마루방향(ux,uz)에 정렬
      wa.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(ux, 0, uz));
      wa.position.set(p.x + ux * 0.22, cy, p.z + uz * 0.22);
      wa.castShadow = true; roof.add(wa);
    }
  }

  // 와구토: 처마 끝 흰 회물림 반달 스트립. sk에서 처마선(마이터 오프셋+앙곡)을 재구성해
  // 지붕 밑 처마를 따라 얹는다(roof-skeleton과 동일 공식 → 앙곡 코너까지 정확히 밀착).
  const poly = sk.poly, edges = sk.edges, pn = poly.length;
  const nrm = (v) => { const l = Math.hypot(v.x, v.z) || 1; return { x: v.x / l, z: v.z / l }; };
  const eaveVv = [], eaveLift = [];
  for (let i = 0; i < pn; i++) {
    const oPrev = { x: -edges[(i - 1 + pn) % pn].normal.x, z: -edges[(i - 1 + pn) % pn].normal.z };
    const oCur = { x: -edges[i].normal.x, z: -edges[i].normal.z };
    const sum = { x: oPrev.x + oCur.x, z: oPrev.z + oCur.z };
    const convex = edges[i].startConvex;
    const bis = nrm(sum);
    const extra = convex ? P.planCurve : 0;
    eaveVv.push({ x: poly[i].x + sum.x * P.eaveOverhang + bis.x * extra, z: poly[i].z + sum.z * P.eaveOverhang + bis.z * extra });
    eaveLift.push(convex ? P.cornerLift : 0);
  }
  for (const face of sk.faces) {
    if (face.polygon.length < 3) continue;
    const ei = face.edgeIndex;
    const Ae = eaveVv[ei], Be = eaveVv[(ei + 1) % pn];
    const liftA = eaveLift[ei], liftB = eaveLift[(ei + 1) % pn];
    const out = { x: -edges[ei].normal.x, z: -edges[ei].normal.z };
    const width = Math.hypot(Be.x - Ae.x, Be.z - Ae.z);
    const NU = 16, pos = [], uv = [], idx = [];
    for (let iu = 0; iu <= NU; iu++) {
      const t = iu / NU;
      const ex = Ae.x + (Be.x - Ae.x) * t + out.x * 0.03;
      const ez = Ae.z + (Be.z - Ae.z) * t + out.z * 0.03;
      const ends = Math.pow(Math.abs(2 * t - 1), 4.5);
      const eY = eaveY + (t < 0.5 ? liftA : liftB) * ends;
      pos.push(ex, eY + 0.04, ez, ex, eY - 0.10, ez);
      uv.push(t * (width / 0.34), 0, t * (width / 0.34), 1);
    }
    for (let iu = 0; iu < NU; iu++) { const A2 = iu * 2, B2 = A2 + 1, C2 = A2 + 2, D2 = A2 + 3; idx.push(A2, B2, C2, C2, B2, D2); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    const wm = M.waguto.clone(); wm.side = THREE.DoubleSide;
    const strip = new THREE.Mesh(geo, wm);
    strip.castShadow = true; roof.add(strip);
  }

  // ── 우측 독립 전돌 굴뚝 (name='chimney' — smoke.js가 상단을 연기 anchor로 탐지) ──
  // 반가 전돌 굴뚝: 회흑 전돌 켜쌓기 몸통 + 기와 갓지붕 + 연가(오지 토관) 여러 개.
  // 처마(xEave) 안쪽에 두면 연기가 지붕을 뚫으므로, 처마선 밖(x=a+1.55)에 독립식으로 세워
  // 연가에서 연기가 하늘로 곧게 오르게 한다(반가 독립 굴뚝은 고증에도 맞음).
  const cx0 = a + 1.55, cz0 = -b + 1.0, chimH = 2.7, cw = 0.46;
  const chimney = new THREE.Group(); chimney.name = 'chimney';
  // 굴뚝 밑 돌 기초(독립식이라 자체 지대)
  const cbase = new THREE.Mesh(new THREE.BoxGeometry(cw + 0.22, 0.22, cw + 0.22), M.stoneDark);
  cbase.position.set(cx0, 0.11, cz0); cbase.castShadow = cbase.receiveShadow = true; chimney.add(cbase);
  const baseTop = 0.22;
  // 전돌 몸통 (켜 수에 맞춰 텍스처 반복)
  const jm = M.jeondol.clone();
  jm.map = M.jeondol.map.clone();
  jm.map.repeat.set(2, Math.round(chimH / 0.36));  // 세로로 전돌 켜 반복
  jm.map.needsUpdate = true;
  const chim = new THREE.Mesh(new THREE.BoxGeometry(cw, chimH, cw), jm);
  chim.position.set(cx0, baseTop + chimH / 2, cz0);
  chim.castShadow = chim.receiveShadow = true; chimney.add(chim);
  const cTop = baseTop + chimH;
  // 상단 전돌 코니스(살짝 내밈)
  const cornice = new THREE.Mesh(new THREE.BoxGeometry(cw + 0.12, 0.14, cw + 0.12), jm);
  cornice.position.set(cx0, cTop + 0.05, cz0); cornice.castShadow = true; chimney.add(cornice);
  // 기와 갓지붕(작은 사모지붕): 4모 피라미드 + 기와 톤
  const capRoof = new THREE.Mesh(new THREE.ConeGeometry(cw * 0.95, 0.30, 4), M.tileRidge);
  capRoof.rotation.y = Math.PI / 4;                 // 모서리를 축에 맞춤
  capRoof.position.set(cx0, cTop + 0.28, cz0); capRoof.castShadow = true; chimney.add(capRoof);
  // 연가(오지 토관 연통): 갓지붕 위 개별 토관 3개 — 원거리에서 개별 실루엣으로 읽히게
  // 슬렌더하게 세우고 간격 벌림 + 높이·굵기 미세 변주(결정론 고정값). 갓지붕에 하부를 묻어
  // 부양감 없이 위로 솟게 한다.
  const yBase = cTop + 0.33;
  const yeonga = [
    { dx: -0.18, dz: -0.04, h: 0.48, r: 0.055 },
    { dx:  0.03, dz:  0.11, h: 0.36, r: 0.062 },
    { dx:  0.18, dz: -0.10, h: 0.44, r: 0.050 },
  ];
  for (const s of yeonga) {
    const yg = new THREE.CylinderGeometry(s.r * 0.88, s.r, s.h, 10);
    const y = new THREE.Mesh(yg, M.tileRidge);
    y.position.set(cx0 + s.dx, yBase + s.h / 2, cz0 + s.dz); y.castShadow = true; chimney.add(y);
    // 연가 갓(작은 기와 반구 마감)
    const cap = new THREE.Mesh(new THREE.SphereGeometry(s.r + 0.012, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), M.tileRidge);
    cap.position.set(cx0 + s.dx, yBase + s.h + 0.004, cz0 + s.dz); cap.castShadow = true; chimney.add(cap);
  }
  root.add(chimney);

  // 부엌 화구는 굴뚝과 이어지는 살림채 끝방의 마당 높이 개구 안으로 물린다. 외부 기단에
  // 별도 부뚜막을 덧붙이던 중복 구현을 초가와 공유하는 생활 장면 조립기로 대체한다.
  const kitchenOpening = planGiwaKitchenOpening(a);
  root.add(buildRecessedKitchenHearth({
    mats: M,
    wallX: kitchenOpening.wallX,
    centerZ: kitchenOpening.centerZ,
    floorY: 0,
    openingWidth: kitchenOpening.openingWidth,
    openingHeight: kitchenOpening.openingHeight,
    frameThickness: kitchenOpening.frameThickness,
    lightRange: kitchenOpening.lightRange,
  }));

  return root;
}
