import * as THREE from 'three';
import { sunkPrism } from '../core/surface-clearance.js';

// 기단(월대): 장대석 단 + 전면 계단 + 주춧돌
export function buildPodium(P, L, M) {
  const g = new THREE.Group();

  for (let t = 0; t < P.podiumTiers; t++) {
    const shrink = t * 1.35;
    const w = L.W + P.podiumMarginS * 2 + (P.podiumMarginF - P.podiumMarginS) - shrink * 0;
    const halfW = L.W / 2 + P.podiumMarginS + (P.podiumTiers - 1 - t) * 1.35;
    const halfDF = L.D / 2 + P.podiumMarginF + (P.podiumTiers - 1 - t) * 1.35; // 전면
    const halfDB = L.D / 2 + P.podiumMarginS + (P.podiumTiers - 1 - t) * 1.35; // 후면
    const h = P.podiumTierH;
    const tier = t === 0 ? sunkPrism(h) : { height: h, center: t * h + h / 2 };
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(halfW * 2, tier.height, halfDF + halfDB),
      M.stone
    );
    box.name = `podium-tier-${t}`;
    box.position.set(0, tier.center, (halfDF - halfDB) / 2);
    box.castShadow = box.receiveShadow = true;
    g.add(box);

    // 갑석: 단 윗면 마감돌. 절은 밝은 톤으로 상면/옆면 분리, 초가는 형식 갑석 생략(막돌 느낌).
    const isTemple = P.style === 'temple';
    const isChoga = P.style === 'choga';
    if (!isChoga) {
      const capMat = isTemple
        ? new THREE.MeshStandardMaterial({ color: 0xbfb6a3, roughness: 0.95 }) // 밝은 갑석
        : M.stoneDark;
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(halfW * 2 + 0.22, isTemple ? 0.2 : 0.12, halfDF + halfDB + 0.22),
        capMat
      );
      cap.position.set(0, t * h + h - (isTemple ? 0.10 : 0.06), (halfDF - halfDB) / 2);
      cap.castShadow = cap.receiveShadow = true;
      g.add(cap);
    }

    // 초가: 낮은 외벌대(막돌 한 벌) — 다단 석축 인상 제거. 상단에 막돌 줄눈 홈 하나만.
    if (isChoga) {
      const jointMat = new THREE.MeshStandardMaterial({ color: 0x6f665a, roughness: 1.0 });
      const line = new THREE.Mesh(
        new THREE.BoxGeometry(halfW * 2 + 0.04, 0.05, halfDF + halfDB + 0.04), jointMat);
      line.position.set(0, t * h + h * 0.55, (halfDF - halfDB) / 2);
      line.receiveShadow = true; g.add(line);
    }

    // 장대석 켜 (절): 수평 줄눈을 어두운 홈으로 또렷하게 — 시멘트 느낌 제거.
    if (isTemple) {
      const jointMat = new THREE.MeshStandardMaterial({ color: 0x6e675a, roughness: 1.0 });
      const courses = Math.max(3, Math.round(h / 0.38));
      for (let ci = 1; ci < courses; ci++) {
        const line = new THREE.Mesh(
          new THREE.BoxGeometry(halfW * 2 + 0.05, 0.07, halfDF + halfDB + 0.05),
          jointMat
        );
        line.position.set(0, t * h + (h / courses) * ci, (halfDF - halfDB) / 2);
        line.receiveShadow = true;
        g.add(line);
      }
    }
  }

  // 전면 중앙 계단 (어칸 폭)
  const stairW = P.centerBayW + 0.8;
  const totalH = L.podTopY;
  const steps = Math.max(4, Math.round(totalH / 0.22));
  const stepH = totalH / steps;
  const stepD = 0.34;
  const frontEdge = L.D / 2 + P.podiumMarginF;

  if (P.style === 'choga') {
    // 초가: 형식 계단·소맷돌 대신 소박한 디딤돌 두 개(지면에 밀착).
    const ddong = (w, d, h, z) => {
      const s = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M.stone);
      s.position.set(0, h / 2, z);
      s.castShadow = s.receiveShadow = true;
      g.add(s);
    };
    // 디딤돌은 쪽마루 앞으로 (쪽마루가 기단 앞 ~0.9m까지 나오므로 그 밖에 배치)
    ddong(1.3, 0.6, 0.12, frontEdge + 0.55);  // 큰 디딤돌
    ddong(0.9, 0.5, 0.06, frontEdge + 1.15);  // 앞 디딤돌
  } else {
    // 계단은 최상단 월대 전면에 접합 (하단 월대를 관통해 내려감)
    for (let i = 0; i < steps; i++) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(stairW, stepH, stepD), M.stone);
      s.position.set(0, i * stepH + stepH / 2, frontEdge + (steps - i) * stepD - stepD / 2);
      s.castShadow = s.receiveShadow = true;
      g.add(s);
    }
    // 계단 소맷돌
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, totalH * 0.55, steps * stepD * 1.05),
        M.stoneDark
      );
      rail.position.set(side * (stairW / 2 + 0.14), totalH * 0.32, frontEdge + steps * stepD / 2);
      rail.rotation.x = -Math.atan2(totalH, steps * stepD) * 0.5;
      rail.castShadow = true;
      g.add(rail);
    }
  }

  // 상단 월대 돌난간(석난간): 최상단 월대 윗면 둘레 (전면 계단 앞은 비움). 궁 전용.
  // 근정전 실물은 가는 각기둥이 아니라, 통통한 동자석(둥근 항아리형)이 둥근 돌란대(원형 손잡이)를
  // 받치는 형식이라 강한 수평 리듬을 만든다. 동자석은 라스 프로파일(연주형)로, 돌란대는 원통으로.
  if (P.podiumRailing !== false) {
    const topY = L.podTopY;
    const halfW = L.W / 2 + P.podiumMarginS;
    const halfDF = L.D / 2 + P.podiumMarginF;
    const halfDB = L.D / 2 + P.podiumMarginS;
    const spacing = 1.15;
    const gapHalf = (stairW + 0.6) / 2; // 전면 중앙 계단 폭 + 0.6
    // 동자석: 밑동 넓고 허리 잘록, 위에 구슬(연주) 얹힌 항아리형 — 라스 회전체.
    const djProf = [
      [0.10, 0.00], [0.15, 0.05], [0.155, 0.16], [0.10, 0.30],
      [0.085, 0.42], [0.12, 0.50], [0.14, 0.56], [0.10, 0.60],
      [0.13, 0.63], [0.11, 0.68], [0.001, 0.70],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const djGeo = new THREE.LatheGeometry(djProf, 12);
    const railR = 0.085;                 // 돌란대(원형 손잡이) 반지름
    const railY = topY + 0.60;           // 돌란대 중심 높이(동자석 머리)

    // axis: 변이 뻗는 축, fixed: 반대축 고정 좌표, from/to: 변 범위
    const addRail = (axis, fixed, from, to, skipFront) => {
      const n = Math.max(2, Math.round(Math.abs(to - from) / spacing));
      for (let i = 0; i <= n; i++) {
        const t = from + (to - from) * (i / n);
        if (skipFront && Math.abs(t) < gapHalf) continue;
        const dj = new THREE.Mesh(djGeo, M.stone);
        if (axis === 'x') dj.position.set(t, topY, fixed);
        else dj.position.set(fixed, topY, t);
        dj.castShadow = true; g.add(dj);
      }
      // 돌란대: 동자석 머리를 잇는 둥근 손잡이(원통). 끝은 법수(연주 마감)로 살짝 키움.
      const segs = skipFront ? [[from, -gapHalf], [gapHalf, to]] : [[from, to]];
      for (const [a, b] of segs) {
        if (b - a <= 0.02) continue;
        const rlen = (b - a) + railR * 2, mid = (a + b) / 2;
        const rail = new THREE.Mesh(new THREE.CylinderGeometry(railR, railR, rlen, 10), M.stone);
        if (axis === 'x') { rail.rotation.z = Math.PI / 2; rail.position.set(mid, railY, fixed); }
        else { rail.rotation.x = Math.PI / 2; rail.position.set(fixed, railY, mid); }
        rail.castShadow = true; g.add(rail);
        // 법수(난간 끝 기둥머리 구슬)
        for (const e of [a, b]) {
          if (skipFront && Math.abs(e) < gapHalf + 0.05) continue;
          const bey = new THREE.Mesh(new THREE.SphereGeometry(railR * 1.5, 10, 8), M.stoneDark);
          if (axis === 'x') bey.position.set(e, railY, fixed); else bey.position.set(fixed, railY, e);
          bey.castShadow = true; g.add(bey);
        }
      }
    };
    addRail('x', halfDF, -halfW, halfW, true);    // 전면 (계단 구간 제외)
    addRail('x', -halfDB, -halfW, halfW, false);  // 후면
    addRail('z', -halfW, -halfDB, halfDF, false); // 왼쪽
    addRail('z', halfW, -halfDB, halfDF, false);  // 오른쪽

    // 답도(踏道): 전면 중앙 계단 가운데 봉황을 새긴 경사 어도(御道) 판석 — 계단 소맷돌 사이.
    const frontEdge2 = L.D / 2 + P.podiumMarginF;
    const rampLen = steps * stepD * 1.05;
    const dapdo = new THREE.Mesh(
      new THREE.BoxGeometry(stairW * 0.5, 0.08, rampLen), M.stone);  // 계단 석재와 같은 밝은 화강암(구덩이처럼 안 죽게)
    dapdo.position.set(0, totalH * 0.5 + 0.06, frontEdge2 + rampLen / 2);
    dapdo.rotation.x = -Math.atan2(totalH, steps * stepD) * 0.5;
    dapdo.castShadow = dapdo.receiveShadow = true;
    g.add(dapdo);
    // 답도 봉황 조각면 힌트: 어도 판석 가운데 얕은 어두운 각자(직사각 릴리프) 한 줄.
    const carve = new THREE.Mesh(
      new THREE.BoxGeometry(stairW * 0.32, 0.02, rampLen * 0.82), M.stoneDark);
    carve.position.set(0, totalH * 0.5 + 0.10, frontEdge2 + rampLen / 2);
    carve.rotation.x = dapdo.rotation.x;
    carve.receiveShadow = true;
    g.add(carve);
  }

  // 주춧돌
  const baseGeo = new THREE.CylinderGeometry(P.columnRadius * 1.55, P.columnRadius * 1.8, 0.26, 10);
  for (const x of L.xPos) for (const z of [L.zPos[0], L.zPos[L.zPos.length - 1]]) {
    const b = new THREE.Mesh(baseGeo, M.stoneDark);
    b.position.set(x, L.podTopY + 0.13, z);
    b.castShadow = true;
    g.add(b);
  }
  for (const z of L.zPos.slice(1, -1)) for (const x of [L.xPos[0], L.xPos[L.xPos.length - 1]]) {
    const b = new THREE.Mesh(baseGeo, M.stoneDark);
    b.position.set(x, L.podTopY + 0.13, z);
    b.castShadow = true;
    g.add(b);
  }

  return g;
}
