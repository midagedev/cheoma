// Pure outer-precinct contract shared by the palace renderer and semantic
// interaction index. Interior ilgwak placement remains palace.js-owned; the
// palace wall and Gwanghwamun must never be reconstructed from unrelated boxes.
//
// 이 파일은 THREE 를 쓰지 않는 순수 계약이다. 궁장 치수 외에 궁역이 **도시와 만나는 면**
//   (정문 앞 광장·육조거리 축선·관아 슬롯·궁장 밖 이격)도 여기서 한 번만 정의하고,
//   plan.js·roads.js·검증 게이트가 같은 수를 읽는다 — 렌더러는 이 좌표를 다시 풀지 않는다.

// 궁장(宮墻) 치수 (#21 R5 D13, 2026-08-02).
//   종전 3.0m/0.7t 는 민가 담(초가 1.3 / 한옥 2.0 / 반가·객사 2.2m, 두께 0.46~0.5)의
//   1.36×/1.4× 라, 부감에서 색만 다른 민가 담으로 읽혔다. 실제 궁장은 사람 키의 세 배에
//   가깝고(경복궁 궁장 약 5~6m·두께 2m 급) 장대석 지대석 위에 전돌을 쌓아 기와 갓을 얹는다
//   — 그 두께가 굵은 그림자 띠를 만든다. 규모를 그대로 옮기면 96m 궁역이 담에 갇히므로
//   민가 담의 1.9×(높이)·2.3×(두께)로 축약하되 위계 구분은 확실히 서는 값을 쓴다.
//   plinth = 지대석: 담 두께보다 넓게 내밀어 발치에 그림자 선을 만든다(팔레트 M.stone 재사용).
export const PALACE_OUTER_WALL = Object.freeze({
  height: 4.2,
  thickness: 1.15,
  wallStyle: 'jeondol',
  gateGap: 9.5,
  gateType: 'soseuldaemun',
  gateWidth: 3.4,
  plinth: Object.freeze({ height: 0.5, spread: 0.34 }),
});

export function palaceOuterPrecinctPlan(width, depth) {
  const W = Number.isFinite(width) && width > 0 ? width : 60;
  const D = Number.isFinite(depth) && depth > 0 ? depth : 90;
  const halfW = W * 0.5;
  const halfD = D * 0.5;
  return {
    width: W,
    depth: D,
    wall: {
      points: [
        { x: -halfW, z: halfD }, { x: halfW, z: halfD },
        { x: halfW, z: -halfD }, { x: -halfW, z: -halfD },
      ],
      height: PALACE_OUTER_WALL.height,
      thickness: PALACE_OUTER_WALL.thickness,
      wallStyle: PALACE_OUTER_WALL.wallStyle,
      plinth: PALACE_OUTER_WALL.plinth,
      opening: { seg: 0, center: 0.5, width: PALACE_OUTER_WALL.gateGap },
    },
    gate: {
      type: PALACE_OUTER_WALL.gateType,
      width: PALACE_OUTER_WALL.gateWidth,
      position: { x: 0, z: halfD },
      rotationY: 0,
    },
  };
}

// ── 궁역과 도시의 접합 (#21 R5 D8·D14·E, 2026-08-02) ─────────────────────────
//
// 근거는 구한말 사진 두 계열이다. ① 문 앞에는 건물 없는 넓은 흙 광장이 있고 상가·행랑은
//   그 광장 좌우 변으로 물러난다(refs/hanyang-old/sungnyemun-1900s — 성문 사례지만 "대문
//   앞 공백"은 같은 규칙이다). ② 관아군은 축을 공유한 긴 행랑 덩어리로 읽힌다
//   (panorama-from-citywall-1902). 고증으로도 광화문 앞 육조거리는 폭 50~60m 급 대로였고
//   의정부·육조가 그 좌우에 거리를 향해 늘어섰다(docs/joseon-city.md §육조거리).
//
// 종전에는 이 셋 중 어느 것도 계획에 없었다. 실측(2026-08-02, hanyang 4시드): 정문 앞
//   광장 구역에 시전 점포 0~14채·민가 0~4필지가 들어찼고, 민가 최근접 정점이 궁장에서
//   0.07m 였다.
// 광장(=육조거리 본체): 정문 면에서 도성 안쪽으로. 폭은 주작대로(17.5m) 양쪽에 관아 앞
//   여유를 남긴 52m — 고증의 육조거리 폭(50~60m)에 해당하며, 대로 폭이 tier 무관 상수라
//   폭도 tier 무관이다. 길이는 관아 열 전체를 덮어야 한다: 이 구간이 짧으면 시전 행랑이
//   관아 사이로 파고들어 육조거리가 상가로 읽힌다(실측 2026-08-02: 길이 70 에서 축선
//   70~84m 대역에 점포 12~14채).
// 관아 슬롯 수는 히어로 삼각형 예산에 묶여 있다 — 실측 2026-08-02: 관아 1동 ≈ 154k tri,
//   반가 1동 ≈ 145k tri 이고 한양 aerial 삼각형 천장(2.45M)이 전제한 히어로 몫은 heroCap 6
//   worst case(868k)다. 한양 2동×2변 + 반가 승격 2 = 히어로 6동으로 그 전제를 보존한다.
const HANYANG_FRONT = Object.freeze({
  plazaLength: 96,
  plazaHalfWidth: 26,
  precinctClearance: 8,   // 궁장 밖 이격 — 민가가 담에 붙어 궁역 윤곽을 지우는 것을 막는다
  // 축선 끝(종로 T)까지 남겨 두는 대로 꼬리. 압축 모델의 육조거리는 실측 44~80m 밖에 안 되므로
  //   (실측 2026-08-02: 광화문→종로 seed 20260716 44.3m · 7 73.9m · 1 80.4m · 11 72.3m)
  //   광장이 그 전부를 먹으면 주작대로가 길이 0 으로 소멸하고 시전 행랑도 T 에 닿지 못한다.
  axisTail: 24,
  magistracy: Object.freeze({
    count: 2,
    plotW: 26,          // 축선에 직교하는 폭(광장 변에서 바깥으로)
    plotD: 24,          // 축선 방향 깊이
    firstOffset: 26,    // 정문 면에서 첫 슬롯 중심까지의 축선 거리(이격 링 8m 밖에 앉게)
    spacing: 28,        // 슬롯 중심 간격(축선 방향)
  }),
});

// capital 축소판(궁역 58×90)은 분지도 작다(R≈280). 이 라운드의 도시면 어휘는 **한양 전용**
//   이다: 사진 대조 판정(#15 D8·D14)이 한양 렌더를 근거로 삼았고, 같은 치수를 capital 에
//   옮기면 광장 하나가 도성 거주역의 상당 부분을 먹는다(실측 2026-08-02: 44m 광장에서도
//   감상모드 저공·도보 계약 T15·T16·W6 가 무너진다 — 드론·도보가 빈 마당 위를 지난다).
//   capital 은 궁장 밖 이격(E)만 받는다. 궁 자체의 위계(D5 행각·정전, D13 궁장)는 기하라
//   두 tier 에 그대로 적용된다.
const CAPITAL_FRONT = Object.freeze({
  plazaLength: 0,
  plazaHalfWidth: 26,
  precinctClearance: 8,
  axisTail: 24,
  magistracy: Object.freeze({
    count: 0, plotW: 26, plotD: 24, firstOffset: 26, spacing: 28,
  }),
});

export const PALACE_URBAN_FRONT = Object.freeze({
  hanyang: HANYANG_FRONT,
  capital: CAPITAL_FRONT,
});

/** 궁역 깊이로 tier 프로필을 고른다(한양 150 / capital 90). */
export function palaceUrbanFront(parcel) {
  return (parcel?.plotD ?? 0) >= 120 ? HANYANG_FRONT : CAPITAL_FRONT;
}

function frameOf(parcel) {
  const front = parcel.frontDir;
  const length = Math.hypot(front.x, front.z) || 1;
  const f = { x: front.x / length, z: front.z / length };
  return { f, r: { x: f.z, z: -f.x } };
}

// 필지 로컬(x=우, z=정면 앞) → 월드. parcel-contract#parcelWorldPoint 와 같은 규약이지만
//   이 파일은 순수 계약이라 의존을 만들지 않고 같은 식을 쓴다.
function toWorld(parcel, frame, x, z) {
  return {
    x: parcel.center.x + frame.r.x * x + frame.f.x * z,
    z: parcel.center.z + frame.r.z * x + frame.f.z * z,
  };
}

/** 정문(광화문) 중심의 월드 좌표. */
export function palaceGatePoint(parcel) {
  return toWorld(parcel, frameOf(parcel), 0, parcel.plotD * 0.5);
}

/**
 * 정문 앞 광장(건물 없는 흙 마당) 폴리곤 — 필지·시전·논 blocker 용.
 * length 를 주면 그 길이로 자른다(축선이 종로에 닿기 전에 끝나야 하는 경우).
 */
export function palaceGatePlazaPolygon(parcel, front = palaceUrbanFront(parcel), length = front.plazaLength) {
  const frame = frameOf(parcel);
  const z0 = parcel.plotD * 0.5;
  const z1 = z0 + length;
  const h = front.plazaHalfWidth;
  return [
    toWorld(parcel, frame, -h, z0),
    toWorld(parcel, frame, h, z0),
    toWorld(parcel, frame, h, z1),
    toWorld(parcel, frame, -h, z1),
  ];
}

/**
 * 궁장 밖 이격 링 — 네 면을 같은 거리로 넓힌 사각형. 민가가 담에 붙어 궁역 윤곽을 지우는
 * 것을 막는다. 관아 슬롯의 첫 칸(firstOffset)은 이 링 밖에 앉도록 잡혀 있다.
 */
export function palacePrecinctClearancePolygon(parcel, front = palaceUrbanFront(parcel)) {
  const frame = frameOf(parcel);
  const c = front.precinctClearance;
  const hw = parcel.plotW * 0.5 + c;
  const hd = parcel.plotD * 0.5 + c;
  return [
    toWorld(parcel, frame, -hw, hd),
    toWorld(parcel, frame, hw, hd),
    toWorld(parcel, frame, hw, -hd),
    toWorld(parcel, frame, -hw, -hd),
  ];
}

/**
 * 육조 관아 슬롯 — 광장 좌우 변에 궁과 **같은 좌향**으로 늘어선다. side=-1(서)/+1(동).
 *
 * 좌향을 거리 쪽(축선 직교)이 아니라 궁 축선과 같게 두는 이유: 실제 육조거리 관아도 대문만
 * 거리로 냈을 뿐 정청은 남향이었고, 이 프로젝트의 필지 계약은 좌향 하나가 대문과 본채를
 * 함께 돌린다(`parcel-contract`). 거리를 향하게 하면 정청이 동/서향이 되어 겨울 일조 회랑
 * 계약(`check-layout-contract`)과 남향 규칙을 동시에 깬다. 판정(#15 D14)이 요구한 것도
 * "궁 축선에 방위를 정렬"이므로, 궁과 같은 방위가 그 요구의 직역이다.
 *
 * 반환은 { center, frontDir, plotW, plotD, side, index } 목록(순수 데이터).
 */
export function palaceMagistracySlots(parcel, front = palaceUrbanFront(parcel)) {
  const frame = frameOf(parcel);
  const spec = front.magistracy;
  const lateral = front.plazaHalfWidth + spec.plotW * 0.5;
  const z0 = parcel.plotD * 0.5;
  const slots = [];
  for (const side of [-1, 1]) {
    for (let index = 0; index < spec.count; index++) {
      const along = z0 + spec.firstOffset + spec.spacing * index;
      slots.push({
        side,
        index,
        center: toWorld(parcel, frame, side * lateral, along),
        frontDir: { x: frame.f.x, z: frame.f.z },
        plotW: spec.plotW,
        plotD: spec.plotD,
      });
    }
  }
  return slots;
}

/** 육조거리 축선 — 정문에서 광장을 곧게 관통하는 직선 구간. roads.js 가 소비한다. */
export function palaceAxisSpec(parcel, front = palaceUrbanFront(parcel), straightLength = front.plazaLength) {
  const frame = frameOf(parcel);
  return {
    origin: palaceGatePoint(parcel),
    dir: { x: frame.f.x, z: frame.f.z },
    straightLength,
  };
}

/**
 * 궁역 앞 도시면 한 벌. axisSpan 은 정문에서 축선 끝(종로 T)까지의 실제 거리로, 압축 모델의
 * 육조거리는 그보다 길 수 없다 — 광장이 종로를 넘으면 남촌을 비우고 주작대로가 소멸한다.
 * 관아 슬롯도 같은 span 안에 완전히 들어오는 것만 남긴다.
 *
 * 반환 { axis, plazaLength, plaza, clearance, magistracy }. plazaLength 0 이면 광장 없음
 * (capital 프로필 또는 축선이 꼬리 길이보다 짧은 구성).
 */
export function palaceUrbanFrontPlan(parcel, { axisSpan = Infinity } = {}) {
  const front = palaceUrbanFront(parcel);
  const usable = Math.max(0, (Number.isFinite(axisSpan) ? axisSpan : Infinity) - front.axisTail);
  const plazaLength = Math.min(front.plazaLength, usable);
  // 축선 직선 구간은 광장보다 짧을 수 없고, 최소한 궁장 밖 이격 링은 곧게 빠져나가야 한다.
  //   링 안에서 대로가 휘면 정문 법선과 어긋난 채 궁장에 닿는다(광장이 없는 capital 프로필).
  const straightLength = Math.min(usable, Math.max(plazaLength, front.precinctClearance + 2));
  const spec = front.magistracy;
  const magistracy = palaceMagistracySlots(parcel, front).filter((slot) => {
    const far = spec.firstOffset + spec.spacing * slot.index + spec.plotD * 0.5;
    return far <= (Number.isFinite(axisSpan) ? axisSpan : Infinity);
  });
  return {
    front,
    plazaLength,
    straightLength,
    axis: palaceAxisSpec(parcel, front, straightLength),
    plaza: plazaLength > 0 ? palaceGatePlazaPolygon(parcel, front, plazaLength) : null,
    clearance: palacePrecinctClearancePolygon(parcel, front),
    magistracy,
  };
}
