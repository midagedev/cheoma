// 칸 확장(들이기) + 머지 — 一자 본채에 종속 날개(사랑채·행각 어휘)를 붙여 ㄱ자·ㄷ자
// 마당을 구성한다. 코어 무수정 제약 하에서 "새 날개만 개별 조립/머지 애니메이션"이
// 가능하도록, 각 날개는 buildBuilding(P)로 만든 독립 그룹(podium/columns/walls/brackets/roof
// 네이밍)이다. (통짜 연속지붕 ㄱ/ㄷ는 buildHanok 경로가 있으나 파트 그룹 네이밍이 없어
//  개별 애니메이션 불가 → 튼ㄱ자·튼ㄷ자 배치로 표현. 보고서의 코어 훅 참조.)

import * as THREE from 'three';
import { buildBuilding, computeLayout, disposeBuilding } from '../../../src/api/building.js';

// 확장 가능한(격자) 프리셋의 최대 날개 수. giwa 는 이미 ㄱ자 단일 동이라 확장 대상 아님.
const WING_MAX = { korea: 2, temple: 2, choga: 2, giwa: 0 };
export function wingCount(preset) { return WING_MAX[preset] ?? 0; }

// P.style(palace/temple/choga/giwa) → WING_MAX 키(korea/temple/choga/giwa).
const STYLE_KEY = { palace: 'korea', temple: 'temple', choga: 'choga', giwa: 'giwa' };
const keyOf = (P) => STYLE_KEY[P.style] || 'korea';

// 본채 P → 종속 날개용 파라미터(더 작고 낮게). 스타일/재질은 본채와 동일하게 유지.
function wingParams(P) {
  const wp = { ...P };
  wp.frontBays = 3;
  wp.sideBays = P.sideBays >= 4 ? 3 : 2;
  wp.columnHeight = P.columnHeight * 0.82;   // 종속(행랑채는 낮다)
  wp.podiumTiers = 1;
  wp.podiumRailing = false;
  wp.bracketTiers = Math.max(0, (P.bracketTiers ?? 1) - 1);
  wp.doubleEave = false;
  return wp;
}

// 날개 index(0=우익,1=좌익)의 배치 스펙: 회전·최종위치·크기.
export function wingSpec(P, index) {
  const Lm = computeLayout(P);
  const wp = wingParams(P);
  const Lw = computeLayout(wp);
  const Ww = Lw.W, Dw = Lw.D;
  const innerX = Lm.W / 2 * 0.9;             // 안쪽면 x(본채 폭 안으로 살짝 들여 연결감)
  const centerZ = Lm.D * 0.12 + Ww / 2;      // 마당 앞쪽으로 뻗어나감
  // 첫 날개는 좌익(-x): 우측 한지 패널에 가리지 않는 화면 좌측에 서서 확장/머지가 잘 보인다.
  const side = index === 0 ? -1 : 1;         // 좌익 -x / 우익 +x
  const rotY = index === 0 ? Math.PI / 2 : -Math.PI / 2;
  const pos = new THREE.Vector3(side * (innerX + Dw / 2), 0, centerZ);
  return { rotY, pos, side, params: wp, size: { W: Ww, D: Dw, H: Lw.totalH } };
}

function makeWingFromSpec(s) {
  const g = buildBuilding(s.params);
  g.name = 'wing';
  g.rotation.y = s.rotY;
  g.position.copy(s.pos);
  return { group: g, spec: s };
}

function makeWing(P, index) {
  return makeWingFromSpec(wingSpec(P, index));
}

// P(본채), expansion(1..3) → 이번 단계에서 존재해야 하는 날개 그룹 배열.
export function buildWings(P, expansion) {
  const max = wingCount(keyOf(P));
  const nWings = Math.min(Math.max(0, expansion - 1), max);
  const out = [];
  for (let i = 0; i < nWings; i++) out.push({ group: makeWing(P, i).group });
  return out;
}

// 날개 wrapper 또는 raw group을 받아 코어의 건물 소유권 규약으로 해제한다.
export function disposeWing(wing) {
  return disposeBuilding(wing?.group || wing);
}

// 다음 날개의 배치만 계산한다. ghost와 실제 머지가 같은 공식을 공유하고,
// 지오메트리·재질 생성은 buildNextWing에서만 일어난다.
export function nextWingPlacement(P, targetExpansion) {
  const max = wingCount(keyOf(P));
  const index = targetExpansion - 2;
  if (index < 0 || index >= max) return null;
  const spec = wingSpec(P, index);
  const pFinal = spec.pos.clone();
  // 시작 위치: 마당 바깥으로 밀려난 "부속채" 자리(머지 시 끌려 들어온다).
  const pStart = pFinal.clone();
  pStart.x += spec.side * spec.size.D * 1.3;
  pStart.z += spec.size.W * 0.45;
  return { spec, pFinal, pStart, size: spec.size, index };
}

// 다음(추가될) 날개 1동. 머지 애니메이션용 시작/최종 위치 포함.
//   targetExpansion 로 커질 때 새로 붙는 날개(index = targetExpansion-2).
export function buildNextWing(P, targetExpansion) {
  const placement = nextWingPlacement(P, targetExpansion);
  if (!placement) return null;
  const { group } = makeWingFromSpec(placement.spec);
  const { pFinal, pStart, size, index } = placement;
  return { group, pFinal, pStart, size, index };
}

// 머지 후보 점선 윤곽용 박스 치수·위치(부속채가 놓인 바깥 자리).
export function ghostSpec(P, targetExpansion) {
  const placement = nextWingPlacement(P, targetExpansion);
  return placement ? { pStart: placement.pStart, size: placement.size } : null;
}
