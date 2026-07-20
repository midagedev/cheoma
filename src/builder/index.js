import * as THREE from 'three';
import { computeLayout } from '../params.js';
import { makeMaterials, applyDoorPattern } from './palette.js';
import { buildPodium } from './podium.js';
import { buildColumns } from './columns.js';
import { buildBrackets } from './brackets.js';
import { buildWalls } from './walls.js';
import { buildRoof } from './roof.js';
import { buildGiwa } from './giwa.js';
import { disposeBuilding, registerBuildingResources } from './lifecycle.js';

export { disposeBuilding };

// 파라미터 → 건물 그룹. 파트별 그룹 이름을 달아 조립 애니메이션에 대비한다.
//   P.mats(옵트인, #149): 호출측이 공유 재질셋을 주면 makeMaterials 를 건너뛰고 그걸 쓴다.
//   궁궐(palace.js)은 한 벌의 'palace' 재질셋을 전 전각에 공유시켜 부감 병합(palaceMerged)이
//   전각 경계까지 무너지게 한다(드로우콜 −). 미지정(마을 giwa/choga·히어로)이면 전과 동일하게
//   호출마다 새 재질셋 — 옵트인이라 기존 경로는 바이트 불변.
export function buildBuilding(P) {
  const M = P.mats || makeMaterials(P.style || 'palace');
  // 창호 살 패턴 변주(#55) — 부재 조립 전에 창호 텍스처 교체(문짝 클론이 새 패턴 상속).
  //   공유 재질(P.mats)에는 적용하지 않는다: M.door.map 교체가 재질셋을 공유하는 다른 전각·행각까지
  //   전파되기 때문. 궁 경로는 doorPattern 을 쓰지 않으므로 실질 무영향(방어적 가드).
  if (P.doorPattern && !P.mats) applyDoorPattern(M, P.doorPattern);
  // 기와집(ㄱ자 반가): L 평면 전용 경로 (스켈레톤 지붕 + L 몸체).
  if (P.style === 'giwa') {
    const root = buildGiwa(P, M);
    root.userData.layout = computeLayout(P);
    root.userData.materials = M;
    return registerBuildingResources(root, M, !P.mats);
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
  return registerBuildingResources(root, M, !P.mats);
}
