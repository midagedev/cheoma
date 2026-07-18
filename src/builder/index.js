import * as THREE from 'three';
import { computeLayout } from '../params.js';
import { makeMaterials, applyDoorPattern } from './palette.js';
import { buildPodium } from './podium.js';
import { buildColumns } from './columns.js';
import { buildBrackets } from './brackets.js';
import { buildWalls } from './walls.js';
import { buildRoof } from './roof.js';
import { buildGiwa } from './giwa.js';

// 파라미터 → 건물 그룹. 파트별 그룹 이름을 달아 조립 애니메이션에 대비한다.
export function buildBuilding(P) {
  const M = makeMaterials(P.style || 'palace');
  // 창호 살 패턴 변주(#55) — 부재 조립 전에 창호 텍스처 교체(문짝 클론이 새 패턴 상속).
  if (P.doorPattern) applyDoorPattern(M, P.doorPattern);
  // 기와집(ㄱ자 반가): L 평면 전용 경로 (스켈레톤 지붕 + L 몸체).
  if (P.style === 'giwa') {
    const root = buildGiwa(P, M);
    root.userData.layout = computeLayout(P);
    root.userData.materials = M;
    return root;
  }
  const L = computeLayout(P);
  const root = new THREE.Group();
  root.name = 'building';

  const parts = {
    podium: buildPodium(P, L, M),
    columns: buildColumns(P, L, M),
    walls: buildWalls(P, L, M),
    brackets: buildBrackets(P, L, M),
    roof: buildRoof(P, L, M),
  };
  for (const [name, group] of Object.entries(parts)) {
    group.name = name;
    root.add(group);
  }

  root.userData.layout = L;
  root.userData.materials = M;
  return root;
}
