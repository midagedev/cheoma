import * as THREE from 'three';
import { mergeStatic } from './instancing.js';

// 성곽(도성 성벽) + 사대문(숭례·흥인·숙정·돈의) 렌더 — 한양 전용(#47).
//   스펙(순수 데이터)은 plan.computeCityWall 이 만든다: { cx, cz, ringR, gates[], wobbleAmp, seed }.
//   여기서는 그 링을 따라 지형(heightAt)에 밀착한 석성 리본을 두르고, 게이트 자리엔 문루(석축 홍예 +
//   기와 문루)를 세운다. 재질을 소수(석축·여장·기와·목·홍예그늘)로 통일해 병합 후 드로우콜을 억제.
//
//   buildCityWall(spec, site) → THREE.Group (스스로 큰 바운딩이라 컬링 이득은 적으나 드로우콜 소수).

const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// 결정론 노이즈(성벽 링 파동) — plan 과 무관한 자체 시드.
function makeWobble(seed, amp) {
  let s = seed >>> 0;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
  const w = [1.7, 3.3, 5.1];
  return (th) => amp * (0.6 * Math.sin(w[0] * th + ph[0]) + 0.28 * Math.sin(w[1] * th + ph[1]) + 0.12 * Math.sin(w[2] * th + ph[2]));
}

// 사각기둥/박스 지오를 버퍼에 누적(월드좌표). p0..p3 은 하단 4모서리(CCW), h 는 높이.
function pushBox(P, I, x0, z0, x1, z1, thk, yb, h, tanx, tanz) {
  // 벽 세그먼트: (x0,z0)→(x1,z1) 를 축으로 두께 thk 의 벽. 법선(tanx,tanz)=벽 횡방향 단위.
  const hx = tanx * thk * 0.5, hz = tanz * thk * 0.5;
  const yt = yb + h;
  const c = [
    [x0 - hx, z0 - hz], [x0 + hx, z0 + hz], [x1 + hx, z1 + hz], [x1 - hx, z1 - hz],
  ];
  const base = P.length / 3;
  for (const [cx, cz] of c) { P.push(cx, yb, cz); P.push(cx, yt, cz); }
  // 8 정점: 각 코너 (bottom, top) 쌍. index: corner i → base+i*2 (bot), +1 (top)
  const q = (a, b, cc, d) => I.push(a, b, cc, a, cc, d);
  // 옆면 4
  for (let i = 0; i < 4; i++) {
    const a = base + i * 2, b = base + ((i + 1) % 4) * 2;
    q(a, b, b + 1, a + 1);
  }
  // 윗면
  q(base + 1, base + 3, base + 5, base + 7);   // top ring (0,2,4,6 tops) — 두 삼각
  I.push(base + 1, base + 5, base + 3, base + 1, base + 7, base + 5);
}

// 문루 우진각 지붕(#78 근경 격상) — 평슬래브 대신 지붕 어휘로 읽히게: 처마 반전(코너 들림)·
//   처마 곡(중앙 처짐)·용마루(main ridge)·내림마루(hip ridges, 능선 끝→4코너). 저폴리 유지.
//   반환 THREE.Group(면=tileMat, 마루=ridgeMat). 문 4기 한정이라 병합 후 드로우콜 소폭↑ 허용.
function buildGateRoof(w, d, h, M) {
  const g = new THREE.Group();
  const hw = w / 2, hd = d / 2;
  const tw = w * 0.15;               // 용마루 반길이(짧은 능선)
  const cl = h * 0.20;               // 처마 반전(코너 들림) — 한식 지붕 실루엣
  const sag = h * 0.06;              // 처마 중앙 처짐(오목 곡선)
  const P = [], I = [];
  const add = (x, y, z) => { P.push(x, y, z); return P.length / 3 - 1; };
  const RL = add(-tw, h, 0), RR = add(tw, h, 0);              // 용마루 두 끝
  const flC = add(-hw, cl, hd), frC = add(hw, cl, hd), fMid = add(0, cl - sag, hd); // 앞 처마
  const blC = add(-hw, cl, -hd), brC = add(hw, cl, -hd), bMid = add(0, cl - sag, -hd); // 뒤 처마
  // 앞면(+z): 처마(fl·fMid·fr) → 용마루(RL·RR)
  I.push(flC, fMid, RL, fMid, RR, RL, fMid, frC, RR);
  // 뒷면(-z)
  I.push(brC, bMid, RR, bMid, RL, RR, bMid, blC, RL);
  // 좌·우 우진각 삼각
  I.push(flC, RL, blC);
  I.push(frC, brC, RR);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setIndex(I); geo.computeVertexNormals();
  const surf = new THREE.Mesh(geo, M.tileMat);
  surf.castShadow = surf.receiveShadow = true; g.add(surf);
  // 용마루: 능선 위 두툼한 어두운 기와마루.
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(tw * 2 + w * 0.05, h * 0.16, d * 0.11), M.ridgeMat);
  ridge.position.set(0, h + h * 0.04, 0); ridge.castShadow = true; g.add(ridge);
  const xAxis = new THREE.Vector3(1, 0, 0);
  for (const [ex, ez] of [[hw, hd], [hw, -hd], [-hw, hd], [-hw, -hd]]) {
    const rx = Math.sign(ex) * tw;                            // 능선 끝
    const dir = new THREE.Vector3(ex - rx, cl - h, ez);
    const len = dir.length(); dir.normalize();
    const hip = new THREE.Mesh(new THREE.BoxGeometry(len, h * 0.10, d * 0.07), M.ridgeMat);
    hip.quaternion.setFromUnitVectors(xAxis, dir);
    hip.position.set((rx + ex) / 2, (h + cl) / 2, ez / 2);
    hip.castShadow = true; g.add(hip);
  }
  return g;
}

export function buildCityWall(spec, site) {
  const group = new THREE.Group(); group.name = 'city-wall-work';
  if (!spec) { group.name = 'city-wall'; return group; }
  const { cx, cz, ringR, gates, wobbleAmp, seed } = spec;
  const wob = makeWobble(seed, wobbleAmp || 0);
  const wallH = 6.2, thk = 2.6, sink = 0.8;

  const stoneP = [], stoneI = [];      // 석축 몸통
  const capP = [], capI = [];          // 여장(윗단) — 약간 안쪽·짙게

  // 게이트 각도폭(라디안) — 이 안쪽 세그먼트는 벽을 비운다(문루가 대신).
  const gateArc = gates.map((g) => ({ a: g.angle, half: (g.width * 0.5 + 4) / ringR }));
  const inGate = (th) => gateArc.some((g) => {
    let d = Math.abs(((th - g.a + Math.PI) % (Math.PI * 2)) - Math.PI);
    return d < g.half;
  });

  const N = Math.max(96, Math.round(ringR * 0.9));
  const ptAt = (th) => {
    const r = ringR + wob(th);
    return { x: cx + Math.cos(th) * r, z: cz + Math.sin(th) * r, th };
  };
  let prev = null;
  for (let i = 0; i <= N; i++) {
    const th = (i / N) * Math.PI * 2;
    const cur = ptAt(th);
    if (prev && !inGate(th) && !inGate(prev.th)) {
      const dx = cur.x - prev.x, dz = cur.z - prev.z;
      const L = Math.hypot(dx, dz) || 1;
      // 벽 횡방향(반경 방향 근사) 단위 — 링 법선.
      const midTh = (prev.th + th) * 0.5;
      const tanx = Math.cos(midTh), tanz = Math.sin(midTh);
      const yb = Math.min(site.heightAt(prev.x, prev.z), site.heightAt(cur.x, cur.z)) - sink;
      pushBox(stoneP, stoneI, prev.x, prev.z, cur.x, cur.z, thk, yb, wallH, tanx, tanz);
      // 여장(윗단): 살짝 얇게 벽 위에 얹어 성가퀴 느낌 + 그림자선.
      pushBox(capP, capI, prev.x, prev.z, cur.x, cur.z, thk * 0.7, yb + wallH, 0.9, tanx, tanz);
    }
    prev = cur;
  }

  // DoubleSide: 수작업 스윕 벽면의 와인딩 불일치로 인한 컬링 구멍 방지(벽 두께라 비용 미미).
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8f887d, roughness: 1, metalness: 0, side: THREE.DoubleSide });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x746c62, roughness: 1, metalness: 0, side: THREE.DoubleSide });
  const mk = (P, I, mat, name) => {
    if (!I.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setIndex(I); g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat); m.name = name;
    m.castShadow = true; m.receiveShadow = true; group.add(m);
  };
  mk(stoneP, stoneI, stoneMat, 'wall-stone');
  mk(capP, capI, capMat, 'wall-cap');

  // ── 사대문(석축 홍예 + 기와 문루) ── 소수 재질(석·홍예그늘·기와·목) 공유.
  const gateStoneMat = new THREE.MeshStandardMaterial({ color: 0x968d80, roughness: 1, metalness: 0 });
  const archMat = new THREE.MeshStandardMaterial({ color: 0x241f1b, roughness: 1, metalness: 0 });
  const tileMat = new THREE.MeshStandardMaterial({ color: linCol(0x3b4048), roughness: 0.82, metalness: 0, side: THREE.DoubleSide });
  const ridgeMat = new THREE.MeshStandardMaterial({ color: linCol(0x262b32), roughness: 0.85, metalness: 0 }); // 용마루·내림마루(짙은 기와마루)
  const woodMat = new THREE.MeshStandardMaterial({ color: linCol(0x8a4a3a), roughness: 0.9, metalness: 0 });
  for (const g of gates) {
    group.add(buildGate(g, site, { gateStoneMat, archMat, tileMat, ridgeMat, woodMat }));
  }
  // 벽·문의 다수 메시(문루 기둥·석축 등)를 재질별 병합 → ~7 드로우콜(정적이라 손실 없음).
  const merged = mergeStatic([group], 'city-wall');
  merged.userData.isCityWall = true;
  return merged;
}

// 한 성문: 지형에 앉힌 석축 대(臺) + 홍예(아치 그늘) + 문루(기와 우진각 + 기둥).
function buildGate(gate, site, M) {
  const g = new THREE.Group(); g.name = `gate-${gate.name}`;
  const w = gate.width, baseH = 7.2, depth = 8.5;
  const gy = site.heightAt(gate.x, gate.z);
  // 문이 성벽 링에 직교하도록 회전 — dir(반경 방향)을 문루 정면(로컬 +z)으로.
  const rotY = Math.atan2(gate.dirX, gate.dirZ);
  g.position.set(gate.x, gy - 0.6, gate.z);
  g.rotation.y = rotY;

  // 석축 대: 폭 w+6, 깊이 depth, 높이 baseH — 좌우 육축 두 덩이 + 홍예 사이.
  const pierW = 5.5;
  const half = w / 2 + pierW / 2;
  for (const sx of [-1, 1]) {
    const pier = new THREE.Mesh(new THREE.BoxGeometry(pierW, baseH, depth), M.gateStoneMat);
    pier.position.set(sx * half, baseH / 2, 0);
    pier.castShadow = pier.receiveShadow = true; g.add(pier);
  }
  // 홍예 상인방(문 위 석재) + 아치 그늘(어두운 리세스)
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(w + pierW, baseH * 0.32, depth), M.gateStoneMat);
  lintel.position.set(0, baseH - baseH * 0.16, 0); lintel.castShadow = true; g.add(lintel);
  const arch = new THREE.Mesh(new THREE.BoxGeometry(w * 0.78, baseH * 0.7, depth * 0.6), M.archMat);
  arch.position.set(0, baseH * 0.35, 0); g.add(arch);

  // 문루 마루(대 위 목조 단): 낮은 난간 + 기둥 열.
  const deckY = baseH + 0.2;
  const deckW = w + pierW * 2 + 1.5, deckD = depth + 2.0;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(deckW, 0.5, deckD), M.gateStoneMat);
  deck.position.set(0, deckY, 0); deck.castShadow = deck.receiveShadow = true; g.add(deck);
  const colH = 3.4;
  for (const sx of [-1, -0.34, 0.34, 1]) for (const sz of [-1, 1]) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, colH, 6), M.woodMat);
    col.position.set(sx * deckW * 0.4, deckY + 0.25 + colH / 2, sz * deckD * 0.38);
    col.castShadow = true; g.add(col);
  }
  // 문루 지붕(기와 우진각) — 처마가 마루 밖으로. #78: 슬래브→지붕 어휘(용마루·내림마루·처마곡).
  const roofY = deckY + 0.25 + colH;
  const roof = buildGateRoof(deckW + 3.4, deckD + 3.4, (deckD + 3.4) * 0.42, M);
  roof.position.set(0, roofY, 0); g.add(roof);
  return g;
}
