# 천장 층위 — 지붕 구조와 실내 마감

> - **상태**: 계약 + 리서치 (실내 볼륨 패스 전 구조 고정)
> - **기준일**: 2026-07-27
> - **코드**: `src/builder/ceiling-plan.js`, `src/layout/roof-shell.js`, `src/core/surface-clearance.js`
> - **게이트**: `npm run check:ceiling`, `npm run check:roof-shell`, `npm run check:assembly`

## 목표

실내 재현이 제품 최종 목표다. 천장은 **한 장의 “방 천장 판”으로 기와 하면을 막는다**가 아니라, 사료가 구분하는 **지붕 구조 층**과 **공간 마감(반자/연등)** 을 분리해 둔다.

## 고증 요약

| 공간 | 일반 마감 | 보이는 것 |
| --- | --- | --- |
| **온돌 방** | **반자** | 지붕틀을 가린 별도 덮개(대개 도배) |
| **대청·마루** | **연등천장** | 서까래 노출 + 사이 개판/산자·앙토 |
| **궁·사찰 정전** | **우물천장** 등 | 격자 반자틀 + 청판 (살림집 기본값 아님) |
| **처마 밑 외관** | 연등 읽기 | 서까래 + 구조 하면 — 방 반자가 아님 |

근거:

1. 한국민족문화대백과 「연등천장」 — *방은 대개 천장을 하고 대청은 천장을 하지 않는다*; 연등은 별도 반자 없이 서까래 노출, 사이는 개판/산자·앙토.
2. 한국민족문화대백과 「우물천장」 — 살림집에서 드묾, 궁·사찰 중심.
3. 국사편찬위원회 우리역사넷 「한옥의 미학」(한필원) — 온돌방 반자 / 대청·흙바닥 반자 없음.
4. AURI 지붕 층위 — 서까래 → 산자/개판 → 암·수키와 (`docs/architectural-authenticity.md` §2.3).

## 제품 층위 계약

```
[외] 기와 외피 (tile, FrontSide)
     ↓ ROOF_SHELL_THICKNESS (기본 0.08m)
[구] 개판/산자 하면 (gaepan)     ← 지붕 구조. undersideIsRoomBanja === false
[구] 서까래·부연 (rafters)       ← 연등 공간·처마 밑에서 읽힘
     ··· 실내 패스에서 방 구역만 ···
[마] 반자 평면 (banja)           ← status: planned → rendered (아직 메시 없음)
```

불변식:

1. **제로 두께 DoubleSide 기와면 금지** — 외피·하면이 같은 평면을 공유하면 z-fighting.
   `makeRoofUndersideGeometry`는 모든 정점을 **단위 외향 노멀**로 `ROOF_SHELL_THICKNESS` 만큼
   내리고, 영길이 노멀(메시 극점)은 +Y 폴백으로 오프셋이 0이 되지 않게 한다. same-index
   최소 거리는 두께의 0.85× 이상(`check:roof-shell`). 조립 중 outer/gaepan visibility는
   같은 비트로 잠근다(`assembly.js` `lockRoofShellVisibility`) — 켜 흐름 lag가 한쪽만
   드러내며 깊이 스택을 깨지 않게.
1b. **마루 튜브·용마루 솔리드** — 내림/추녀/회첨 마루 중심선과 용마루 하면은 외피에서
   `r + ROOF_MARU_SURFACE_CLEAR`(기본 2cm) 이상 떨어져야 한다. 반경만큼 묻히면 조립·처마
   근접에서 기와 면과 동일 평면 충돌이 난다. 회첨은 골 **안(공기 쪽)** 에 앉히고 지붕
   솔리드 쪽으로 파묻지 않는다.
1c. **개판 하면 림 금지** — `paletteKey: 'gaepan'` / `isRoofGaepan` 재질은 Fresnel rim 패치
   대상이 아니다. eaveBand 클론을 그대로 쓰면 role=roof 림이 넓은 처마 하면에 금점 지직으로
   읽힌다. 처마 단면 띠(eaveBand)만 림 유지.
1d. **서까래** — 개판 아래로 표면 노멀 방향 `ROOF_SHELL_THICKNESS + 0.10` 이상. 순수 −Y 오프셋은
   급경사에서 하면과 붙는다.
2. **개판 하면 ≠ 방 반자** — `userData.roofLayer = 'gaepan'`, plan `undersideIsRoomBanja: false`.
3. **공간별 finish** — `yeondeung` | `banja` | `well` (`CEILING_FINISH`).
4. **조립** — 지붕 그룹 강체 1유닛; 자식 local Y/scale 고정으로 구조 스택 보존.
5. **실내 반자 메시** — `banjaGeometry: 'deferred'` 가 유지되는 한 생성하지 않는다. 구역 bounds·`ceilingY`만 plan에 남긴다.

## 건물 부착

`buildGiwa` / `buildBuilding`(궁·절·초가) 가 루트에 `userData.ceilingPlan` 을 붙인다.

- 기와: 대청 → `yeondeung`+`structure`, 방 칸 → `banja`+`planned`, 처마 하면 → `yeondeung`+`structure`.
- 궁·절: 주 공간 `well`+`planned`, 처마 `yeondeung`+`structure`.
- 초가: 연등 구조 읽기 기본.

공개 순수 API: `src/api/ceiling-plan.js` (내부는 `src/builder/ceiling-plan.js`만 import).

## 다음 실내 패스 (이 문서 범위 밖 구현)

1. 방 볼륨·벽 내면·바닥 마감.
2. `status: planned` 인 `banja` 구역에만 수평 반자 메시 (`ceilingY`, bounds).
3. 대청은 반자 없이 기존 서까래·개판을 실내에서도 공유.
4. 우물천장은 궁·사찰 주전각 전용 문법으로 분리.

## 검증

| 명령 | 내용 |
| --- | --- |
| `npm run check:ceiling` | plan schema, 방/대청 finish 분리, underside≠banja |
| `npm run check:roof-shell` | 외피·개판 물리 간격, FrontSide |
| `npm run check:assembly` | 지붕 강체 |
| `npm run check:worker` | 구조 메시 변경 시 scene golden |
