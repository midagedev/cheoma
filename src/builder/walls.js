import * as THREE from 'three';
import {
  createThatchRoofProfile,
  THATCH_WALL_END_OVERLAP,
  thatchWallBreakpoints,
  thatchWallTopAt,
} from './thatch-profile.js';

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
  if (choga) { return buildChogaWalls(P, L, M, g, lastX, lastZ); }

  const y0 = L.podTopY + 0.18;
  const y1 = L.colTopY - 0.05;
  const H = y1 - y0;
  const T = 0.14; // 벽 두께

  // 문짝 패널 (텍스처 반복으로 분합문 표현)
  const doorPanel = (cx, cz, w) => {
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
  };

  // 회벽/황토벽(하부) + 중방 + 광창/살창(상부). winFrac: 상부 창 높이 비율.
  const sideWall = (cx, cz, w, rotY, winMat, winFrac = 0.30) => {
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
      doorPanel(cx, zF, w);                  // 궁: 전 칸 문 / 절·초가: 어칸만 문
    } else {
      sideWall(cx, zF, w, 0, winMat, 0.34);  // 협칸: 흙벽 + 살창
    }
  }

  // ---- 후면 ----
  const zB = L.zPos[0] + 0.12 + rec;
  for (let i = 0; i < lastX; i++) {
    const x0 = L.xPos[i], x1 = L.xPos[i + 1];
    sideWall((x0 + x1) / 2, zB, (x1 - x0) - P.columnRadius * 1.6, 0, winMat);
  }

  // ---- 좌우 측면 (맞배는 박공쪽) ----
  for (let j = 0; j < lastZ; j++) {
    const z0 = L.zPos[j], z1 = L.zPos[j + 1];
    const w = (z1 - z0) - P.columnRadius * 1.6;
    sideWall(L.xPos[0] + 0.12 + rec, (z0 + z1) / 2, w, Math.PI / 2, winMat);
    sideWall(L.xPos[lastX] - 0.12 - rec, (z0 + z1) / 2, w, Math.PI / 2, winMat);
  }

  return g;
}

// 초가 심벽 민가: 전 칸을 벽으로 채워 밀폐. 벽 상단이 지붕 밑면 곡선을 따라 올라가
// 지붕과 벽 사이 틈(모자 뜸)을 없앤다. 어칸 좁은 띠살문 + 작은 살창, 측면 진흙 굴뚝.
function buildChogaWalls(P, L, M, g, lastX, lastZ) {
  const y0 = L.podTopY + 0.05;
  const roofProfile = createThatchRoofProfile(P, L);
  const zF = L.zPos[lastZ], zB = L.zPos[0], xL = L.xPos[0], xR = L.xPos[lastX];
  const centerBay = Math.floor(lastX / 2);
  const cr = P.columnRadius + THATCH_WALL_END_OVERLAP;
  // #55 변주 필드(집집이 창호 개수·배치·하방 판벽·툇마루가 다름). 미지정 시 기존 룩 기본값.
  const winBack = P.winBack != null ? P.winBack : 1;       // 후면 살창 개수(0~2)
  const winSide = !!P.winSide;                             // 측면(부엌 반대편) 봉창 유무
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
  const smallWin = (cx, cz, rotY) => {
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.06), winMat);
    win.position.set(cx, y0 + 1.35, cz); win.rotation.y = rotY; g.add(win);
  };
  const door = (cx, cz, rotY) => {
    const dh = 1.55;
    const mat = M.door.clone();
    mat.map = M.door.map.clone(); mat.map.repeat.set(1, 1); mat.map.needsUpdate = true;
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.9, dh, 0.06), mat);
    d.position.set(cx, y0 + dh / 2, cz); d.rotation.y = rotY; d.receiveShadow = true; g.add(d);
  };
  for (let i = 0; i < lastX; i++) {
    const cx = (L.xPos[i] + L.xPos[i + 1]) / 2;
    if (i === centerBay) door(cx, zF + 0.06, 0); else smallWin(cx, zF + 0.06, 0);
  }
  // 후면 살창 개수 변주: 어칸 우선, 이어 협칸으로 분산(0~2).
  const backOrder = [centerBay, centerBay - 1, centerBay + 1, 0, lastX - 1].filter((i) => i >= 0 && i < lastX);
  for (let k = 0; k < Math.min(winBack, backOrder.length); k++) {
    const i = backOrder[k];
    smallWin((L.xPos[i] + L.xPos[i + 1]) / 2, zB - 0.06, 0);
  }
  // 측면 봉창(부엌 반대편 -x): 부엌·굴뚝(+x)과 겹치지 않게 좌측벽에만.
  if (winSide) smallWin(xL - 0.06, (zB + zF) / 2, Math.PI / 2);
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

  // ── 부엌 아궁이(+x 끝면 하부): 황토 부뚜막 + 검은 가마솥 + 어두운 화구 + 그을음 + 불씨 ──
  // 팔레트 무수정 원칙(giwa 참고): 그을음/화구/가마솥 재질은 여기서 자체 생성.
  // name 규약: 화구 발광면='agungiEmber', 화광='agungiFire' → src/env/smoke.js가 시간대 변조.
  buildChogaAgungi(L, M, g, xR);

  return g;
}

// 초가 아궁이: 소박한 황토 부뚜막을 부엌 끝(+x)면 바깥에 붙인다. giwa 대비 낮고 작게.
function buildChogaAgungi(L, M, g, xR) {
  const clayMat = new THREE.MeshStandardMaterial({ color: 0x8a6b45, roughness: 1.0, emissive: 0x1c1508 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x0a0806, roughness: 1.0 });
  const scorchMat = new THREE.MeshStandardMaterial({ color: 0x1a140f, roughness: 1.0, transparent: true, opacity: 0.85 });
  const potMat = new THREE.MeshStandardMaterial({ color: 0x141210, roughness: 0.5, metalness: 0.35 });
  const agX = xR + 0.02;             // 끝벽 바깥면
  const agZ = -0.25;                 // 부엌(뒤쪽)으로 살짝 치우침
  const bodyD = 0.5, bodyH = 0.82, bodyW = 1.15;
  const bodyCx = agX + bodyD / 2;
  const gy = 0;                      // 아궁이는 지면(마당) 레벨
  // 부뚜막 몸체(황토 조적 매스)
  const body = new THREE.Mesh(new THREE.BoxGeometry(bodyD, bodyH, bodyW), clayMat);
  body.position.set(bodyCx, gy + bodyH / 2, agZ);
  body.castShadow = body.receiveShadow = true; g.add(body);
  // 막돌 기초(부뚜막 밑 돌)
  const stoneBase = new THREE.Mesh(new THREE.BoxGeometry(bodyD + 0.14, 0.2, bodyW + 0.14), M.fieldstone);
  stoneBase.position.set(bodyCx, gy + 0.1, agZ); stoneBase.receiveShadow = true; g.add(stoneBase);
  // 화구(어두운 사각 개구) — +x 전면 하부
  const mouthW = 0.6, mouthH = 0.42, mouthY = gy + 0.34;
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.26, mouthH, mouthW), darkMat);
  mouth.position.set(agX + bodyD - 0.09, mouthY, agZ); g.add(mouth);
  // 그을음 얼룩(+x 전면)
  const scorch = new THREE.Mesh(new THREE.PlaneGeometry(mouthW + 0.16, bodyH * 0.62), scorchMat);
  scorch.position.set(agX + bodyD + 0.006, mouthY + 0.14, agZ); scorch.rotation.y = Math.PI / 2; g.add(scorch);
  // 화구 상부 돌 인방
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(bodyD + 0.05, 0.1, mouthW + 0.12), M.stoneDark);
  lintel.position.set(bodyCx, mouthY + mouthH / 2 + 0.05, agZ); lintel.castShadow = true; g.add(lintel);
  // 가마솥(검은 무쇠 반구) — 부뚜막 상판에 앉음
  const pot = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), potMat);
  pot.rotation.x = Math.PI; pot.scale.set(1, 0.68, 1);
  pot.position.set(bodyCx, gy + bodyH + 0.02, agZ); pot.castShadow = true; g.add(pot);
  // 불씨 발광면(밤·밥짓는 시간) — smoke.js가 emissiveIntensity 시간대 변조
  const ember = new THREE.Mesh(
    new THREE.PlaneGeometry(mouthW * 0.8, mouthH * 0.7),
    new THREE.MeshStandardMaterial({ color: 0x1a0d04, emissive: 0xff5a1e, emissiveIntensity: 0, roughness: 1.0, side: THREE.DoubleSide }));
  ember.name = 'agungiEmber';
  ember.position.set(agX + bodyD - 0.05, mouthY - 0.02, agZ);
  ember.rotation.y = Math.PI / 2; g.add(ember);
  // 화광 PointLight(밤 주변 온기) — smoke.js가 강도/가시성 제어
  const fire = new THREE.PointLight(0xff6a24, 0, 4.0, 2);
  fire.castShadow = false; fire.visible = false; fire.name = 'agungiFire';
  fire.position.set(agX + bodyD + 0.2, mouthY + 0.05, agZ); g.add(fire);
}
