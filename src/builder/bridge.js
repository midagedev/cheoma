import * as THREE from 'three';
import { getPropMaterials } from '../props/materials.js';
import { boulderGeometry } from '../props/geom.js';
import { makeRng } from '../rng.js';
import { BRIDGE_SLAB_DECK_LIFT } from '../village/stream-spatial.js';

// 돌다리 — 개울을 가로지르는 화강석 다리. 두 형식을 파라미터로 선택.
//   type:'slab' 판석교(널돌+교각, 소박)  |  type:'arch' 홍예교(무지개 아치, 격식)
//   돌 질감·팔레트는 props(석탑·석등·석축 등)와 통일하려고 getPropMaterials()
//   (granite/graniteDark/graniteWarm/graniteMoss)와 boulderGeometry 를 재사용한다.
//
// 로컬 좌표: X = 개울을 건너는 방향(span), Z = 통행 방향(width), y=0 = 수면.
//   호출부가 개울 교차점에 맞춰 회전·이동한다.
// buildBridge(opts) → THREE.Group.

export function buildBridge(opts = {}) {
  const type = opts.type === 'arch' ? 'arch' : 'slab';
  return type === 'arch' ? buildArchBridge(opts) : buildSlabBridge(opts);
}

// ── 판석교(평석교) ──────────────────────────────────────────────────
// 고증(한국민족문화대백과사전 「평석교」): "교각을 세우고 멍엣돌을 건너지른 다음 판석을 깔아 만든
//   돌다리"이고, "교각 위에는 긴 장대석을 건너질러 연결하는데 이를 **멍엣돌(駕石)**이라고 한다.
//   멍엣돌 위에는 마치 우물마루를 짜듯이 먼저 **귀틀석**을 건너지른 다음 귀틀석 사이에 **청판석**을
//   깔아 마감한다." → 데크는 널돌 2열이 아니라 멍엣돌·귀틀석·청판석 3층 구성이다.
// 난간: 같은 출처가 "**규모가 있는 석교에서는** 다리 양쪽에 난간을 설치하여 격식을 갖추기도 한다"고
//   조건부로 서술한다. 그래서 난간은 폭 위계 게이트를 통과할 때만 세운다(RAILING_MIN_WIDTH) —
//   근거 없이 전 규모에 붙이지 않는다. 조선시대 한양의 평석교 사례는 수표교·광통교·살곶이다리이며,
//   살곶이다리가 76m 인 것이 다경간 장대 평석교의 선례다(도성 개천 데크 33m 의 근거).
// 지간: BRIDGE_SLAB_BAY(3m) — 석재 한 장이 건널 수 있는 길이. 호출부가 교각 수를 계약에서 받는다.
export const RAILING_MIN_WIDTH = 4;    // m — "규모가 있는 석교"의 제품 경계(간선 6m 데크만 통과)

export function buildSlabBridge(opts = {}) {
  // 데크 리프트 기본값은 순수 접지 계약과 같은 상수를 쓴다(두 곳에 적으면 접지 단언이 무의미해진다).
  const {
    seed = 7, span = 4.5, width = 1.5, deckY = BRIDGE_SLAB_DECK_LIFT,
    piers = 2, bedY: bedYOpt,
  } = opts;
  const rng = makeRng(seed);
  const P = getPropMaterials();
  const g = new THREE.Group();
  g.name = 'bridge-slab';

  const slabThk = 0.16;
  const beamThk = 0.22;              // 멍엣돌(장대석) 두께
  const segN = Math.max(1, Math.round(piers)) + 1;
  const segLen = span / segN;
  // 하상은 접지 계약이 준다. 개천 트렌치에서는 데크가 시가지 지반 높이라 하상까지 3m 이상이고,
  //   옛 로컬 고정값(-0.4)을 쓰면 교각이 물 위에 떠 있는 그림이 된다.
  const bedY = Math.min(-0.4, Number.isFinite(bedYOpt) ? bedYOpt : -0.4);
  const beamTop = deckY - slabThk;
  const beamBottom = beamTop - beamThk;
  const railing = width >= RAILING_MIN_WIDTH;

  // 교각(중간 지점) — 하상에 선 각석 기둥 + 갑석 + 물가름 돌
  for (let i = 1; i < segN; i++) {
    const x = -span / 2 + i * segLen;
    const pierTop = beamBottom;
    const pierH = pierTop - bedY;
    if (pierH <= 0) continue;
    // 교각 폭은 높이에 따라 두꺼워진다 — 3m 교각을 0.52m 각석으로 세우면 이쑤시개로 읽힌다.
    const pierW = Math.min(segLen * 0.42, 0.52 + pierH * 0.14);
    const pier = new THREE.Mesh(new THREE.BoxGeometry(pierW, pierH, width * 0.86), P.granite);
    pier.position.set(x, bedY + pierH / 2, 0); pier.castShadow = pier.receiveShadow = true; g.add(pier);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(pierW + 0.18, 0.1, width * 0.98), P.graniteWarm);
    cap.position.set(x, pierTop - 0.05, 0); cap.castShadow = true; g.add(cap);
    // 물가름(뱃머리) 돌 — 상류측 삼각
    const cut = new THREE.Mesh(new THREE.BoxGeometry(pierW * 0.6, pierH * 0.8, pierW * 0.6), P.graniteDark);
    cut.position.set(x - pierW * 0.6, bedY + pierH * 0.4, 0); cut.rotation.y = Math.PI / 4; g.add(cut);
  }

  // 양안 둑돌(자연석 무리) — 다리 끝을 땅에 자연스럽게 앉힘
  for (const s of [-1, 1]) {
    const bx = s * (span / 2 + 0.05);
    const abutH = deckY - bedY;
    const abut = new THREE.Mesh(new THREE.BoxGeometry(0.6, abutH, width * 0.95), P.graniteDark);
    abut.position.set(bx, deckY - abutH / 2, 0); abut.castShadow = abut.receiveShadow = true; g.add(abut);
    for (let k = 0; k < 3; k++) {
      const r = 0.28 + rng() * 0.16;
      const rock = new THREE.Mesh(boulderGeometry(rng, r, 1, 0.8),
        rng() > 0.5 ? P.granite : P.graniteMoss);
      rock.position.set(bx + s * (0.3 + rng() * 0.3), r * 0.5, (rng() - 0.5) * width * 1.1);
      rock.rotation.y = rng() * Math.PI; rock.castShadow = true; g.add(rock);
    }
  }

  // 멍엣돌(駕石) — 교각 위를 통행 방향과 직교로 건너지르는 긴 장대석 2열(데크 양 옆).
  for (const row of [-1, 1]) {
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(span, beamThk, width * 0.2), P.granite);
    beam.position.set(0, beamBottom + beamThk / 2, row * width * 0.38);
    beam.castShadow = beam.receiveShadow = true; g.add(beam);
  }

  // 귀틀석 + 청판석 — 우물마루처럼 귀틀석을 건너지르고 그 사이를 청판석으로 마감한다.
  for (let i = 0; i < segN; i++) {
    const x0 = -span / 2 + i * segLen;
    // 귀틀석: 경간 경계마다 폭 방향 한 켜.
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(0.26, slabThk, width * 0.94), P.graniteWarm);
    rail.position.set(x0 + 0.13, deckY - slabThk / 2, 0);
    rail.castShadow = rail.receiveShadow = true; g.add(rail);
    // 청판석: 귀틀석 사이를 채우는 2열 널돌.
    const fillLen = Math.max(0.2, segLen - 0.3);
    for (const row of [-1, 1]) {
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(fillLen, slabThk, width * 0.42),
        rng() > 0.5 ? P.granite : P.graniteWarm);
      slab.position.set(
        x0 + 0.26 + fillLen / 2 + (rng() - 0.5) * 0.04,
        deckY - slabThk / 2 + (rng() - 0.5) * 0.02,
        row * width * 0.24);
      slab.rotation.y = (rng() - 0.5) * 0.02;
      slab.castShadow = slab.receiveShadow = true; g.add(slab);
    }
  }
  // 마지막 귀틀석(데크 끝단 마감).
  {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.26, slabThk, width * 0.94), P.graniteWarm);
    rail.position.set(span / 2 - 0.13, deckY - slabThk / 2, 0);
    rail.castShadow = rail.receiveShadow = true; g.add(rail);
  }

  // 난간 — "규모가 있는 석교"만. 지대석 위 난간기둥과 그 위 돌란대(수평 장대석)로 구성한다.
  if (railing) {
    const postH = 0.78;
    const postSpacing = Math.max(1.6, segLen);
    const postN = Math.max(2, Math.round(span / postSpacing) + 1);
    for (const row of [-1, 1]) {
      const z = row * width * 0.46;
      const sill = new THREE.Mesh(new THREE.BoxGeometry(span, 0.14, 0.2), P.graniteWarm);
      sill.position.set(0, deckY + 0.07, z);
      sill.castShadow = sill.receiveShadow = true; g.add(sill);
      for (let i = 0; i < postN; i++) {
        const x = -span / 2 + span * (postN === 1 ? 0.5 : i / (postN - 1));
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, postH, 0.18), P.granite);
        post.position.set(x, deckY + 0.14 + postH / 2, z);
        post.castShadow = true; g.add(post);
      }
      // 돌란대 — 난간기둥 위를 잇는 수평 장대석.
      const handrail = new THREE.Mesh(new THREE.BoxGeometry(span, 0.16, 0.24), P.graniteWarm);
      handrail.position.set(0, deckY + 0.14 + postH + 0.08, z);
      handrail.castShadow = true; g.add(handrail);
    }
  }

  g.userData = { kind: 'bridge', type: 'slab', span, width, piers: segN - 1, railing };
  return g;
}

// ── 홍예교(무지개다리) ──────────────────────────────────────────────
// 반원 홍예(아치) 위로 노면이 봉긋하게 넘어가는 격식 있는 돌다리.
//   ExtrudeGeometry 로 옆면 실루엣(홍예 개구 포함)을 단면으로 뽑아 통돌 몸체를 만들고,
//   홍예석 이음선·낮은 난간·둑돌을 덧댄다.
export function buildArchBridge(opts = {}) {
  const { seed = 9, span = 4.6, width = 1.6 } = opts;
  const rng = makeRng(seed);
  const P = getPropMaterials();
  const g = new THREE.Group();
  g.name = 'bridge-arch';

  const R = span * 0.4;              // 홍예 반경(반원)
  const springY = 0.05;             // 홍예가 솟는 높이(수면 바로 위)
  const halfLen = span / 2;         // 몸체 반폭
  const baseY = -0.25;              // 몸체 바닥(개울 바닥/둑에 묻힘)
  const crownY = springY + R;       // 홍예 정점(내면)
  const deckCenterY = crownY + 0.42;
  const deckEndY = springY + R * 0.42 + 0.3;
  const deckY = (x) => deckEndY + (deckCenterY - deckEndY) * (1 - Math.pow(Math.abs(x) / halfLen, 2)); // 봉긋한 노면

  // 옆면 단면(XY): 바깥 경계가 홍예 내면(반원)을 파고들어 개구를 만든다.
  const shape = new THREE.Shape();
  shape.moveTo(-halfLen, baseY);
  shape.lineTo(-R, baseY);
  shape.lineTo(-R, springY);                 // 좌측 홍예 받침(abutment) 수직면
  const AN = 16;
  for (let i = 0; i <= AN; i++) {            // 홍예 내면 반원: 좌 → 정점 → 우
    const a = Math.PI - (i / AN) * Math.PI;
    shape.lineTo(Math.cos(a) * R, springY + Math.sin(a) * R);
  }
  shape.lineTo(R, baseY);                     // 우측 받침 수직면 내려감
  shape.lineTo(halfLen, baseY);
  shape.lineTo(halfLen, deckEndY);           // 우측 바깥면
  const DN = 12;
  for (let i = 0; i <= DN; i++) {            // 봉긋한 노면(우 → 좌)
    const x = halfLen - (i / DN) * (halfLen * 2);
    shape.lineTo(x, deckY(x));
  }
  shape.lineTo(-halfLen, baseY);             // 좌측 바깥면 닫기

  const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, steps: 1 });
  geo.translate(0, 0, -width / 2);
  geo.computeVertexNormals();
  const bodyMat = P.granite.clone(); bodyMat.side = THREE.DoubleSide; // 통돌 몸체(안팎 안전)
  const body = new THREE.Mesh(geo, bodyMat);
  body.castShadow = body.receiveShadow = true; g.add(body);

  // 홍예석 이음선(방사형) — 양면에 얕은 쐐기돌 경계
  const nVous = 9;
  for (let i = 0; i <= nVous; i++) {
    const a = Math.PI - (i / nVous) * Math.PI;
    for (const zf of [-1, 1]) {
      const joint = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.34, 0.03), P.graniteDark);
      joint.position.set(Math.cos(a) * (R + 0.14), springY + Math.sin(a) * (R + 0.14), zf * (width / 2 + 0.005));
      joint.rotation.z = a - Math.PI / 2; g.add(joint);
    }
  }

  // 낮은 난간(양쪽 노면 가) — 짧은 엄지기둥 + 갑석 곡선
  for (const zf of [-1, 1]) {
    const z = zf * (width / 2 - 0.06);
    const NP = 7;
    for (let i = 0; i <= NP; i++) {
      const x = -halfLen + (i / NP) * (halfLen * 2);
      const y = deckY(x);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.34, 0.12), P.graniteWarm);
      post.position.set(x, y + 0.17, z); post.castShadow = true; g.add(post);
    }
    // 갑석(난간 윗돌) — 노면 곡선을 따라 판석 조각들
    for (let i = 0; i < NP; i++) {
      const x0 = -halfLen + (i / NP) * (halfLen * 2);
      const x1 = -halfLen + ((i + 1) / NP) * (halfLen * 2);
      const xm = (x0 + x1) / 2;
      const seg = new THREE.Mesh(new THREE.BoxGeometry((x1 - x0) * 1.02, 0.1, 0.18), P.granite);
      seg.position.set(xm, deckY(xm) + 0.38, z);
      seg.rotation.z = Math.atan2(deckY(x1) - deckY(x0), x1 - x0);
      seg.castShadow = true; g.add(seg);
    }
  }

  // 양안 둑돌(자연석) — 다리 끝을 땅에 앉힘
  for (const s of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const r = 0.3 + rng() * 0.18;
      const rock = new THREE.Mesh(boulderGeometry(rng, r, 1, 0.8),
        rng() > 0.5 ? P.graniteDark : P.graniteMoss);
      rock.position.set(s * (halfLen + 0.15 + rng() * 0.3), r * 0.4, (rng() - 0.5) * (width + 0.6));
      rock.rotation.y = rng() * Math.PI; rock.castShadow = rock.receiveShadow = true; g.add(rock);
    }
  }

  g.userData = { kind: 'bridge', type: 'arch', span, width, height: deckCenterY + 0.5 };
  return g;
}
