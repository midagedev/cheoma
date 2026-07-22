import * as THREE from 'three';
import {
  createThatchRoofProfile,
  THATCH_WALL_END_OVERLAP,
  thatchWallBreakpoints,
  thatchWallTopAt,
} from './thatch-profile.js';
import { planChogaKitchenOpening } from '../layout/kitchen-opening-spatial.js';
import { buildRecessedKitchenHearth } from './kitchen-hearth.js';
import { planOpeningDetail } from './opening-detail-plan.js';
import { createOpeningDetailAssembler } from './opening-details.js';
import { createResidentialOpeningDetails } from './residential-opening-details.js';

// 벽체·창호. 궁(palace): 전면 칸마다 세살문, 측·후면 회벽+광창.
// 절(temple): 전면 어칸 띠살문 + 협칸(황토벽 하부 + 살창 상부), 측·후면 황토벽+작은 살창.
// 얇은 Box를 사용해 단면 페이싱 문제를 피한다.
export function buildWalls(P, L, M) {
  const g = new THREE.Group();
  const temple = P.style === 'temple';
  const choga = P.style === 'choga';
  const rustic = temple; // 절: 어칸 문 + 협칸 벽+창
  const lastX = L.xPos.length - 1, lastZ = L.zPos.length - 1;
  // ── 초가: 밀폐 심벽 민가 (전 칸 벽/문/작은 살창, 개방 툇간 없음) ──
  if (choga) {
    buildChogaWalls(P, L, M, g, lastX, lastZ);
    return g;
  }

  const openingDetails = createOpeningDetailAssembler(g, {
    frame: M.woodDark,
    hardware: M.hardware,
  });

  const y0 = L.podTopY + 0.18;
  const y1 = L.colTopY - 0.05;
  const H = y1 - y0;
  const T = 0.14; // 벽 두께

  // 문짝 패널 (텍스처 반복으로 분합문 표현)
  const doorPanel = (cx, cz, w, placement, primary, seed) => {
    const leaves = w > 3.2 ? 4 : w > 1.9 ? 3 : 2;
    const mat = M.door.clone();
    mat.map = M.door.map.clone();
    mat.map.repeat.set(leaves, 1);
    mat.map.wrapS = THREE.RepeatWrapping;
    mat.map.needsUpdate = true;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(w, H, T), mat);
    panel.position.set(cx, y0 + H / 2, cz);
    panel.receiveShadow = true;
    g.add(panel);
    openingDetails.add(planOpeningDetail({
      kind: 'door', style: temple ? 'temple' : 'palace', seed,
      width: w, height: H, wallThickness: T, leafCount: leaves,
      lowerPanelHeight: H * (temple ? 0.16 : 0.19), primary,
    }), { ...placement, center: { x: cx, z: cz }, bottomY: y0 }, panel);
  };

  // 회벽/황토벽(하부) + 중방 + 광창/살창(상부). winFrac: 상부 창 높이 비율.
  const sideWall = (cx, cz, w, rotY, winMat, placement, seed, winFrac = 0.30) => {
    const wallFrac = 1 - winFrac - 0.08;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, H * wallFrac, T), M.plaster);
    wall.position.set(cx, y0 + H * wallFrac / 2, cz);
    wall.rotation.y = rotY;
    wall.receiveShadow = true;
    g.add(wall);
    const midBeam = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, T + 0.06), M.woodDark);
    midBeam.position.set(cx, y0 + H * wallFrac + 0.08, cz);
    midBeam.rotation.y = rotY;
    g.add(midBeam);
    // 창: 절·초가는 폭을 줄인 작은 살창(가운데), 궁은 칸 전체 광창.
    const ww = rustic ? Math.min(w * 0.5, 1.3) : w;
    const window_ = new THREE.Mesh(new THREE.BoxGeometry(ww, H * winFrac, T), winMat);
    window_.position.set(cx, y0 + H * wallFrac + 0.16 + H * winFrac / 2, cz);
    window_.rotation.y = rotY;
    g.add(window_);
    openingDetails.add(planOpeningDetail({
      kind: 'window', style: temple ? 'temple' : 'palace', seed,
      width: ww, height: H * winFrac, wallThickness: T,
    }), {
      ...placement,
      center: { x: cx, z: cz },
      bottomY: y0 + H * wallFrac + 0.16,
    }, window_);
  };

  const winMat = rustic ? M.salchang : M.hanji;
  const rec = rustic ? 0.06 : 0; // 절·초가: 문/창 패널을 기둥면보다 안쪽으로 후퇴

  // ---- 전면 ----
  const zF = L.zPos[lastZ] - 0.12 - rec;
  const centerBay = Math.floor((lastX) / 2); // 어칸(3칸 → index 1)
  for (let i = 0; i < lastX; i++) {
    const x0 = L.xPos[i], x1 = L.xPos[i + 1];
    const cx = (x0 + x1) / 2, w = (x1 - x0) - P.columnRadius * 1.6;
    if (!rustic || i === centerBay) {
      doorPanel(cx, zF, w, {
        tangent: { x: 1, z: 0 }, outward: { x: 0, z: 1 },
      }, i === centerBay, `${P.style}:${P.seed ?? 0}:front:${i}`); // 궁: 전 칸 문 / 절: 어칸만 문
    } else {
      sideWall(cx, zF, w, 0, winMat, {
        tangent: { x: 1, z: 0 }, outward: { x: 0, z: 1 },
      }, `${P.style}:${P.seed ?? 0}:front:${i}`, 0.34); // 협칸: 흙벽 + 살창
    }
  }

  // ---- 후면 ----
  const zB = L.zPos[0] + 0.12 + rec;
  for (let i = 0; i < lastX; i++) {
    const x0 = L.xPos[i], x1 = L.xPos[i + 1];
    sideWall((x0 + x1) / 2, zB, (x1 - x0) - P.columnRadius * 1.6, 0, winMat, {
      tangent: { x: -1, z: 0 }, outward: { x: 0, z: -1 },
    }, `${P.style}:${P.seed ?? 0}:back:${i}`);
  }

  // ---- 좌우 측면 (맞배는 박공쪽) ----
  for (let j = 0; j < lastZ; j++) {
    const z0 = L.zPos[j], z1 = L.zPos[j + 1];
    const w = (z1 - z0) - P.columnRadius * 1.6;
    sideWall(L.xPos[0] + 0.12 + rec, (z0 + z1) / 2, w, Math.PI / 2, winMat, {
      tangent: { x: 0, z: 1 }, outward: { x: -1, z: 0 },
    }, `${P.style}:${P.seed ?? 0}:left:${j}`);
    sideWall(L.xPos[lastX] - 0.12 - rec, (z0 + z1) / 2, w, Math.PI / 2, winMat, {
      tangent: { x: 0, z: -1 }, outward: { x: 1, z: 0 },
    }, `${P.style}:${P.seed ?? 0}:right:${j}`);
  }

  openingDetails.finish();
  return g;
}

// 초가 심벽 민가: 전 칸을 벽으로 채워 밀폐. 벽 상단이 지붕 밑면 곡선을 따라 올라가
// 지붕과 벽 사이 틈(모자 뜸)을 없앤다. 어칸 좁은 띠살문 + 작은 살창, 측면 진흙 굴뚝.
function buildChogaWalls(P, L, M, g, lastX, lastZ) {
  const y0 = L.podTopY + 0.05;
  const roofProfile = createThatchRoofProfile(P, L);
  const zF = L.zPos[lastZ], zB = L.zPos[0], xL = L.xPos[0], xR = L.xPos[lastX];
  const cr = P.columnRadius + THATCH_WALL_END_OVERLAP;
  // #55의 하방 판벽·툇마루 변주는 유지하되 문/창 개수와 폭은 공유 residential planner가 소유한다.
  const plankBase = !!P.plankBase;                         // 하방 판벽(전면 벽 하부 널)
  const maruStyle = P.maruStyle || 'full';                 // 툇마루: full | short | none

  // 상단이 지붕선을 따르는 심벽 벽면(리본). axis 'x'=z고정, 'z'=x고정.
  const wallStrip = (axis, fixed, a, b) => {
    const points = thatchWallBreakpoints(roofProfile, axis, fixed, a, b);
    const N = points.length - 1, pos = [], idx = [], uv = [];
    for (let i = 0; i < points.length; i++) {
      const along = points[i];
      const x = axis === 'x' ? along : Math.fround(fixed);
      const z = axis === 'x' ? Math.fround(fixed) : along;
      // 렌더 표면과 동일한 프로파일에서 3cm만 안으로 물려, 틈 없이 이엉 아래에 숨긴다.
      const top = thatchWallTopAt(roofProfile, x, z);
      pos.push(x, y0, z, x, top, z);
      const u = ((along - a) / (b - a)) * 14; // 기존 28분할의 0..14 반복 범위를 보존한다.
      uv.push(u, 0, u, 1.5);
    }
    for (let i = 0; i < N; i++) {
      const A = i * 2, B = A + 1, C = A + 2, D = A + 3;
      idx.push(A, C, B, B, C, D);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    const mat = M.plaster.clone(); mat.side = THREE.DoubleSide;
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true; g.add(m);
  };
  wallStrip('x', zF, xL - cr, xR + cr);  // 전면
  wallStrip('x', zB, xL - cr, xR + cr);  // 후면
  wallStrip('z', xL, zB - cr, zF + cr);  // 좌
  wallStrip('z', xR, zB - cr, zF + cr);  // 우

  // ── 막돌 기단/화방벽: 벽 하부를 두른 낮은 자연석 켜(다듬은 장대석 아님) ──
  // 흙벽 앞에 살짝 내밀어 붙인 거친 돌 띠. 정면은 툇마루가 가리므로 측·후면 위주로 읽힌다.
  const baseH = 0.62;                       // 막돌 켜 높이(낮게)
  const fsMat = (lenM) => {
    const m = M.fieldstone.clone();
    m.map = M.fieldstone.map.clone();
    m.map.repeat.set(Math.max(2, Math.round(lenM / 1.1)), 1);
    m.map.needsUpdate = true; return m;
  };
  const stoneBand = (axis, fixed, a, b, out) => {
    const len = Math.abs(b - a), mid = (a + b) / 2;
    const geo = axis === 'x'
      ? new THREE.BoxGeometry(len, baseH, 0.16)
      : new THREE.BoxGeometry(0.16, baseH, len);
    const m = new THREE.Mesh(geo, fsMat(len));
    const y = y0 + baseH / 2 - 0.06;
    if (axis === 'x') m.position.set(mid, y, fixed + out); else m.position.set(fixed + out, y, mid);
    m.castShadow = m.receiveShadow = true; g.add(m);
  };
  stoneBand('x', zB, xL - cr, xR + cr, -0.05);  // 후면
  stoneBand('z', xL, zB - cr, zF + cr, -0.05);  // 좌
  stoneBand('z', xR, zB - cr, zF + cr, 0.05);   // 우(부엌 끝)

  // 창호/문/중방 오버레이 (벽면 바로 바깥)
  const midBeam = (axis, fixed, a, b) => {
    const len = Math.abs(b - a), mid = (a + b) / 2;
    const geo = axis === 'x' ? new THREE.BoxGeometry(len, 0.11, 0.2) : new THREE.BoxGeometry(0.2, 0.11, len);
    const m = new THREE.Mesh(geo, M.woodDark);
    if (axis === 'x') m.position.set(mid, y0 + 0.95, fixed); else m.position.set(fixed, y0 + 0.95, mid);
    g.add(m);
  };
  midBeam('x', zF, xL - cr, xR + cr); midBeam('x', zB, xL - cr, xR + cr);
  midBeam('z', xL, zB - cr, zF + cr); midBeam('z', xR, zB - cr, zF + cr);

  // 작은 살창: 파란 유리처럼 어둡게 죽지 않게 미색 한지 살창으로.
  const winMat = M.door.clone();
  winMat.map = M.door.map.clone(); winMat.map.repeat.set(1, 1); winMat.map.needsUpdate = true;
  const residentialDetails = createResidentialOpeningDetails('choga', P, g, {
    frame: M.woodDark,
    hardware: M.hardware,
  }, {
    door: {
      bottomY: y0,
      height: 1.55,
      wallThickness: 0.06,
      lowerPanelHeight: 0.12,
      footwear: maruStyle === 'none'
        ? { y: L.podTopY - y0, outward: 0.30, surface: 'threshold' }
        : {
          y: L.podTopY + 0.36 - y0,
          outward: (maruStyle === 'short' ? 0.78 : 0.95) * 0.68,
          surface: 'jjokmaru',
        },
    },
    window: {
      bottomY: y0 + 1.10,
      height: 0.5,
      wallThickness: 0.06,
    },
  });
  const panelRotation = (opening) => (
    Math.abs(opening.tangent.x) >= Math.abs(opening.tangent.z) ? 0 : Math.PI / 2
  );
  const smallWin = (opening) => {
    const win = new THREE.Mesh(new THREE.BoxGeometry(opening.width, 0.5, 0.06), winMat);
    win.position.set(opening.center.x, y0 + 1.35, opening.center.z);
    win.rotation.y = panelRotation(opening);
    g.add(win);
    residentialDetails.add(opening, win);
  };
  const door = (opening) => {
    residentialDetails.add(opening, (detail) => {
      const dh = 1.55;
      const mat = M.door.clone();
      mat.map = M.door.map.clone();
      mat.map.repeat.set(detail.leafCount, 1);
      mat.map.wrapS = THREE.RepeatWrapping;
      mat.map.needsUpdate = true;
      const d = new THREE.Mesh(new THREE.BoxGeometry(opening.width, dh, 0.06), mat);
      d.position.set(opening.center.x, y0 + dh / 2, opening.center.z);
      d.rotation.y = panelRotation(opening);
      d.receiveShadow = true;
      g.add(d);
      return d;
    });
  };
  for (const opening of residentialDetails.plan.openings) {
    if (opening.kind === 'door') door(opening);
    else smallWin(opening);
  }
  residentialDetails.finish();
  // 하방 판벽: 전면 벽 하부를 어두운 세로널로 두른 띠(회벽 대신 널). 살림 격 변주.
  if (plankBase) {
    const pbH = 0.52;
    const band = new THREE.Mesh(new THREE.BoxGeometry((xR - xL) + 2 * cr, pbH, 0.08), M.planwall || M.woodDark);
    band.position.set((xL + xR) / 2, L.podTopY + 0.05 + pbH / 2, zF + 0.05);
    band.castShadow = band.receiveShadow = true; g.add(band);
  }

  // 툇마루: 전면 칸을 잇는 낮은 널마루(쪽마루) + 동바리 — 깊은 처마 그늘 아래 열린 마루로 답답함을
  //   풀되, 뒤벽은 심벽 그대로 유지(개방 정자 아님). 스타일 변주: full(전폭)·short(중앙 반폭)·none(생략).
  if (maruStyle !== 'none') {
    const smCx = (xL + xR) / 2;
    const sw = maruStyle === 'short' ? (xR - xL) * 0.55 : (xR - xL) - 0.3;
    const smDep = maruStyle === 'short' ? 0.78 : 0.95;
    const smY = L.podTopY + 0.36;
    const mm = M.maru.clone(); mm.map = M.maru.map.clone(); mm.map.repeat.set(Math.max(1, Math.round(sw / 1.2)), 1); mm.map.needsUpdate = true;
    const jjok = new THREE.Mesh(new THREE.BoxGeometry(sw, 0.1, smDep), mm);
    jjok.position.set(smCx, smY, zF + smDep / 2 + 0.06);
    jjok.castShadow = jjok.receiveShadow = true; g.add(jjok);
    // 마루 앞턱 귀틀(어두운 테)
    const rail = new THREE.Mesh(new THREE.BoxGeometry(sw, 0.11, 0.09), M.woodDark);
    rail.position.set(smCx, smY - 0.02, zF + smDep + 0.05); g.add(rail);
    const jh = smY - L.podTopY;
    for (let d = -sw / 2 + 0.35; d <= sw / 2 - 0.35 + 1e-3; d += (sw - 0.7) / 4) {
      const dong = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, jh, 8), M.woodDark);
      dong.position.set(smCx + d, L.podTopY + jh / 2, zF + smDep - 0.05);
      dong.castShadow = true; g.add(dong);
    }
  }

  // ── 부엌 끝 뭉툭한 진흙 굴뚝 스택(둥근 유기 형태·금 간 표면, 매끈 관 아님) ──
  // 후면 처마선 밖(-zEave 바깥)에 세워 연기가 지붕에 갇히지 않고 곧게 오르게 한다.
  // 라스 프로파일 회전체 = 단일 M.mud 메시 → smoke.js 연기 anchor 1개 유지(둘로 쪼개면 anchor 중복).
  const zEaveW = roofProfile.zEave;
  const ccx = xR - 0.45, ccz = -zEaveW - 0.28;        // +x 부엌 코너·후면 처마 밖
  const prof = [
    [0.31, 0.00], [0.32, 0.25], [0.29, 0.60], [0.27, 1.05],
    [0.255, 1.55], [0.25, 2.05], [0.25, 2.35], [0.21, 2.52],
    [0.13, 2.63], [0.0, 2.68],                         // 둥글게 오므린 상단
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const stackGeo = new THREE.LatheGeometry(prof, 18);
  const stack = new THREE.Mesh(stackGeo, M.mud);       // 재질 동일성으로 smoke.js가 굴뚝 식별
  stack.position.set(ccx, 0, ccz);                     // 마당(지면) 레벨
  stack.castShadow = stack.receiveShadow = true; g.add(stack);
  // 벽↔굴뚝 낮은 연도(구들에서 나오는 흙 둔덕) — 굴뚝이 겉돌지 않게 뒷벽에 물림.
  // ⚠ 재질을 M.mud 클론으로 분리 — smoke.js는 material===M.mud 로 굴뚝을 식별하므로
  //    연도가 원본 M.mud면 두 번째 연기 anchor가 생긴다(굴뚝 스택만 원본 M.mud 유지).
  const flue = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, Math.abs(ccz - zB) + 0.2), M.mud.clone());
  flue.position.set(ccx, 0.25, (ccz + zB) / 2);
  flue.castShadow = flue.receiveShadow = true; g.add(flue);

  // 부엌 아궁이는 마당 높이의 끝방 개구 안으로 물린다. 독립 노천 화덕처럼 외벽 밖에
  // 부뚜막 매스를 붙이지 않으며, 불씨/화광 이름은 smoke.js 시간대 계약을 그대로 쓴다.
  const kitchenOpening = planChogaKitchenOpening(xR);
  g.add(buildRecessedKitchenHearth({
    mats: M,
    wallX: kitchenOpening.wallX,
    centerZ: kitchenOpening.centerZ,
    floorY: 0,
    openingWidth: kitchenOpening.openingWidth,
    openingHeight: kitchenOpening.openingHeight,
    frameThickness: kitchenOpening.frameThickness,
    lightRange: kitchenOpening.lightRange,
  }));

  return g;
}
