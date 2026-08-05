// Renderer-free 현판 (uninscribed name plaque) plan for the principal worship hall.
//
// Evidence and its limits (docs/temple-generator.md §8):
//   - 편액은 "건물의 앞부분 높은 곳에 설치하여 건물의 명호를 알려주는 액자"이고
//     "규격은 건물의 규모나 성격에 따라 정해졌"다 (한국학중앙연구원 sillokwiki 「현판」).
//     크기는 건물에 종속된 변수이므로 절대 치수 대신 어칸 폭 비율로 유도한다.
//   - 위계가 높은 현판은 가장자리에 테두리(몰딩)를 두르고, 바탕은 흰색·검은색이
//     대표적이며 주요 전각에는 검은 바탕이 쓰인다 (나무위키 「현판」, 광화문 현판
//     검은 바탕·금박 글씨 복원 보도).
//   - 실측 표본: 여수 흥국사 봉황루 '공북루' 편액 가로 280cm × 세로 120cm
//     (법보신문 「이것이 한국 불교 최초」 64. 편액) → 세로/가로 ≈ 0.43. 기사는 이 크기를
//     "웅장하다"고 설명하므로 상한 표본으로 읽고, 기본값은 그보다 절제한다.
//   전국 사찰 현판의 폭·높이 분포를 제공하는 출처는 없다. 아래 비율은 §2.1과 같은 성격의
//   제품 해석이며 특정 문화유산의 실측 복제가 아니다.
//
// 무자(無字): 글자는 넣지 않는다. 판·몰딩 기하만 만들고 새 텍스처·재질·프로그램을 만들지
// 않으므로, 렌더러는 기존 사찰 팔레트를 차입해 병합 그룹 수를 늘리지 않는다.

import { computeLayout } from '../params.js';
import { templeHallBuilderPreset } from './role-hierarchy.js';

export const TEMPLE_PLAQUE_SCHEMA_VERSION = 1;

// The principal worship hall is the unique rank-4 hall (plan contract), so the
// plaque is gated on architectural rank — never on a role name.
const PRINCIPAL_RANK = 4;
// Board width as a share of the 어칸 (center bay) it hangs in.
const CENTER_BAY_COVER = 0.56;
// Board height / width. Matches the 공북루 편액 aspect (120/280).
const BOARD_ASPECT = 0.43;
const BOARD_THICKNESS = 0.09;
// Border molding: in-plane rail width and how far it stands proud of the board.
const MOLDING_RAIL = 0.11;
const MOLDING_PROUD = 0.03;
// Clear gap below the 공포대 base (평방 윗면) so the plaque never intrudes into
// the bracket band.
const BRACKET_CLEARANCE = 0.06;
// Front face of the 창방 the plaque is fastened to: columns.js builds that beam
// 0.26 deep on the column line.
const CHANGBANG_HALF_DEPTH = 0.13;
// Both columns flanking the 어칸 must stay legible beside the board.
const BAY_SIDE_CLEARANCE = 0.8;
const MIN_BOARD_WIDTH = 1.1;

/**
 * Only the principal worship hall carries a plaque. Subsidiary halls, lecture
 * halls, 요사, and the pass-under 문루 are a rank below and stay bare in this
 * contract (see docs/temple-generator.md §8 for the deferred 누각 편액 case).
 */
export function templeHallHasPlaque(spec) {
  return !!spec
    && spec.architecturalRank === PRINCIPAL_RANK
    && Number.isInteger(spec.frontBays)
    && spec.frontBays >= 3
    // An even bay count has a column, not a bay, on the center axis.
    && spec.frontBays % 2 === 1;
}

/**
 * One 무자 현판 record in hall-local, unscaled space (the host hall group applies
 * `spec.scale`, `spec.yaw`, and any apron lift). `+z` is the south front, matching the
 * builder's front bay row, so the record needs no renderer-side re-derivation.
 * Returns null for every hall that does not carry a plaque.
 */
export function templeHallPlaquePlan(spec) {
  if (!templeHallHasPlaque(spec)) return null;
  const preset = templeHallBuilderPreset(spec);
  const layout = computeLayout(preset);
  const scale = Number.isFinite(spec.scale) ? spec.scale : 1;
  const centerBay = preset.centerBayW;
  const maxWidth = Math.max(MIN_BOARD_WIDTH, centerBay - BAY_SIDE_CLEARANCE * 2);
  const width = Math.min(Math.max(centerBay * CENTER_BAY_COVER, MIN_BOARD_WIDTH), maxWidth);
  const height = width * BOARD_ASPECT;
  // 공포대는 평방 윗면(plateY)에서 시작한다. 현판 상단은 그 밑에서 끝나고, 나머지는
  // 창방을 물고 어칸 문 위로 내려온다 — 사료 사진의 관례 위치.
  const bracketBaseY = layout.plateY;
  const topY = bracketBaseY - BRACKET_CLEARANCE;
  const bottomY = topY - height;
  const frontFaceZ = layout.zPos[layout.zPos.length - 1];
  const backZ = frontFaceZ + CHANGBANG_HALF_DEPTH;
  return {
    schemaVersion: TEMPLE_PLAQUE_SCHEMA_VERSION,
    hostRank: spec.architecturalRank,
    // 무자 현판: no glyphs, no lettering texture, no inscription geometry.
    lettering: 'none',
    board: { width, height, thickness: BOARD_THICKNESS },
    molding: { rail: MOLDING_RAIL, proud: MOLDING_PROUD },
    local: { x: 0, y: (topY + bottomY) / 2, z: backZ + BOARD_THICKNESS / 2 },
    topY,
    bottomY,
    // Landmarks the gate asserts against, all hall-local and unscaled.
    band: {
      columnTopY: layout.colTopY,
      bracketBaseY,
      bracketTopY: bracketBaseY + layout.bracketH,
      eaveEdgeY: layout.eaveEdgeY,
      centerBayHalf: centerBay / 2,
      frontFaceZ,
      eaveFrontZ: layout.zEave,
    },
    scale,
    world: { width: width * scale, height: height * scale },
  };
}
